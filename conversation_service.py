"""Conversation CRUD, search, history, and pin management for the A&F Web Frontend.

All conversation-related operations extracted from FrontendAdapter.
Uses runtime.conversation_manager dynamically at call time (never cached).
"""

import json
import math
import sqlite3
from pathlib import Path

from aiohttp import web

from astrbot import logger

from . import runtime


class ConversationService:
    """Manages conversations, history, pins, and search."""

    def __init__(self, config: dict, umo: str) -> None:
        self._config = config
        self._umo = umo

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
        path = self._pins_path()
        path.write_text(json.dumps(pins))

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
                    "readonly": False,
                    "platform_id": platform_id,
                })
            else:
                # No history — send empty so frontend knows to clear
                await ws.send_json({
                    "type": "history",
                    "messages": [],
                    "readonly": False,
                    "platform_id": platform_id,
                })
        except Exception as exc:
            logger.warning(f"Failed to load chat history: {exc}")

    # -- Conversation list -----------------------------------------------------

    async def send_conversations_list(self, ws: web.WebSocketResponse, page: int = 1, limit: int = 20):
        """Send a paginated list of all conversations (Den + QQ) to the frontend."""
        try:
            db_path = self.find_db()
            if not db_path:
                return

            conn = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)

            # Count total across both platforms
            cursor = conn.execute(
                "SELECT COUNT(*) FROM conversations "
                "WHERE platform_id IN ('Abyss', 'Abyss_Den')"
            )
            total = cursor.fetchone()[0]

            pages = max(1, math.ceil(total / limit))
            page = max(1, min(page, pages))
            offset = (page - 1) * limit

            cursor = conn.execute(
                "SELECT conversation_id, title, updated_at, platform_id, content "
                "FROM conversations "
                "WHERE platform_id IN ('Abyss', 'Abyss_Den') "
                "ORDER BY updated_at DESC "
                "LIMIT ? OFFSET ?",
                (limit, offset),
            )
            rows = cursor.fetchall()
            conn.close()

            # Active conversation pointer (Den only)
            active_cid = None
            if runtime.conversation_manager:
                active_cid = await runtime.conversation_manager.get_curr_conversation_id(
                    self._umo
                )

            pinned = self.load_pins()

            conversations = []
            for cid, title, updated_at, pid, content in rows:
                preview = title or ""
                if not preview and content:
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
                                break
                    except (json.JSONDecodeError, TypeError):
                        pass

                conversations.append({
                    "id": cid,
                    "preview": preview or "(empty)",
                    "updated_at": updated_at,
                    "platform_id": pid,
                    "active": cid == active_cid,
                    "pinned": cid in pinned,
                })

            await ws.send_json({
                "type": "conversations_list",
                "conversations": conversations,
                "page": page,
                "pages": pages,
                "total": total,
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
            pinned = self.load_pins()
            active_cid = None
            if runtime.conversation_manager:
                active_cid = await runtime.conversation_manager.get_curr_conversation_id(
                    self._umo
                )

            results: list[dict] = []

            if mode == "title":
                if not query:
                    conn.close()
                    await ws.send_json({"type": "search_results", "results": [], "mode": mode})
                    return
                cursor = conn.execute(
                    "SELECT conversation_id, title, updated_at, platform_id "
                    "FROM conversations "
                    "WHERE platform_id IN ('Abyss', 'Abyss_Den') AND title LIKE ? "
                    "ORDER BY updated_at DESC LIMIT 30",
                    (f"%{query}%",),
                )
                for cid, title, updated_at, pid in cursor.fetchall():
                    results.append({
                        "id": cid, "preview": title or cid[:20],
                        "updated_at": updated_at, "platform_id": pid,
                        "active": cid == active_cid, "pinned": cid in pinned,
                    })

            elif mode == "content":
                if not query:
                    conn.close()
                    await ws.send_json({"type": "search_results", "results": [], "mode": mode})
                    return
                escaped = self.to_unicode_escaped(query)
                cursor = conn.execute(
                    "SELECT conversation_id, title, updated_at, platform_id, content "
                    "FROM conversations "
                    "WHERE platform_id IN ('Abyss', 'Abyss_Den') "
                    "AND (content LIKE ? OR content LIKE ?) "
                    "ORDER BY updated_at DESC LIMIT 30",
                    (f"%{query}%", f"%{escaped}%"),
                )
                for cid, title, updated_at, pid, content in cursor.fetchall():
                    snippet = ""
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
                    results.append({
                        "id": cid, "preview": title or cid[:20],
                        "updated_at": updated_at, "platform_id": pid,
                        "active": cid == active_cid, "pinned": cid in pinned,
                        "snippet": snippet,
                    })

            elif mode == "date":
                date_from = data.get("date_from", "")
                date_to = data.get("date_to", "")
                if not date_from or not date_to:
                    conn.close()
                    await ws.send_json({"type": "search_results", "results": [], "mode": mode})
                    return
                cursor = conn.execute(
                    "SELECT conversation_id, title, updated_at, platform_id "
                    "FROM conversations "
                    "WHERE platform_id IN ('Abyss', 'Abyss_Den') "
                    "AND updated_at >= ? AND updated_at <= ? "
                    "ORDER BY updated_at DESC LIMIT 50",
                    (date_from, date_to + "T23:59:59"),
                )
                for cid, title, updated_at, pid in cursor.fetchall():
                    results.append({
                        "id": cid, "preview": title or cid[:20],
                        "updated_at": updated_at, "platform_id": pid,
                        "active": cid == active_cid, "pinned": cid in pinned,
                    })

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
        pins = self.load_pins()
        if conversation_id not in pins:
            pins.append(conversation_id)
            self.save_pins(pins)
        await ws.send_json({"type": "pin_updated", "pinned": pins})

    async def handle_unpin(self, ws: web.WebSocketResponse, conversation_id: str):
        pins = self.load_pins()
        if conversation_id in pins:
            pins.remove(conversation_id)
            self.save_pins(pins)
        await ws.send_json({"type": "pin_updated", "pinned": pins})

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
