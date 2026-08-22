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

  let ws = null;
  let savedToken = null;
  let reconnectDelay = 1000;
  let reconnecting = false;

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
        renderHistory(data.messages || []);
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
            thinkText += (block.think || block.text || block.content || "") + "\n";
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

  function appendUser(text) {
    const div = document.createElement("div");
    div.className = "msg-user";
    div.textContent = text;
    messagesDiv.appendChild(div);
    scrollToBottom();
  }

  function appendBot(segments) {
    const wrapper = document.createElement("div");
    wrapper.className = "msg-bot";

    for (const seg of segments) {
      switch (seg.type) {
        case "text": {
          const content = document.createElement("div");
          content.innerHTML = renderMarkdown(seg.data);
          wrapper.appendChild(content);
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

    messagesDiv.appendChild(wrapper);
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
    if (!text || !ws || ws.readyState !== WebSocket.OPEN) return;

    const id = crypto.randomUUID();
    ws.send(JSON.stringify({ type: "message", id, content: text }));
    appendUser(text);
    msgInput.value = "";
    msgInput.style.height = "auto";
  }

  // ==================================================================
  // Auto-resize textarea
  // ==================================================================

  msgInput.addEventListener("input", () => {
    msgInput.style.height = "auto";
    msgInput.style.height = Math.min(msgInput.scrollHeight, 120) + "px";
  });

  // ==================================================================
  // Event listeners
  // ==================================================================

  loginBtn.addEventListener("click", () => connect(tokenInput.value));
  tokenInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") connect(tokenInput.value);
  });

  sendBtn.addEventListener("click", sendMessage);
  msgInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  });

  themeToggle.addEventListener("click", cycleTheme);
  fontToggle.addEventListener("click", cycleFont);
})();
