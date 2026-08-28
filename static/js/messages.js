/* ================================================================
   Den — Messages
   Rendering, markdown, CoT, tool calls, edit/retry, formatToolArgs.
   ================================================================ */

import { state } from "./state.js";
import { dom } from "./dom.js";
import { send, isConnected } from "./socket.js";

// ---- Markdown rendering ----

function renderMarkdown(text) {
  if (!text) return "";
  if (typeof window.marked !== "undefined" && typeof window.DOMPurify !== "undefined") {
    const html = window.marked.parse(text, { breaks: true, gfm: true });
    return window.DOMPurify.sanitize(html, {
      ADD_TAGS: ["details", "summary"],
      ADD_ATTR: ["open"],
    });
  }
  // Fallback: escape HTML and convert newlines to <br>
  const el = document.createElement("span");
  el.textContent = text;
  return el.innerHTML.replace(/\n/g, "<br>");
}

// ---- Constants ----

const TIMESTAMP_TAG_RE = /<(?:current_)?date_and_time>[\s\S]*?<\/(?:current_)?date_and_time>\s*$/;

const ICON_COPY = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';
const ICON_CHECK = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>';
const ICON_RETRY = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M23 4v6h-6"/><path d="M1 20v-6h6"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10"/><path d="M20.49 15a9 9 0 0 1-14.85 3.36L1 14"/></svg>';
const ICON_EDIT = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.83 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/></svg>';

// ---- Helpers ----

function formatToolArgs(argsStr) {
  if (!argsStr) return "";
  try {
    const parsed = typeof argsStr === "string" ? JSON.parse(argsStr) : argsStr;
    const keys = Object.keys(parsed);
    if (keys.length === 1 && typeof parsed[keys[0]] === "string") {
      return parsed[keys[0]];
    }
    return JSON.stringify(parsed, null, 2);
  } catch {
    return argsStr;
  }
}

// Accumulates intermediate segments (thinking, tool calls) into
// a single bot row until the final text segment arrives.
let pendingBotRow = null;

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

export function scrollToBottom() {
  requestAnimationFrame(() => {
    dom.chatScroll.scrollTop = dom.chatScroll.scrollHeight;
  });
}

export function updateLastActions() {
  dom.messages.querySelectorAll(".msg-row-user.is-last, .msg-row-bot.is-last")
    .forEach((el) => el.classList.remove("is-last"));
  if (state.isReadonly) return;
  const users = dom.messages.querySelectorAll(".msg-row-user");
  const bots = dom.messages.querySelectorAll(".msg-row-bot");
  if (users.length) users[users.length - 1].classList.add("is-last");
  if (bots.length) bots[bots.length - 1].classList.add("is-last");
}

// ---- Append user message ----

export function appendUser(text, { images = [], files = [], hasAttachment = false } = {}) {
  pendingBotRow = null;  // New user turn — reset accumulator

  const wrapper = document.createElement("div");
  wrapper.className = "msg-row msg-row-user";
  wrapper.dataset.text = text;
  if (hasAttachment) wrapper.dataset.hasAttachment = "true";

  const div = document.createElement("div");
  div.className = "msg-user";

  // Text content
  if (text && text !== "[image]" && text !== "[file]") {
    const textNode = document.createElement("span");
    textNode.textContent = text;
    div.appendChild(textNode);
  }

  // Image thumbnails in bubble
  if (images.length > 0) {
    const strip = document.createElement("div");
    strip.className = "msg-attachment-images";
    for (const img of images) {
      const imgEl = document.createElement("img");
      imgEl.src = img.dataUri || img;
      strip.appendChild(imgEl);
    }
    div.appendChild(strip);
  }

  // File chips in bubble
  if (files.length > 0) {
    const strip = document.createElement("div");
    strip.className = "msg-attachment-files";
    for (const f of files) {
      const chip = document.createElement("span");
      chip.className = "msg-file-chip";
      chip.textContent = f.name || "file";
      strip.appendChild(chip);
    }
    div.appendChild(strip);
  }

  // Action bar — skip Edit for attachment messages
  const actionList = [];
  if (!hasAttachment) {
    actionList.push({ icon: ICON_EDIT, title: "Edit", onClick: () => handleEditClick(wrapper), className: "edit-btn" });
  }
  actionList.push({ icon: ICON_COPY, title: "Copy", onClick: (e) => copyText(text, e.currentTarget) });
  const actions = createActionBar(actionList);

  wrapper.appendChild(div);
  wrapper.appendChild(actions);
  dom.messages.appendChild(wrapper);
  if (!state.batchRendering) updateLastActions();
  scrollToBottom();
}

// ---- Append bot message ----

function appendSegment(wrapper, seg) {
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

    case "tool_call": {
      const tcDetails = document.createElement("details");
      tcDetails.className = "tool-call-block";
      const tcSummary = document.createElement("summary");
      tcSummary.textContent = seg.name || "tool call";
      tcDetails.appendChild(tcSummary);

      if (seg.args) {
        const argsCode = document.createElement("pre");
        argsCode.className = "tool-call-args";
        argsCode.textContent = seg.args;
        tcDetails.appendChild(argsCode);
      }

      if (seg.result) {
        const resultLabel = document.createElement("div");
        resultLabel.className = "tool-call-result-label";
        resultLabel.textContent = "\u2192 result";
        tcDetails.appendChild(resultLabel);

        const resultCode = document.createElement("pre");
        resultCode.className = "tool-call-result";
        resultCode.textContent = seg.result;
        tcDetails.appendChild(resultCode);
      }

      wrapper.appendChild(tcDetails);
      break;
    }
  }
}

export function appendBot(segments) {
  const isIntermediate = segments.length > 0
    && segments.every(s => s.type === "reasoning" || s.type === "tool_call");

  // Reuse pending row or create a new one
  let row = pendingBotRow;
  let wrapper;

  if (!row || !row.isConnected) {
    row = document.createElement("div");
    row.className = "msg-row msg-row-bot";

    wrapper = document.createElement("div");
    wrapper.className = "msg-bot";

    row.appendChild(wrapper);
    dom.messages.appendChild(row);
  } else {
    wrapper = row.querySelector(".msg-bot");
  }

  // Separate content segments from tool_call segments
  const contentSegs = [];
  const toolSegs = [];
  for (const seg of segments) {
    if (seg.type === "tool_call") toolSegs.push(seg);
    else contentSegs.push(seg);
  }

  let plainText = "";

  for (const seg of contentSegs) {
    appendSegment(wrapper, seg);
    if (seg.type === "text") {
      plainText += seg.data || "";
    }
  }

  if (isIntermediate) {
    // Thinking / tool call — render tool calls, hold the row
    for (const seg of toolSegs) {
      appendSegment(wrapper, seg);
    }
    pendingBotRow = row;
  } else {
    // Final text arrived — complete the response row
    const actions = createActionBar([
      { icon: ICON_RETRY, title: "Retry", onClick: () => handleRetryClick(row), className: "retry-btn" },
      { icon: ICON_COPY, title: "Copy", onClick: (e) => copyText(plainText, e.currentTarget) },
    ]);

    if (toolSegs.length > 0) {
      // Action bar inside wrapper, between text and tool calls
      wrapper.appendChild(actions);
      for (const seg of toolSegs) {
        appendSegment(wrapper, seg);
      }
    } else {
      // No tool calls — action bar on the row as usual
      row.appendChild(actions);
    }

    pendingBotRow = null;
  }

  if (!state.batchRendering) updateLastActions();
  scrollToBottom();
}

// ---- Render full history ----

export function renderHistory(messages) {
  state.batchRendering = true;
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
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

    text = text.replace(TIMESTAMP_TAG_RE, "").trim();

    if (role === "user") {
      if (text) appendUser(text);
    } else if (role === "assistant") {
      const segments = [];
      if (thinkText.trim()) {
        segments.push({ type: "reasoning", data: thinkText.trim() });
      }

      if (text) {
        segments.push({ type: "text", data: text });
      }

      if (msg.tool_calls && msg.tool_calls.length > 0) {
        for (const tc of msg.tool_calls) {
          const fn = tc.function || {};
          const toolId = tc.id;
          let resultContent = "";
          for (let j = i + 1; j < messages.length; j++) {
            if (messages[j].role === "tool" && messages[j].tool_call_id === toolId) {
              const rc = messages[j].content;
              resultContent = typeof rc === "string" ? rc : JSON.stringify(rc, null, 2);
              break;
            }
          }
          segments.push({
            type: "tool_call",
            name: fn.name || "tool call",
            args: formatToolArgs(fn.arguments || ""),
            result: resultContent,
          });
        }
      }
      if (segments.length > 0) {
        appendBot(segments);
      }
    }
  }

  state.batchRendering = false;
  updateLastActions();
  scrollToBottom();

  if (state.isReadonly) {
    const existing = document.querySelector(".readonly-divider");
    if (!existing) {
      const divider = document.createElement("div");
      divider.className = "readonly-divider";
      divider.innerHTML = "<span>QQ \u00B7 read only</span>";
      dom.messages.appendChild(divider);
    }
  }
}

// ---- Edit / Retry ----

function handleRetryClick(botRow) {
  if (state.isProcessing || state.isReadonly || !botRow.classList.contains("is-last")) return;

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
  if (state.isProcessing || !isConnected()) return;

  const lastUser = dom.messages.querySelector(".msg-row-user.is-last");
  if (!lastUser) return;
  if (lastUser.dataset.hasAttachment) return; // Cannot retry attachment messages
  const userText = lastUser.dataset.text;
  if (!userText) return;

  // Remove all response rows after the last user message
  let node = lastUser.nextElementSibling;
  while (node) {
    const next = node.nextElementSibling;
    node.remove();
    node = next;
  }
  pendingBotRow = null;
  updateLastActions();

  send({ type: "retry", content: userText });
}

function handleEditClick(userRow) {
  if (state.isProcessing || state.isReadonly || !userRow.classList.contains("is-last")) return;
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
    if (!newText || !isConnected()) return;

    editArea.remove();
    msgDiv.textContent = newText;
    msgDiv.classList.remove("hidden");
    userRow.dataset.text = newText;
    if (actionsBar) actionsBar.classList.remove("hidden");

    // Remove all response rows after this user message
    let node = userRow.nextElementSibling;
    while (node) {
      const next = node.nextElementSibling;
      node.remove();
      node = next;
    }
    pendingBotRow = null;

    send({ type: "edit_message", content: newText });
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

// ---- Scroll-to-bottom button ----

export function initScrollButton() {
  const THRESHOLD = 200;
  const composerSection = document.querySelector(".composer-section");

  function updateScrollBtn() {
    const distFromBottom =
      dom.chatScroll.scrollHeight - dom.chatScroll.scrollTop - dom.chatScroll.clientHeight;
    dom.scrollBottomBtn.classList.toggle("visible", distFromBottom > THRESHOLD);
  }

  dom.chatScroll.addEventListener("scroll", updateScrollBtn, { passive: true });

  // Track composer height + content/viewport resizes so the button
  // always floats above the composer and updates after image loads,
  // orientation changes, conversation switches, etc.
  const ro = new ResizeObserver((entries) => {
    for (const entry of entries) {
      if (entry.target === composerSection) {
        dom.scrollBottomBtn.style.bottom = (composerSection.offsetHeight + 8) + "px";
      }
    }
    updateScrollBtn();
  });
  ro.observe(composerSection);
  ro.observe(dom.chatScroll);
  ro.observe(dom.messages);

  dom.scrollBottomBtn.addEventListener("click", () => {
    dom.chatScroll.scrollTo({ top: dom.chatScroll.scrollHeight, behavior: "smooth" });
  });
}

// ---- Read-only mode ----

export function setComposerReadonly(readonly) {
  state.isReadonly = readonly;
  const composer = document.querySelector(".composer");
  const existing = document.querySelector(".readonly-divider");

  if (readonly) {
    dom.msgInput.disabled = true;
    dom.msgInput.placeholder = "";
    dom.sendBtn.disabled = true;
    dom.attachBtn.disabled = true;
    if (composer) composer.classList.add("composer-readonly");
  } else {
    dom.msgInput.disabled = false;
    dom.msgInput.placeholder = "Talk to me...";
    dom.sendBtn.disabled = false;
    dom.attachBtn.disabled = false;
    if (composer) composer.classList.remove("composer-readonly");
    if (existing) existing.remove();
  }
}
