"""A&F Web Frontend -- Den local log viewer.

Handles the ``den_command`` WebSocket message type, providing read-only
access to the AstrBot main log file without entering the message pipeline.
"""

import asyncio
import re
from pathlib import Path

from aiohttp import web

from astrbot import logger

# Matches the start of a log record: [YYYY-MM-DD HH:MM:SS.mmm]
_RECORD_START = re.compile(r"^\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}\]")

# Maximum bytes to read from the tail of the log file
_MAX_TAIL_BYTES = 256 * 1024  # 256 KiB

# Valid command prefixes (longer first, checked after strip + lowercase)
_DEN_PREFIXES = ("/show log", "/showlog", "show log", "showlog")

_DEFAULT_COUNT = 30
_MIN_COUNT = 1
_MAX_COUNT = 200

_ERROR_MESSAGE = "Invalid Den command.\nUsage: show log [query] [1\u2013200]"


class LogService:
    """Reads and returns recent AstrBot log records."""

    def __init__(self, log_path: Path) -> None:
        self._log_path = log_path

    async def handle_command(self, ws: web.WebSocketResponse, data: dict) -> None:
        """Entry point from ``_dispatch_non_turn`` for ``den_command``."""
        req_id = data.get("id", "")
        content = data.get("content", "")

        try:
            query, count = self._parse_show_log(content)
        except ValueError:
            await self._send_error(ws, req_id)
            return

        try:
            log_text = await asyncio.to_thread(
                self._read_recent_records, count, query,
            )
        except Exception as exc:
            logger.warning(f"Log read failed: {exc}")
            await self._send_error(ws, req_id, f"Could not read log file: {exc}")
            return

        if log_text:
            content_out = log_text
        elif query:
            content_out = f'No log entries matching "{query}".'
        else:
            content_out = "No log entries found."

        try:
            payload: dict = {
                "type": "den_log",
                "id": req_id,
                "content": content_out,
                "count": count,
            }
            if query:
                payload["query"] = query
            await ws.send_json(payload)
        except Exception:
            logger.warning("Failed to send den_log (client disconnected?).")

    # -- Parsing --------------------------------------------------------

    def _parse_show_log(self, content: str) -> tuple[str | None, int]:
        """Parse the command text into ``(query, limit)``.

        *query* is ``None`` when no search term is provided.
        Raises ``ValueError`` for invalid syntax or out-of-range count.
        """
        normalized = content.strip().lower()

        matched_prefix = None
        for prefix in _DEN_PREFIXES:
            if normalized.startswith(prefix):
                matched_prefix = prefix
                break

        if matched_prefix is None:
            raise ValueError("no matching prefix")

        # Extract remainder using the length of the matched prefix
        remainder = content.strip()[len(matched_prefix):].strip()

        if not remainder:
            return (None, _DEFAULT_COUNT)

        # Split from the right to isolate the potential trailing count
        parts = remainder.rsplit(None, 1)
        last_token = parts[-1]

        # Pure integer → treat as limit
        if re.fullmatch(r"\d+", last_token):
            count = int(last_token)
            if count < _MIN_COUNT or count > _MAX_COUNT:
                raise ValueError(f"count {count} out of range")
            query = parts[0].strip() if len(parts) > 1 else None
            return (query or None, count)

        # Numeric-looking but not a valid integer (e.g. 1.5, -3) → error
        if re.fullmatch(r"-?[\d.]+", last_token):
            raise ValueError("invalid numeric parameter")

        # Non-numeric → entire remainder is the search query
        return (remainder, _DEFAULT_COUNT)

    # -- Log reading ----------------------------------------------------

    def _read_recent_records(self, limit: int, query: str | None = None) -> str:
        """Synchronous tail-read of the log file, split into complete records.

        When *query* is provided, only records whose full text (including
        traceback / continuation lines) contains *query* are kept.  The
        match uses ``casefold()`` for case-insensitive comparison.

        Called via ``asyncio.to_thread`` to avoid blocking the event loop.
        """
        path = self._log_path
        if not path.is_file():
            raise FileNotFoundError("AstrBot log file not found.")

        size = path.stat().st_size
        if size == 0:
            return ""

        read_size = min(size, _MAX_TAIL_BYTES)
        with open(path, "rb") as f:
            f.seek(max(0, size - read_size))
            raw = f.read(read_size)

        text = raw.decode("utf-8", errors="replace")
        lines = text.split("\n")

        # If we started mid-file, the first record is likely incomplete
        started_mid_file = size > read_size

        records: list[str] = []
        current: list[str] = []

        for line in lines:
            if _RECORD_START.match(line):
                if current:
                    records.append("\n".join(current))
                current = [line]
            else:
                current.append(line)

        if current:
            records.append("\n".join(current))

        # Discard the first (potentially truncated) record when read from mid-file
        if started_mid_file and records:
            records = records[1:]

        # Filter by query (casefold for case-insensitive containment)
        if query:
            q = query.casefold()
            records = [r for r in records if q in r.casefold()]

        # Return the last `limit` records, oldest first
        return "\n".join(records[-limit:]).strip()

    # -- Error helper ---------------------------------------------------

    @staticmethod
    async def _send_error(
        ws: web.WebSocketResponse,
        req_id: str,
        message: str = _ERROR_MESSAGE,
    ) -> None:
        try:
            await ws.send_json({
                "type": "den_command_error",
                "id": req_id,
                "message": message,
            })
        except Exception:
            logger.warning("Failed to send den_command_error (client disconnected?).")
