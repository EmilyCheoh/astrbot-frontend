"""Authentication rate limiter for the A&F Web Frontend.

Transport-agnostic — manages auth state only, knows nothing about
WebSocket or aiohttp. The adapter handles error sending.
"""

import hmac
import time
from collections import deque

from astrbot import logger


class AuthGuard:
    """Tracks auth failures and enforces timed lockout."""

    def __init__(
        self,
        fail_limit: int = 5,
        window: int = 600,
        lock_duration: int = 600,
    ) -> None:
        self._failures: deque[float] = deque()    # monotonic timestamps
        self._locked_until: float = 0.0            # monotonic deadline
        self._fail_limit = fail_limit
        self._window = window                      # seconds
        self._lock_duration = lock_duration        # seconds

    def is_locked(self) -> bool:
        """Check whether auth is currently locked due to too many failures."""
        return time.monotonic() < self._locked_until

    def record_failure(self) -> None:
        """Record an auth failure. Triggers lockout if limit is reached."""
        now = time.monotonic()
        # Purge entries outside the sliding window
        while self._failures and self._failures[0] < now - self._window:
            self._failures.popleft()
        self._failures.append(now)
        if len(self._failures) >= self._fail_limit:
            self._locked_until = now + self._lock_duration
            logger.warning(
                f"Auth rate limit triggered: locked for {self._lock_duration}s"
            )

    def clear_failures(self) -> None:
        """Clear all recorded failures (called on successful auth)."""
        self._failures.clear()

    def retry_after(self) -> int:
        """Seconds remaining until lockout expires (0 if not locked)."""
        return max(0, int(self._locked_until - time.monotonic()))

    def compare_token(self, provided: str, expected: str) -> bool:
        """Constant-time token comparison."""
        return hmac.compare_digest(str(provided), str(expected))
