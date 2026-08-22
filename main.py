from astrbot.api.star import Context, Star
from astrbot.api.event import filter

from .frontend_adapter import FrontendAdapter  # noqa: F401


class Main(Star):
    def __init__(self, context: Context):
        super().__init__(context)

    @filter.on_astrbot_loaded()
    async def on_loaded(self):
        adapter = next(
            (p for p in self.context.platform_manager.get_insts()
             if isinstance(p, FrontendAdapter)),
            None,
        )
        if adapter is not None:
            adapter.conversation_manager = self.context.conversation_manager
