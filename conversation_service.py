"""Conversation CRUD, search, history, and pin management for the A&F Web Frontend.

All conversation-related operations extracted from FrontendAdapter.
Uses runtime.conversation_manager dynamically at call time (never cached).
"""

import asyncio
import json
import os
import re
import sqlite3
import tempfile
from pathlib import Path

from aiohttp import web

from astrbot import logger

from . import runtime


_TIMESTAMP_TAG_RE = re.compile(
    r"<(?:current_)?date_and_time>"
    r"[\s\S]*?"
    r"</(?:current_)?date_and_time>\s*$"
)


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

    # -- Navigation failure helper --------------------------------------------

    @staticmethod
    async def _send_navigation_failed(
        ws: web.WebSocketResponse, conversation_id: str | None,
    ):
        """Send a terminal navigation failure to the frontend."""
        try:
            await ws.send_json({
                "type": "navigation_failed",
                "conversation_id": conversation_id,
            })
        except Exception:
            pass

    # -- History loading -------------------------------------------------------

    def _load_conversation_history(
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

    async def send_history(
        self, ws: web.WebSocketResponse, conversation_id: str | None = None,
    ):
        """Load conversation history and send to client (auth flow only).

        If *conversation_id* is given, load that specific conversation.
        Otherwise fall back to the most recently updated one.
        """
        try:
            platform_id = self._config.get("id", "abyss_web")

            if conversation_id:
                result = self._load_conversation_history(
                    conversation_id, platform_id,
                )
                if result is not None:
                    messages, _ = result
                    cid = conversation_id
                else:
                    messages, cid = [], conversation_id
            else:
                db_path = self.find_db()
                if not db_path:
                    logger.warning("Chat history DB not found, tried common paths")
                    return
                conn = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
                try:
                    cursor = conn.execute(
                        "SELECT content, conversation_id FROM conversations "
                        "WHERE platform_id = ? ORDER BY updated_at DESC LIMIT 1",
                        (platform_id,),
                    )
                    row = cursor.fetchone()
                finally:
                    conn.close()
                if row and row[0]:
                    messages = json.loads(row[0])
                    cid = row[1]
                else:
                    messages = []
                    cid = row[1] if row else None

            await ws.send_json({
                "type": "history",
                "messages": messages,
                "readonly": False,
                "platform_id": platform_id,
                "conversation_id": cid,
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
        generation: int | None = None,
    ):
        """Send a cursor-paginated list of conversations."""
        try:
            limit = max(1, min(limit, 50))

            db_path = self.find_db()
            if not db_path:
                raise FileNotFoundError("Chat history DB not found")

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

            response = {
                "type": "conversations_list",
                "conversations": conversations,
                "next_cursor": next_cursor,
                "has_more": has_more,
            }
            if generation is not None:
                response["generation"] = generation
            await ws.send_json(response)
        except Exception as exc:
            logger.warning(f"Failed to list conversations: {exc}")
            try:
                response = {"type": "conversations_list_failed"}
                if generation is not None:
                    response["generation"] = generation
                await ws.send_json(response)
            except Exception:
                pass

    # -- Switch / New ----------------------------------------------------------

    async def handle_switch(self, ws: web.WebSocketResponse, conversation_id: str):
        """Switch the active conversation pointer and send its history."""
        try:
            if not runtime.conversation_manager:
                logger.warning("Conversation manager not available yet")
                await self._send_navigation_failed(ws, conversation_id)
                return

            # Load and validate history BEFORE switching the pointer.
            # If this fails the server pointer stays unchanged.
            platform_id = self._config.get("id", "abyss_web")
            result = self._load_conversation_history(conversation_id, platform_id)
            if result is None:
                await self._send_navigation_failed(ws, conversation_id)
                return

            messages, pid = result

            # History validated — safe to switch pointer now
            await runtime.conversation_manager.switch_conversation(
                self._umo, conversation_id,
            )
            await ws.send_json({
                "type": "history",
                "messages": messages,
                "readonly": False,
                "platform_id": pid,
                "conversation_id": conversation_id,
            })
            await ws.send_json({
                "type": "conversation_switched",
                "conversation_id": conversation_id,
            })
        except Exception as exc:
            logger.warning(f"Failed to switch conversation: {exc}")
            await self._send_navigation_failed(ws, conversation_id)

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

    # -- Branch ----------------------------------------------------------------

    @staticmethod
    def _extract_branch_text(message: dict) -> str:
        """Extract visible text from a message, stripping timestamp tags."""
        content = message.get("content", "")

        if isinstance(content, str):
            text = content
        elif isinstance(content, list):
            parts: list[str] = []
            for block in content:
                if isinstance(block, str):
                    parts.append(block)
                    continue
                if not isinstance(block, dict):
                    continue
                block_type = block.get("type")
                if block_type in ("thinking", "think"):
                    continue
                if block_type == "text":
                    parts.append(
                        block.get("text")
                        or block.get("content")
                        or ""
                    )
            text = "".join(parts)
        else:
            text = ""

        return _TIMESTAMP_TAG_RE.sub("", text).strip()

    @classmethod
    def _build_branch_points(cls, history: list[dict]) -> list[dict]:
        """Build an ordered list of Branch-eligible positions.

        Each entry maps a frontend branch_index to the raw history
        slice needed.  Uses per-turn scanning so the last assistant
        in each turn is always a valid Branch point — regardless of
        whether it carries tool_calls.
        """
        points: list[dict] = []
        last_assistant_index: int | None = None

        def finish_turn(turn_end_index: int):
            nonlocal last_assistant_index
            if last_assistant_index is None:
                return
            assistant = history[last_assistant_index]
            display_text = cls._extract_branch_text(assistant)

            # Skip assistants the frontend would never render (no segments).
            content = assistant.get("content")
            has_thinking = (
                isinstance(content, list)
                and any(
                    isinstance(block, dict)
                    and block.get("type") in ("thinking", "think")
                    for block in content
                )
            )
            has_tool_calls = bool(assistant.get("tool_calls"))
            if not display_text and not has_thinking and not has_tool_calls:
                last_assistant_index = None
                return

            points.append({
                "role": "assistant",
                "cut_index": turn_end_index + 1,
                "display_text": display_text,
            })
            last_assistant_index = None

        for raw_index, message in enumerate(history):
            if not isinstance(message, dict):
                continue
            role = message.get("role")

            if role == "user":
                # New user message — close previous turn
                finish_turn(raw_index - 1)
                display_text = cls._extract_branch_text(message)
                if display_text:
                    points.append({
                        "role": "user",
                        "cut_index": raw_index,
                        "display_text": display_text,
                    })
                continue

            if role == "assistant":
                last_assistant_index = raw_index

        # Close the last turn at end of history
        finish_turn(len(history) - 1)
        return points

    @staticmethod
    async def _send_branch_failed(
        ws: web.WebSocketResponse,
        conversation_id: str | None,
    ):
        try:
            await ws.send_json({
                "type": "conversation_branch_failed",
                "conversation_id": conversation_id,
            })
        except Exception:
            pass

    async def handle_branch(
        self,
        ws: web.WebSocketResponse,
        data: dict,
    ):
        """Create a new conversation branched from a specific point."""
        source_cid = data.get("conversation_id")
        branch_index = data.get("branch_index")
        expected_role = data.get("role")

        if (
            not source_cid
            or not isinstance(branch_index, int)
            or expected_role not in ("user", "assistant")
        ):
            await self._send_branch_failed(ws, source_cid)
            return

        manager = runtime.conversation_manager
        if not manager:
            logger.warning(
                "Conversation manager not available for branch"
            )
            await self._send_branch_failed(ws, source_cid)
            return

        try:
            loaded = self._load_conversation_history(
                source_cid, ("Abyss", "Abyss_Den"),
            )
            if loaded is None:
                await self._send_branch_failed(ws, source_cid)
                return

            source_history, source_platform_id = loaded

            branch_points = self._build_branch_points(source_history)

            if branch_index < 0 or branch_index >= len(branch_points):
                await self._send_branch_failed(ws, source_cid)
                return

            point = branch_points[branch_index]

            if point["role"] != expected_role:
                await self._send_branch_failed(ws, source_cid)
                return

            branched_history = source_history[:point["cut_index"]]

            if expected_role == "user":
                draft = point["display_text"]
            else:
                draft = ""

            # Resolve source conversation for title and persona
            source_umo = self.resolve_umo(source_platform_id)
            source = await manager.get_conversation(
                source_umo, source_cid,
            )

            if not source:
                await self._send_branch_failed(ws, source_cid)
                return

            base_title = source.title
            if not base_title:
                base_title = self._extract_preview(
                    None,
                    json.dumps(source_history, ensure_ascii=False),
                )
            if not base_title or base_title == "(empty)":
                base_title = "conversation"

            branched_title = f"{base_title}-branched"

            den_platform_id = self._config.get("id", "abyss_web")

            new_cid = await manager.new_conversation(
                self._umo,
                den_platform_id,
                content=branched_history,
                title=branched_title,
                persona_id=source.persona_id,
            )

            await ws.send_json({
                "type": "conversation_branched",
                "source_conversation_id": source_cid,
                "conversation_id": new_cid,
                "title": branched_title,
                "messages": branched_history,
                "draft": draft,
            })

        except Exception as exc:
            logger.warning(
                f"Failed to branch conversation {source_cid}: {exc}"
            )
            await self._send_branch_failed(ws, source_cid)

    # -- Search helpers --------------------------------------------------------

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

    # -- Search ----------------------------------------------------------------

    async def handle_search(self, ws: web.WebSocketResponse, data: dict):
        """Search conversations by title, content, CoT, or date range."""
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
                    escaped = self.to_unicode_escaped(query)
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

                    conv = self._serialize_conversation(
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
            result = self._load_conversation_history(
                conversation_id, ("Abyss", "Abyss_Den"),
            )
            if result is None:
                await self._send_navigation_failed(ws, conversation_id)
                return

            messages, pid = result
            den_pid = self._config.get("id", "abyss_web")
            await ws.send_json({
                "type": "history",
                "messages": messages,
                "readonly": pid != den_pid,
                "platform_id": pid,
                "conversation_id": conversation_id,
            })
        except Exception as exc:
            logger.warning(f"Failed to view history: {exc}")
            await self._send_navigation_failed(ws, conversation_id)

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
