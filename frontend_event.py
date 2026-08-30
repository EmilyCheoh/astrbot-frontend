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
        """Push the response back through the active WebSocket connection.

        Does NOT emit ``status: idle`` automatically — the lifecycle
        hooks in ``main.py`` determine the correct moment to finalise
        the turn via :meth:`send_idle_once`.
        """
        ws = self._adapter._active_ws

        if ws is not None and not ws.closed:
            segments = await chain_to_segments(message)
            await ws.send_json({"type": "message", "segments": segments})

        # Always call super — lets AstrBot run post-send hooks
        await super().send(message)

        # Direct send from a command/plugin that bypasses RespondStage
        # entirely (no agent lifecycle, no pipeline result).  Send idle
        # here because after_message_sent will never fire for these.
        # When a pipeline result IS set, RespondStage may split the
        # response into multiple send() calls (e.g. text + TTS audio),
        # so we must wait for after_message_sent to finalise.
        if (
            self.get_extra("_den_agent_active") is None
            and self.get_result() is None
        ):
            await self.send_idle_once()

    async def send_idle_once(self):
        """Send ``status: idle`` to the frontend at most once per event.

        Idempotent — safe to call multiple times; only the first call
        actually transmits.  Stored state lives in event extras so it
        is scoped to this single event, not to the adapter.
        """
        if self.get_extra("_den_idle_sent"):
            return

        ws = self._adapter._active_ws
        if ws is not None and not ws.closed:
            await ws.send_json({"type": "status", "status": "idle"})

        self.set_extra("_den_idle_sent", True)
