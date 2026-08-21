"""A&F Web Frontend — WebSocket platform adapter for AstrBot.

Runs a lightweight WebSocket server so Felis Abyssalis can reach AstrBot
through a dedicated web UI, independent of QQ / NapCat.
"""

import asyncio
import base64
import json
import mimetypes
import os
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
from astrbot.api.message_components import Plain, Image, Record
from astrbot.core.platform.astr_message_event import MessageSesion
from astrbot import logger

from .frontend_event import FrontendEvent


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

    def __init__(
        self,
        platform_config: dict,
        platform_settings: dict,
        event_queue: asyncio.Queue,
    ) -> None:
        super().__init__(event_queue)
        self.config = platform_config
        self.settings = platform_settings
        # Currently active WebSocket connection (single-user)
        self._active_ws: web.WebSocketResponse | None = None
        self._static_dir = Path(__file__).parent / "static"

    # -- Required overrides --------------------------------------------------

    def meta(self) -> PlatformMetadata:
        return PlatformMetadata("abyss_web", "A&F Web Frontend")

    async def run(self):
        """Start the WebSocket (+ static file) server."""
        app = web.Application()
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
        self, session: MessageSesion, message_chain: MessageChain
    ):
        """Active push — used by context.send_message()."""
        ws = self._active_ws
        if ws is not None and not ws.closed:
            segments = await self._chain_to_segments(message_chain)
            await ws.send_json({"type": "message", "segments": segments})
        await super().send_by_session(session, message_chain)

    # -- Index handler -------------------------------------------------------

    async def _index_handler(self, _request: web.Request) -> web.FileResponse:
        return web.FileResponse(self._static_dir / "index.html")

    # -- WebSocket handler ---------------------------------------------------

    async def _ws_handler(self, request: web.Request) -> web.WebSocketResponse:
        ws = web.WebSocketResponse(
            heartbeat=30.0,
            max_msg_size=16 * 1024 * 1024,  # 16 MiB — room for images
        )
        await ws.prepare(request)

        authenticated = False

        try:
            async for msg in ws:
                if msg.type == aiohttp.WSMsgType.TEXT:
                    try:
                        data = json.loads(msg.data)
                    except json.JSONDecodeError:
                        continue

                    kind = data.get("type")

                    # --- Authentication handshake ---------------------------
                    if kind == "auth":
                        if data.get("token") == self.config.get("token"):
                            authenticated = True
                            self._active_ws = ws
                            await ws.send_json({"type": "auth_ok"})
                            logger.info("Web frontend client authenticated.")
                        else:
                            await ws.send_json(
                                {"type": "error", "message": "Invalid token"}
                            )
                            await ws.close()
                            break

                    # --- Incoming chat message ------------------------------
                    elif kind == "message" and authenticated:
                        await self._on_message(data, ws)

                    # --- Heartbeat -----------------------------------------
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
            path = self._save_temp_media(img, "image")
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

    # -- Serialisation helpers -----------------------------------------------

    async def _chain_to_segments(self, message_chain: MessageChain) -> list[dict]:
        """Convert a MessageChain into JSON-serialisable segments."""
        segments: list[dict] = []
        for comp in message_chain.chain:
            if isinstance(comp, Plain):
                text = comp.text
                if text and text.strip():
                    segments.append({"type": "text", "data": text})
            elif isinstance(comp, Image):
                uri = await self._media_to_data_uri(comp)
                if uri:
                    segments.append({"type": "image", "data": uri})
            elif isinstance(comp, Record):
                uri = await self._media_to_data_uri(comp)
                if uri:
                    segments.append({"type": "audio", "data": uri})
        return segments

    async def _media_to_data_uri(self, component) -> str | None:
        """Best-effort conversion of a media component to a data-URI."""
        try:
            file_path = await component.convert_to_file_path()
            if file_path and os.path.exists(file_path):
                mime = mimetypes.guess_type(file_path)[0] or "application/octet-stream"
                with open(file_path, "rb") as fh:
                    encoded = base64.b64encode(fh.read()).decode("utf-8")
                return f"data:{mime};base64,{encoded}"
        except Exception as exc:
            logger.warning(f"Media conversion failed: {exc}")

        # Fallback — pass through any HTTP URL
        url = getattr(component, "url", None) or getattr(component, "file", None)
        if isinstance(url, str) and url.startswith("http"):
            return url
        return None

    # -- Temp-file helpers ---------------------------------------------------

    @staticmethod
    def _save_temp_media(data_uri: str, media_type: str) -> str | None:
        """Decode a data-URI / raw base64 string and write it to a temp file."""
        try:
            if data_uri.startswith("data:"):
                header, encoded = data_uri.split(",", 1)
                mime = header.split(":")[1].split(";")[0]
                ext = mimetypes.guess_extension(mime) or ".bin"
            else:
                encoded = data_uri
                ext = ".png" if media_type == "image" else ".wav"

            raw = base64.b64decode(encoded)
            tmp_dir = Path("/tmp/abyss_frontend")
            tmp_dir.mkdir(parents=True, exist_ok=True)
            tmp_path = tmp_dir / f"{uuid.uuid4()}{ext}"
            tmp_path.write_bytes(raw)
            return str(tmp_path)
        except Exception as exc:
            logger.warning(f"Failed to save temp media: {exc}")
            return None
