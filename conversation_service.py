"""Conversation facade for the A&F Web Frontend.

Unified entry point consumed by ``FrontendAdapter`` and ``MessageService``.
Delegates branch logic to ``ConversationBranchService`` and search logic
to ``ConversationSearchService``, while keeping history, navigation, list,
favorites, and CRUD operations here.
"""

import asyncio
import base64
import json
import mimetypes
import os
import sqlite3
from pathlib import Path

from aiohttp import web

from astrbot import logger

from . import runtime
from .conversation_core import ConversationCore
from .conversation_branch import ConversationBranchService
from .conversation_search import ConversationSearchService


class ConversationService:
    """Manages conversations, history, pins, and search."""

    def __init__(self, config: dict, umo: str) -> None:
        self._core = ConversationCore(config=config, umo=umo)
        self._branches = ConversationBranchService(self._core)
        self._search = ConversationSearchService(self._core)

    # -- Forwarded properties --------------------------------------------------

    @property
    def data_dir(self) -> Path:
        return self._core.data_dir

    def find_db(self) -> str | None:
        return self._core.find_db()

    # -- Forwarded to branch module --------------------------------------------

    def resolve_patch_target(
        self,
        history: list[dict],
        branch_index: int,
        expected_role: str,
    ) -> dict | None:
        return self._branches.resolve_patch_target(
            history, branch_index, expected_role,
        )

    def extract_branch_text(self, message: dict) -> str:
        return self._branches._extract_branch_text(message)

    # -- Forwarded to core (used by MessageService for patch loading) -----------

    def load_conversation_history(
        self,
        conversation_id: str,
        platform_id: str,
    ) -> tuple[list, str, str] | None:
        return self._core.load_conversation_history(conversation_id, platform_id)

    def resolve_umo(self, platform_id: str) -> str:
        return self._core.resolve_umo(platform_id)

    @property
    def den_platform_id(self) -> str:
        return self._core.config.get("id", "abyss_web")

    async def handle_branch(self, ws: web.WebSocketResponse, data: dict):
        await self._branches.handle_branch(ws, data)

    # -- Forwarded to search module --------------------------------------------

    async def handle_search(self, ws: web.WebSocketResponse, data: dict):
        await self._search.handle_search(ws, data)

    # -- CID alignment ---------------------------------------------------------

    async def align_cid(self) -> str | None:
        """Align AstrBot's CID pointer with the latest Den conversation.

        Queries the most recently updated Den conversation from the DB,
        then calls ``switch_conversation()`` so AstrBot's internal
        pointer matches what the frontend will display.

        Returns the aligned CID, or ``None`` if no Den conversation
        exists yet (legitimate empty state).

        Raises ``RuntimeError`` on infrastructure failures — missing DB,
        unavailable conversation manager, or failed switch — so the
        caller can distinguish "no conversations" from "broken setup."

        Must be called BEFORE sending ``auth_ok`` to prevent a race
        where the client sends a message before the pointer is aligned.
        """
        platform_id = self._core.config.get("id", "abyss_web")
        db_path = self._core.find_db()
        if not db_path:
            raise RuntimeError("Den conversation database not found")

        if runtime.conversation_manager is None:
            raise RuntimeError("AstrBot conversation manager is unavailable")

        conn = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
        try:
            cursor = conn.execute(
                "SELECT conversation_id FROM conversations "
                "WHERE platform_id = ? ORDER BY updated_at DESC LIMIT 1",
                (platform_id,),
            )
            row = cursor.fetchone()
        finally:
            conn.close()

        if not row:
            return None

        cid = row[0]
        await runtime.conversation_manager.switch_conversation(
            self._core.umo, cid,
        )
        return cid

    # -- Auth history (reconnect-aware) ----------------------------------------

    _UNSET = object()  # sentinel: align_cid not yet called this auth cycle

    @staticmethod
    def _make_history_payload(
        *,
        messages,
        conversation_id,
        platform_id,
        title,
        readonly,
    ):
        return {
            "type": "history",
            "messages": messages,
            "readonly": readonly,
            "platform_id": platform_id,
            "conversation_id": conversation_id,
            "title": title,
        }

    async def _align_cid_once(self, cached):
        """Run align_cid() if not yet executed this cycle; return (cid, True)
        on first call, (cached, False) on subsequent calls.

        *cached* must be ``_UNSET`` on the first call.  A ``None`` return
        from ``align_cid()`` is valid (no Den conversations) and must not
        be confused with "not yet executed."
        """
        if cached is not self._UNSET:
            return cached, False
        cid = await self.align_cid()
        return cid, True

    async def _latest_den_auth_history(self, *, aligned_cid=_UNSET):
        """Default auth history: latest Den window + aligned CID pointer.

        If *aligned_cid* is the sentinel, calls ``align_cid()`` itself.
        Otherwise reuses the already-aligned value.
        """
        den_pid = self._core.config.get("id", "abyss_web")
        cid, _ = await self._align_cid_once(aligned_cid)

        if cid is None:
            return self._make_history_payload(
                messages=[],
                conversation_id=None,
                platform_id=den_pid,
                title="",
                readonly=False,
            )

        result = self._core.load_conversation_history(cid, den_pid)
        if result is None:
            raise RuntimeError("Aligned Den conversation could not be loaded")

        messages, actual_pid, title = result
        return self._make_history_payload(
            messages=messages,
            conversation_id=cid,
            platform_id=actual_pid,
            title=title,
            readonly=False,
        )

    async def prepare_auth_history(
        self,
        resume_conversation_id: str | None,
        resume_platform_id: str | None,
    ):
        """Build the authoritative history payload for an auth cycle.

        Handles three cases:
        1. Reconnect restoring a writable Den window.
        2. Reconnect restoring a read-only QQ window.
        3. Fresh login / unknown platform / invalid CID → latest Den.

        ``align_cid()`` is called at most once per invocation.
        """
        den_pid = self._core.config.get("id", "abyss_web")
        aligned = self._UNSET  # track cached align_cid result

        # 1. Resume a writable Den window.
        if resume_conversation_id and resume_platform_id == den_pid:
            result = self._core.load_conversation_history(
                resume_conversation_id, den_pid,
            )
            if result is not None:
                messages, actual_pid, title = result
                await runtime.conversation_manager.switch_conversation(
                    self._core.umo, resume_conversation_id,
                )
                return self._make_history_payload(
                    messages=messages,
                    conversation_id=resume_conversation_id,
                    platform_id=actual_pid,
                    title=title,
                    readonly=False,
                )
            # CID deleted or forged — fall through to latest Den.

        # 2. Resume a read-only QQ window.
        if resume_conversation_id and resume_platform_id == "Abyss":
            qq_result = self._core.load_conversation_history(
                resume_conversation_id, "Abyss",
            )

            # Den pointer must still align regardless of QQ display target.
            aligned, _ = await self._align_cid_once(aligned)

            if qq_result is not None:
                messages, actual_pid, title = qq_result
                return self._make_history_payload(
                    messages=messages,
                    conversation_id=resume_conversation_id,
                    platform_id=actual_pid,
                    title=title,
                    readonly=True,
                )
            # QQ CID invalid — fall through to latest Den.

        # 3. Fresh login, unknown platform, or invalid resume target.
        return await self._latest_den_auth_history(aligned_cid=aligned)

    # -- Navigation failure helper --------------------------------------------

    @staticmethod
    async def _send_navigation_failed(
        ws: web.WebSocketResponse, conversation_id: str | None,
    ):
        """Send a terminal navigation failure to the frontend."""
        try:
            await ws.send_json({
                "type": "navigation_failed",
                "conversation_id": conversation_id,
            })
        except Exception:
            pass

    # -- History loading -------------------------------------------------------

    async def send_history(
        self, ws: web.WebSocketResponse, conversation_id: str | None = None,
    ):
        """Load conversation history and send to client (auth flow only).

        If *conversation_id* is given, load that specific conversation.
        Otherwise fall back to the most recently updated one.
        """
        try:
            platform_id = self._core.config.get("id", "abyss_web")

            title = ""
            if conversation_id:
                result = self._core.load_conversation_history(
                    conversation_id, platform_id,
                )
                if result is not None:
                    messages, _, title = result
                    cid = conversation_id
                else:
                    messages, cid = [], conversation_id
            else:
                db_path = self._core.find_db()
                if not db_path:
                    logger.warning("Chat history DB not found, tried common paths")
                    return
                conn = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
                try:
                    cursor = conn.execute(
                        "SELECT content, conversation_id, title FROM conversations "
                        "WHERE platform_id = ? ORDER BY updated_at DESC LIMIT 1",
                        (platform_id,),
                    )
                    row = cursor.fetchone()
                finally:
                    conn.close()
                if row and row[0]:
                    messages = json.loads(row[0])
                    cid = row[1]
                    title = row[2] or ""
                else:
                    messages = []
                    cid = row[1] if row else None

            await ws.send_json({
                "type": "history",
                "messages": messages,
                "readonly": False,
                "platform_id": platform_id,
                "conversation_id": cid,
                "title": title,
            })
        except Exception as exc:
            logger.warning(f"Failed to load chat history: {exc}")

    # -- Favorites -------------------------------------------------------------

    async def get_favorites(self) -> list[dict]:
        """Query all favorited conversations with full summary objects."""
        pinned_ids = self._core.load_pins()
        if not pinned_ids:
            return []

        db_path = self._core.find_db()
        if not db_path:
            return []

        active_cid = await self._core.get_active_cid()

        conn = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
        placeholders = ",".join("?" * len(pinned_ids))
        cursor = conn.execute(
            f"SELECT conversation_id, title, updated_at, platform_id, content "
            f"FROM conversations "
            f"WHERE conversation_id IN ({placeholders}) "
            f"AND platform_id IN ('Abyss', 'Abyss_Den') "
            f"ORDER BY updated_at DESC",
            pinned_ids,
        )
        rows = cursor.fetchall()
        conn.close()

        return [
            self._core.serialize_conversation(row, pinned_ids, active_cid)
            for row in rows
        ]

    async def send_favorites(self, ws: web.WebSocketResponse):
        """Push the full favorites list to the client (called after auth)."""
        try:
            favorites = await self.get_favorites()
            await ws.send_json({
                "type": "favorites_list",
                "favorites": favorites,
            })
        except Exception as exc:
            logger.warning(f"Failed to send favorites: {exc}")

    # -- Conversation list (cursor pagination) ---------------------------------

    async def send_conversations_list(
        self,
        ws: web.WebSocketResponse,
        cursor: str | None = None,
        limit: int = 20,
        generation: int | None = None,
    ):
        """Send a cursor-paginated list of conversations."""
        try:
            limit = max(1, min(limit, 50))

            db_path = self._core.find_db()
            if not db_path:
                raise FileNotFoundError("Chat history DB not found")

            conn = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
            active_cid = await self._core.get_active_cid()
            pinned_ids = self._core.load_pins()

            # Cursor format: "updated_at|conversation_id"
            if cursor:
                parts = cursor.split("|", 1)
                if len(parts) == 2:
                    cursor_ts, cursor_cid = parts
                    db_cursor = conn.execute(
                        "SELECT conversation_id, title, updated_at, platform_id, content "
                        "FROM conversations "
                        "WHERE platform_id IN ('Abyss', 'Abyss_Den') "
                        "AND (updated_at < ? OR (updated_at = ? AND conversation_id < ?)) "
                        "ORDER BY updated_at DESC, conversation_id DESC "
                        "LIMIT ?",
                        (cursor_ts, cursor_ts, cursor_cid, limit + 1),
                    )
                else:
                    cursor = None  # Invalid format, fall through

            if not cursor:
                db_cursor = conn.execute(
                    "SELECT conversation_id, title, updated_at, platform_id, content "
                    "FROM conversations "
                    "WHERE platform_id IN ('Abyss', 'Abyss_Den') "
                    "ORDER BY updated_at DESC, conversation_id DESC "
                    "LIMIT ?",
                    (limit + 1,),
                )

            rows = db_cursor.fetchall()
            conn.close()

            has_more = len(rows) > limit
            if has_more:
                rows = rows[:limit]

            conversations = [
                self._core.serialize_conversation(row, pinned_ids, active_cid)
                for row in rows
            ]

            next_cursor = None
            if has_more and rows:
                last = rows[-1]
                next_cursor = f"{last[2]}|{last[0]}"

            response = {
                "type": "conversations_list",
                "conversations": conversations,
                "next_cursor": next_cursor,
                "has_more": has_more,
            }
            if generation is not None:
                response["generation"] = generation
            await ws.send_json(response)
        except Exception as exc:
            logger.warning(f"Failed to list conversations: {exc}")
            try:
                response = {"type": "conversations_list_failed"}
                if generation is not None:
                    response["generation"] = generation
                await ws.send_json(response)
            except Exception:
                pass

    # -- Switch / New ----------------------------------------------------------

    async def handle_switch(self, ws: web.WebSocketResponse, conversation_id: str):
        """Switch the active conversation pointer and send its history."""
        try:
            if not runtime.conversation_manager:
                logger.warning("Conversation manager not available yet")
                await self._send_navigation_failed(ws, conversation_id)
                return

            # Load and validate history BEFORE switching the pointer.
            # If this fails the server pointer stays unchanged.
            platform_id = self._core.config.get("id", "abyss_web")
            result = self._core.load_conversation_history(
                conversation_id, platform_id,
            )
            if result is None:
                await self._send_navigation_failed(ws, conversation_id)
                return

            messages, pid, title = result

            # History validated — safe to switch pointer now
            await runtime.conversation_manager.switch_conversation(
                self._core.umo, conversation_id,
            )
            await ws.send_json({
                "type": "history",
                "messages": messages,
                "readonly": False,
                "platform_id": pid,
                "conversation_id": conversation_id,
                "title": title,
            })
            await ws.send_json({
                "type": "conversation_switched",
                "conversation_id": conversation_id,
            })
        except Exception as exc:
            logger.warning(f"Failed to switch conversation: {exc}")
            await self._send_navigation_failed(ws, conversation_id)

    async def handle_new(self, ws: web.WebSocketResponse):
        """Create a new conversation and switch to it."""
        try:
            if not runtime.conversation_manager:
                logger.warning("Conversation manager not available yet")
                return

            platform_id = self._core.config.get("id", "abyss_web")
            cid = await runtime.conversation_manager.new_conversation(
                self._core.umo, platform_id,
            )
            await ws.send_json({
                "type": "conversation_created",
                "conversation_id": cid,
                "platform_id": platform_id,
            })
        except Exception as exc:
            logger.warning(f"Failed to create conversation: {exc}")

    # -- View history (read-only, no pointer switch) ---------------------------

    async def handle_view_history(self, ws: web.WebSocketResponse, conversation_id: str):
        """Load a conversation's history without switching the active pointer."""
        try:
            result = self._core.load_conversation_history(
                conversation_id, ("Abyss", "Abyss_Den"),
            )
            if result is None:
                await self._send_navigation_failed(ws, conversation_id)
                return

            messages, pid, title = result
            den_pid = self._core.config.get("id", "abyss_web")
            await ws.send_json({
                "type": "history",
                "messages": messages,
                "readonly": pid != den_pid,
                "platform_id": pid,
                "conversation_id": conversation_id,
                "title": title,
            })
        except Exception as exc:
            logger.warning(f"Failed to view history: {exc}")
            await self._send_navigation_failed(ws, conversation_id)

    # -- Pin / Unpin -----------------------------------------------------------

    async def handle_pin(self, ws: web.WebSocketResponse, conversation_id: str):
        try:
            async with self._core.pins_lock:
                pins = self._core.load_pins()
                if conversation_id not in pins:
                    pins.append(conversation_id)
                    self._core.save_pins(pins)
                favorites = await self.get_favorites()
                await ws.send_json({
                    "type": "pin_updated",
                    "conversation_id": conversation_id,
                    "pinned": True,
                    "favorites": favorites,
                })
        except Exception as exc:
            logger.warning(f"Failed to pin conversation: {exc}")
            try:
                await ws.send_json({
                    "type": "pin_update_failed",
                    "conversation_id": conversation_id,
                })
            except Exception:
                pass

    async def handle_unpin(self, ws: web.WebSocketResponse, conversation_id: str):
        try:
            async with self._core.pins_lock:
                pins = self._core.load_pins()
                if conversation_id in pins:
                    pins.remove(conversation_id)
                    self._core.save_pins(pins)
                favorites = await self.get_favorites()
                await ws.send_json({
                    "type": "pin_updated",
                    "conversation_id": conversation_id,
                    "pinned": False,
                    "favorites": favorites,
                })
        except Exception as exc:
            logger.warning(f"Failed to unpin conversation: {exc}")
            try:
                await ws.send_json({
                    "type": "pin_update_failed",
                    "conversation_id": conversation_id,
                })
            except Exception:
                pass

    # -- Rename / Delete -------------------------------------------------------

    async def handle_rename(
        self,
        ws: web.WebSocketResponse,
        conversation_id: str,
        title: str,
        platform_id: str,
    ) -> bool:
        """Rename a conversation's title."""
        try:
            if not runtime.conversation_manager:
                logger.warning("Conversation manager not available for rename")
                return False
            umo = self._core.resolve_umo(platform_id)
            await runtime.conversation_manager.update_conversation(
                umo, conversation_id, title=title,
            )
            await ws.send_json({
                "type": "conversation_renamed",
                "conversation_id": conversation_id,
                "title": title,
            })
            return True
        except Exception as exc:
            logger.warning(f"Failed to rename conversation: {exc}")
            return False

    # -- History image loading (tool-sent images) --------------------------------

    _MAX_IMAGE_SIZE = 10 * 1024 * 1024  # 10 MiB

    async def handle_load_history_image(
        self, ws: web.WebSocketResponse, data: dict,
    ) -> None:
        """Validate parameters and spawn a background task to load a
        tool-sent image from conversation history.

        The actual I/O runs outside ``_dispatch_lock`` so it cannot
        block conversation switching or new-client takeover.
        """
        request_id = data.get("request_id")
        cid = data.get("conversation_id")
        pid = data.get("platform_id")
        tool_call_id = data.get("tool_call_id")
        image_index = data.get("image_index")

        if (
            not request_id
            or not cid
            or not pid
            or not tool_call_id
            or not isinstance(image_index, int)
        ):
            return

        den_pid = self._core.config.get("id", "abyss_web")
        if pid not in (den_pid, "Abyss", "Abyss_Den"):
            return

        asyncio.create_task(
            self._load_history_image_task(
                ws, request_id, cid, pid, tool_call_id, image_index,
            )
        )

    async def _load_history_image_task(
        self,
        ws: web.WebSocketResponse,
        request_id: str,
        cid: str,
        pid: str,
        tool_call_id: str,
        image_index: int,
    ) -> None:
        """Background task: resolve a tool-sent image and return a
        ``history_image_result`` over WebSocket.

        All exceptions are caught internally so a failed image never
        produces ``Task exception was never retrieved``.
        """
        try:
            data_uri = self._resolve_tool_image(
                cid, pid, tool_call_id, image_index,
            )
            payload: dict = {
                "type": "history_image_result",
                "request_id": request_id,
                "conversation_id": cid,
                "platform_id": pid,
            }
            if data_uri:
                payload["status"] = "ok"
                payload["data"] = data_uri
            else:
                payload["status"] = "unavailable"
            await ws.send_json(payload)
        except Exception:
            # ws closed or any other failure — silently discard
            try:
                await ws.send_json({
                    "type": "history_image_result",
                    "request_id": request_id,
                    "conversation_id": cid,
                    "platform_id": pid,
                    "status": "unavailable",
                })
            except Exception:
                pass

    def _resolve_tool_image(
        self,
        cid: str,
        pid: str,
        tool_call_id: str,
        image_index: int,
    ) -> str | None:
        """Locate a tool-sent image in the authoritative conversation
        history and return a data URI, or ``None`` if unavailable.
        """
        loaded = self._core.load_conversation_history(cid, pid)
        if loaded is None:
            return None

        history, _, _ = loaded

        # -- Find the assistant tool_call with matching ID -----------
        target_tc = None
        tc_msg_index = None
        for i, msg in enumerate(history):
            if not isinstance(msg, dict) or msg.get("role") != "assistant":
                continue
            for tc in msg.get("tool_calls", []):
                if tc.get("id") != tool_call_id:
                    continue
                fn = tc.get("function", {})
                if fn.get("name") == "send_message_to_user":
                    target_tc = tc
                    tc_msg_index = i
                break
            if target_tc is not None:
                break

        if target_tc is None:
            return None

        # -- Verify successful tool result --------------------------
        result_ok = False
        for j in range(tc_msg_index + 1, len(history)):
            msg = history[j]
            if (
                isinstance(msg, dict)
                and msg.get("role") == "tool"
                and msg.get("tool_call_id") == tool_call_id
            ):
                content = msg.get("content", "")
                if isinstance(content, str) and content.startswith(
                    "Message sent to session"
                ):
                    result_ok = True
                break

        if not result_ok:
            return None

        # -- Parse arguments (JSON string or dict) ------------------
        raw_args = target_tc.get("function", {}).get("arguments", "")
        if isinstance(raw_args, str):
            try:
                args = json.loads(raw_args)
            except (json.JSONDecodeError, ValueError):
                return None
        elif isinstance(raw_args, dict):
            args = raw_args
        else:
            return None

        # -- Find image at the requested index ----------------------
        messages_list = args.get("messages", [])
        if not isinstance(messages_list, list):
            return None

        image_items = [
            m for m in messages_list
            if isinstance(m, dict) and m.get("type") == "image"
        ]

        if image_index < 0 or image_index >= len(image_items):
            return None

        item = image_items[image_index]
        path = item.get("path")
        url = item.get("url")

        # -- Local file path ----------------------------------------
        if path and isinstance(path, str):
            if not os.path.isfile(path):
                return None
            if os.path.getsize(path) > self._MAX_IMAGE_SIZE:
                return None
            mime = mimetypes.guess_type(path)[0] or "image/png"
            with open(path, "rb") as fh:
                encoded = base64.b64encode(fh.read()).decode("utf-8")
            return f"data:{mime};base64,{encoded}"

        # -- Remote URL (pass through directly) ---------------------
        if url and isinstance(url, str) and url.startswith("http"):
            return url

        return None

    async def handle_delete(self, ws: web.WebSocketResponse, conversation_id: str, platform_id: str):
        """Delete a conversation permanently."""
        try:
            if not runtime.conversation_manager:
                logger.warning("Conversation manager not available for delete")
                return
            umo = self._core.resolve_umo(platform_id)
            await runtime.conversation_manager.delete_conversation(
                umo, conversation_id,
            )
            # Remove from pins if pinned
            async with self._core.pins_lock:
                pins = self._core.load_pins()
                if conversation_id in pins:
                    pins.remove(conversation_id)
                    self._core.save_pins(pins)
            await ws.send_json({
                "type": "conversation_deleted",
                "conversation_id": conversation_id,
            })
        except Exception as exc:
            logger.warning(f"Failed to delete conversation: {exc}")
