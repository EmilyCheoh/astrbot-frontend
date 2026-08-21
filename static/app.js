(() => {
  "use strict";

  // ---- DOM refs ----
  const loginDiv    = document.getElementById("login");
  const chatDiv     = document.getElementById("chat");
  const tokenInput  = document.getElementById("token-input");
  const loginBtn    = document.getElementById("login-btn");
  const messagesDiv = document.getElementById("messages");
  const statusBar   = document.getElementById("status-bar");
  const msgInput    = document.getElementById("msg-input");
  const sendBtn     = document.getElementById("send-btn");

  let ws = null;

  // ---- Login ----
  function connect(token) {
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    ws = new WebSocket(`${proto}//${location.host}/ws`);

    ws.onopen = () => {
      ws.send(JSON.stringify({ type: "auth", token }));
    };

    ws.onmessage = (evt) => {
      const data = JSON.parse(evt.data);
      handleMessage(data);
    };

    ws.onclose = () => {
      appendSystem("Connection closed. Refresh to reconnect.");
    };

    ws.onerror = () => {
      appendSystem("Connection error.");
    };
  }

  // ---- Handle incoming messages ----
  function handleMessage(data) {
    switch (data.type) {
      case "auth_ok":
        loginDiv.classList.add("hidden");
        chatDiv.classList.remove("hidden");
        msgInput.focus();
        break;

      case "error":
        alert(data.message || "Authentication failed");
        break;

      case "message_ack":
        // Message received by server, nothing to do
        break;

      case "status":
        if (data.status === "thinking") {
          statusBar.classList.remove("hidden");
        } else {
          statusBar.classList.add("hidden");
        }
        break;

      case "message":
        statusBar.classList.add("hidden");
        appendBot(data.segments || []);
        break;
    }
  }

  // ---- Append messages ----
  function appendUser(text) {
    const div = document.createElement("div");
    div.className = "msg user";
    div.textContent = text;
    messagesDiv.appendChild(div);
    scrollToBottom();
  }

  function appendBot(segments) {
    const div = document.createElement("div");
    div.className = "msg bot";

    for (const seg of segments) {
      if (seg.type === "text") {
        const span = document.createElement("span");
        span.textContent = seg.data;
        div.appendChild(span);
      } else if (seg.type === "image") {
        const img = document.createElement("img");
        img.src = seg.data;
        div.appendChild(img);
      } else if (seg.type === "audio") {
        const audio = document.createElement("audio");
        audio.controls = true;
        audio.src = seg.data;
        div.appendChild(audio);
      }
    }

    messagesDiv.appendChild(div);
    scrollToBottom();
  }

  function appendSystem(text) {
    const div = document.createElement("div");
    div.className = "msg bot";
    div.style.color = "#999";
    div.style.fontStyle = "italic";
    div.textContent = text;
    messagesDiv.appendChild(div);
    scrollToBottom();
  }

  function scrollToBottom() {
    messagesDiv.scrollTop = messagesDiv.scrollHeight;
  }

  // ---- Send message ----
  function sendMessage() {
    const text = msgInput.value.trim();
    if (!text || !ws || ws.readyState !== WebSocket.OPEN) return;

    const id = crypto.randomUUID();
    ws.send(JSON.stringify({ type: "message", id, content: text }));
    appendUser(text);
    msgInput.value = "";
    msgInput.style.height = "auto";
  }

  // ---- Auto-resize textarea ----
  msgInput.addEventListener("input", () => {
    msgInput.style.height = "auto";
    msgInput.style.height = Math.min(msgInput.scrollHeight, 120) + "px";
  });

  // ---- Event listeners ----
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
})();
