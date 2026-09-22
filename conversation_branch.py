"""Branch and patch logic for the A&F Web Frontend.

Handles branch-point computation, patch-target resolution, and the
``handle_branch`` WebSocket handler.  Shared state comes from
``ConversationCore``.
"""

import json
import re

from aiohttp import web

from astrbot import logger

from . import runtime
from .conversation_core import ConversationCore


_TIMESTAMP_TAG_RE = re.compile(
    r"<(?:current_)?date_and_time>"
    r"[\s\S]*?"
    r"</(?:current_)?date_and_time>\s*$"
)


class ConversationBranchService:
    """Branch creation and patch-target resolution."""

    def __init__(self, core: ConversationCore) -> None:
        self._core = core

    # -- Text extraction -------------------------------------------------------

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

    # -- Branch-point computation ----------------------------------------------

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

            # Skip assistants the frontend would never show a Branch for.
            # A thinking-only entry is rendered as a CoT block but does
            # not receive a branch_index on the frontend, so the backend
            # must not create a branch point for it either — otherwise
            # the sequential indices drift apart.
            has_tool_calls = bool(assistant.get("tool_calls"))
            if not display_text and not has_tool_calls:
                last_assistant_index = None
                return

            points.append({
                "role": "assistant",
                "message_index": last_assistant_index,
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
                # Skip slash commands — they don't get branch indices
                # on the frontend, so the backend must not count them
                if display_text and not display_text.lstrip().startswith("/"):
                    points.append({
                        "role": "user",
                        "message_index": raw_index,
                        "cut_index": raw_index,
                        "display_text": display_text,
                    })
                continue

            if role == "assistant":
                last_assistant_index = raw_index

        # Close the last turn at end of history
        finish_turn(len(history) - 1)
        return points

    # -- Patch target resolution -----------------------------------------------

    @classmethod
    def resolve_patch_target(
        cls,
        history: list[dict],
        branch_index: int,
        expected_role: str,
    ) -> dict | None:
        """Resolve a branch_index to a patch target with message_index.

        Returns the branch point dict (role, message_index, cut_index,
        display_text) or ``None`` if the index is out of range or the
        role does not match.
        """
        points = cls._build_branch_points(history)
        if branch_index < 0 or branch_index >= len(points):
            return None
        point = points[branch_index]
        if point["role"] != expected_role:
            return None
        return point

    # -- WebSocket handler -----------------------------------------------------

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
            loaded = self._core.load_conversation_history(
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
            source_umo = self._core.resolve_umo(source_platform_id)
            source = await manager.get_conversation(
                source_umo, source_cid,
            )

            if not source:
                await self._send_branch_failed(ws, source_cid)
                return

            base_title = source.title
            if not base_title:
                base_title = self._core.extract_preview(
                    None,
                    json.dumps(source_history, ensure_ascii=False),
                )
            if not base_title or base_title == "(empty)":
                base_title = "conversation"

            branched_title = f"{base_title}-branched"

            den_platform_id = self._core.config.get("id", "abyss_web")

            new_cid = await manager.new_conversation(
                self._core.umo,
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
                "platform_id": den_platform_id,
            })

        except Exception as exc:
            logger.warning(
                f"Failed to branch conversation {source_cid}: {exc}"
            )
            await self._send_branch_failed(ws, source_cid)
