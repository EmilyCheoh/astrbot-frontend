"""A&F Web Frontend — WebSocket platform adapter for AstrBot.

Runs a lightweight WebSocket server so Felis Abyssalis can reach AstrBot
through a dedicated web UI, independent of QQ / NapCat.
"""

import asyncio
import base64
import json
import mimetypes
import os
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
from astrbot.api.message_components import Node, Plain, Image, Record
from astrbot import logger

from .frontend_event import FrontendEvent
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

    # -- Required overrides --------------------------------------------------

    def meta(self) -> PlatformMetadata:
        return PlatformMetadata("abyss_web", "A&F Web Frontend", self.config.get("id", "abyss_web"))

    @property
    def _umo(self) -> str:
        """Unified message origin for the Den session."""
        pid = self.config.get("id", "abyss_web")
        return f"{pid}:FriendMessage:felis_abyssalis"

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
        self, session, message_chain: MessageChain
    ):
        """Active push — used by context.send_message()."""
        ws = self._active_ws
        if ws is not None and not ws.closed:
            segments = await self._chain_to_segments(message_chain)
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
                            await self._send_history(ws)
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

                    # --- Conversation management ---------------------------
                    elif kind == "list_conversations" and authenticated:
                        await self._send_conversations_list(ws)

                    elif kind == "switch_conversation" and authenticated:
                        cid = data.get("conversation_id")
                        if cid:
                            await self._handle_switch(ws, cid)

                    elif kind == "new_conversation" and authenticated:
                        await self._handle_new(ws)

                    # --- Edit / Retry --------------------------------------
                    elif kind == "retry" and authenticated:
                        await self._handle_retry_or_edit(
                            ws, data.get("content", ""), action="retry",
                        )

                    elif kind == "edit_message" and authenticated:
                        await self._handle_retry_or_edit(
                            ws, data.get("content", ""), action="edit",
                        )

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

    # -- History loading -------------------------------------------------------

    def _find_db(self) -> str | None:
        """Locate AstrBot's SQLite database (path differs host vs container)."""
        candidates = [
            Path.cwd() / "data" / "data_v4.db",
            Path("/AstrBot/data/data_v4.db"),
            Path("/opt/astrbot/data/data_v4.db"),
            Path("/app/data/data_v4.db"),
        ]
        for p in candidates:
            if p.is_file():
                return str(p)
        return None

    async def _send_history(self, ws: web.WebSocketResponse, conversation_id: str | None = None):
        """Load conversation history from the DB and send to client.

        If *conversation_id* is given, load that specific conversation.
        Otherwise fall back to the most recently updated one.
        """
        try:
            db_path = self._find_db()
            if not db_path:
                logger.warning("Chat history DB not found, tried common paths")
                return

            platform_id = self.config.get("id", "abyss_web")
            conn = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)

            if conversation_id:
                cursor = conn.execute(
                    "SELECT content FROM conversations "
                    "WHERE conversation_id = ? AND platform_id = ?",
                    (conversation_id, platform_id),
                )
            else:
                cursor = conn.execute(
                    "SELECT content FROM conversations "
                    "WHERE platform_id = ? ORDER BY updated_at DESC LIMIT 1",
                    (platform_id,),
                )

            row = cursor.fetchone()
            conn.close()

            if row and row[0]:
                messages = json.loads(row[0])
                await ws.send_json({
                    "type": "history",
                    "messages": messages,
                })
            else:
                # No history — send empty so frontend knows to clear
                await ws.send_json({"type": "history", "messages": []})
        except Exception as exc:
            logger.warning(f"Failed to load chat history: {exc}")

    # -- Conversation management -----------------------------------------------

    async def _send_conversations_list(self, ws: web.WebSocketResponse):
        """Send a list of all Den conversations to the frontend."""
        try:
            db_path = self._find_db()
            if not db_path:
                return

            platform_id = self.config.get("id", "abyss_web")
            conn = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)

            cursor = conn.execute(
                "SELECT conversation_id, title, updated_at, content "
                "FROM conversations WHERE platform_id = ? "
                "ORDER BY updated_at DESC",
                (platform_id,),
            )
            rows = cursor.fetchall()
            conn.close()

            # Determine which conversation is currently active
            active_cid = None
            if runtime.conversation_manager:
                active_cid = await runtime.conversation_manager.get_curr_conversation_id(
                    self._umo
                )

            conversations = []
            for cid, title, updated_at, content in rows:
                # Build a preview from the first user message if no title
                preview = title or ""
                if not preview and content:
                    try:
                        msgs = json.loads(content)
                        for m in msgs:
                            if m.get("role") == "user":
                                c = m.get("content", "")
                                if isinstance(c, list):
                                    # Extract text from content blocks
                                    c = "".join(
                                        b.get("text", "") for b in c
                                        if isinstance(b, dict) and b.get("type") == "text"
                                    )
                                preview = c[:40].strip()
                                break
                    except (json.JSONDecodeError, TypeError):
                        pass

                conversations.append({
                    "id": cid,
                    "preview": preview or "(empty)",
                    "updated_at": updated_at,
                    "active": cid == active_cid,
                })

            await ws.send_json({
                "type": "conversations_list",
                "conversations": conversations,
            })
        except Exception as exc:
            logger.warning(f"Failed to list conversations: {exc}")

    async def _handle_switch(self, ws: web.WebSocketResponse, conversation_id: str):
        """Switch the active conversation pointer and send its history."""
        try:
            if not runtime.conversation_manager:
                logger.warning("Conversation manager not available yet")
                return

            await runtime.conversation_manager.switch_conversation(
                self._umo, conversation_id,
            )
            await ws.send_json({
                "type": "conversation_switched",
                "conversation_id": conversation_id,
            })
            await self._send_history(ws, conversation_id)
        except Exception as exc:
            logger.warning(f"Failed to switch conversation: {exc}")

    async def _handle_new(self, ws: web.WebSocketResponse):
        """Create a new conversation and switch to it."""
        try:
            if not runtime.conversation_manager:
                logger.warning("Conversation manager not available yet")
                return

            platform_id = self.config.get("id", "abyss_web")
            cid = await runtime.conversation_manager.new_conversation(
                self._umo, platform_id,
            )
            await ws.send_json({
                "type": "conversation_created",
                "conversation_id": cid,
            })
        except Exception as exc:
            logger.warning(f"Failed to create conversation: {exc}")

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

            db_path = self._find_db()
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
            elif isinstance(comp, Node):
                # CoT / forwarded-message nodes — extract text for reasoning display
                texts = []
                for sub in comp.content:
                    if isinstance(sub, Plain) and sub.text and sub.text.strip():
                        texts.append(sub.text.strip())
                if texts:
                    segments.append({"type": "reasoning", "data": "\n".join(texts)})
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
