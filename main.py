from astrbot.api.star import Context, Star

from . import runtime
from .frontend_adapter import FrontendAdapter  # noqa: F401


class Main(Star):
    def __init__(self, context: Context):
        super().__init__(context)
        runtime.conversation_manager = context.conversation_manager
