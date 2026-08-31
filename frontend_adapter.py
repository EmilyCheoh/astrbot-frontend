"""A&F Web Frontend — WebSocket platform adapter for AstrBot.

Runs a lightweight WebSocket server so Felis Abyssalis can reach AstrBot
through a dedicated web UI, independent of QQ / NapCat.

Single-client exclusive access: at most one authenticated browser tab or
device holds the Den at any time.  New logins replace the old client after
in-flight turns finish and history is saved.
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


# -- Message kinds that start a new pipeline turn ----------------------------
_TURN_KINDS = frozenset({"message", "retry", "edit_message"})

# -- Message kinds frozen while a turn is active -----------------------------
_FROZEN_KINDS = frozenset({
    "switch_conversation",
    "new_conversation",
    "branch_conversation",
    "view_history",
    "delete_conversation",
    "edit_assistant_message",
    "prepare_user_message_patch",
    "save_user_message_patch",
})


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
        self._static_dir = Path(__file__).parent / "static"

        # Auth rate limiter (transport-agnostic state)
        self.auth_guard = AuthGuard(fail_limit=5, window=600, lock_duration=600)

        # Conversation CRUD, search, pins, history
        self.conversations = ConversationService(config=self.config, umo=self._umo)

        # Message intake, retry/edit
        self.messages = MessageService(
            adapter=self, conversations=self.conversations, umo=self._umo,
        )

        # -- Single-client ownership state ----------------------------------
        self._active_ws: web.WebSocketResponse | None = None

        # Serialises multiple concurrent legitimate logins
        self._takeover_lock = asyncio.Lock()
        # Mutual exclusion between takeover steps and per-frame dispatch
        self._dispatch_lock = asyncio.Lock()
        # True while a new client waits for the old turn to finish
        self._handoff_pending: bool = False

        # -- Turn lease state -----------------------------------------------
        # Token is a unique `object()` — identity comparison prevents stale
        # cleanup from releasing a newer turn.
        self._turn_token: object | None = None
        self._turn_owner_ws: web.WebSocketResponse | None = None
        self._turn_finished: asyncio.Event = asyncio.Event()
        self._turn_finished.set()  # no turn in progress initially

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
        """Active push — used by context.send_message().

        Always routes to the current ``_active_ws``, NOT to any specific
        source socket.  This preserves existing push behaviour.
        """
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

    # -- Turn lease ----------------------------------------------------------

    def _acquire_turn(self, ws: web.WebSocketResponse) -> object | None:
        """Try to acquire the pipeline turn.

        MUST be called under ``_dispatch_lock``.
        Returns a unique token on success, ``None`` if a turn is active.
        """
        if self._turn_token is not None:
            return None
        token = object()
        self._turn_token = token
        self._turn_owner_ws = ws
        self._turn_finished.clear()
        return token

    def finish_turn(self, token: object) -> None:
        """Release the pipeline turn.

        Only succeeds if *token* identity matches the active turn token.
        Safe to call from any coroutine — synchronous, no locks needed.
        """
        if token is not self._turn_token:
            return
        self._turn_token = None
        self._turn_owner_ws = None
        self._turn_finished.set()

    # -- Takeover sequence ---------------------------------------------------

    async def _handle_takeover(self, new_ws: web.WebSocketResponse) -> bool:
        """Execute the single-client handoff sequence.

        Returns ``True`` if *new_ws* is now the active client.
        Returns ``False`` if the handoff was cancelled (candidate died).

        Turn wait is unconditional — a disconnected old socket does NOT
        cancel the in-flight AstrBot pipeline, so the new client must
        still wait for ``_turn_finished`` before it can safely operate.
        """
        async with self._takeover_lock:
            old_ws = self._active_ws

            # Step 1: set handoff pending (briefly hold dispatch lock)
            async with self._dispatch_lock:
                self._handoff_pending = True

            # Step 2: wait for any active turn (NO lock held).
            # Must happen regardless of old_ws state — a disconnected
            # socket does not cancel the in-flight AstrBot pipeline.
            if not self._turn_finished.is_set():
                try:
                    await new_ws.send_json({"type": "takeover_waiting"})
                except Exception:
                    # Candidate died before we could notify
                    async with self._dispatch_lock:
                        self._handoff_pending = False
                    return False

                await self._turn_finished.wait()

            # Step 3: reacquire dispatch lock for final handoff
            async with self._dispatch_lock:
                # Verify candidate is still alive
                if new_ws.closed:
                    self._handoff_pending = False
                    return False

                # Notify and close old connection if still alive
                if old_ws is not None and not old_ws.closed and old_ws is not new_ws:
                    try:
                        await old_ws.send_json({"type": "session_replaced"})
                    except Exception:
                        pass
                    try:
                        await old_ws.close(code=4001, message=b"session_replaced")
                    except Exception:
                        pass

                # Install new client
                self._active_ws = new_ws
                self._handoff_pending = False

            return True

    # -- Non-turn dispatch ---------------------------------------------------

    async def _dispatch_non_turn(
        self, ws: web.WebSocketResponse, kind: str, data: dict,
    ) -> None:
        """Dispatch a non-turn message.  MUST be called under ``_dispatch_lock``."""
        if kind == "list_conversations":
            cur = data.get("cursor")
            limit = data.get("limit", 20)
            gen = data.get("generation")
            await self.conversations.send_conversations_list(
                ws, cursor=cur, limit=limit, generation=gen,
            )

        elif kind == "switch_conversation":
            cid = data.get("conversation_id")
            if cid:
                await self.conversations.handle_switch(ws, cid)

        elif kind == "new_conversation":
            await self.conversations.handle_new(ws)

        elif kind == "branch_conversation":
            await self.conversations.handle_branch(ws, data)

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

        elif kind == "edit_assistant_message":
            cid = data.get("conversation_id")
            content = data.get("content", "").strip()
            original = data.get("original_content", "")
            if cid and content:
                await self.messages.handle_edit_assistant_message(
                    ws, cid, content, original,
                )

        elif kind == "prepare_user_message_patch":
            cid = data.get("conversation_id")
            display_content = data.get("display_content", "")
            if cid and display_content:
                await self.messages.handle_prepare_user_message_patch(
                    ws, cid, display_content,
                )

        elif kind == "save_user_message_patch":
            await self.messages.handle_save_user_message_patch(ws, data)

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
        if self.auth_guard.is_locked():
            await self._send_rate_limited(ws)
            await ws.close()
            return ws

        # -- Token comparison (constant-time) ---------------------------
        if not self.auth_guard.compare_token(
            data.get("token", ""),
            self.config.get("token", ""),
        ):
            self.auth_guard.record_failure()
            if self.auth_guard.is_locked():
                await self._send_rate_limited(ws)
            else:
                await ws.send_json({
                    "type": "error",
                    "code": "invalid_token",
                    "message": "Invalid token",
                })
            await ws.close()
            return ws

        # -- Auth success -----------------------------------------------
        self.auth_guard.clear_failures()

        accepted = False
        try:
            # Execute single-client handoff
            accepted = await self._handle_takeover(ws)
            if not accepted:
                # Candidate ws died during handoff wait
                return ws

            # Strict CID alignment — infrastructure failures abort the
            # session so the client never operates against a stale pointer.
            try:
                cid = await self.conversations.align_cid()
            except Exception as exc:
                logger.warning(f"CID alignment failed during auth: {exc}")
                try:
                    await ws.send_json({
                        "type": "error",
                        "code": "initialization_failed",
                        "message": "Failed to initialize the Den conversation.",
                    })
                except Exception:
                    pass
                return ws

            await ws.send_json({"type": "auth_ok"})
            await self.conversations.send_history(ws, conversation_id=cid)
            await self.conversations.send_favorites(ws)
            logger.info("Web frontend client authenticated.")

            # -- Authenticated message loop -----------------------------
            async for msg in ws:
                if msg.type == aiohttp.WSMsgType.TEXT:
                    try:
                        data = json.loads(msg.data)
                    except json.JSONDecodeError:
                        continue

                    kind = data.get("type")

                    # --- Heartbeat (always allowed) --------------------
                    if kind == "ping":
                        try:
                            await ws.send_json({"type": "pong"})
                        except Exception:
                            pass
                        continue

                    # --- Turn-starting operations ----------------------
                    # Acquire token under lock, then execute pipeline
                    # outside so takeover can enter draining state.
                    if kind in _TURN_KINDS:
                        turn_token = None
                        async with self._dispatch_lock:
                            if ws is not self._active_ws:
                                continue
                            if self._handoff_pending:
                                continue
                            turn_token = self._acquire_turn(ws)
                            if turn_token is None:
                                continue

                        committed = False
                        try:
                            if kind == "message":
                                committed = await self.messages.on_message(
                                    data, ws, turn_token,
                                )
                            else:
                                committed = await self.messages.handle_retry_or_edit(
                                    ws, data.get("content", ""),
                                    action="retry" if kind == "retry" else "edit",
                                    turn_token=turn_token,
                                )
                        except Exception as exc:
                            logger.warning(f"Turn processing error ({kind}): {exc}")
                        finally:
                            if not committed:
                                self.finish_turn(turn_token)
                                try:
                                    if not ws.closed:
                                        await ws.send_json({"type": "status", "status": "idle"})
                                except Exception:
                                    pass
                        continue

                    # --- Non-turn operations (entirely under lock) -----
                    # Handler executes inside _dispatch_lock so takeover
                    # cannot slip between the ownership check and the
                    # actual CID-mutating operation.
                    async with self._dispatch_lock:
                        if ws is not self._active_ws:
                            continue
                        if self._handoff_pending:
                            continue
                        if kind in _FROZEN_KINDS and self._turn_token is not None:
                            try:
                                await ws.send_json({
                                    "type": "error",
                                    "code": "busy",
                                    "message": "Please wait for the current reply to finish.",
                                })
                            except Exception:
                                pass
                            continue

                        await self._dispatch_non_turn(ws, kind, data)

                elif msg.type in (
                    aiohttp.WSMsgType.ERROR,
                    aiohttp.WSMsgType.CLOSE,
                ):
                    break
        finally:
            if accepted and self._active_ws is ws:
                self._active_ws = None
            logger.info("Web frontend client disconnected.")

        return ws
