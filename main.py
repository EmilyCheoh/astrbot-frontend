from astrbot.api.star import Context, Star


class Main(Star):
    def __init__(self, context: Context):
        super().__init__(context)
        from .frontend_adapter import FrontendAdapter  # noqa: F401
