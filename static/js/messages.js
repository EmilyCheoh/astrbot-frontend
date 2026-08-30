/* ================================================================
   Den — Messages
   Rendering, markdown, CoT, tool calls, edit/retry, formatToolArgs.
   ================================================================ */

import { state } from "./state.js";
import { dom } from "./dom.js";
import { send, isConnected } from "./socket.js";
import { updateComposerAvailability } from "./composer.js";

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
const ICON_PATCH = '<svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true"><g transform="rotate(-45 12 12)"><rect x="0.9" y="6.9" width="22.2" height="10.2" rx="5.1" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"/><rect x="9.2" y="9.2" width="5.6" height="5.6" rx="0.7" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linejoin="round"/><circle cx="4.75" cy="10" r="0.55" fill="currentColor"/><circle cx="6.15" cy="13.9" r="0.55" fill="currentColor"/><circle cx="17.85" cy="10.1" r="0.55" fill="currentColor"/><circle cx="19.25" cy="14" r="0.55" fill="currentColor"/></g></svg>';
const ICON_BRANCH = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 12h5c3 0 4.5-1.5 6-3l4-4"/><path d="M14 5h4v4"/><path d="m14 15 4 4"/><path d="M14 19h4v-4"/></svg>';

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

// ---- Branch indexing ----
// Counts only messages that display a Branch button (user messages
// with text + final assistant messages).  Resets on full history render.
let nextBranchIndex = 0;

function assignBranchIndex(row) {
  row.dataset.branchIndex = String(nextBranchIndex);
  nextBranchIndex += 1;
}

function findFinalAssistantIndices(messages) {
  const finalIndices = new Set();
  let lastAssistantIndex = null;

  function finishTurn() {
    if (lastAssistantIndex !== null) {
      finalIndices.add(lastAssistantIndex);
      lastAssistantIndex = null;
    }
  }

  for (let i = 0; i < messages.length; i++) {
    const role = messages[i]?.role;
    if (role === "user") {
      finishTurn();
    } else if (role === "assistant") {
      lastAssistantIndex = i;
    }
  }

  finishTurn();
  return finalIndices;
}

function handleBranchClick(row, role) {
  if (state.isProcessing || state.isBranching || !isConnected()) return;

  const branchIndex = Number(row.dataset.branchIndex);
  if (!Number.isInteger(branchIndex)) return;

  state.isBranching = true;

  send({
    type: "branch_conversation",
    conversation_id: state.currentConversationId,
    branch_index: branchIndex,
    role,
    display_text: row.dataset.text || "",
  });
}

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
  if (text) {
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

  // Branch index for user messages with text
  if (text) {
    assignBranchIndex(wrapper);
  }

  // Action bar — skip Edit for attachment messages, skip Copy if no text
  const actionList = [];
  if (!hasAttachment) {
    actionList.push({ icon: ICON_EDIT, title: "Edit", onClick: () => handleEditClick(wrapper), className: "edit-btn" });
    actionList.push({ icon: ICON_PATCH, title: "Correct without reply", onClick: () => handleUserPatchClick(wrapper), className: "patch-btn" });
  }
  if (text) {
    actionList.push({ icon: ICON_BRANCH, title: "Branch in new conversation", onClick: () => handleBranchClick(wrapper, "user"), className: "branch-btn" });
    actionList.push({ icon: ICON_COPY, title: "Copy", onClick: (e) => copyText(wrapper.dataset.text || "", e.currentTarget) });
  }
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
      content.className = "msg-bot-text";
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

export function appendBot(segments, { complete = false } = {}) {
  // Reuse pending row or create a new one
  let row = pendingBotRow;
  let wrapper;

  if (!row || !row.isConnected) {
    row = document.createElement("div");
    row.className = "msg-row msg-row-bot";
    row.dataset.text = "";

    wrapper = document.createElement("div");
    wrapper.className = "msg-bot";

    row.appendChild(wrapper);
    dom.messages.appendChild(row);
  } else {
    wrapper = row.querySelector(".msg-bot");
  }

  // Render all segments and accumulate visible text
  for (const seg of segments) {
    appendSegment(wrapper, seg);
    if (seg.type === "text") {
      row.dataset.text = (row.dataset.text || "") + (seg.data || "");
    }
  }

  pendingBotRow = row;

  if (complete) {
    finalizePendingBotRow();
  }

  if (!state.batchRendering) updateLastActions();
  scrollToBottom();
}

export function finalizePendingBotRow() {
  const row = pendingBotRow;
  if (!row || !row.isConnected) {
    pendingBotRow = null;
    return;
  }

  // Prevent double finalization
  if (row.dataset.complete === "true") {
    pendingBotRow = null;
    return;
  }

  row.dataset.complete = "true";
  const plainText = row.dataset.text || "";

  // Determine whether this row represents a branch-eligible assistant reply.
  // Pure CoT rows must never consume a branch_index — otherwise every
  // later index becomes offset from the backend's sequential numbering.
  const hasToolCall = !!row.querySelector(".tool-call-block");
  const branchable = !!plainText || hasToolCall;

  if (branchable) {
    assignBranchIndex(row);
  }

  // Hide Retry if the preceding user message carried attachments
  const userRows = dom.messages.querySelectorAll(".msg-row-user");
  const lastUserRow = userRows.length > 0 ? userRows[userRows.length - 1] : null;
  const userHasAttachment = lastUserRow && lastUserRow.dataset.hasAttachment;

  const botActions = [
    ...(!userHasAttachment
      ? [{ icon: ICON_RETRY, title: "Retry", onClick: () => handleRetryClick(row), className: "retry-btn" }]
      : []),
    ...(plainText && !hasToolCall
      ? [{ icon: ICON_PATCH, title: "Edit response", onClick: () => handleAssistantEditClick(row), className: "edit-btn" }]
      : []),
    ...(branchable
      ? [{ icon: ICON_BRANCH, title: "Branch in new conversation", onClick: () => handleBranchClick(row, "assistant"), className: "branch-btn" }]
      : []),
    ...(plainText
      ? [{ icon: ICON_COPY, title: "Copy", onClick: (e) => copyText(row.dataset.text || "", e.currentTarget) }]
      : []),
  ];

  if (botActions.length > 0) {
    row.appendChild(createActionBar(botActions));
  }

  pendingBotRow = null;
  updateLastActions();
}

// ---- Render full history ----

export function renderHistory(messages) {
  nextBranchIndex = 0;
  state.batchRendering = true;
  const finalAssistantIndices = findFinalAssistantIndices(messages);
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
        appendBot(segments, { complete: finalAssistantIndices.has(i) });
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

  // Lock immediately — do not wait for server's "thinking" status
  state.isProcessing = true;
  updateComposerAvailability();

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

    // Lock immediately — do not wait for server's "thinking" status
    state.isProcessing = true;
    updateComposerAvailability();

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

// ---- Assistant edit (no LLM re-fire) ----

let pendingAssistantEdit = null;

function handleAssistantEditClick(botRow) {
  if (state.isProcessing || state.isReadonly || !botRow.classList.contains("is-last")) return;
  if (botRow.querySelector(".bot-edit-area")) return;

  const wrapper = botRow.querySelector(".msg-bot");
  const textBlocks = wrapper.querySelectorAll(".msg-bot-text");
  const actionsBar = botRow.querySelector(".msg-actions") || wrapper.querySelector(".msg-actions");
  const originalText = botRow.dataset.text || "";

  // Hide text blocks and action bar
  textBlocks.forEach((block) => block.classList.add("hidden"));
  if (actionsBar) actionsBar.classList.add("hidden");

  const editArea = document.createElement("div");
  editArea.className = "edit-area bot-edit-area";

  const textarea = document.createElement("textarea");
  textarea.className = "edit-textarea";
  textarea.value = originalText;

  const btnRow = document.createElement("div");
  btnRow.className = "edit-btns";

  const cancelBtn = document.createElement("button");
  cancelBtn.className = "edit-cancel-btn";
  cancelBtn.textContent = "Cancel";

  const confirmBtn = document.createElement("button");
  confirmBtn.className = "edit-send-btn";
  confirmBtn.textContent = "Confirm";
  confirmBtn.disabled = !originalText.trim();

  function closeBotEdit() {
    // Block ESC/Cancel while waiting for backend save
    if (pendingAssistantEdit?.editArea === editArea) {
      return;
    }

    editArea.remove();
    textBlocks.forEach((block) => block.classList.remove("hidden"));
    if (actionsBar) actionsBar.classList.remove("hidden");
    pendingAssistantEdit = null;
  }

  function updateConfirmAvailability() {
    confirmBtn.disabled = !textarea.value.trim();
  }

  cancelBtn.addEventListener("click", closeBotEdit);

  confirmBtn.addEventListener("click", () => {
    const newText = textarea.value.trim();
    if (!newText || !isConnected()) return;

    // Clear previous error if retrying
    editArea.querySelector(".bot-edit-error")?.remove();

    // Keep edit area visible until backend confirms
    confirmBtn.disabled = true;
    cancelBtn.disabled = true;
    pendingAssistantEdit = { botRow, editArea, textBlocks, actionsBar };

    send({
      type: "edit_assistant_message",
      conversation_id: state.currentConversationId,
      original_content: originalText,
      content: newText,
    });
  });

  textarea.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      closeBotEdit();
    }
  });

  textarea.addEventListener("input", () => {
    updateConfirmAvailability();
    textarea.style.height = "auto";
    textarea.style.height = Math.min(textarea.scrollHeight, 200) + "px";
  });

  btnRow.appendChild(cancelBtn);
  btnRow.appendChild(confirmBtn);
  editArea.appendChild(textarea);
  editArea.appendChild(btnRow);

  // Insert edit area after the last text block (before tool calls if any)
  const lastTextBlock = textBlocks.length > 0 ? textBlocks[textBlocks.length - 1] : null;
  if (lastTextBlock && lastTextBlock.nextSibling) {
    wrapper.insertBefore(editArea, lastTextBlock.nextSibling);
  } else {
    wrapper.appendChild(editArea);
  }

  requestAnimationFrame(() => {
    textarea.style.height = Math.min(textarea.scrollHeight, 200) + "px";
    textarea.focus();
  });
}

export function handleAssistantEditSuccess(data) {
  const edit = pendingAssistantEdit;
  if (!edit) return;

  const { botRow, editArea, textBlocks, actionsBar } = edit;

  // Extract visible text from the authoritative backend message
  const msg = data.message || {};
  let editedText = "";
  if (typeof msg.content === "string") {
    editedText = msg.content;
  } else if (Array.isArray(msg.content)) {
    editedText = msg.content
      .filter((b) => b && b.type === "text")
      .map((b) => b.text || "")
      .join("");
  }

  // Remove old text blocks
  textBlocks.forEach((block) => block.remove());

  // Render new text through markdown + DOMPurify
  const newContent = document.createElement("div");
  newContent.className = "msg-bot-text";
  newContent.innerHTML = renderMarkdown(editedText);

  // Insert where the edit area is, then remove edit area
  editArea.parentNode.insertBefore(newContent, editArea);
  editArea.remove();

  // Update stored text
  botRow.dataset.text = editedText;

  // Update in-memory history
  if (data.message_index != null && state.currentMessages[data.message_index]) {
    state.currentMessages[data.message_index] = data.message;
  }

  // Restore action bar
  if (actionsBar) actionsBar.classList.remove("hidden");

  pendingAssistantEdit = null;
}

export function handleAssistantEditFailure() {
  const edit = pendingAssistantEdit;
  if (!edit) return;

  // Re-enable buttons so the user can try again or cancel
  const confirmBtn = edit.editArea.querySelector(".edit-send-btn");
  const cancelBtn = edit.editArea.querySelector(".edit-cancel-btn");
  if (confirmBtn) confirmBtn.disabled = false;
  if (cancelBtn) cancelBtn.disabled = false;

  // Show inline error hint
  let errorText = edit.editArea.querySelector(".bot-edit-error");
  if (!errorText) {
    errorText = document.createElement("div");
    errorText.className = "bot-edit-error";
    errorText.textContent = "Couldn't save the edit.";
    const btnRow = edit.editArea.querySelector(".edit-btns");
    edit.editArea.insertBefore(errorText, btnRow);
  }

  pendingAssistantEdit = null;
}

// ---- User message patch (no LLM re-fire) ----

let pendingUserPatch = null;

function handleUserPatchClick(userRow) {
  if (
    state.isProcessing
    || state.isReadonly
    || !userRow.classList.contains("is-last")
    || pendingUserPatch
    || !isConnected()
  ) return;

  const displayContent = userRow.dataset.text || "";
  if (displayContent.trimStart().startsWith("/")) return;

  const patchBtn = userRow.querySelector(".patch-btn");
  if (patchBtn) patchBtn.disabled = true;

  pendingUserPatch = {
    phase: "preparing",
    conversationId: state.currentConversationId,
    userRow,
    patchBtn,
    displayContent,
  };

  send({
    type: "prepare_user_message_patch",
    conversation_id: state.currentConversationId,
    display_content: displayContent,
  });
}

export function handleUserPatchReady(data) {
  if (!pendingUserPatch || pendingUserPatch.phase !== "preparing") return;
  if (data.conversation_id !== state.currentConversationId) {
    if (pendingUserPatch.patchBtn) pendingUserPatch.patchBtn.disabled = false;
    pendingUserPatch = null;
    return;
  }

  const { userRow } = pendingUserPatch;
  const msgDiv = userRow.querySelector(".msg-user");
  const actionsBar = userRow.querySelector(".msg-actions");

  msgDiv.classList.add("hidden");
  if (actionsBar) actionsBar.classList.add("hidden");

  pendingUserPatch.phase = "editing";
  pendingUserPatch.originalRawText = data.raw_text;
  pendingUserPatch.messageIndex = data.message_index;
  pendingUserPatch.blockIndex = data.block_index;
  pendingUserPatch.contentKind = data.content_kind;
  pendingUserPatch.revision = data.revision;
  pendingUserPatch.msgDiv = msgDiv;
  pendingUserPatch.actionsBar = actionsBar;

  const editArea = document.createElement("div");
  editArea.className = "edit-area patch-edit-area";
  pendingUserPatch.editArea = editArea;

  const label = document.createElement("div");
  label.className = "patch-edit-label";
  label.textContent = "Save only";

  const textarea = document.createElement("textarea");
  textarea.className = "edit-textarea";
  textarea.value = data.raw_text;

  const btnRow = document.createElement("div");
  btnRow.className = "edit-btns";

  const cancelBtn = document.createElement("button");
  cancelBtn.className = "edit-cancel-btn";
  cancelBtn.textContent = "Cancel";

  const saveBtn = document.createElement("button");
  saveBtn.className = "edit-send-btn";
  saveBtn.textContent = "Save";

  const maxHeight = 400;

  function closePatchEditor() {
    if (pendingUserPatch?.phase === "saving") return;
    editArea.remove();
    msgDiv.classList.remove("hidden");
    if (actionsBar) actionsBar.classList.remove("hidden");
    if (pendingUserPatch?.patchBtn) pendingUserPatch.patchBtn.disabled = false;
    pendingUserPatch = null;
  }

  cancelBtn.addEventListener("click", closePatchEditor);

  saveBtn.addEventListener("click", () => {
    if (textarea.value === pendingUserPatch?.originalRawText) {
      closePatchEditor();
      return;
    }

    if (!isConnected()) return;

    editArea.querySelector(".patch-edit-error")?.remove();

    saveBtn.disabled = true;
    cancelBtn.disabled = true;
    pendingUserPatch.phase = "saving";

    send({
      type: "save_user_message_patch",
      conversation_id: state.currentConversationId,
      message_index: pendingUserPatch.messageIndex,
      block_index: pendingUserPatch.blockIndex,
      content_kind: pendingUserPatch.contentKind,
      raw_text: textarea.value,
      revision: pendingUserPatch.revision,
    });
  });

  textarea.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && pendingUserPatch?.phase !== "saving") {
      e.preventDefault();
      e.stopPropagation();
      closePatchEditor();
    }
  });

  textarea.addEventListener("input", () => {
    textarea.style.height = "auto";
    textarea.style.height = Math.min(textarea.scrollHeight, maxHeight) + "px";
  });

  btnRow.appendChild(cancelBtn);
  btnRow.appendChild(saveBtn);
  editArea.appendChild(label);
  editArea.appendChild(textarea);
  editArea.appendChild(btnRow);
  userRow.insertBefore(editArea, actionsBar);

  requestAnimationFrame(() => {
    textarea.style.height = Math.min(textarea.scrollHeight, maxHeight) + "px";
    textarea.focus();
  });
}

export function resetUserPatchState() {
  pendingUserPatch = null;
}

export function handleUserPatchSuccess(data) {
  if (!pendingUserPatch) return;

  if (
    data.conversation_id !== pendingUserPatch.conversationId
    || data.conversation_id !== state.currentConversationId
  ) {
    pendingUserPatch = null;
    return;
  }

  const { userRow, msgDiv, actionsBar, editArea } = pendingUserPatch;
  const rawText = data.raw_text || "";

  msgDiv.textContent = rawText;
  userRow.dataset.text = rawText;

  if (data.message_index != null && state.currentMessages[data.message_index]) {
    const msg = state.currentMessages[data.message_index];
    if (typeof msg.content === "string") {
      msg.content = rawText;
    } else if (Array.isArray(msg.content)) {
      const textBlock = msg.content.find(b => b && b.type === "text");
      if (textBlock) textBlock.text = rawText;
    }
  }

  editArea.remove();
  msgDiv.classList.remove("hidden");
  if (actionsBar) actionsBar.classList.remove("hidden");
  if (pendingUserPatch.patchBtn) pendingUserPatch.patchBtn.disabled = false;
  pendingUserPatch = null;
}

export function handleUserPatchFailure(data) {
  if (!pendingUserPatch) return;

  if (pendingUserPatch.phase === "preparing") {
    if (pendingUserPatch.patchBtn) pendingUserPatch.patchBtn.disabled = false;
    pendingUserPatch = null;
    return;
  }

  const saveBtn = pendingUserPatch.editArea?.querySelector(".edit-send-btn");
  const cancelBtnEl = pendingUserPatch.editArea?.querySelector(".edit-cancel-btn");
  if (saveBtn) saveBtn.disabled = false;
  if (cancelBtnEl) cancelBtnEl.disabled = false;
  pendingUserPatch.phase = "editing";

  let errorEl = pendingUserPatch.editArea?.querySelector(".patch-edit-error");
  if (!errorEl && pendingUserPatch.editArea) {
    errorEl = document.createElement("div");
    errorEl.className = "patch-edit-error";
    errorEl.textContent = "Could not save \u2014 the stored message changed.";
    const btnRowEl = pendingUserPatch.editArea.querySelector(".edit-btns");
    pendingUserPatch.editArea.insertBefore(errorEl, btnRowEl);
  }
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
    dom.attachBtn.disabled = false;
    if (composer) composer.classList.remove("composer-readonly");
    if (existing) existing.remove();
  }
}
