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

_ERROR_MESSAGE = "Invalid Den command.\nUsage: show log [1\u2013200]"


class LogService:
    """Reads and returns recent AstrBot log records."""

    def __init__(self, log_path: Path) -> None:
        self._log_path = log_path

    async def handle_command(self, ws: web.WebSocketResponse, data: dict) -> None:
        """Entry point from ``_dispatch_non_turn`` for ``den_command``."""
        req_id = data.get("id", "")
        content = data.get("content", "")

        try:
            count = self._parse_show_log(content)
        except ValueError:
            await self._send_error(ws, req_id)
            return

        try:
            log_text = await asyncio.to_thread(self._read_recent_records, count)
        except Exception as exc:
            logger.warning(f"Log read failed: {exc}")
            await self._send_error(ws, req_id, f"Could not read log file: {exc}")
            return

        try:
            await ws.send_json({
                "type": "den_log",
                "id": req_id,
                "content": log_text or "No log entries found.",
                "count": count,
            })
        except Exception:
            logger.warning("Failed to send den_log (client disconnected?).")

    # -- Parsing --------------------------------------------------------

    def _parse_show_log(self, content: str) -> int:
        """Parse the command text and return the requested record count.

        Raises ``ValueError`` if the syntax is invalid or the count
        is out of range.
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
            return _DEFAULT_COUNT

        # Must be a bare non-negative integer with nothing else
        if not re.fullmatch(r"\d+", remainder):
            raise ValueError("non-integer parameter")

        count = int(remainder)
        if count < _MIN_COUNT or count > _MAX_COUNT:
            raise ValueError(f"count {count} out of range")

        return count

    # -- Log reading ----------------------------------------------------

    def _read_recent_records(self, limit: int) -> str:
        """Synchronous tail-read of the log file, split into complete records.

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
