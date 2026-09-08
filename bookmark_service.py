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

_CREATE_BOOKMARKS_TABLE = """\
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
    source_key TEXT UNIQUE,
    label_id TEXT
);
"""

_CREATE_LABELS_TABLE = """\
CREATE TABLE IF NOT EXISTS bookmark_labels (
    id TEXT PRIMARY KEY,
    emoji TEXT NOT NULL UNIQUE,
    note TEXT NOT NULL DEFAULT '',
    sort_order INTEGER NOT NULL
);
"""

_EMOJI_MAX_LEN = 32
_NOTE_MAX_LEN = 100

# Default seed labels (emoji, note) — inserted in order as sort_order 0..3
_SEED_LABELS = [
    ("\U0001f49c", "\u7231\u7684\u77ac\u95f4"),       # 💜  爱的瞬间
    ("\U0001f638", "\u597d\u7b11\u7684\u4e8b"),       # 😸  好笑的事
    ("\U0001f608", "\u5f88\u574f\u7684Abyss"),        # 😈  很坏的Abyss
    ("\U0001f4a1", "\u7075\u5149\u4e00\u95ea"),       # 💡  灵光一闪
]


class BookmarkService:
    """CRUD for bookmarks and bookmark labels in den_bookmarks.db."""

    def __init__(self, data_dir: Path) -> None:
        self._db_path = data_dir / "den_bookmarks.db"
        data_dir.mkdir(parents=True, exist_ok=True)
        self._init_db()

    # -- DB helpers ------------------------------------------------------------

    def _init_db(self) -> None:
        conn = sqlite3.connect(str(self._db_path))
        try:
            conn.execute("BEGIN")

            # -- Bookmarks table (may already exist from earlier schema) -------
            conn.executescript(_CREATE_BOOKMARKS_TABLE)

            # -- Ensure label_id column exists (migration for older DBs) -------
            cols = {
                row[1]
                for row in conn.execute("PRAGMA table_info(bookmarks)").fetchall()
            }
            if "label_id" not in cols:
                conn.execute(
                    "ALTER TABLE bookmarks ADD COLUMN label_id TEXT"
                )

            # -- Labels table --------------------------------------------------
            conn.executescript(_CREATE_LABELS_TABLE)

            # -- Seed default labels if table is empty -------------------------
            count = conn.execute(
                "SELECT COUNT(*) FROM bookmark_labels"
            ).fetchone()[0]
            if count == 0:
                for idx, (emoji, note) in enumerate(_SEED_LABELS):
                    conn.execute(
                        "INSERT INTO bookmark_labels (id, emoji, note, sort_order) "
                        "VALUES (?, ?, ?, ?)",
                        (uuid.uuid4().hex, emoji, note, idx),
                    )

            # -- Get default label id ------------------------------------------
            default_row = conn.execute(
                "SELECT id FROM bookmark_labels "
                "ORDER BY sort_order ASC, rowid ASC LIMIT 1"
            ).fetchone()
            default_label_id = default_row[0] if default_row else None

            # -- Backfill bookmarks with missing / invalid label_id ------------
            if default_label_id:
                conn.execute(
                    "UPDATE bookmarks SET label_id = ? "
                    "WHERE label_id IS NULL OR label_id = '' "
                    "OR NOT EXISTS ("
                    "  SELECT 1 FROM bookmark_labels "
                    "  WHERE bookmark_labels.id = bookmarks.label_id"
                    ")",
                    (default_label_id,),
                )

            conn.execute("COMMIT")
        except Exception:
            conn.execute("ROLLBACK")
            raise
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

    # -- Label helpers ---------------------------------------------------------

    @staticmethod
    def _list_labels(conn: sqlite3.Connection) -> list[dict]:
        cursor = conn.execute(
            "SELECT * FROM bookmark_labels "
            "ORDER BY sort_order ASC, rowid ASC"
        )
        return [dict(r) for r in cursor.fetchall()]

    @staticmethod
    def _get_default_label_id(conn: sqlite3.Connection) -> str | None:
        row = conn.execute(
            "SELECT id FROM bookmark_labels "
            "ORDER BY sort_order ASC, rowid ASC LIMIT 1"
        ).fetchone()
        return row["id"] if row else None

    @staticmethod
    def _validate_label_id(conn: sqlite3.Connection, label_id: str) -> bool:
        row = conn.execute(
            "SELECT 1 FROM bookmark_labels WHERE id = ?",
            (label_id,),
        ).fetchone()
        return row is not None

    # -- Label CRUD handlers ---------------------------------------------------

    async def handle_label_list(
        self, ws: web.WebSocketResponse, msg: dict,
    ) -> None:
        """Return all bookmark labels ordered by sort_order ASC."""
        request_id = msg.get("request_id")
        try:
            conn = self._connect()
            try:
                labels = self._list_labels(conn)
            finally:
                conn.close()

            if not labels:
                await self._send_failed(
                    ws, request_id, "label_list",
                    "No labels found.",
                )
                return

            await ws.send_json({
                "type": "bookmark_labels_list",
                "request_id": request_id,
                "labels": labels,
            })
        except Exception as exc:
            logger.warning(f"bookmark_label_list failed: {exc}")
            await self._send_failed(ws, request_id, "label_list", str(exc))

    async def handle_label_create(
        self, ws: web.WebSocketResponse, msg: dict,
    ) -> None:
        """Create a new bookmark label."""
        request_id = msg.get("request_id")
        try:
            emoji = msg.get("emoji", "")
            note = msg.get("note", "")

            if not emoji or not emoji.strip():
                await self._send_failed(
                    ws, request_id, "label_create",
                    "Emoji must not be empty.",
                )
                return

            emoji = emoji.strip()
            note = note.strip() if note else ""

            if len(emoji) > _EMOJI_MAX_LEN:
                await self._send_failed(
                    ws, request_id, "label_create",
                    f"Emoji must be at most {_EMOJI_MAX_LEN} characters.",
                )
                return

            if len(note) > _NOTE_MAX_LEN:
                await self._send_failed(
                    ws, request_id, "label_create",
                    f"Note must be at most {_NOTE_MAX_LEN} characters.",
                )
                return

            label_id = uuid.uuid4().hex

            conn = self._connect()
            try:
                with conn:
                    next_order = conn.execute(
                        "SELECT COALESCE(MAX(sort_order), -1) + 1 "
                        "FROM bookmark_labels"
                    ).fetchone()[0]

                    try:
                        conn.execute(
                            "INSERT INTO bookmark_labels "
                            "(id, emoji, note, sort_order) "
                            "VALUES (?, ?, ?, ?)",
                            (label_id, emoji, note, next_order),
                        )
                    except sqlite3.IntegrityError:
                        await self._send_failed(
                            ws, request_id, "label_create",
                            "That emoji is already in use.",
                        )
                        return

                    label = {
                        "id": label_id,
                        "emoji": emoji,
                        "note": note,
                        "sort_order": next_order,
                    }
                    labels = self._list_labels(conn)
            finally:
                conn.close()

            await ws.send_json({
                "type": "bookmark_label_created",
                "request_id": request_id,
                "label": label,
                "labels": labels,
            })

        except Exception as exc:
            logger.warning(f"bookmark_label_create failed: {exc}")
            await self._send_failed(ws, request_id, "label_create", str(exc))

    async def handle_label_update(
        self, ws: web.WebSocketResponse, msg: dict,
    ) -> None:
        """Update emoji and/or note for a bookmark label."""
        request_id = msg.get("request_id")
        try:
            label_id = msg.get("id", "")
            emoji = msg.get("emoji", "")
            note = msg.get("note", "")

            if not label_id:
                await self._send_failed(
                    ws, request_id, "label_update",
                    "Label id is required.",
                )
                return

            if not emoji or not emoji.strip():
                await self._send_failed(
                    ws, request_id, "label_update",
                    "Emoji must not be empty.",
                )
                return

            emoji = emoji.strip()
            note = note.strip() if note else ""

            if len(emoji) > _EMOJI_MAX_LEN:
                await self._send_failed(
                    ws, request_id, "label_update",
                    f"Emoji must be at most {_EMOJI_MAX_LEN} characters.",
                )
                return

            if len(note) > _NOTE_MAX_LEN:
                await self._send_failed(
                    ws, request_id, "label_update",
                    f"Note must be at most {_NOTE_MAX_LEN} characters.",
                )
                return

            conn = self._connect()
            try:
                with conn:
                    try:
                        cursor = conn.execute(
                            "UPDATE bookmark_labels "
                            "SET emoji = ?, note = ? WHERE id = ?",
                            (emoji, note, label_id),
                        )
                    except sqlite3.IntegrityError:
                        await self._send_failed(
                            ws, request_id, "label_update",
                            "That emoji is already in use.",
                        )
                        return

                    if cursor.rowcount == 0:
                        await self._send_failed(
                            ws, request_id, "label_update",
                            "Label not found.",
                        )
                        return

                    row = conn.execute(
                        "SELECT * FROM bookmark_labels WHERE id = ?",
                        (label_id,),
                    ).fetchone()
                    label = dict(row)
                    labels = self._list_labels(conn)
            finally:
                conn.close()

            await ws.send_json({
                "type": "bookmark_label_updated",
                "request_id": request_id,
                "label": label,
                "labels": labels,
            })

        except Exception as exc:
            logger.warning(f"bookmark_label_update failed: {exc}")
            await self._send_failed(ws, request_id, "label_update", str(exc))

    async def handle_label_delete(
        self, ws: web.WebSocketResponse, msg: dict,
    ) -> None:
        """Delete a bookmark label and migrate its bookmarks."""
        request_id = msg.get("request_id")
        try:
            label_id = msg.get("id", "")
            if not label_id:
                await self._send_failed(
                    ws, request_id, "label_delete",
                    "Label id is required.",
                )
                return

            conn = self._connect()
            try:
                with conn:
                    # Read all labels sorted
                    sorted_labels = self._list_labels(conn)

                    # Verify target exists
                    target = None
                    target_idx = None
                    for idx, lbl in enumerate(sorted_labels):
                        if lbl["id"] == label_id:
                            target = lbl
                            target_idx = idx
                            break

                    if target is None:
                        await self._send_failed(
                            ws, request_id, "label_delete",
                            "Label not found.",
                        )
                        return

                    # Must have more than one label
                    if len(sorted_labels) <= 1:
                        await self._send_failed(
                            ws, request_id, "label_delete",
                            "The last label cannot be deleted.",
                        )
                        return

                    # Determine replacement label
                    if target_idx == 0:
                        # Deleting first → replacement is second
                        replacement_id = sorted_labels[1]["id"]
                    else:
                        # Deleting non-first → replacement is first
                        replacement_id = sorted_labels[0]["id"]

                    # Migrate bookmarks
                    cursor = conn.execute(
                        "UPDATE bookmarks SET label_id = ? "
                        "WHERE label_id = ?",
                        (replacement_id, label_id),
                    )
                    moved_count = cursor.rowcount

                    # Delete the label
                    conn.execute(
                        "DELETE FROM bookmark_labels WHERE id = ?",
                        (label_id,),
                    )

                    # Read final labels
                    labels = self._list_labels(conn)
            finally:
                conn.close()

            await ws.send_json({
                "type": "bookmark_label_deleted",
                "request_id": request_id,
                "deleted_label_id": label_id,
                "replacement_label_id": replacement_id,
                "moved_count": moved_count,
                "labels": labels,
            })

        except Exception as exc:
            logger.warning(f"bookmark_label_delete failed: {exc}")
            await self._send_failed(ws, request_id, "label_delete", str(exc))

    # -- Bookmark handlers -----------------------------------------------------

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
                    # Resolve label_id
                    label_id = msg.get("label_id", "")
                    if not label_id:
                        label_id = self._get_default_label_id(conn)
                    else:
                        if not self._validate_label_id(conn, label_id):
                            await self._send_failed(
                                ws, request_id, "create",
                                "Selected label no longer exists.",
                            )
                            return

                    # Determine sort_order: one less than current minimum
                    cursor = conn.execute(
                        "SELECT COALESCE(MIN(sort_order), 0) - 1 FROM bookmarks"
                    )
                    sort_order = cursor.fetchone()[0]

                    cursor = conn.execute(
                        "INSERT INTO bookmarks "
                        "(id, platform_id, conversation_id, conversation_title, "
                        "source_type, source_name, capture_type, content, context, "
                        "note, created_at, updated_at, sort_order, source_key, "
                        "label_id) "
                        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) "
                        "ON CONFLICT(source_key) DO NOTHING",
                        (
                            bookmark_id, platform_id, conversation_id,
                            conversation_title, source_type, source_name,
                            capture_type, content, context, note,
                            now, now, sort_order, source_key, label_id,
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
                        "label_id": label_id,
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
        """Update content, context, note, and optionally label_id for a bookmark."""
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
                    # Resolve label_id
                    msg_label_id = msg.get("label_id")
                    if msg_label_id is not None and msg_label_id != "":
                        # Explicit label_id provided — validate it
                        if not self._validate_label_id(conn, msg_label_id):
                            await self._send_failed(
                                ws, request_id, "update",
                                "Selected label no longer exists.",
                                bookmark_id=bookmark_id,
                            )
                            return
                        label_id = msg_label_id
                    else:
                        # No label_id in msg — keep existing; if invalid, default
                        existing = conn.execute(
                            "SELECT label_id FROM bookmarks WHERE id = ?",
                            (bookmark_id,),
                        ).fetchone()
                        if existing is None:
                            await self._send_failed(
                                ws, request_id, "update",
                                "Bookmark not found.",
                                bookmark_id=bookmark_id,
                            )
                            return
                        existing_label_id = existing["label_id"]
                        if existing_label_id and self._validate_label_id(
                            conn, existing_label_id,
                        ):
                            label_id = existing_label_id
                        else:
                            label_id = self._get_default_label_id(conn)

                    cursor = conn.execute(
                        "UPDATE bookmarks SET content = ?, context = ?, "
                        "note = ?, label_id = ?, updated_at = ? WHERE id = ?",
                        (content, context, note, label_id, now, bookmark_id),
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
