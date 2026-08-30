from astrbot.api.event import filter, AstrMessageEvent
from astrbot.api.star import Context, Star

from . import runtime
from .frontend_adapter import FrontendAdapter  # noqa: F401
from .frontend_event import FrontendEvent


class Main(Star):
    def __init__(self, context: Context):
        super().__init__(context)
        runtime.conversation_manager = context.conversation_manager

    # ---- Den-only lifecycle hooks ----------------------------------------
    #
    # These hooks control when ``status: idle`` is sent to the frontend.
    # FrontendEvent.send() no longer emits idle automatically; instead,
    # the hooks below determine the correct moment — exactly once, after
    # the entire agent turn (or non-agent command) has finished.
    #
    # Every hook gates on ``isinstance(event, FrontendEvent)`` so QQ and
    # all other platforms are completely unaffected.

    @filter.on_agent_begin()
    async def _den_agent_begin(self, event: AstrMessageEvent, run_context):
        if not isinstance(event, FrontendEvent):
            return
        event.set_extra("_den_agent_active", True)

    @filter.on_agent_done()
    async def _den_agent_done(self, event: AstrMessageEvent, run_context, resp):
        if not isinstance(event, FrontendEvent):
            return
        event.set_extra("_den_agent_active", False)

        # Determine whether a final downstream event.send() is expected.
        # on_agent_done fires BEFORE the final result passes through
        # RespondStage, so we must NOT send idle here when there is
        # still content to deliver — otherwise the frontend would
        # finalise the row before the last segments arrive.
        has_text = bool(getattr(resp, "completion_text", None))
        has_chain = bool(
            getattr(resp, "result_chain", None)
            and getattr(resp.result_chain, "chain", None)
        )

        if has_text or has_chain:
            # Flag it — FrontendEvent.send() will consume this after
            # transporting the final segments.
            event.set_extra("_den_finish_after_send", True)
        else:
            # Nothing left to send (e.g. agent finished with an empty
            # response).  Emit idle immediately.
            await event.send_idle_once()

    @filter.on_llm_tool_respond(priority=-10000)
    async def _den_direct_tool_finish(
        self, event: AstrMessageEvent, tool, tool_args, tool_result,
    ):
        """Handle direct-send tools that return ``None``.

        These tools terminate the agent loop without triggering
        ``on_agent_done``, so the turn would otherwise stay stuck
        in the processing state.
        """
        if not isinstance(event, FrontendEvent):
            return
        if tool_result is not None:
            return
        event.set_extra("_den_agent_active", False)
        await event.send_idle_once()

    @filter.after_message_sent(priority=-10000)
    async def _den_after_send(self, event: AstrMessageEvent):
        """Final fallback — guarantees idle is always sent exactly once.

        Covers:
        * ``_den_finish_after_send`` still True — the expected final
          content was stripped during result decoration (e.g. TTS
          suppressing the plain text).
        * Non-agent command responses (``_den_agent_active`` was never
          set or is already False, and no idle has been sent yet).
        * Terminal error results (``GENERAL_RESULT``) where the agent
          is still marked active — the error is the last thing sent.
        """
        if not isinstance(event, FrontendEvent):
            return

        # Consume leftover flag (final content was suppressed).
        if event.get_extra("_den_finish_after_send"):
            event.set_extra("_den_finish_after_send", False)
            await event.send_idle_once()
            return

        # If the agent is still active AND this is an intermediate
        # LLM result, do NOT send idle — more content is coming.
        if event.get_extra("_den_agent_active"):
            result = event.get_result()
            if result is not None:
                rct = getattr(result, "result_content_type", None)
                # ResultContentType.LLM_RESULT — intermediate content
                # before a tool call; do not finalise.
                if rct is not None and rct.name == "LLM_RESULT":
                    return
            # Terminal non-model result (error, command output) while
            # agent is active — finalise so the composer unlocks.
            await event.send_idle_once()
            return

        # Ordinary non-agent command response.
        await event.send_idle_once()
