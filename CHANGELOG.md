V9

refactor frontend_adapter.py

1. refactor: extract media_utils.py from frontend_adapter

- New media_utils.py: chain_to_segments, parse_tool_call_text,
  media_to_data_uri, save_temp_media
- frontend_event.py: import chain_to_segments from media_utils
- frontend_adapter.py: import from media_utils, remove old methods,
  clean up unused imports (base64, mimetypes, os, Node, Record)
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