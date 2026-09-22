"""Shared state and low-level helpers for conversation modules.

Holds config, UMO, pin lock, DB resolution, pin storage, serialization,
and history loading — everything that ConversationService, Branch, and
Search all depend on.
"""

import asyncio
import json
import os
import sqlite3
import tempfile
from pathlib import Path

from . import runtime


class ConversationCore:
    """Shared state and utilities consumed by all conversation modules."""

    def __init__(self, config: dict, umo: str) -> None:
        self.config = config
        self.umo = umo
        self.pins_lock = asyncio.Lock()

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

    @property
    def data_dir(self) -> Path:
        """Resolve the AstrBot data directory (where data_v4.db lives)."""
        db_path = self.find_db()
        return Path(db_path).parent if db_path else Path("/opt/astrbot/data")

    # -- Pin storage -----------------------------------------------------------

    def _pins_path(self) -> Path:
        """Path to the server-side pin storage file."""
        return self.data_dir / "den_pins.json"

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
    def extract_preview(title: str | None, content: str | None) -> str:
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

    def serialize_conversation(
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
            "preview": self.extract_preview(title, content),
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
        return self.umo

    async def get_active_cid(self) -> str | None:
        """Get the current active conversation ID."""
        if runtime.conversation_manager:
            return await runtime.conversation_manager.get_curr_conversation_id(
                self.umo
            )
        return None

    def load_conversation_history(
        self,
        conversation_id: str,
        platform_filter: str | tuple[str, ...],
    ) -> tuple[list, str] | None:
        """Load and parse a single conversation's history from the DB.

        Returns ``(messages, platform_id)`` when the row exists (messages
        may be ``[]`` for a newly created conversation with no content yet).
        Returns ``None`` when no matching row is found.
        Raises on DB access or JSON parse errors.
        """
        db_path = self.find_db()
        if not db_path:
            raise FileNotFoundError("Chat history DB not found")

        conn = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
        try:
            if isinstance(platform_filter, str):
                cursor = conn.execute(
                    "SELECT content, platform_id FROM conversations "
                    "WHERE conversation_id = ? AND platform_id = ?",
                    (conversation_id, platform_filter),
                )
            else:
                placeholders = ",".join("?" * len(platform_filter))
                cursor = conn.execute(
                    f"SELECT content, platform_id FROM conversations "
                    f"WHERE conversation_id = ? AND platform_id IN ({placeholders})",
                    (conversation_id, *platform_filter),
                )
            row = cursor.fetchone()
        finally:
            conn.close()

        if row is None:
            return None

        content, pid = row
        messages = json.loads(content) if content else []
        return (messages, pid)
