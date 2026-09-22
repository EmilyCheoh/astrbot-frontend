"""Search logic for the A&F Web Frontend.

Handles title, content, CoT, and date-range search across conversations.
Shared state comes from ``ConversationCore``.
"""

import json
import re
import sqlite3

from aiohttp import web

from astrbot import logger

from .conversation_core import ConversationCore


class ConversationSearchService:
    """Conversation search across four modes: title, content, cot, date."""

    def __init__(self, core: ConversationCore) -> None:
        self._core = core

    # -- Helpers ---------------------------------------------------------------

    @staticmethod
    def _normalise_tool_payload(value) -> str:
        """Decode tool arguments/results into readable text.

        Tool arguments are often stored as a JSON string.  Decode them
        so Chinese text and formatted code produce readable snippets.
        """
        if value is None:
            return ""

        if not isinstance(value, str):
            try:
                return json.dumps(value, ensure_ascii=False, indent=2)
            except (TypeError, ValueError):
                return str(value)

        try:
            parsed = json.loads(value)
        except (json.JSONDecodeError, TypeError):
            return value

        try:
            return json.dumps(parsed, ensure_ascii=False, indent=2)
        except (TypeError, ValueError):
            return value

    @staticmethod
    def _extract_cot_value(block: dict) -> str:
        """Extract the text value from a think/thinking content block."""
        value = (
            block.get("thinking")
            or block.get("think")
            or block.get("text")
            or block.get("content")
            or ""
        )
        return value if isinstance(value, str) else ""

    @classmethod
    def _extract_search_texts(cls, message: dict, mode: str) -> list[str]:
        """Extract searchable text blocks from a single message.

        *cot* mode returns only assistant ``think``/``thinking`` blocks.
        *content* mode returns ordinary text, CoT, tool names, arguments,
        and tool results.
        """
        texts: list[str] = []

        if not isinstance(message, dict):
            return texts

        role = message.get("role", "")
        content = message.get("content", "")

        if mode == "cot":
            if role != "assistant" or not isinstance(content, list):
                return texts

            for block in content:
                if not isinstance(block, dict):
                    continue
                if block.get("type") not in ("think", "thinking"):
                    continue
                value = cls._extract_cot_value(block)
                if value:
                    texts.append(value)

            return texts

        if mode != "content":
            return texts

        # -- Content mode: ordinary text + CoT + tool calls + tool results --

        if role in ("user", "assistant"):
            if isinstance(content, str):
                if content:
                    texts.append(content)

            elif isinstance(content, list):
                for block in content:
                    if isinstance(block, str):
                        if block:
                            texts.append(block)
                        continue

                    if not isinstance(block, dict):
                        continue

                    block_type = block.get("type")

                    if block_type == "text":
                        value = block.get("text") or block.get("content") or ""
                    elif block_type in ("think", "thinking"):
                        value = cls._extract_cot_value(block)
                    else:
                        continue

                    if isinstance(value, str) and value:
                        texts.append(value)

        if role == "assistant":
            tool_calls = message.get("tool_calls") or []

            if isinstance(tool_calls, list):
                for tool_call in tool_calls:
                    if not isinstance(tool_call, dict):
                        continue

                    function = tool_call.get("function") or {}
                    if not isinstance(function, dict):
                        continue

                    name = function.get("name")
                    if isinstance(name, str) and name:
                        texts.append(name)

                    arguments = cls._normalise_tool_payload(
                        function.get("arguments")
                    )
                    if arguments:
                        texts.append(arguments)

        if role == "tool":
            result = cls._normalise_tool_payload(content)
            if result:
                texts.append(result)

        return texts

    @staticmethod
    def _find_text_matches(
        text: str,
        query: str,
        context_size: int = 40,
    ) -> list[dict]:
        """Find every occurrence of *query* in *text* with surrounding context.

        Returns ``[{before, match, after}, ...]``.  Pre-split strings
        avoid the Python/JS Unicode offset mismatch.
        """
        if not text or not query:
            return []

        matches: list[dict] = []
        pattern = re.compile(re.escape(query), re.IGNORECASE)

        for found in pattern.finditer(text):
            match_start, match_end = found.span()

            context_start = max(0, match_start - context_size)
            context_end = min(len(text), match_end + context_size)

            before = text[context_start:match_start]
            matched = text[match_start:match_end]
            after = text[match_end:context_end]

            if context_start > 0:
                before = "..." + before
            if context_end < len(text):
                after = after + "..."

            matches.append({
                "before": before,
                "match": matched,
                "after": after,
            })

        return matches

    @classmethod
    def _extract_conversation_matches(
        cls,
        messages: list,
        query: str,
        mode: str,
    ) -> list[dict]:
        """Collect all matches across every message in a conversation."""
        matches: list[dict] = []

        if not isinstance(messages, list):
            return matches

        for message in messages:
            for text in cls._extract_search_texts(message, mode):
                matches.extend(cls._find_text_matches(text, query))

        return matches

    # -- WebSocket handler -----------------------------------------------------

    async def handle_search(self, ws: web.WebSocketResponse, data: dict):
        """Search conversations by title, content, CoT, or date range."""
        mode = data.get("mode", "title")
        query = data.get("q", "").strip()

        try:
            db_path = self._core.find_db()
            if not db_path:
                return

            conn = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
            pinned_ids = self._core.load_pins()
            active_cid = await self._core.get_active_cid()

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
                        self._core.serialize_conversation(row, pinned_ids, active_cid)
                    )

            elif mode in ("content", "cot"):
                if not query:
                    conn.close()
                    await ws.send_json({"type": "search_results", "results": [], "mode": mode})
                    return

                # Detect if the query contains characters that get
                # JSON-escaped (quotes, backslashes, control chars).
                # When it does, SQL LIKE against the raw JSON will miss
                # matches inside decoded tool arguments / results, so
                # we fall back to a full scan and let the structured
                # extractors handle matching.
                json_escaped = json.dumps(query, ensure_ascii=False)[1:-1]
                needs_full_scan = json_escaped != query

                if needs_full_scan:
                    db_cursor = conn.execute(
                        "SELECT conversation_id, title, updated_at, "
                        "platform_id, content "
                        "FROM conversations "
                        "WHERE platform_id IN ('Abyss', 'Abyss_Den') "
                        "ORDER BY updated_at DESC",
                    )
                else:
                    escaped = self._core.to_unicode_escaped(query)
                    db_cursor = conn.execute(
                        "SELECT conversation_id, title, updated_at, "
                        "platform_id, content "
                        "FROM conversations "
                        "WHERE platform_id IN ('Abyss', 'Abyss_Den') "
                        "AND (content LIKE ? OR content LIKE ?) "
                        "ORDER BY updated_at DESC",
                        (f"%{query}%", f"%{escaped}%"),
                    )

                for row in db_cursor:
                    content = row[4]
                    if not content:
                        continue

                    try:
                        messages = json.loads(content)
                    except (json.JSONDecodeError, TypeError):
                        continue

                    matches = self._extract_conversation_matches(
                        messages, query, mode,
                    )

                    # SQL searches the full JSON, so it may match an
                    # ignored structural field.  Only keep real matches.
                    if not matches:
                        continue

                    conv = self._core.serialize_conversation(
                        row, pinned_ids, active_cid,
                    )
                    conv["matches"] = matches
                    results.append(conv)

                    if len(results) >= 30:
                        break

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
                        self._core.serialize_conversation(row, pinned_ids, active_cid)
                    )

            conn.close()
            await ws.send_json({"type": "search_results", "results": results, "mode": mode})
        except Exception as exc:
            logger.warning(f"Search failed: {exc}")
