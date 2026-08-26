"""A&F Web Frontend — WebSocket platform adapter for AstrBot.

Runs a lightweight WebSocket server so Felis Abyssalis can reach AstrBot
through a dedicated web UI, independent of QQ / NapCat.
"""

import asyncio
import json
import sqlite3
import uuid
from pathlib import Path

import aiohttp
from aiohttp import web

from astrbot.api.platform import (
    Platform,
    AstrBotMessage,
    MessageMember,
    PlatformMetadata,
    MessageType,
    register_platform_adapter,
)
from astrbot.api.event import MessageChain
from astrbot.api.message_components import Plain, Image
from astrbot import logger

from .auth_guard import AuthGuard
from .conversation_service import ConversationService
from .frontend_event import FrontendEvent
from .media_utils import chain_to_segments, save_temp_media
from . import runtime


# ---------------------------------------------------------------------------
# Platform adapter registration
# ---------------------------------------------------------------------------

@register_platform_adapter(
    "abyss_web",
    "A&F Web Frontend",
    default_config_tmpl={
        "port": 8766,
        "token": "change_me_to_a_secure_token",
    },
)
class FrontendAdapter(Platform):
    """WebSocket-based platform adapter."""

    def __init__(self, config: dict, platform_settings: dict, event_queue: asyncio.Queue) -> None:
        super().__init__(config, event_queue)
        # Currently active WebSocket connection (single-user)
        self._active_ws: web.WebSocketResponse | None = None
        self._static_dir = Path(__file__).parent / "static"
        # conversation_manager is accessed via runtime module (set by Main)

        # Auth rate limiter (transport-agnostic state)
        self.auth_guard = AuthGuard(fail_limit=5, window=600, lock_duration=600)

        # Conversation CRUD, search, pins, history
        self.conversations = ConversationService(config=self.config, umo=self._umo)

    # -- Required overrides --------------------------------------------------

    def meta(self) -> PlatformMetadata:
        return PlatformMetadata("abyss_web", "A&F Web Frontend", self.config.get("id", "abyss_web"))

    @property
    def _umo(self) -> str:
        """Unified message origin for the Den session."""
        pid = self.config.get("id", "abyss_web")
        return f"{pid}:FriendMessage:felis_abyssalis"

    @staticmethod
    @web.middleware
    async def _cache_control(request, handler):
        """Disable caching for all static assets (removes need for ?v= versioning)."""
        response = await handler(request)
        if request.path.startswith("/static/"):
            response.headers["Cache-Control"] = "no-cache, must-revalidate"
        return response

    async def run(self):
        """Start the WebSocket (+ static file) server."""
        app = web.Application(middlewares=[self._cache_control])
        app.router.add_get("/ws", self._ws_handler)

        # Serve the frontend when the static/ folder exists
        if self._static_dir.is_dir():
            app.router.add_get("/", self._index_handler)
            app.router.add_static("/static", self._static_dir, show_index=False)

        runner = web.AppRunner(app)
        await runner.setup()

        port = int(self.config.get("port", 8766))
        site = web.TCPSite(runner, "0.0.0.0", port)
        await site.start()
        logger.info(f"A&F Web Frontend listening on 0.0.0.0:{port}")

        try:
            while True:
                await asyncio.sleep(3600)
        except asyncio.CancelledError:
            await runner.cleanup()

    async def send_by_session(
        self, session, message_chain: MessageChain
    ):
        """Active push — used by context.send_message()."""
        ws = self._active_ws
        if ws is not None and not ws.closed:
            segments = await chain_to_segments(message_chain)
            await ws.send_json({"type": "message", "segments": segments})
        await super().send_by_session(session, message_chain)

    # -- Index handler -------------------------------------------------------

    async def _index_handler(self, _request: web.Request) -> web.Response:
        html_path = self._static_dir / "index.html"
        return web.Response(
            body=html_path.read_bytes(),
            content_type="text/html",
            headers={
                "Cache-Control": "no-cache, no-store, must-revalidate",
                "Pragma": "no-cache",
            },
        )

    # -- Auth helpers --------------------------------------------------------

    async def _send_rate_limited(self, ws: web.WebSocketResponse) -> None:
        """Send a rate_limited error via WebSocket (transport layer)."""
        await ws.send_json({
            "type": "error",
            "code": "rate_limited",
            "message": "Too many failed attempts. Try again later.",
            "retry_after": self.auth_guard.retry_after(),
        })

    # -- WebSocket handler ---------------------------------------------------

    async def _ws_handler(self, request: web.Request) -> web.WebSocketResponse:
        ws = web.WebSocketResponse(
            heartbeat=30.0,
            max_msg_size=16 * 1024 * 1024,  # 16 MiB — room for images
        )
        await ws.prepare(request)

        # -- First lock check (connection time) -------------------------
        if self.auth_guard.is_locked():
            await self._send_rate_limited(ws)
            await ws.close()
            return ws

        # -- Wait for first message (10s auth timeout) ------------------
        try:
            first_msg = await asyncio.wait_for(ws.receive(), timeout=10)
        except asyncio.TimeoutError:
            logger.info("Auth timeout: no message received within 10s")
            await ws.close()
            return ws

        if first_msg.type != aiohttp.WSMsgType.TEXT:
            await ws.close()
            return ws

        try:
            data = json.loads(first_msg.data)
        except json.JSONDecodeError:
            await ws.close()
            return ws

        if data.get("type") != "auth":
            await ws.close()
            return ws

        # -- Second lock check (auth message time) ----------------------
        # Prevents pre-established connections from bypassing lockout
        if self.auth_guard.is_locked():
            await self._send_rate_limited(ws)
            await ws.close()
            return ws

        # -- Token comparison (constant-time) ---------------------------
        if not self.auth_guard.compare_token(
            data.get("token", ""),
            self.config.get("token", ""),
        ):
            # Record failure synchronously — no await between check and record
            self.auth_guard.record_failure()
            if self.auth_guard.is_locked():
                await self._send_rate_limited(ws)
            else:
                await ws.send_json(
                    {"type": "error", "message": "Invalid token"}
                )
            await ws.close()
            return ws

        # -- Auth success -----------------------------------------------
        self.auth_guard.clear_failures()
        self._active_ws = ws
        await ws.send_json({"type": "auth_ok"})
        await self.conversations.send_history(ws)
        logger.info("Web frontend client authenticated.")

        # -- Authenticated message loop ---------------------------------
        # All handlers below are inherently authenticated — the loop
        # only runs after successful auth above.
        try:
            async for msg in ws:
                if msg.type == aiohttp.WSMsgType.TEXT:
                    try:
                        data = json.loads(msg.data)
                    except json.JSONDecodeError:
                        continue

                    kind = data.get("type")

                    # --- Incoming chat message --------------------------
                    if kind == "message":
                        await self._on_message(data, ws)

                    # --- Conversation management -----------------------
                    elif kind == "list_conversations":
                        page = data.get("page", 1)
                        limit = data.get("limit", 20)
                        await self.conversations.send_conversations_list(ws, page=page, limit=limit)

                    elif kind == "switch_conversation":
                        cid = data.get("conversation_id")
                        if cid:
                            await self.conversations.handle_switch(ws, cid)

                    elif kind == "new_conversation":
                        await self.conversations.handle_new(ws)

                    elif kind == "search_conversations":
                        await self.conversations.handle_search(ws, data)

                    elif kind == "view_history":
                        cid = data.get("conversation_id")
                        if cid:
                            await self.conversations.handle_view_history(ws, cid)

                    elif kind == "pin_conversation":
                        cid = data.get("conversation_id")
                        if cid:
                            await self.conversations.handle_pin(ws, cid)

                    elif kind == "unpin_conversation":
                        cid = data.get("conversation_id")
                        if cid:
                            await self.conversations.handle_unpin(ws, cid)

                    # --- Rename / Delete -------------------------------
                    elif kind == "rename_conversation":
                        cid = data.get("conversation_id")
                        title = data.get("title", "")
                        pid = data.get("platform_id", "")
                        if cid and title is not None:
                            await self.conversations.handle_rename(ws, cid, title.strip(), pid)

                    elif kind == "delete_conversation":
                        cid = data.get("conversation_id")
                        pid = data.get("platform_id", "")
                        if cid:
                            await self.conversations.handle_delete(ws, cid, pid)

                    # --- Edit / Retry ----------------------------------
                    elif kind == "retry":
                        await self._handle_retry_or_edit(
                            ws, data.get("content", ""), action="retry",
                        )

                    elif kind == "edit_message":
                        await self._handle_retry_or_edit(
                            ws, data.get("content", ""), action="edit",
                        )

                    # --- Heartbeat -------------------------------------
                    elif kind == "ping":
                        await ws.send_json({"type": "pong"})

                elif msg.type in (
                    aiohttp.WSMsgType.ERROR,
                    aiohttp.WSMsgType.CLOSE,
                ):
                    break
        finally:
            if self._active_ws is ws:
                self._active_ws = None
            logger.info("Web frontend client disconnected.")

        return ws

    # -- Retry / Edit --------------------------------------------------------

    async def _handle_retry_or_edit(self, ws: web.WebSocketResponse, content: str, *, action: str = "retry"):
        """Handle retry or edit: truncate last exchange, re-fire message."""
        if not content.strip():
            await ws.send_json({"type": "status", "status": "idle"})
            return

        success = await self._truncate_last_exchange(expected_content=content, action=action)
        if not success:
            logger.warning("Retry/edit failed: could not truncate history")
            await ws.send_json({"type": "status", "status": "idle"})
            return

        # Re-fire as a normal message through the standard pipeline
        await self._on_message(
            {"content": content, "id": str(uuid.uuid4())}, ws,
        )

    async def _truncate_last_exchange(self, expected_content: str = "", *, action: str = "retry") -> bool:
        """Remove the last user+assistant exchange from conversation history.

        Strips everything from the last user message onwards.  AstrBot's
        pipeline will re-add the user message when the re-fired event
        is processed.

        If *expected_content* is given, the method verifies that the last
        user message in the DB actually contains that text.  A mismatch
        means the frontend's "last message" is something that was never
        stored (e.g. an AstrBot command response) — in that case we skip
        truncation and return True so the caller still fires the message.
        """
        try:
            if not runtime.conversation_manager:
                logger.warning("Conversation manager not available for truncation")
                return False

            cid = await runtime.conversation_manager.get_curr_conversation_id(
                self._umo
            )
            if not cid:
                logger.warning("No active conversation to truncate")
                return False

            db_path = self.conversations.find_db()
            if not db_path:
                return False

            conn = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
            cursor = conn.execute(
                "SELECT content FROM conversations WHERE conversation_id = ?",
                (cid,),
            )
            row = cursor.fetchone()
            conn.close()

            if not row or not row[0]:
                return False

            history = json.loads(row[0])

            # Walk backwards to find the last user message
            last_user_idx = None
            for i in range(len(history) - 1, -1, -1):
                if history[i].get("role") == "user":
                    last_user_idx = i
                    break

            if last_user_idx is None:
                logger.warning("No user message found in history to truncate")
                return False

            # Verify that the DB's last user message matches the content
            # we are retrying / editing.  If it doesn't, the frontend's
            # "last message" was probably a command that AstrBot handled
            # without storing — skip truncation to avoid deleting a real
            # exchange.
            if expected_content.strip():
                db_content = history[last_user_idx].get("content", "")
                if isinstance(db_content, list):
                    db_content = "".join(
                        b.get("text", "")
                        for b in db_content
                        if isinstance(b, dict) and b.get("type") == "text"
                    )
                if expected_content.strip() not in str(db_content):
                    logger.info(
                        "Skipping truncation: retry/edit content not found "
                        "in last DB user message (likely a command response)"
                    )
                    return True

            # Truncate everything from the last user message onwards
            truncated = history[:last_user_idx]

            await runtime.conversation_manager.update_conversation(
                self._umo, cid, history=truncated,
            )

            logger.info(
                f"Truncated conversation {cid} ({action}): "
                f"{len(history)} -> {len(truncated)} messages"
            )
            return True

        except Exception as exc:
            logger.warning(f"Failed to truncate last exchange: {exc}")
            return False

    # -- Message handling ----------------------------------------------------

    async def _on_message(self, data: dict, ws: web.WebSocketResponse):
        """Convert an incoming frontend message and commit it to the queue."""

        # Acknowledge receipt immediately
        msg_id = data.get("id", str(uuid.uuid4()))
        await ws.send_json({"type": "message_ack", "id": msg_id})

        # Notify frontend that processing has started
        await ws.send_json({"type": "status", "status": "thinking"})

        # ---- Build message chain -------------------------------------------
        chain: list = []
        content = data.get("content", "").strip()
        if content:
            chain.append(Plain(text=content))

        temp_files: list[str] = []
        for img in data.get("images", []):
            path = save_temp_media(img, "image")
            if path:
                chain.append(Image.fromFileSystem(path))
                temp_files.append(path)
                if not content:
                    content = "[图片]"

        if not chain:
            return

        # ---- Build AstrBotMessage ------------------------------------------
        abm = AstrBotMessage()
        abm.type = MessageType.FRIEND_MESSAGE
        abm.group_id = ""
        abm.message_str = content
        abm.sender = MessageMember(
            user_id="felis_abyssalis", nickname="Felis Abyssalis"
        )
        abm.message = chain
        abm.raw_message = data
        abm.self_id = "abyss_web"
        abm.session_id = "felis_abyssalis"
        abm.message_id = msg_id

        # ---- Create event and commit ---------------------------------------
        event = FrontendEvent(
            message_str=abm.message_str,
            message_obj=abm,
            platform_meta=self.meta(),
            session_id=abm.session_id,
            adapter=self,
        )

        # Register temp files so AstrBot cleans them up
        for fp in temp_files:
            event.track_temporary_local_file(fp)

        self.commit_event(event)

