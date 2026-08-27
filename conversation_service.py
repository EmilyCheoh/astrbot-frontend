"""Conversation CRUD, search, history, and pin management for the A&F Web Frontend.

All conversation-related operations extracted from FrontendAdapter.
Uses runtime.conversation_manager dynamically at call time (never cached).
"""

import asyncio
import json
import os
import sqlite3
import tempfile
from pathlib import Path

from aiohttp import web

from astrbot import logger

from . import runtime


class ConversationService:
    """Manages conversations, history, pins, and search."""

    def __init__(self, config: dict, umo: str) -> None:
        self._config = config
        self._umo = umo
        self._pins_lock = asyncio.Lock()

    # -- DB location -----------------------------------------------------------

    def find_db(self) -> str | None:
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

    # -- Pin storage -----------------------------------------------------------

    def _pins_path(self) -> Path:
        """Path to the server-side pin storage file."""
        db_path = self.find_db()
        data_dir = Path(db_path).parent if db_path else Path("/opt/astrbot/data")
        return data_dir / "den_pins.json"

    def load_pins(self) -> list[str]:
        path = self._pins_path()
        if path.exists():
            try:
                return json.loads(path.read_text())
            except (json.JSONDecodeError, OSError):
                pass
        return []

    def save_pins(self, pins: list[str]):
        """Atomic pin file write: temp file in same dir + os.replace."""
        path = self._pins_path()
        fd = None
        tmp = None
        try:
            fd, tmp = tempfile.mkstemp(dir=str(path.parent), suffix=".tmp")
            os.write(fd, json.dumps(pins).encode())
            os.close(fd)
            fd = None
            os.replace(tmp, str(path))
            tmp = None
        finally:
            if fd is not None:
                try:
                    os.close(fd)
                except OSError:
                    pass
            if tmp is not None:
                try:
                    os.unlink(tmp)
                except OSError:
                    pass

    # -- Serialization ---------------------------------------------------------

    @staticmethod
    def _extract_preview(title: str | None, content: str | None) -> str:
        """Extract preview text from title or first user message in content."""
        if title:
            return title
        if content:
            try:
                msgs = json.loads(content)
                for m in msgs:
                    if m.get("role") == "user":
                        c = m.get("content", "")
                        if isinstance(c, list):
                            c = "".join(
                                b.get("text", "") for b in c
                                if isinstance(b, dict) and b.get("type") == "text"
                            )
                        preview = c[:40].strip()
                        if preview:
                            return preview
            except (json.JSONDecodeError, TypeError):
                pass
        return "(empty)"

    def _serialize_conversation(
        self,
        row: tuple,
        pinned_ids: list[str],
        active_cid: str | None,
    ) -> dict:
        """Serialize a DB row into a conversation summary dict.

        Expected row: (conversation_id, title, updated_at, platform_id, content)
        """
        cid, title, updated_at, platform_id, content = row
        return {
            "id": cid,
            "preview": self._extract_preview(title, content),
            "updated_at": updated_at,
            "platform_id": platform_id,
            "active": cid == active_cid,
            "pinned": cid in pinned_ids,
        }

    # -- Helpers ---------------------------------------------------------------

    @staticmethod
    def to_unicode_escaped(text: str) -> str:
        """Convert non-ASCII chars to \\uXXXX escapes for DB content search."""
        result = []
        for char in text:
            code = ord(char)
            if code > 127:
                if code > 0xFFFF:
                    hi = ((code - 0x10000) >> 10) + 0xD800
                    lo = ((code - 0x10000) & 0x3FF) + 0xDC00
                    result.append(f"\\u{hi:04x}\\u{lo:04x}")
                else:
                    result.append(f"\\u{code:04x}")
            else:
                result.append(char)
        return "".join(result)

    def resolve_umo(self, platform_id: str) -> str:
        """Resolve the UMO for a given platform_id."""
        if platform_id == "Abyss":
            return "Abyss:FriendMessage:396070723"
        return self._umo

    async def _get_active_cid(self) -> str | None:
        """Get the current active conversation ID."""
        if runtime.conversation_manager:
            return await runtime.conversation_manager.get_curr_conversation_id(
                self._umo
            )
        return None

    # -- History loading -------------------------------------------------------

    async def send_history(self, ws: web.WebSocketResponse, conversation_id: str | None = None):
        """Load conversation history from the DB and send to client.

        If *conversation_id* is given, load that specific conversation.
        Otherwise fall back to the most recently updated one.
        """
        try:
            db_path = self.find_db()
            if not db_path:
                logger.warning("Chat history DB not found, tried common paths")
                return

            platform_id = self._config.get("id", "abyss_web")
            conn = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)

            if conversation_id:
                cursor = conn.execute(
                    "SELECT content, conversation_id FROM conversations "
                    "WHERE conversation_id = ? AND platform_id = ?",
                    (conversation_id, platform_id),
                )
            else:
                cursor = conn.execute(
                    "SELECT content, conversation_id FROM conversations "
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
                    "readonly": False,
                    "platform_id": platform_id,
                    "conversation_id": row[1],
                })
            else:
                await ws.send_json({
                    "type": "history",
                    "messages": [],
                    "readonly": False,
                    "platform_id": platform_id,
                    "conversation_id": conversation_id,
                })
        except Exception as exc:
            logger.warning(f"Failed to load chat history: {exc}")

    # -- Favorites -------------------------------------------------------------

    async def get_favorites(self) -> list[dict]:
        """Query all favorited conversations with full summary objects."""
        pinned_ids = self.load_pins()
        if not pinned_ids:
            return []

        db_path = self.find_db()
        if not db_path:
            return []

        active_cid = await self._get_active_cid()

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
            self._serialize_conversation(row, pinned_ids, active_cid)
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
    ):
        """Send a cursor-paginated list of conversations."""
        try:
            limit = max(1, min(limit, 50))

            db_path = self.find_db()
            if not db_path:
                return

            conn = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
            active_cid = await self._get_active_cid()
            pinned_ids = self.load_pins()

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
                self._serialize_conversation(row, pinned_ids, active_cid)
                for row in rows
            ]

            next_cursor = None
            if has_more and rows:
                last = rows[-1]
                next_cursor = f"{last[2]}|{last[0]}"

            await ws.send_json({
                "type": "conversations_list",
                "conversations": conversations,
                "next_cursor": next_cursor,
                "has_more": has_more,
            })
        except Exception as exc:
            logger.warning(f"Failed to list conversations: {exc}")

    # -- Switch / New ----------------------------------------------------------

    async def handle_switch(self, ws: web.WebSocketResponse, conversation_id: str):
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
            await self.send_history(ws, conversation_id)
        except Exception as exc:
            logger.warning(f"Failed to switch conversation: {exc}")

    async def handle_new(self, ws: web.WebSocketResponse):
        """Create a new conversation and switch to it."""
        try:
            if not runtime.conversation_manager:
                logger.warning("Conversation manager not available yet")
                return

            platform_id = self._config.get("id", "abyss_web")
            cid = await runtime.conversation_manager.new_conversation(
                self._umo, platform_id,
            )
            await ws.send_json({
                "type": "conversation_created",
                "conversation_id": cid,
            })
        except Exception as exc:
            logger.warning(f"Failed to create conversation: {exc}")

    # -- Search ----------------------------------------------------------------

    async def handle_search(self, ws: web.WebSocketResponse, data: dict):
        """Search conversations by title, content, or date range."""
        mode = data.get("mode", "title")
        query = data.get("q", "").strip()

        try:
            db_path = self.find_db()
            if not db_path:
                return

            conn = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
            pinned_ids = self.load_pins()
            active_cid = await self._get_active_cid()

            results: list[dict] = []

            if mode == "title":
                if not query:
                    conn.close()
                    await ws.send_json({"type": "search_results", "results": [], "mode": mode})
                    return
                db_cursor = conn.execute(
                    "SELECT conversation_id, title, updated_at, platform_id, content "
                    "FROM conversations "
                    "WHERE platform_id IN ('Abyss', 'Abyss_Den') AND title LIKE ? "
                    "ORDER BY updated_at DESC LIMIT 30",
                    (f"%{query}%",),
                )
                for row in db_cursor.fetchall():
                    results.append(
                        self._serialize_conversation(row, pinned_ids, active_cid)
                    )

            elif mode == "content":
                if not query:
                    conn.close()
                    await ws.send_json({"type": "search_results", "results": [], "mode": mode})
                    return
                escaped = self.to_unicode_escaped(query)
                db_cursor = conn.execute(
                    "SELECT conversation_id, title, updated_at, platform_id, content "
                    "FROM conversations "
                    "WHERE platform_id IN ('Abyss', 'Abyss_Den') "
                    "AND (content LIKE ? OR content LIKE ?) "
                    "ORDER BY updated_at DESC LIMIT 30",
                    (f"%{query}%", f"%{escaped}%"),
                )
                for row in db_cursor.fetchall():
                    conv = self._serialize_conversation(row, pinned_ids, active_cid)
                    # Extract snippet from content
                    content = row[4]
                    snippet = ""
                    if content:
                        try:
                            msgs = json.loads(content)
                            for m in msgs:
                                text = ""
                                mc = m.get("content", "")
                                if isinstance(mc, str):
                                    text = mc
                                elif isinstance(mc, list):
                                    text = " ".join(
                                        b.get("text", "") or b.get("content", "")
                                        for b in mc if isinstance(b, dict)
                                    )
                                idx = text.lower().find(query.lower())
                                if idx != -1:
                                    start = max(0, idx - 40)
                                    end = min(len(text), idx + len(query) + 40)
                                    snippet = (
                                        ("..." if start > 0 else "")
                                        + text[start:end]
                                        + ("..." if end < len(text) else "")
                                    )
                                    break
                        except (json.JSONDecodeError, TypeError):
                            pass
                    conv["snippet"] = snippet
                    results.append(conv)

            elif mode == "date":
                date_from = data.get("date_from", "")
                date_to = data.get("date_to", "")
                if not date_from or not date_to:
                    conn.close()
                    await ws.send_json({"type": "search_results", "results": [], "mode": mode})
                    return
                db_cursor = conn.execute(
                    "SELECT conversation_id, title, updated_at, platform_id, content "
                    "FROM conversations "
                    "WHERE platform_id IN ('Abyss', 'Abyss_Den') "
                    "AND updated_at >= ? AND updated_at <= ? "
                    "ORDER BY updated_at DESC LIMIT 50",
                    (date_from, date_to + "T23:59:59"),
                )
                for row in db_cursor.fetchall():
                    results.append(
                        self._serialize_conversation(row, pinned_ids, active_cid)
                    )

            conn.close()
            await ws.send_json({"type": "search_results", "results": results, "mode": mode})
        except Exception as exc:
            logger.warning(f"Search failed: {exc}")

    # -- View history (read-only, no pointer switch) ---------------------------

    async def handle_view_history(self, ws: web.WebSocketResponse, conversation_id: str):
        """Load a conversation's history without switching the active pointer."""
        try:
            db_path = self.find_db()
            if not db_path:
                return

            conn = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
            cursor = conn.execute(
                "SELECT content, platform_id FROM conversations "
                "WHERE conversation_id = ? AND platform_id IN ('Abyss', 'Abyss_Den')",
                (conversation_id,),
            )
            row = cursor.fetchone()
            conn.close()

            if row and row[0]:
                messages = json.loads(row[0])
                pid = row[1]
                den_pid = self._config.get("id", "abyss_web")
                await ws.send_json({
                    "type": "history",
                    "messages": messages,
                    "readonly": pid != den_pid,
                    "platform_id": pid,
                    "conversation_id": conversation_id,
                })
            else:
                await ws.send_json({
                    "type": "history",
                    "messages": [],
                    "readonly": True,
                    "platform_id": None,
                })
        except Exception as exc:
            logger.warning(f"Failed to view history: {exc}")

    # -- Pin / Unpin -----------------------------------------------------------

    async def handle_pin(self, ws: web.WebSocketResponse, conversation_id: str):
        try:
            async with self._pins_lock:
                pins = self.load_pins()
                if conversation_id not in pins:
                    pins.append(conversation_id)
                    self.save_pins(pins)
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
            async with self._pins_lock:
                pins = self.load_pins()
                if conversation_id in pins:
                    pins.remove(conversation_id)
                    self.save_pins(pins)
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
            umo = self.resolve_umo(platform_id)
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
            umo = self.resolve_umo(platform_id)
            await runtime.conversation_manager.delete_conversation(
                umo, conversation_id,
            )
            # Remove from pins if pinned
            async with self._pins_lock:
                pins = self.load_pins()
                if conversation_id in pins:
                    pins.remove(conversation_id)
                    self.save_pins(pins)
            await ws.send_json({
                "type": "conversation_deleted",
                "conversation_id": conversation_id,
            })
        except Exception as exc:
            logger.warning(f"Failed to delete conversation: {exc}")
