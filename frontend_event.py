"""Platform event for the A&F Web Frontend.

Handles sending AstrBot responses back to the frontend via WebSocket.
"""

from __future__ import annotations

from typing import TYPE_CHECKING

from astrbot.api.event import AstrMessageEvent, MessageChain
from astrbot.api.platform import AstrBotMessage, PlatformMetadata

from .media_utils import chain_to_segments

if TYPE_CHECKING:
    from .frontend_adapter import FrontendAdapter


class FrontendEvent(AstrMessageEvent):
    """Message event bound to a WebSocket connection through the adapter."""

    def __init__(
        self,
        message_str: str,
        message_obj: AstrBotMessage,
        platform_meta: PlatformMetadata,
        session_id: str,
        adapter: "FrontendAdapter",
    ):
        super().__init__(message_str, message_obj, platform_meta, session_id)
        self._adapter = adapter

    async def send(self, message: MessageChain):
        """Push the response back through the active WebSocket connection."""
        ws = self._adapter._active_ws

        if ws is not None and not ws.closed:
            segments = await chain_to_segments(message)
            await ws.send_json({"type": "message", "segments": segments})

            # Clear the "thinking" indicator
            await ws.send_json({"type": "status", "status": "idle"})

        # Always call super — lets AstrBot run post-send hooks
        await super().send(message)
