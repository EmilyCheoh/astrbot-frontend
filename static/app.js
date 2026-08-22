(() => {
  "use strict";

  // ==================================================================
  // Theme
  // ==================================================================

  function initTheme() {
    const saved = localStorage.getItem("den-theme");
    if (saved === "light" || saved === "dark") {
      document.documentElement.setAttribute("data-theme", saved);
    } else {
      const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
      document.documentElement.setAttribute("data-theme", prefersDark ? "dark" : "light");
    }
  }

  function toggleTheme() {
    const current = document.documentElement.getAttribute("data-theme");
    const next = current === "dark" ? "light" : "dark";
    document.documentElement.setAttribute("data-theme", next);
    localStorage.setItem("den-theme", next);
  }

  initTheme();

  // ==================================================================
  // Markdown rendering
  // ==================================================================

  function renderMarkdown(text) {
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
    }
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

  themeToggle.addEventListener("click", toggleTheme);
})();
