"""Bookmark (favorites) service for the A&F Web Frontend.

Manages den_bookmarks.db — an independent SQLite database for message
and selection bookmarks.  All operations use short-lived connections
and explicit transactions.
"""

import hashlib
import json
import logging
import sqlite3
import uuid
from datetime import datetime
from pathlib import Path

from aiohttp import web

logger = logging.getLogger(__name__)

_CREATE_TABLE = """\
CREATE TABLE IF NOT EXISTS bookmarks (
    id TEXT PRIMARY KEY,
    platform_id TEXT NOT NULL,
    conversation_id TEXT NOT NULL,
    conversation_title TEXT NOT NULL DEFAULT '',
    source_type TEXT NOT NULL,
    source_name TEXT NOT NULL DEFAULT '',
    capture_type TEXT NOT NULL,
    content TEXT NOT NULL,
    context TEXT NOT NULL DEFAULT '',
    note TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    sort_order INTEGER NOT NULL,
    source_key TEXT UNIQUE
);
"""


class BookmarkService:
    """CRUD + reorder for den_bookmarks.db."""

    def __init__(self, data_dir: Path) -> None:
        self._db_path = data_dir / "den_bookmarks.db"
        data_dir.mkdir(parents=True, exist_ok=True)
        self._init_db()

    # -- DB helpers ------------------------------------------------------------

    def _init_db(self) -> None:
        conn = sqlite3.connect(str(self._db_path))
        try:
            conn.execute(_CREATE_TABLE)
            conn.commit()
        finally:
            conn.close()

    def _connect(self) -> sqlite3.Connection:
        conn = sqlite3.connect(str(self._db_path))
        conn.row_factory = sqlite3.Row
        return conn

    @staticmethod
    def _row_to_dict(row: sqlite3.Row) -> dict:
        return dict(row)

    # -- Source key computation ------------------------------------------------

    @staticmethod
    def _compute_source_key(
        platform_id: str,
        conversation_id: str,
        branch_index: int,
        content: str,
        context: str,
    ) -> str:
        raw = json.dumps(
            [
                platform_id,
                conversation_id,
                "assistant",
                branch_index,
                content,
                context,
            ],
            ensure_ascii=False,
            separators=(",", ":"),
        )
        return hashlib.sha256(raw.encode("utf-8")).hexdigest()

    # -- Failure response helper -----------------------------------------------

    @staticmethod
    async def _send_failed(
        ws: web.WebSocketResponse,
        request_id,
        operation: str,
        message: str,
        bookmark_id=None,
    ) -> None:
        payload: dict = {
            "type": "bookmark_failed",
            "request_id": request_id,
            "operation": operation,
            "bookmark_id": bookmark_id,
            "message": message,
        }
        await ws.send_json(payload)

    # -- Handlers --------------------------------------------------------------

    async def handle_list(self, ws: web.WebSocketResponse, msg: dict) -> None:
        """Return all bookmarks ordered by sort_order ASC."""
        request_id = msg.get("request_id")
        try:
            conn = self._connect()
            try:
                cursor = conn.execute(
                    "SELECT * FROM bookmarks ORDER BY sort_order ASC"
                )
                rows = [self._row_to_dict(r) for r in cursor.fetchall()]
            finally:
                conn.close()

            await ws.send_json({
                "type": "bookmarks_list",
                "request_id": request_id,
                "bookmarks": rows,
            })
        except Exception as exc:
            logger.warning(f"bookmark_list failed: {exc}")
            await self._send_failed(ws, request_id, "list", str(exc))

    async def handle_create(self, ws: web.WebSocketResponse, msg: dict) -> None:
        """Create a bookmark with dedup for full-message captures."""
        request_id = msg.get("request_id")
        try:
            content = msg.get("content", "")
            if not content or not content.strip():
                await self._send_failed(
                    ws, request_id, "create", "Content must not be empty."
                )
                return

            capture_type = msg.get("capture_type", "message")
            platform_id = msg.get("platform_id", "")
            conversation_id = msg.get("conversation_id", "")
            conversation_title = msg.get("conversation_title", "")
            source_type = msg.get("source_type", "assistant")
            source_name = msg.get("source_name", "")
            context = msg.get("context", "")
            note = msg.get("note", "")

            # Compute source_key for full-message captures only
            source_key = None
            if capture_type == "message":
                branch_index = msg.get("branch_index")
                if branch_index is None:
                    await self._send_failed(
                        ws, request_id, "create",
                        "branch_index is required for message captures.",
                    )
                    return
                source_key = self._compute_source_key(
                    platform_id, conversation_id,
                    branch_index, content, context,
                )

            now = datetime.utcnow().isoformat() + "Z"
            bookmark_id = uuid.uuid4().hex

            conn = self._connect()
            try:
                with conn:
                    # Determine sort_order: one less than current minimum
                    cursor = conn.execute(
                        "SELECT COALESCE(MIN(sort_order), 0) - 1 FROM bookmarks"
                    )
                    sort_order = cursor.fetchone()[0]

                    cursor = conn.execute(
                        "INSERT INTO bookmarks "
                        "(id, platform_id, conversation_id, conversation_title, "
                        "source_type, source_name, capture_type, content, context, "
                        "note, created_at, updated_at, sort_order, source_key) "
                        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) "
                        "ON CONFLICT(source_key) DO NOTHING",
                        (
                            bookmark_id, platform_id, conversation_id,
                            conversation_title, source_type, source_name,
                            capture_type, content, context, note,
                            now, now, sort_order, source_key,
                        ),
                    )
                    created = cursor.rowcount == 1
            finally:
                conn.close()

            if created:
                await ws.send_json({
                    "type": "bookmark_create_result",
                    "request_id": request_id,
                    "created": True,
                    "bookmark": {
                        "id": bookmark_id,
                        "platform_id": platform_id,
                        "conversation_id": conversation_id,
                        "conversation_title": conversation_title,
                        "source_type": source_type,
                        "source_name": source_name,
                        "capture_type": capture_type,
                        "content": content,
                        "context": context,
                        "note": note,
                        "created_at": now,
                        "updated_at": now,
                        "sort_order": sort_order,
                        "source_key": source_key,
                    },
                })
            else:
                await ws.send_json({
                    "type": "bookmark_create_result",
                    "request_id": request_id,
                    "created": False,
                    "already_exists": True,
                })

        except Exception as exc:
            logger.warning(f"bookmark_create failed: {exc}")
            await self._send_failed(ws, request_id, "create", str(exc))

    async def handle_update(self, ws: web.WebSocketResponse, msg: dict) -> None:
        """Update content, context, and note for a bookmark."""
        request_id = msg.get("request_id")
        bookmark_id = msg.get("id")
        try:
            content = msg.get("content", "")
            if not content or not content.strip():
                await self._send_failed(
                    ws, request_id, "update",
                    "Content must not be empty.",
                    bookmark_id=bookmark_id,
                )
                return

            context = msg.get("context", "")
            note = msg.get("note", "")
            now = datetime.utcnow().isoformat() + "Z"

            conn = self._connect()
            try:
                with conn:
                    cursor = conn.execute(
                        "UPDATE bookmarks SET content = ?, context = ?, "
                        "note = ?, updated_at = ? WHERE id = ?",
                        (content, context, note, now, bookmark_id),
                    )
                    if cursor.rowcount == 0:
                        await self._send_failed(
                            ws, request_id, "update",
                            "Bookmark not found.",
                            bookmark_id=bookmark_id,
                        )
                        return

                    row = conn.execute(
                        "SELECT * FROM bookmarks WHERE id = ?",
                        (bookmark_id,),
                    ).fetchone()
            finally:
                conn.close()

            await ws.send_json({
                "type": "bookmark_updated",
                "request_id": request_id,
                "bookmark": self._row_to_dict(row),
            })

        except Exception as exc:
            logger.warning(f"bookmark_update failed: {exc}")
            await self._send_failed(
                ws, request_id, "update", str(exc),
                bookmark_id=bookmark_id,
            )

    async def handle_delete(self, ws: web.WebSocketResponse, msg: dict) -> None:
        """Delete a bookmark by id."""
        request_id = msg.get("request_id")
        bookmark_id = msg.get("id")
        try:
            conn = self._connect()
            try:
                with conn:
                    cursor = conn.execute(
                        "DELETE FROM bookmarks WHERE id = ?",
                        (bookmark_id,),
                    )
                    if cursor.rowcount == 0:
                        await self._send_failed(
                            ws, request_id, "delete",
                            "Bookmark not found.",
                            bookmark_id=bookmark_id,
                        )
                        return
            finally:
                conn.close()

            await ws.send_json({
                "type": "bookmark_deleted",
                "request_id": request_id,
                "bookmark_id": bookmark_id,
            })

        except Exception as exc:
            logger.warning(f"bookmark_delete failed: {exc}")
            await self._send_failed(
                ws, request_id, "delete", str(exc),
                bookmark_id=bookmark_id,
            )

    async def handle_reorder(self, ws: web.WebSocketResponse, msg: dict) -> None:
        """Reorder all bookmarks according to ordered_ids."""
        request_id = msg.get("request_id")
        try:
            ordered_ids = msg.get("ordered_ids", [])
            if not isinstance(ordered_ids, list):
                await self._send_failed(
                    ws, request_id, "reorder",
                    "ordered_ids must be a list.",
                )
                return

            conn = self._connect()
            try:
                # Validate ID sets match exactly
                cursor = conn.execute("SELECT id FROM bookmarks")
                db_ids = {row["id"] for row in cursor.fetchall()}
                request_ids = set(ordered_ids)

                if db_ids != request_ids or len(ordered_ids) != len(db_ids):
                    await self._send_failed(
                        ws, request_id, "reorder",
                        "ID set does not match current bookmarks.",
                    )
                    return

                with conn:
                    for sort_order, bid in enumerate(ordered_ids):
                        conn.execute(
                            "UPDATE bookmarks SET sort_order = ? WHERE id = ?",
                            (sort_order, bid),
                        )
            finally:
                conn.close()

            await ws.send_json({
                "type": "bookmarks_reordered",
                "request_id": request_id,
            })

        except Exception as exc:
            logger.warning(f"bookmark_reorder failed: {exc}")
            await self._send_failed(ws, request_id, "reorder", str(exc))
