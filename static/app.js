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

  // New DOM refs
  const searchBtn         = document.getElementById("search-btn");
  const searchOverlay     = document.getElementById("search-overlay");
  const searchInputEl     = document.getElementById("search-input");
  const searchCloseBtn    = document.getElementById("search-close");
  const searchResultsEl   = document.getElementById("search-results");
  const searchDateInputs  = document.getElementById("search-date-inputs");
  const searchDateFrom    = document.getElementById("search-date-from");
  const searchDateTo      = document.getElementById("search-date-to");
  const searchDateApply   = document.getElementById("search-date-apply");
  const paginationEl      = document.getElementById("pagination");
  const moreMenuBtn       = document.getElementById("more-menu-btn");
  const moreMenu          = document.getElementById("more-menu");
  const exportMdBtn       = document.getElementById("export-md-btn");

  // ==================================================================
  // State
  // ==================================================================

  let ws = null;
  let savedToken = null;
  let reconnectDelay = 1000;
  let reconnecting = false;
  let pendingImages = [];
  let isProcessing = false;
  let batchRendering = false;

  // New state
  let currentMessages = [];
  let isReadonly = false;
  let currentConvTitle = "";
  let currentPage = 1;
  let pinnedIds = [];
  let lastConvListData = null;
  let searchDebounce = null;
  let searchMode = "title";

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

    ws.onerror = () => {};
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
          isProcessing = true;
          thinkingIndicator.classList.remove("hidden");
          scrollToBottom();
        } else {
          isProcessing = false;
          thinkingIndicator.classList.add("hidden");
        }
        break;

      case "message":
        isProcessing = false;
        thinkingIndicator.classList.add("hidden");
        appendBot(data.segments || []);
        break;

      case "history":
        currentMessages = data.messages || [];
        isReadonly = data.readonly || false;
        messagesDiv.innerHTML = "";
        renderHistory(currentMessages);
        setComposerReadonly(isReadonly);
        break;

      case "conversations_list":
        lastConvListData = data;
        renderConvList(data);
        break;

      case "conversation_switched":
        isReadonly = false;
        setComposerReadonly(false);
        closePanel();
        break;

      case "conversation_created":
        currentMessages = [];
        isReadonly = false;
        messagesDiv.innerHTML = "";
        setComposerReadonly(false);
        closePanel();
        break;

      case "search_results":
        renderSearchResults(data.results || [], data.mode);
        break;

      case "pin_updated":
        pinnedIds = data.pinned || [];
        if (lastConvListData) {
          for (const conv of lastConvListData.conversations) {
            conv.pinned = pinnedIds.includes(conv.id);
          }
          renderConvList(lastConvListData);
        }
        break;
    }
  }

  // ==================================================================
  // Render conversation history from DB
  // ==================================================================

  const TIMESTAMP_TAG_RE = /<(?:current_)?date_and_time>[\s\S]*?<\/(?:current_)?date_and_time>\s*$/;

  function renderHistory(messages) {
    batchRendering = true;
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

    batchRendering = false;
    updateLastActions();
    scrollToBottom();

    // Add read-only divider if needed
    if (isReadonly) {
      const existing = document.querySelector(".readonly-divider");
      if (!existing) {
        const divider = document.createElement("div");
        divider.className = "readonly-divider";
        divider.innerHTML = "<span>QQ \u00B7 read only</span>";
        messagesDiv.appendChild(divider);
      }
    }
  }

  // ==================================================================
  // Render messages
  // ==================================================================

  function createActionBar(actions) {
    const bar = document.createElement("div");
    bar.className = "msg-actions";
    for (const { icon, title, onClick, className } of actions) {
      const btn = document.createElement("button");
      btn.className = "msg-action-btn" + (className ? " " + className : "");
      btn.title = title;
      btn.innerHTML = icon;
      btn.addEventListener("click", onClick);
      bar.appendChild(btn);
    }
    return bar;
  }

  const ICON_COPY = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';
  const ICON_CHECK = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>';
  const ICON_RETRY = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M23 4v6h-6"/><path d="M1 20v-6h6"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10"/><path d="M20.49 15a9 9 0 0 1-14.85 3.36L1 14"/></svg>';
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
    wrapper.dataset.text = text;

    const div = document.createElement("div");
    div.className = "msg-user";
    div.textContent = text;

    const actions = createActionBar([
      { icon: ICON_EDIT, title: "Edit", onClick: () => handleEditClick(wrapper), className: "edit-btn" },
      { icon: ICON_COPY, title: "Copy", onClick: (e) => copyText(text, e.currentTarget) },
    ]);

    wrapper.appendChild(div);
    wrapper.appendChild(actions);
    messagesDiv.appendChild(wrapper);
    if (!batchRendering) updateLastActions();
    scrollToBottom();
  }

  function appendBot(segments) {
    const row = document.createElement("div");
    row.className = "msg-row msg-row-bot";

    const wrapper = document.createElement("div");
    wrapper.className = "msg-bot";

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
      { icon: ICON_RETRY, title: "Retry", onClick: () => handleRetryClick(row), className: "retry-btn" },
      { icon: ICON_COPY, title: "Copy", onClick: (e) => copyText(plainText, e.currentTarget) },
    ]);

    row.appendChild(wrapper);
    row.appendChild(actions);
    messagesDiv.appendChild(row);
    if (!batchRendering) updateLastActions();
    scrollToBottom();
  }

  function scrollToBottom() {
    requestAnimationFrame(() => {
      chatScroll.scrollTop = chatScroll.scrollHeight;
    });
  }

  // ==================================================================
  // Edit / Retry
  // ==================================================================

  function updateLastActions() {
    messagesDiv.querySelectorAll(".msg-row-user.is-last, .msg-row-bot.is-last")
      .forEach((el) => el.classList.remove("is-last"));
    const users = messagesDiv.querySelectorAll(".msg-row-user");
    const bots = messagesDiv.querySelectorAll(".msg-row-bot");
    if (users.length) users[users.length - 1].classList.add("is-last");
    if (bots.length) bots[bots.length - 1].classList.add("is-last");
  }

  function handleRetryClick(botRow) {
    if (isProcessing || isReadonly || !botRow.classList.contains("is-last")) return;

    const existing = document.querySelector(".retry-confirm");
    if (existing) existing.remove();

    const bar = document.createElement("div");
    bar.className = "retry-confirm";
    bar.innerHTML =
      '<span class="retry-confirm-text">Regenerate this response?</span>' +
      '<div class="retry-confirm-btns">' +
      '<button class="retry-confirm-cancel">Cancel</button>' +
      '<button class="retry-confirm-ok">Confirm</button>' +
      "</div>";

    bar.querySelector(".retry-confirm-cancel").addEventListener("click", () => bar.remove());
    bar.querySelector(".retry-confirm-ok").addEventListener("click", () => {
      bar.remove();
      handleRetry(botRow);
    });

    botRow.appendChild(bar);
  }

  function handleRetry(botRow) {
    if (isProcessing || !ws || ws.readyState !== WebSocket.OPEN) return;

    const lastUser = messagesDiv.querySelector(".msg-row-user.is-last");
    if (!lastUser) return;
    const userText = lastUser.dataset.text;
    if (!userText) return;

    botRow.remove();
    updateLastActions();

    ws.send(JSON.stringify({ type: "retry", content: userText }));
  }

  function handleEditClick(userRow) {
    if (isProcessing || isReadonly || !userRow.classList.contains("is-last")) return;
    if (userRow.querySelector(".edit-area")) return;

    const msgDiv = userRow.querySelector(".msg-user");
    const actionsBar = userRow.querySelector(".msg-actions");
    const originalText = userRow.dataset.text;

    msgDiv.classList.add("hidden");
    if (actionsBar) actionsBar.classList.add("hidden");

    const editArea = document.createElement("div");
    editArea.className = "edit-area";

    const textarea = document.createElement("textarea");
    textarea.className = "edit-textarea";
    textarea.value = originalText;

    const btnRow = document.createElement("div");
    btnRow.className = "edit-btns";

    const cancelBtn = document.createElement("button");
    cancelBtn.className = "edit-cancel-btn";
    cancelBtn.textContent = "Cancel";

    const sendEditBtn = document.createElement("button");
    sendEditBtn.className = "edit-send-btn";
    sendEditBtn.textContent = "Send";

    function closeEdit() {
      editArea.remove();
      msgDiv.classList.remove("hidden");
      if (actionsBar) actionsBar.classList.remove("hidden");
    }

    cancelBtn.addEventListener("click", closeEdit);

    sendEditBtn.addEventListener("click", () => {
      const newText = textarea.value.trim();
      if (!newText || !ws || ws.readyState !== WebSocket.OPEN) return;

      editArea.remove();
      msgDiv.textContent = newText;
      msgDiv.classList.remove("hidden");
      userRow.dataset.text = newText;
      if (actionsBar) actionsBar.classList.remove("hidden");

      const lastBot = messagesDiv.querySelector(".msg-row-bot.is-last");
      if (lastBot) lastBot.remove();

      ws.send(JSON.stringify({ type: "edit_message", content: newText }));
      updateLastActions();
    });

    textarea.addEventListener("keydown", (e) => {
      if (e.key === "Escape") closeEdit();
    });

    textarea.addEventListener("input", () => {
      textarea.style.height = "auto";
      textarea.style.height = Math.min(textarea.scrollHeight, 200) + "px";
    });

    btnRow.appendChild(cancelBtn);
    btnRow.appendChild(sendEditBtn);
    editArea.appendChild(textarea);
    editArea.appendChild(btnRow);
    userRow.insertBefore(editArea, actionsBar);

    requestAnimationFrame(() => {
      textarea.style.height = Math.min(textarea.scrollHeight, 200) + "px";
      textarea.focus();
    });
  }

  // ==================================================================
  // Send message
  // ==================================================================

  function sendMessage() {
    if (isReadonly) return;
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
    ws.send(JSON.stringify({ type: "list_conversations", page: currentPage, limit: 20 }));
    convPanel.classList.add("open");
    panelOverlay.classList.remove("hidden");
    panelOverlay.classList.add("open");
  }

  function closePanel() {
    convPanel.classList.remove("open");
    panelOverlay.classList.remove("open");
    setTimeout(() => {
      if (!convPanel.classList.contains("open")) {
        panelOverlay.classList.add("hidden");
      }
    }, 260);
  }

  function renderConvList(data) {
    const { conversations, page, pages } = data;
    convList.innerHTML = "";

    if (!conversations || conversations.length === 0) {
      convList.innerHTML = '<div class="conv-empty">No conversations</div>';
      renderPagination(page || 1, pages || 1);
      return;
    }

    // Separate pinned and unpinned
    const pinned = conversations.filter(c => c.pinned);
    const unpinned = conversations.filter(c => !c.pinned);

    // Render pinned group
    if (pinned.length > 0) {
      const isExpanded = localStorage.getItem("den-pinned-expanded") !== "false";

      const header = document.createElement("div");
      header.className = "pinned-header";
      header.innerHTML =
        '<span class="pinned-arrow' + (isExpanded ? " expanded" : "") +
        '">\u25B6</span> Favorites (' + pinned.length + ")";

      const container = document.createElement("div");
      container.className = "pinned-items" + (isExpanded ? " expanded" : "");

      for (const conv of pinned) {
        container.appendChild(createConvItem(conv));
      }

      header.addEventListener("click", () => {
        const nowExpanded = container.classList.toggle("expanded");
        header.querySelector(".pinned-arrow").classList.toggle("expanded");
        localStorage.setItem("den-pinned-expanded", String(nowExpanded));
      });

      convList.appendChild(header);
      convList.appendChild(container);
    }

    // Render unpinned
    for (const conv of unpinned) {
      convList.appendChild(createConvItem(conv));
    }

    renderPagination(page || 1, pages || 1);
  }

  function createConvItem(conv) {
    const btn = document.createElement("button");
    btn.className = "conv-item" + (conv.active ? " active" : "");
    btn.dataset.id = conv.id;
    btn.dataset.platform = conv.platform_id;

    // Top row: preview + platform tag + pin
    const topRow = document.createElement("div");
    topRow.className = "conv-item-top";

    const preview = document.createElement("div");
    preview.className = "conv-item-preview";
    preview.textContent = conv.preview || "(empty)";
    topRow.appendChild(preview);

    if (conv.platform_id === "Abyss") {
      const tag = document.createElement("span");
      tag.className = "platform-tag qq";
      tag.textContent = "QQ";
      topRow.appendChild(tag);
    }

    const pinBtn = document.createElement("button");
    pinBtn.className = "conv-pin-btn" + (conv.pinned ? " pinned" : "");
    pinBtn.title = conv.pinned ? "Unpin" : "Pin";
    pinBtn.innerHTML = conv.pinned ? "\u25C6" : "\u25C7";
    pinBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      ws.send(JSON.stringify({
        type: conv.pinned ? "unpin_conversation" : "pin_conversation",
        conversation_id: conv.id,
      }));
    });
    topRow.appendChild(pinBtn);

    // Bottom row: timestamp
    const time = document.createElement("div");
    time.className = "conv-item-time";
    time.textContent = formatTime(conv.updated_at);

    btn.appendChild(topRow);
    btn.appendChild(time);

    btn.addEventListener("click", (e) => {
      if (e.target.closest(".conv-pin-btn")) return;
      currentConvTitle = conv.preview || "conversation";

      if (!ws || ws.readyState !== WebSocket.OPEN) return;

      if (conv.platform_id === "Abyss") {
        // QQ — view only, don't switch pointer
        ws.send(JSON.stringify({
          type: "view_history",
          conversation_id: conv.id,
        }));
        closePanel();
      } else {
        // Den — switch conversation
        ws.send(JSON.stringify({
          type: "switch_conversation",
          conversation_id: conv.id,
        }));
      }
    });

    return btn;
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
  // Pagination
  // ==================================================================

  function renderPagination(page, pages) {
    paginationEl.innerHTML = "";
    if (pages <= 1) return;

    currentPage = page;

    const prev = document.createElement("button");
    prev.className = "page-btn";
    prev.textContent = "\u2039";
    prev.disabled = page <= 1;
    prev.addEventListener("click", () => {
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      ws.send(JSON.stringify({ type: "list_conversations", page: page - 1, limit: 20 }));
    });

    const info = document.createElement("span");
    info.className = "page-info";
    info.textContent = page + " / " + pages;

    const next = document.createElement("button");
    next.className = "page-btn";
    next.textContent = "\u203A";
    next.disabled = page >= pages;
    next.addEventListener("click", () => {
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      ws.send(JSON.stringify({ type: "list_conversations", page: page + 1, limit: 20 }));
    });

    paginationEl.append(prev, info, next);
  }

  // ==================================================================
  // Search overlay
  // ==================================================================

  function openSearch() {
    closePanel();
    searchOverlay.classList.remove("hidden");
    searchInputEl.value = "";
    searchResultsEl.innerHTML = "";
    setSearchMode("title");
    requestAnimationFrame(() => searchInputEl.focus());
  }

  function closeSearch() {
    searchOverlay.classList.add("hidden");
    searchInputEl.value = "";
    searchResultsEl.innerHTML = "";
  }

  function doSearch() {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;

    if (searchMode === "date") {
      const from = searchDateFrom.value;
      const to = searchDateTo.value;
      if (from && to) {
        ws.send(JSON.stringify({
          type: "search_conversations",
          mode: "date",
          date_from: from,
          date_to: to,
        }));
      }
      return;
    }

    const q = searchInputEl.value.trim();
    if (!q) {
      searchResultsEl.innerHTML = "";
      return;
    }
    ws.send(JSON.stringify({
      type: "search_conversations",
      mode: searchMode,
      q: q,
    }));
  }

  function setSearchMode(mode) {
    searchMode = mode;
    document.querySelectorAll(".search-mode-btn").forEach(btn => {
      btn.classList.toggle("active", btn.dataset.mode === mode);
    });

    if (mode === "date") {
      searchInputEl.classList.add("hidden");
      searchDateInputs.classList.remove("hidden");
    } else {
      searchInputEl.classList.remove("hidden");
      searchDateInputs.classList.add("hidden");
      searchInputEl.placeholder = mode === "title" ? "Search titles..." : "Search content...";
      searchInputEl.focus();
    }

    searchResultsEl.innerHTML = "";
  }

  function renderSearchResults(results) {
    searchResultsEl.innerHTML = "";

    if (results.length === 0) {
      searchResultsEl.innerHTML = '<div class="search-empty">No results found</div>';
      return;
    }

    for (const r of results) {
      const item = document.createElement("button");
      item.className = "search-result-item";

      const topRow = document.createElement("div");
      topRow.className = "search-result-top";

      const preview = document.createElement("div");
      preview.className = "search-result-preview";
      preview.textContent = r.preview || "(empty)";
      topRow.appendChild(preview);

      if (r.platform_id === "Abyss") {
        const tag = document.createElement("span");
        tag.className = "platform-tag qq";
        tag.textContent = "QQ";
        topRow.appendChild(tag);
      }

      item.appendChild(topRow);

      if (r.snippet) {
        const snippet = document.createElement("div");
        snippet.className = "search-result-snippet";
        snippet.textContent = r.snippet;
        item.appendChild(snippet);
      }

      const time = document.createElement("div");
      time.className = "search-result-time";
      time.textContent = formatTime(r.updated_at);
      item.appendChild(time);

      item.addEventListener("click", () => {
        currentConvTitle = r.preview || "conversation";
        closeSearch();

        if (!ws || ws.readyState !== WebSocket.OPEN) return;

        if (r.platform_id === "Abyss") {
          ws.send(JSON.stringify({
            type: "view_history",
            conversation_id: r.id,
          }));
        } else {
          ws.send(JSON.stringify({
            type: "switch_conversation",
            conversation_id: r.id,
          }));
        }
      });

      searchResultsEl.appendChild(item);
    }
  }

  // ==================================================================
  // Read-only mode
  // ==================================================================

  function setComposerReadonly(readonly) {
    isReadonly = readonly;
    const composer = document.querySelector(".composer");
    const existing = document.querySelector(".readonly-divider");

    if (readonly) {
      msgInput.disabled = true;
      msgInput.placeholder = "QQ conversation \u00B7 read only";
      sendBtn.disabled = true;
      attachBtn.disabled = true;
      if (composer) composer.classList.add("composer-readonly");
    } else {
      msgInput.disabled = false;
      msgInput.placeholder = "Talk to me...";
      sendBtn.disabled = false;
      attachBtn.disabled = false;
      if (composer) composer.classList.remove("composer-readonly");
      if (existing) existing.remove();
    }
  }

  // ==================================================================
  // Overflow menu
  // ==================================================================

  function toggleMoreMenu() {
    moreMenu.classList.toggle("hidden");
  }

  function closeMoreMenu() {
    moreMenu.classList.add("hidden");
  }

  // ==================================================================
  // Export as Markdown
  // ==================================================================

  function exportMarkdown() {
    if (!currentMessages.length) return;

    let md = "";

    for (const msg of currentMessages) {
      const role = msg.role || "system";

      if (role === "tool") {
        const resultText = typeof msg.content === "string"
          ? msg.content
          : JSON.stringify(msg.content, null, 2);
        md += "<details><summary>\u2192 result</summary>\n\n```\n" + resultText + "\n```\n\n</details>\n\n---\n\n";
        continue;
      }

      const prefix = role === "user" ? "**User:**"
        : role === "assistant" ? "**Assistant:**"
        : "**" + role + ":**";

      let text = "";
      if (Array.isArray(msg.content)) {
        for (const block of msg.content) {
          if (block.type === "thinking" || block.type === "think") {
            const thinkText = block.thinking || block.think || block.text || block.content || "";
            text += "<details><summary>thinking</summary>\n\n" + thinkText + "\n\n</details>\n\n";
          } else if (block.type === "text") {
            text += block.text || block.content || "";
          } else if (typeof block === "string") {
            text += block;
          } else {
            text += block.text || block.content || JSON.stringify(block);
          }
        }
      } else {
        text = typeof msg.content === "string"
          ? msg.content
          : JSON.stringify(msg.content);
      }

      // Strip timestamp tags
      text = text.replace(TIMESTAMP_TAG_RE, "").trim();

      // Append tool_calls
      if (role === "assistant" && msg.tool_calls && msg.tool_calls.length > 0) {
        for (const tc of msg.tool_calls) {
          const fn = tc.function || {};
          let args = fn.arguments || "";
          if (typeof args === "string") {
            try { args = JSON.stringify(JSON.parse(args), null, 2); } catch {}
          } else {
            args = JSON.stringify(args, null, 2);
          }
          text += "\n\n<details><summary>\u26A1 " + (fn.name || "tool call") + "</summary>\n\n```\n" + args + "\n```\n\n</details>";
        }
      }

      md += prefix + "\n\n" + text.trim() + "\n\n---\n\n";
    }

    const blob = new Blob([md], { type: "text/markdown;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    const safeName = (currentConvTitle || "conversation").slice(0, 50).replace(/[/\\?%*:|"<>]/g, "_");
    a.download = safeName + ".md";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);

    closeMoreMenu();
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

  // Search overlay
  searchBtn.addEventListener("click", openSearch);
  searchCloseBtn.addEventListener("click", closeSearch);

  searchInputEl.addEventListener("input", () => {
    clearTimeout(searchDebounce);
    searchDebounce = setTimeout(doSearch, 300);
  });

  searchInputEl.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeSearch();
    if (e.key === "Enter") {
      e.preventDefault();
      clearTimeout(searchDebounce);
      doSearch();
    }
  });

  document.querySelectorAll(".search-mode-btn").forEach(btn => {
    btn.addEventListener("click", () => setSearchMode(btn.dataset.mode));
  });

  searchDateApply.addEventListener("click", doSearch);

  // Overflow menu
  moreMenuBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    toggleMoreMenu();
  });

  document.addEventListener("click", (e) => {
    if (!e.target.closest(".more-menu-wrapper")) {
      closeMoreMenu();
    }
  });

  exportMdBtn.addEventListener("click", exportMarkdown);

  // Global ESC
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      if (!searchOverlay.classList.contains("hidden")) {
        closeSearch();
      }
    }
  });
})();
