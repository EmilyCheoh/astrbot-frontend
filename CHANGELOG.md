debugging

* sidebar now highlights active conversation

* fixed tool call rendering order

* changed icon position + fixed block width

* optimized Favorite and pagination

* fix(sidebar): address race conditions, ghost anchors, scroll reset, and failure paths

- Generation counter prevents stale list responses from corrupting sidebar state
- Search anchor cleared on non-anchor navigation (click + history arrival)
- Scroll resets to top on sidebar reopen, preserved on load-more
- Pin lock scope expanded to cover favorites fetch + response send
- Backend sends conversations_list_failed / navigation_failed on errors
- Frontend clears pending states on failure responses

* 继续优化sidebar

---

V9

refactor frontend_adapter.py

1. refactor: extract media_utils.py from frontend_adapter

- New media_utils.py: chain_to_segments, parse_tool_call_text,
  media_to_data_uri, save_temp_media
- frontend_event.py: import chain_to_segments from media_utils
- frontend_adapter.py: import from media_utils, remove old methods,
  clean up unused imports (base64, mimetypes, os, Node, Record)
- Pure code move, no behavior changes

2. refactor: extract auth_guard.py from frontend_adapter

- New AuthGuard class: is_locked, record_failure, clear_failures,
  retry_after, compare_token (transport-agnostic)
- Adapter keeps _send_rate_limited (WebSocket error sending)
- Clean up dead imports (hmac, time, deque)
- Pure code move, no behavior changes

3. refactor: extract conversation_service.py from frontend_adapter

- New ConversationService class: history loading, conversation list,
  switch/new, search, view_history, pin/unpin, rename/delete,
  DB location, pin storage, unicode escape helper
- Adapter dispatch table rewired to self.conversations.*
- runtime.conversation_manager read dynamically (never cached)
- Clean up dead import (math)
- Pure code move, no behavior changes

4. refactor: extract message_service.py from frontend_adapter

- New MessageService class: on_message, handle_retry_or_edit,
  truncate_last_exchange, AstrBotMessage construction, FrontendEvent creation
- MessageService receives adapter ref + ConversationService via constructor
- runtime.conversation_manager read dynamically (never cached)
- Adapter reduced from ~1056 to ~297 lines — pure dispatcher
- Clean up all dead imports
- Pure code move, no behavior changes
---

V8

full refactor

* 修复错误 token 无限重连的问题

* 修复rename的bug

* add rate limiter

---

V7

show tool call

---

V6

integrated Log Viewer

+ optimized search UI

+ optimized sidebar UI + rename /delete function

---

V5
edit + retry

system指令的保护机制

---

V4
* Add copy button under message bubbles
* Change Enter key to not send — only send button sends

---

v3 - supporting image

Now show chat history - done

Aug 22 - V2

+ 锁屏后自动重连