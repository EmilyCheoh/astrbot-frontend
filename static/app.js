(() => {
  "use strict";

  // ==================================================================
  // Theme — Light / Dark / Auto (3-state cycle)
  // ==================================================================

  const THEME_MODES = ["light", "dark", "auto"];
  const THEME_ICONS = { light: "\u2600\uFE0E", dark: "\u263E", auto: "\u25D0" };

  function getResolvedTheme(mode) {
    if (mode === "auto") {
      return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
    }
    return mode;
  }

  function applyTheme(mode) {
    const resolved = getResolvedTheme(mode);
    document.documentElement.setAttribute("data-theme", resolved);
    localStorage.setItem("den-theme", mode);
    const btn = document.getElementById("theme-toggle");
    if (btn) {
      btn.textContent = THEME_ICONS[mode];
      btn.title = "Theme: " + mode;
    }
  }

  function cycleTheme() {
    const current = localStorage.getItem("den-theme") || "auto";
    const next = THEME_MODES[(THEME_MODES.indexOf(current) + 1) % THEME_MODES.length];
    applyTheme(next);
  }

  // Re-apply when system preference changes (only matters in auto mode)
  window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
    if ((localStorage.getItem("den-theme") || "auto") === "auto") {
      applyTheme("auto");
    }
  });

  applyTheme(localStorage.getItem("den-theme") || "auto");

  // ==================================================================
  // Font — Serif / Sans-serif toggle
  // ==================================================================

  const FONT_SERIF = 'Georgia, "Times New Roman", serif';
  const FONT_SANS  = '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';

  function applyFont(family) {
    const isSerif = family === "serif";
    document.documentElement.style.setProperty(
      "--font-bot",
      isSerif ? FONT_SERIF : FONT_SANS
    );
    localStorage.setItem("den-font", family);
    const btn = document.getElementById("font-toggle");
    if (btn) {
      btn.className = "icon-btn " + (isSerif ? "serif" : "sans");
      btn.title = "Font: " + family;
    }
  }

  function cycleFont() {
    const current = localStorage.getItem("den-font") || "serif";
    applyFont(current === "serif" ? "sans-serif" : "serif");
  }

  applyFont(localStorage.getItem("den-font") || "serif");

  // ==================================================================
  // Markdown rendering
  // ==================================================================

  function renderMarkdown(text) {
    if (!text) return "";
    if (typeof marked !== "undefined" && typeof DOMPurify !== "undefined") {
      const html = marked.parse(text, { breaks: true, gfm: true });
      return DOMPurify.sanitize(html, {
        ADD_TAGS: ["details", "summary"],
        ADD_ATTR: ["open"],
      });
    }
    // Fallback: escape HTML and convert newlines to <br>
    const el = document.createElement("span");
    el.textContent = text;
    return el.innerHTML.replace(/\n/g, "<br>");
  }

  // ==================================================================
  // DOM refs
  // ==================================================================

  const loginDiv          = document.getElementById("login");
  const chatDiv           = document.getElementById("chat");
  const tokenInput        = document.getElementById("token-input");
  const loginBtn          = document.getElementById("login-btn");
  const messagesDiv       = document.getElementById("messages");
  const chatScroll        = document.getElementById("chat-scroll");
  const thinkingIndicator = document.getElementById("thinking-indicator");
  const msgInput          = document.getElementById("msg-input");
  const sendBtn           = document.getElementById("send-btn");
  const themeToggle       = document.getElementById("theme-toggle");
  const fontToggle        = document.getElementById("font-toggle");
  const panelToggle       = document.getElementById("panel-toggle");
  const panelOverlay      = document.getElementById("panel-overlay");
  const convPanel         = document.getElementById("conv-panel");
  const convList          = document.getElementById("conv-list");
  const newConvBtn        = document.getElementById("new-conv-btn");
  const attachBtn         = document.getElementById("attach-btn");
  const fileInput         = document.getElementById("file-input");
  const imgPreview        = document.getElementById("img-preview");

  let ws = null;
  let savedToken = null;
  let reconnectDelay = 1000;
  let reconnecting = false;
  let pendingImages = [];  // data URIs waiting to be sent

  // ==================================================================
  // WebSocket connection
  // ==================================================================

  function connect(token) {
    savedToken = token;
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    ws = new WebSocket(`${proto}//${location.host}/ws`);

    ws.onopen = () => {
      ws.send(JSON.stringify({ type: "auth", token: savedToken }));
      reconnectDelay = 1000;
    };

    ws.onmessage = (evt) => {
      const data = JSON.parse(evt.data);
      handleMessage(data);
    };

    ws.onclose = () => {
      if (savedToken && !reconnecting) {
        scheduleReconnect();
      }
    };

    ws.onerror = () => {
      // onclose fires after this — reconnection handled there
    };
  }

  // ==================================================================
  // Auto-reconnect
  // ==================================================================

  function scheduleReconnect() {
    reconnecting = true;
    setTimeout(() => {
      reconnecting = false;
      connect(savedToken);
      reconnectDelay = Math.min(reconnectDelay * 1.5, 15000);
    }, reconnectDelay);
  }

  // ==================================================================
  // Incoming message handler
  // ==================================================================

  function handleMessage(data) {
    switch (data.type) {
      case "auth_ok":
        loginDiv.classList.add("hidden");
        chatDiv.classList.remove("hidden");
        thinkingIndicator.classList.add("hidden");
        msgInput.focus();
        break;

      case "error":
        alert(data.message || "Authentication failed");
        savedToken = null;
        break;

      case "message_ack":
        break;

      case "status":
        if (data.status === "thinking") {
          thinkingIndicator.classList.remove("hidden");
          scrollToBottom();
        } else {
          thinkingIndicator.classList.add("hidden");
        }
        break;

      case "message":
        thinkingIndicator.classList.add("hidden");
        appendBot(data.segments || []);
        break;

      case "history":
        messagesDiv.innerHTML = "";
        renderHistory(data.messages || []);
        break;

      case "conversations_list":
        renderConvList(data.conversations || []);
        break;

      case "conversation_switched":
        closePanel();
        break;

      case "conversation_created":
        messagesDiv.innerHTML = "";
        closePanel();
        break;
    }
  }

  // ==================================================================
  // Render conversation history from DB
  // ==================================================================

  const TIMESTAMP_TAG_RE = /<(?:current_)?date_and_time>[\s\S]*?<\/(?:current_)?date_and_time>\s*$/;

  function renderHistory(messages) {
    for (const msg of messages) {
      const role = msg.role || "system";
      if (role === "tool" || role === "system") continue;

      let text = "";
      let thinkText = "";

      if (Array.isArray(msg.content)) {
        for (const block of msg.content) {
          if (block.type === "thinking" || block.type === "think") {
            thinkText += (block.thinking || block.think || block.text || block.content || "") + "\n";
          } else if (block.type === "text") {
            text += block.text || block.content || "";
          } else if (typeof block === "string") {
            text += block;
          } else {
            text += block.text || block.content || JSON.stringify(block);
          }
        }
      } else {
        text = typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content);
      }

      // Strip AstrBot timestamp injection from user messages
      text = text.replace(TIMESTAMP_TAG_RE, "").trim();

      if (!text && !thinkText.trim()) continue;

      if (role === "user") {
        appendUser(text);
      } else if (role === "assistant") {
        const segments = [];
        if (thinkText.trim()) {
          segments.push({ type: "reasoning", data: thinkText.trim() });
        }
        if (text) {
          segments.push({ type: "text", data: text });
        }
        if (segments.length > 0) {
          appendBot(segments);
        }
      }
    }

    scrollToBottom();
  }

  // ==================================================================
  // Render messages
  // ==================================================================

  function createActionBar(actions) {
    const bar = document.createElement("div");
    bar.className = "msg-actions";
    for (const { icon, title, onClick } of actions) {
      const btn = document.createElement("button");
      btn.className = "msg-action-btn";
      btn.title = title;
      btn.innerHTML = icon;
      btn.addEventListener("click", onClick);
      bar.appendChild(btn);
    }
    return bar;
  }

  const ICON_COPY = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';
  const ICON_CHECK = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>';
  const ICON_RETRY = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>';
  const ICON_EDIT = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.83 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/></svg>';

  function copyText(text, btn) {
    navigator.clipboard.writeText(text).then(() => {
      const original = btn.innerHTML;
      btn.innerHTML = ICON_CHECK;
      btn.classList.add("copied");
      setTimeout(() => {
        btn.innerHTML = original;
        btn.classList.remove("copied");
      }, 1500);
    });
  }

  function appendUser(text) {
    const wrapper = document.createElement("div");
    wrapper.className = "msg-row msg-row-user";

    const div = document.createElement("div");
    div.className = "msg-user";
    div.textContent = text;

    const actions = createActionBar([
      { icon: ICON_COPY, title: "Copy", onClick: (e) => copyText(text, e.currentTarget) },
    ]);

    wrapper.appendChild(div);
    wrapper.appendChild(actions);
    messagesDiv.appendChild(wrapper);
    scrollToBottom();
  }

  function appendBot(segments) {
    const row = document.createElement("div");
    row.className = "msg-row msg-row-bot";

    const wrapper = document.createElement("div");
    wrapper.className = "msg-bot";

    // Collect plain text from text segments for copy
    let plainText = "";

    for (const seg of segments) {
      switch (seg.type) {
        case "text": {
          const content = document.createElement("div");
          content.innerHTML = renderMarkdown(seg.data);
          wrapper.appendChild(content);
          plainText += seg.data;
          break;
        }

        case "image": {
          const img = document.createElement("img");
          img.src = seg.data;
          wrapper.appendChild(img);
          break;
        }

        case "audio": {
          const audio = document.createElement("audio");
          audio.controls = true;
          audio.src = seg.data;
          wrapper.appendChild(audio);
          break;
        }

        case "reasoning": {
          const details = document.createElement("details");
          details.className = "cot-block";
          const summary = document.createElement("summary");
          summary.textContent = "Thinking\u2026";
          const body = document.createElement("div");
          body.className = "cot-content";
          body.textContent = seg.data;
          details.appendChild(summary);
          details.appendChild(body);
          wrapper.appendChild(details);
          break;
        }
      }
    }

    const actions = createActionBar([
      { icon: ICON_COPY, title: "Copy", onClick: (e) => copyText(plainText, e.currentTarget) },
    ]);

    row.appendChild(wrapper);
    row.appendChild(actions);
    messagesDiv.appendChild(row);
    scrollToBottom();
  }

  function scrollToBottom() {
    requestAnimationFrame(() => {
      chatScroll.scrollTop = chatScroll.scrollHeight;
    });
  }

  // ==================================================================
  // Send message
  // ==================================================================

  function sendMessage() {
    const text = msgInput.value.trim();
    const images = pendingImages.slice();
    if ((!text && images.length === 0) || !ws || ws.readyState !== WebSocket.OPEN) return;

    const id = crypto.randomUUID();
    const payload = { type: "message", id, content: text };
    if (images.length > 0) payload.images = images;

    ws.send(JSON.stringify(payload));
    appendUser(text || "[image]");
    msgInput.value = "";
    msgInput.style.height = "auto";
    clearPendingImages();
  }

  // ==================================================================
  // Auto-resize textarea
  // ==================================================================

  msgInput.addEventListener("input", () => {
    msgInput.style.height = "auto";
    msgInput.style.height = Math.min(msgInput.scrollHeight, 120) + "px";
  });

  // ==================================================================
  // Image attachment
  // ==================================================================

  function addImages(files) {
    for (const file of files) {
      if (!file.type.startsWith("image/")) continue;
      const reader = new FileReader();
      reader.onload = () => {
        pendingImages.push(reader.result);
        renderImagePreview();
      };
      reader.readAsDataURL(file);
    }
  }

  function renderImagePreview() {
    imgPreview.innerHTML = "";
    if (pendingImages.length === 0) {
      imgPreview.classList.add("hidden");
      return;
    }
    imgPreview.classList.remove("hidden");
    pendingImages.forEach((uri, i) => {
      const item = document.createElement("div");
      item.className = "img-preview-item";

      const img = document.createElement("img");
      img.src = uri;

      const rm = document.createElement("button");
      rm.className = "img-preview-remove";
      rm.textContent = "\u00D7";
      rm.addEventListener("click", () => {
        pendingImages.splice(i, 1);
        renderImagePreview();
      });

      item.appendChild(img);
      item.appendChild(rm);
      imgPreview.appendChild(item);
    });
  }

  function clearPendingImages() {
    pendingImages.length = 0;
    renderImagePreview();
  }

  // ==================================================================
  // Conversation panel
  // ==================================================================

  function openPanel() {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ type: "list_conversations" }));
    convPanel.classList.add("open");
    panelOverlay.classList.remove("hidden");
    panelOverlay.classList.add("open");
  }

  function closePanel() {
    convPanel.classList.remove("open");
    panelOverlay.classList.remove("open");
    // Wait for slide-out transition, then hide overlay
    setTimeout(() => {
      if (!convPanel.classList.contains("open")) {
        panelOverlay.classList.add("hidden");
      }
    }, 260);
  }

  function renderConvList(conversations) {
    convList.innerHTML = "";
    for (const conv of conversations) {
      const btn = document.createElement("button");
      btn.className = "conv-item" + (conv.active ? " active" : "");

      const preview = document.createElement("div");
      preview.className = "conv-item-preview";
      preview.textContent = conv.preview || "(empty)";

      const time = document.createElement("div");
      time.className = "conv-item-time";
      time.textContent = formatTime(conv.updated_at);

      btn.appendChild(preview);
      btn.appendChild(time);

      btn.addEventListener("click", () => {
        if (!ws || ws.readyState !== WebSocket.OPEN) return;
        ws.send(JSON.stringify({
          type: "switch_conversation",
          conversation_id: conv.id,
        }));
      });

      convList.appendChild(btn);
    }
  }

  function formatTime(ts) {
    if (!ts) return "";
    try {
      const d = new Date(ts);
      if (isNaN(d.getTime())) return ts;
      const mm = String(d.getMonth() + 1).padStart(2, "0");
      const dd = String(d.getDate()).padStart(2, "0");
      const hh = String(d.getHours()).padStart(2, "0");
      const mi = String(d.getMinutes()).padStart(2, "0");
      return `${mm}-${dd} ${hh}:${mi}`;
    } catch {
      return ts;
    }
  }

  // ==================================================================
  // Event listeners
  // ==================================================================

  loginBtn.addEventListener("click", () => connect(tokenInput.value));
  tokenInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") connect(tokenInput.value);
  });

  sendBtn.addEventListener("click", sendMessage);

  themeToggle.addEventListener("click", cycleTheme);
  fontToggle.addEventListener("click", cycleFont);

  panelToggle.addEventListener("click", openPanel);
  panelOverlay.addEventListener("click", closePanel);
  newConvBtn.addEventListener("click", () => {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ type: "new_conversation" }));
  });

  attachBtn.addEventListener("click", () => fileInput.click());
  fileInput.addEventListener("change", () => {
    if (fileInput.files.length > 0) addImages(fileInput.files);
    fileInput.value = "";
  });

  // Paste image from clipboard
  msgInput.addEventListener("paste", (e) => {
    const items = e.clipboardData && e.clipboardData.items;
    if (!items) return;
    const imageFiles = [];
    for (const item of items) {
      if (item.type.startsWith("image/")) {
        const file = item.getAsFile();
        if (file) imageFiles.push(file);
      }
    }
    if (imageFiles.length > 0) {
      e.preventDefault();
      addImages(imageFiles);
    }
  });
})();
