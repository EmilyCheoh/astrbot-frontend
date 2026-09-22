"""Conversation facade for the A&F Web Frontend.

Unified entry point consumed by ``FrontendAdapter`` and ``MessageService``.
Delegates branch logic to ``ConversationBranchService`` and search logic
to ``ConversationSearchService``, while keeping history, navigation, list,
favorites, and CRUD operations here.
"""

import json
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

            if conversation_id:
                result = self._core.load_conversation_history(
                    conversation_id, platform_id,
                )
                if result is not None:
                    messages, _ = result
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
                        "SELECT content, conversation_id FROM conversations "
                        "WHERE platform_id = ? ORDER BY updated_at DESC LIMIT 1",
                        (platform_id,),
                    )
                    row = cursor.fetchone()
                finally:
                    conn.close()
                if row and row[0]:
                    messages = json.loads(row[0])
                    cid = row[1]
                else:
                    messages = []
                    cid = row[1] if row else None

            await ws.send_json({
                "type": "history",
                "messages": messages,
                "readonly": False,
                "platform_id": platform_id,
                "conversation_id": cid,
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

            messages, pid = result

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

            messages, pid = result
            den_pid = self._core.config.get("id", "abyss_web")
            await ws.send_json({
                "type": "history",
                "messages": messages,
                "readonly": pid != den_pid,
                "platform_id": pid,
                "conversation_id": conversation_id,
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

    async def handle_rename(self, ws: web.WebSocketResponse, conversation_id: str, title: str, platform_id: str):
        """Rename a conversation's title."""
        try:
            if not runtime.conversation_manager:
                logger.warning("Conversation manager not available for rename")
                return
            umo = self._core.resolve_umo(platform_id)
            await runtime.conversation_manager.update_conversation(
                umo, conversation_id, title=title,
            )
            await ws.send_json({
                "type": "conversation_renamed",
                "conversation_id": conversation_id,
                "title": title,
            })
        except Exception as exc:
            logger.warning(f"Failed to rename conversation: {exc}")

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
