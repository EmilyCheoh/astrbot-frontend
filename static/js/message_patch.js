/* ================================================================
   Den — Message Patch
   User and assistant message patch lifecycle (Save only).
   No reverse dependency on messages.js.
   ================================================================ */

import { state } from "./state.js";
import { send, isConnected } from "./socket.js";
import { renderMarkdown } from "./markdown.js";

// ---- Patch: shared state and helpers ----

const PATCH_TIMESTAMP_TAG_RE = /<(?:current_)?date_and_time>[\s\S]*?<\/(?:current_)?date_and_time>\s*$/;

let pendingPatchConfirm = null; // { row, bar }
let pendingUserPatch = null;
let pendingAssistantPatch = null;

function canPatchDisplayedConversation() {
  if (!isConnected() || state.isProcessing) return false;
  if (!state.currentConversationId) return false;
  const pid = state.currentPlatformId;
  return pid === "Abyss" || pid === "Abyss_Den";
}

function closePatchConfirmInner() {
  if (!pendingPatchConfirm) return;
  pendingPatchConfirm.bar.remove();
  pendingPatchConfirm = null;
}

export function closeTopmostPatchLayer() {
  if (pendingPatchConfirm) {
    closePatchConfirmInner();
    return true;
  }
  if (pendingUserPatch) {
    if (pendingUserPatch.phase === "saving") return true;
    pendingUserPatch.cancel?.();
    return true;
  }
  if (pendingAssistantPatch) {
    if (pendingAssistantPatch.phase === "saving") return true;
    pendingAssistantPatch.cancel?.();
    return true;
  }
  return false;
}

function userPatchVisibleText(rawText) {
  return rawText.replace(PATCH_TIMESTAMP_TAG_RE, "").trim();
}

function showPatchConfirm(row, role, branchIndex, displayText) {
  closePatchConfirmInner();

  const bar = document.createElement("div");
  bar.className = "patch-confirm";
  bar.innerHTML =
    '<span class="patch-confirm-text">This may invalidate cached context and increase API cost. Continue?</span>' +
    '<div class="patch-confirm-btns">' +
    '<button class="patch-confirm-cancel">Cancel</button>' +
    '<button class="patch-confirm-ok">Continue</button>' +
    "</div>";

  bar.querySelector(".patch-confirm-cancel").addEventListener("click", closePatchConfirmInner);
  bar.querySelector(".patch-confirm-ok").addEventListener("click", () => {
    closePatchConfirmInner();
    if (role === "user") {
      startUserPatchPrepare(row, branchIndex, displayText);
    } else {
      startAssistantPatchPrepare(row, branchIndex, displayText);
    }
  });

  row.appendChild(bar);
  pendingPatchConfirm = { row, bar };
}

// ---- User message patch (no LLM re-fire) ----

export function handleUserPatchClick(userRow) {
  if (!canPatchDisplayedConversation()) return;
  if (pendingUserPatch || pendingAssistantPatch) return;

  const branchIndex = Number(userRow.dataset.branchIndex);
  if (!Number.isInteger(branchIndex)) return;

  const displayContent = userRow.dataset.text || "";
  if (displayContent.trimStart().startsWith("/")) return;

  closePatchConfirmInner();

  if (userRow.classList.contains("is-last")) {
    startUserPatchPrepare(userRow, branchIndex, displayContent);
  } else {
    showPatchConfirm(userRow, "user", branchIndex, displayContent);
  }
}

function startUserPatchPrepare(userRow, branchIndex, displayContent) {
  if (!canPatchDisplayedConversation()) return;
  if (pendingUserPatch || pendingAssistantPatch) return;

  const patchBtn = userRow.querySelector(".patch-btn");
  if (patchBtn) patchBtn.disabled = true;

  const cid = state.currentConversationId;
  const pid = state.currentPlatformId;

  pendingUserPatch = {
    phase: "preparing",
    conversationId: cid,
    platformId: pid,
    userRow,
    patchBtn,
    branchIndex,
    displayContent,
  };

  send({
    type: "prepare_user_message_patch",
    conversation_id: cid,
    platform_id: pid,
    branch_index: branchIndex,
    expected_role: "user",
    display_content: displayContent,
  });
}

export function handleUserPatchReady(data) {
  if (!pendingUserPatch || pendingUserPatch.phase !== "preparing") return;
  if (
    data.conversation_id !== pendingUserPatch.conversationId
    || data.platform_id !== pendingUserPatch.platformId
  ) return; // stale response — ignore without touching pending

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

  pendingUserPatch.cancel = closePatchEditor;

  cancelBtn.addEventListener("click", closePatchEditor);

  saveBtn.addEventListener("click", () => {
    if (textarea.value === pendingUserPatch?.originalRawText) {
      closePatchEditor();
      return;
    }

    if (!canPatchDisplayedConversation()) return;

    // Prevent patched message from becoming non-branch-eligible
    const visibleText = userPatchVisibleText(textarea.value);
    if (!visibleText || visibleText.startsWith("/")) {
      editArea.querySelector(".patch-edit-error")?.remove();
      const hint = document.createElement("div");
      hint.className = "patch-edit-error";
      hint.textContent = "Patched message cannot be empty or start with /.";
      editArea.insertBefore(hint, editArea.querySelector(".edit-btns"));
      return;
    }

    editArea.querySelector(".patch-edit-error")?.remove();

    saveBtn.disabled = true;
    cancelBtn.disabled = true;
    pendingUserPatch.phase = "saving";

    send({
      type: "save_user_message_patch",
      conversation_id: pendingUserPatch.conversationId,
      platform_id: pendingUserPatch.platformId,
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

export function handleUserPatchSuccess(data) {
  if (!pendingUserPatch) return;
  if (
    data.conversation_id !== pendingUserPatch.conversationId
    || data.platform_id !== pendingUserPatch.platformId
  ) return; // stale response — ignore without touching pending

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
  if (
    data?.conversation_id !== pendingUserPatch.conversationId
    || data?.platform_id !== pendingUserPatch.platformId
  ) return; // stale response — ignore without touching pending

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
    const reason = data?.reason || "";
    errorEl = document.createElement("div");
    errorEl.className = "patch-edit-error";
    errorEl.textContent = reason === "invalid_content"
      ? "Patched message cannot be empty or start with /."
      : "Could not save \u2014 the stored message changed.";
    const btnRowEl = pendingUserPatch.editArea.querySelector(".edit-btns");
    pendingUserPatch.editArea.insertBefore(errorEl, btnRowEl);
  }
}

// ---- Assistant message patch (no LLM re-fire) ----

export function handleAssistantPatchClick(botRow) {
  if (!canPatchDisplayedConversation()) return;
  if (pendingUserPatch || pendingAssistantPatch) return;

  const branchIndex = Number(botRow.dataset.branchIndex);
  if (!Number.isInteger(branchIndex)) return;

  closePatchConfirmInner();

  if (botRow.classList.contains("is-last")) {
    startAssistantPatchPrepare(botRow, branchIndex, botRow.dataset.text || "");
  } else {
    showPatchConfirm(botRow, "assistant", branchIndex, botRow.dataset.text || "");
  }
}

function startAssistantPatchPrepare(botRow, branchIndex, displayText) {
  if (!canPatchDisplayedConversation()) return;
  if (pendingUserPatch || pendingAssistantPatch) return;

  const patchBtn = botRow.querySelector(".patch-btn");
  if (patchBtn) patchBtn.disabled = true;

  const cid = state.currentConversationId;
  const pid = state.currentPlatformId;

  pendingAssistantPatch = {
    phase: "preparing",
    conversationId: cid,
    platformId: pid,
    botRow,
    patchBtn,
    branchIndex,
    displayText,
  };

  send({
    type: "prepare_assistant_message_patch",
    conversation_id: cid,
    platform_id: pid,
    branch_index: branchIndex,
    expected_role: "assistant",
    display_content: displayText,
  });
}

export function handleAssistantPatchReady(data) {
  if (!pendingAssistantPatch || pendingAssistantPatch.phase !== "preparing") return;
  if (
    data.conversation_id !== pendingAssistantPatch.conversationId
    || data.platform_id !== pendingAssistantPatch.platformId
  ) return; // stale response — ignore without touching pending

  const { botRow } = pendingAssistantPatch;
  const wrapper = botRow.querySelector(".msg-bot");
  const textBlocks = wrapper.querySelectorAll(".msg-bot-text");
  const actionsBar = botRow.querySelector(".msg-actions") || wrapper.querySelector(".msg-actions");

  textBlocks.forEach((block) => block.classList.add("hidden"));
  if (actionsBar) actionsBar.classList.add("hidden");

  pendingAssistantPatch.phase = "editing";
  pendingAssistantPatch.originalRawText = data.raw_text;
  pendingAssistantPatch.messageIndex = data.message_index;
  pendingAssistantPatch.revision = data.revision;
  pendingAssistantPatch.wrapper = wrapper;
  pendingAssistantPatch.textBlocks = textBlocks;
  pendingAssistantPatch.actionsBar = actionsBar;

  const editArea = document.createElement("div");
  editArea.className = "edit-area bot-edit-area";
  pendingAssistantPatch.editArea = editArea;

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
  saveBtn.disabled = !data.raw_text.trim();

  function closeBotPatchEditor() {
    if (pendingAssistantPatch?.phase === "saving") return;
    editArea.remove();
    textBlocks.forEach((block) => block.classList.remove("hidden"));
    if (actionsBar) actionsBar.classList.remove("hidden");
    if (pendingAssistantPatch?.patchBtn) pendingAssistantPatch.patchBtn.disabled = false;
    pendingAssistantPatch = null;
  }

  pendingAssistantPatch.cancel = closeBotPatchEditor;

  cancelBtn.addEventListener("click", closeBotPatchEditor);

  saveBtn.addEventListener("click", () => {
    const newText = textarea.value.trim();
    if (!newText) return;
    if (!canPatchDisplayedConversation()) return;

    if (textarea.value === pendingAssistantPatch?.originalRawText) {
      closeBotPatchEditor();
      return;
    }

    editArea.querySelector(".bot-edit-error")?.remove();

    saveBtn.disabled = true;
    cancelBtn.disabled = true;
    pendingAssistantPatch.phase = "saving";

    send({
      type: "save_assistant_message_patch",
      conversation_id: pendingAssistantPatch.conversationId,
      platform_id: pendingAssistantPatch.platformId,
      message_index: pendingAssistantPatch.messageIndex,
      raw_text: textarea.value,
      revision: pendingAssistantPatch.revision,
    });
  });

  textarea.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && pendingAssistantPatch?.phase !== "saving") {
      e.preventDefault();
      e.stopPropagation();
      closeBotPatchEditor();
    }
  });

  textarea.addEventListener("input", () => {
    saveBtn.disabled = !textarea.value.trim();
    textarea.style.height = "auto";
    textarea.style.height = Math.min(textarea.scrollHeight, 200) + "px";
  });

  btnRow.appendChild(cancelBtn);
  btnRow.appendChild(saveBtn);
  editArea.appendChild(label);
  editArea.appendChild(textarea);
  editArea.appendChild(btnRow);

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

export function handleAssistantPatchSuccess(data) {
  if (!pendingAssistantPatch) return;
  if (
    data.conversation_id !== pendingAssistantPatch.conversationId
    || data.platform_id !== pendingAssistantPatch.platformId
  ) return; // stale response — ignore without touching pending

  const { botRow, editArea, textBlocks, actionsBar } = pendingAssistantPatch;

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

  textBlocks.forEach((block) => block.remove());

  const newContent = document.createElement("div");
  newContent.className = "msg-bot-text";
  newContent.innerHTML = renderMarkdown(editedText);

  editArea.parentNode.insertBefore(newContent, editArea);
  editArea.remove();

  botRow.dataset.text = editedText;

  if (data.message_index != null && state.currentMessages[data.message_index]) {
    state.currentMessages[data.message_index] = data.message;
  }

  if (actionsBar) actionsBar.classList.remove("hidden");
  if (pendingAssistantPatch.patchBtn) pendingAssistantPatch.patchBtn.disabled = false;
  pendingAssistantPatch = null;
}

export function handleAssistantPatchFailure(data) {
  if (!pendingAssistantPatch) return;
  if (
    data?.conversation_id !== pendingAssistantPatch.conversationId
    || data?.platform_id !== pendingAssistantPatch.platformId
  ) return; // stale response — ignore without touching pending

  if (pendingAssistantPatch.phase === "preparing") {
    if (pendingAssistantPatch.patchBtn) pendingAssistantPatch.patchBtn.disabled = false;
    pendingAssistantPatch = null;
    return;
  }

  const saveBtn = pendingAssistantPatch.editArea?.querySelector(".edit-send-btn");
  const cancelBtnEl = pendingAssistantPatch.editArea?.querySelector(".edit-cancel-btn");
  if (saveBtn) saveBtn.disabled = false;
  if (cancelBtnEl) cancelBtnEl.disabled = false;
  pendingAssistantPatch.phase = "editing";

  let errorEl = pendingAssistantPatch.editArea?.querySelector(".bot-edit-error");
  if (!errorEl && pendingAssistantPatch.editArea) {
    errorEl = document.createElement("div");
    errorEl.className = "bot-edit-error";
    errorEl.textContent = "Could not save \u2014 the stored message changed.";
    const btnRow = pendingAssistantPatch.editArea.querySelector(".edit-btns");
    pendingAssistantPatch.editArea.insertBefore(errorEl, btnRow);
  }
}

// ---- Patch: unified reset ----

export function resetPatchState() {
  closePatchConfirmInner();
  pendingUserPatch = null;
  pendingAssistantPatch = null;
}
