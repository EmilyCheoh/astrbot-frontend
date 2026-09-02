"""Platform event for the A&F Web Frontend.

Handles sending AstrBot responses back to the frontend via WebSocket.

Each event is bound to a specific source WebSocket and turn token at
creation time.  Responses always route to the source socket, not to
the adapter's current ``_active_ws`` — this prevents in-flight replies
from leaking to a newly connected client during handoff.
"""

from __future__ import annotations

import asyncio
from typing import TYPE_CHECKING

from astrbot.api.event import AstrMessageEvent, MessageChain
from astrbot.api.platform import AstrBotMessage, PlatformMetadata

from .media_utils import chain_to_segments

if TYPE_CHECKING:
    from aiohttp import web
    from .frontend_adapter import FrontendAdapter


class FrontendEvent(AstrMessageEvent):
    """Message event bound to a specific WebSocket connection and turn token."""

    def __init__(
        self,
        message_str: str,
        message_obj: AstrBotMessage,
        platform_meta: PlatformMetadata,
        session_id: str,
        adapter: "FrontendAdapter",
        source_ws: "web.WebSocketResponse",
        turn_token: object,
        is_stop: bool = False,
    ):
        super().__init__(message_str, message_obj, platform_meta, session_id)
        self._adapter = adapter
        self._source_ws = source_ws
        self._turn_token = turn_token
        self._is_stop = is_stop

    async def send(self, message: MessageChain):
        """Push the response back through the source WebSocket connection.

        For stop events the AstrBot result text is swallowed and a single
        ``stop_ack`` is sent instead.  Normal events deliver message
        segments as before.  Neither path emits ``status: idle`` — turn
        finalisation is handled exclusively by
        :meth:`cleanup_temporary_local_files`.
        """
        ws = self._source_ws

        if self._is_stop:
            # Swallow the stop handler's result; send stop_ack once
            if not self.get_extra("_den_stop_ack_sent"):
                self.set_extra("_den_stop_ack_sent", True)
                if ws is not None and not ws.closed:
                    try:
                        stop_id = self.message_obj.message_id
                        await ws.send_json({
                            "type": "stop_ack", "id": stop_id,
                        })
                    except Exception:
                        pass
            await super().send(message)
            return

        if ws is not None and not ws.closed:
            segments = await chain_to_segments(message)
            await ws.send_json({"type": "message", "segments": segments})

        await super().send(message)

    async def send_idle_once(self):
        """Send ``status: idle`` to the frontend at most once per event.

        Idempotent — safe to call multiple times; only the first call
        actually transmits.  The flag is set *before* the send attempt
        so concurrent callers cannot slip through the guard.
        """
        if self.get_extra("_den_idle_sent"):
            return

        self.set_extra("_den_idle_sent", True)

        ws = self._source_ws
        if ws is None or ws.closed:
            return

        try:
            payload = {"type": "status", "status": "idle"}
            if self.message_obj and self.message_obj.message_id:
                payload["id"] = self.message_obj.message_id
            await ws.send_json(payload)
        except Exception:
            pass

    # -- Pipeline completion hook -------------------------------------------

    def cleanup_temporary_local_files(self) -> None:
        """Override: clean temp files, release turn, then notify frontend.

        Called by ``PipelineScheduler.execute()`` in its ``finally``
        block, AFTER ``_process_stages()`` has fully returned — meaning
        ``_save_to_history()`` has finished and the UMO session lock has
        been released.

        Turn release is synchronous so it succeeds even when the event
        loop is shutting down.  The async idle notification follows as
        a best-effort task.
        """
        try:
            super().cleanup_temporary_local_files()
        finally:
            self._adapter.finish_turn(self._turn_token)

            # Stop events already sent stop_ack — no idle needed
            if not self._is_stop:
                try:
                    loop = asyncio.get_running_loop()
                    loop.create_task(self.send_idle_once())
                except RuntimeError:
                    pass
