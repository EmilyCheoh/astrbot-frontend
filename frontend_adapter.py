"""A&F Web Frontend — WebSocket platform adapter for AstrBot.

Runs a lightweight WebSocket server so Felis Abyssalis can reach AstrBot
through a dedicated web UI, independent of QQ / NapCat.
"""

import asyncio
import json
from pathlib import Path

import aiohttp
from aiohttp import web

from astrbot.api.platform import (
    Platform,
    PlatformMetadata,
    register_platform_adapter,
)
from astrbot.api.event import MessageChain
from astrbot import logger

from .auth_guard import AuthGuard
from .conversation_service import ConversationService
from .media_utils import chain_to_segments
from .message_service import MessageService


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

        # Message intake, retry/edit
        self.messages = MessageService(
            adapter=self, conversations=self.conversations, umo=self._umo,
        )

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
        await self.conversations.send_favorites(ws)
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
                        await self.messages.on_message(data, ws)

                    # --- Conversation management -----------------------
                    elif kind == "list_conversations":
                        cur = data.get("cursor")
                        limit = data.get("limit", 20)
                        await self.conversations.send_conversations_list(ws, cursor=cur, limit=limit)

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
                        await self.messages.handle_retry_or_edit(
                            ws, data.get("content", ""), action="retry",
                        )

                    elif kind == "edit_message":
                        await self.messages.handle_retry_or_edit(
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


