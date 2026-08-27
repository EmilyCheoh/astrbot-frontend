/* ================================================================
   Den — Conversations
   Sidebar: Favorites + All conversations (infinite scroll),
   switch, pin, rename, delete, anchor for search results.
   ================================================================ */

import { state } from "./state.js";
import { dom } from "./dom.js";
import { send, isConnected } from "./socket.js";

// ---- Scroll sentinel observer ----

let sentinelObserver = null;

function setupSentinel() {
  if (sentinelObserver) sentinelObserver.disconnect();

  sentinelObserver = new IntersectionObserver(
    (entries) => {
      if (
        entries[0].isIntersecting &&
        state.hasMore &&
        !state.isLoadingMore &&
        isConnected()
      ) {
        state.isLoadingMore = true;
        dom.convLoading.classList.remove("hidden");
        send({
          type: "list_conversations",
          cursor: state.nextCursor,
          limit: 20,
        });
      }
    },
    { root: dom.convList, threshold: 0 }
  );

  if (dom.convSentinel) {
    sentinelObserver.observe(dom.convSentinel);
  }
}

// ---- Panel open / close ----

export function openPanel() {
  if (!isConnected()) return;
  // Always reset and fetch the latest first batch
  state.conversationIds = [];
  state.nextCursor = null;
  state.hasMore = true;
  state.isLoadingMore = true;
  dom.convLoading.classList.remove("hidden");
  dom.convEnd.classList.add("hidden");
  send({ type: "list_conversations", limit: 20 });
  dom.convPanel.classList.add("open");
  dom.panelOverlay.classList.remove("hidden");
  dom.panelOverlay.classList.add("open");
}

export function closePanel() {
  dom.convPanel.classList.remove("open");
  dom.panelOverlay.classList.remove("open");
  setTimeout(() => {
    if (!dom.convPanel.classList.contains("open")) {
      dom.panelOverlay.classList.add("hidden");
    }
  }, 260);
}

// ---- Helpers ----

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

function getConv(id) {
  return state.conversationById.get(id);
}

// ---- Store helpers (called by main.js dispatch) ----

/**
 * Merge a batch of conversation objects into the Map store.
 * Called on conversations_list arrival.
 */
export function mergeConversations(conversations, nextCursor, hasMore) {
  const incomingIds = [];

  for (const conv of conversations) {
    state.conversationById.set(conv.id, conv);
    incomingIds.push(conv.id);
  }

  if (!state.nextCursor) {
    // First batch (no prior cursor) — replace
    state.conversationIds = incomingIds;
  } else {
    // Subsequent batch — deduplicated append
    const existing = new Set(state.conversationIds);
    for (const id of incomingIds) {
      if (!existing.has(id)) {
        state.conversationIds.push(id);
      }
    }
  }

  state.nextCursor = nextCursor;
  state.hasMore = hasMore;
  state.isLoadingMore = false;

  renderSidebar();
}

/**
 * Replace the favorites list entirely (called on favorites_list / pin_updated).
 */
export function setFavorites(favorites) {
  state.favoriteIds = [];
  for (const conv of favorites) {
    state.conversationById.set(conv.id, conv);
    state.favoriteIds.push(conv.id);
  }
  renderSidebar();
}

/**
 * Update a single conversation in the Map (e.g. after rename).
 */
export function updateConversation(id, patch) {
  const conv = state.conversationById.get(id);
  if (conv) {
    Object.assign(conv, patch);
    renderSidebar();
  }
}

/**
 * Remove a conversation from all stores.
 */
export function removeConversation(id) {
  state.conversationById.delete(id);
  state.conversationIds = state.conversationIds.filter(cid => cid !== id);
  state.favoriteIds = state.favoriteIds.filter(cid => cid !== id);
  if (state.activeAnchorId === id) state.activeAnchorId = null;
  if (state.pendingConversationId === id) state.pendingConversationId = null;
  renderSidebar();
}

// ---- Full sidebar render ----

export function renderSidebar() {
  // Preserve scroll position
  const scrollTop = dom.convList.scrollTop;

  // Clear everything except the sentinel
  const sentinel = dom.convSentinel;
  dom.convList.innerHTML = "";

  // -- Favorites section --
  const favConvs = state.favoriteIds
    .map(id => getConv(id))
    .filter(Boolean);

  if (favConvs.length > 0) {
    const isExpanded = localStorage.getItem("den-pinned-expanded") !== "false";

    const header = document.createElement("div");
    header.className = "pinned-header";
    header.innerHTML =
      '<span class="pinned-arrow' + (isExpanded ? " expanded" : "") +
      '">\u25B6</span> Favorites (' + favConvs.length + ")";

    const container = document.createElement("div");
    container.className = "pinned-items" + (isExpanded ? " expanded" : "");

    for (const conv of favConvs) {
      container.appendChild(createConvItem(conv));
    }

    header.addEventListener("click", () => {
      const nowExpanded = container.classList.toggle("expanded");
      header.querySelector(".pinned-arrow").classList.toggle("expanded");
      localStorage.setItem("den-pinned-expanded", String(nowExpanded));
    });

    dom.convList.appendChild(header);
    dom.convList.appendChild(container);
  }

  // -- "All conversations" label (only if favorites exist) --
  if (favConvs.length > 0) {
    const allLabel = document.createElement("div");
    allLabel.className = "conv-section-label";
    allLabel.textContent = "All conversations";
    dom.convList.appendChild(allLabel);
  }

  // -- Active anchor (search result not in loaded list) --
  const showAnchor =
    state.activeAnchorId &&
    !state.conversationIds.includes(state.activeAnchorId);
  if (showAnchor) {
    const anchorConv = getConv(state.activeAnchorId);
    if (anchorConv) {
      const anchorEl = createConvItem(anchorConv);
      anchorEl.classList.add("conv-anchor");
      dom.convList.appendChild(anchorEl);

      // Separator
      const sep = document.createElement("div");
      sep.className = "conv-anchor-sep";
      dom.convList.appendChild(sep);
    }
  }

  // -- All conversations (cursor-loaded) --
  const allConvs = state.conversationIds
    .map(id => getConv(id))
    .filter(Boolean);

  if (allConvs.length === 0 && favConvs.length === 0 && !state.isLoadingMore) {
    const empty = document.createElement("div");
    empty.className = "conv-empty";
    empty.textContent = "No conversations";
    dom.convList.appendChild(empty);
  } else {
    for (const conv of allConvs) {
      dom.convList.appendChild(createConvItem(conv));
    }
  }

  // -- Re-attach sentinel at the end --
  dom.convList.appendChild(sentinel);

  // -- Loading / end indicators --
  if (state.isLoadingMore) {
    dom.convLoading.classList.remove("hidden");
  } else {
    dom.convLoading.classList.add("hidden");
  }

  if (!state.hasMore && state.conversationIds.length > 0) {
    dom.convEnd.classList.remove("hidden");
  } else {
    dom.convEnd.classList.add("hidden");
  }

  // Restore scroll
  dom.convList.scrollTop = scrollTop;

  // Re-observe sentinel
  setupSentinel();
}

// ---- Conversation item ----

function createConvItem(conv) {
  const selectedId = state.pendingConversationId || state.currentConversationId;
  const isSelected = conv.id === selectedId;
  const btn = document.createElement("div");
  btn.className = "conv-item" + (isSelected ? " active" : "");
  btn.setAttribute("role", "button");
  btn.tabIndex = 0;
  btn.dataset.id = conv.id;
  btn.dataset.platform = conv.platform_id;

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

  const menuBtn = document.createElement("button");
  menuBtn.className = "conv-menu-btn";
  menuBtn.innerHTML = "\u22EE";
  menuBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    toggleConvMenu(menuBtn, conv);
  });
  topRow.appendChild(menuBtn);

  const time = document.createElement("div");
  time.className = "conv-item-time";
  time.textContent = formatTime(conv.updated_at);

  btn.appendChild(topRow);
  btn.appendChild(time);

  btn.addEventListener("click", (e) => {
    if (e.target.closest(".conv-menu-btn, .conv-rename-input")) return;
    state.currentConvTitle = conv.preview || "conversation";

    if (!isConnected()) return;

    if (conv.platform_id === "Abyss") {
      state.pendingConversationId = conv.id;
      send({ type: "view_history", conversation_id: conv.id });
      closePanel();
    } else {
      state.pendingConversationId = conv.id;
      send({ type: "switch_conversation", conversation_id: conv.id });
    }
    renderSidebar();
  });

  return btn;
}

// ---- Context menu ----

const ICON_STAR = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>';
const ICON_STAR_FILLED = '<svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>';
const ICON_RENAME = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.83 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/></svg>';
const ICON_TRASH = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>';

let activeConvMenu = null;

function toggleConvMenu(anchorEl, conv) {
  if (activeConvMenu && activeConvMenu.anchor === anchorEl) {
    closeConvMenu();
    return;
  }
  closeConvMenu();

  const rect = anchorEl.getBoundingClientRect();
  const menu = document.createElement("div");
  menu.className = "conv-menu";

  const isPending = state.pendingPinIds.has(conv.id);

  // Star
  const starItem = document.createElement("button");
  starItem.className = "conv-menu-item";
  if (isPending) {
    starItem.innerHTML = (conv.pinned ? ICON_STAR_FILLED : ICON_STAR) + " ...";
    starItem.disabled = true;
  } else {
    starItem.innerHTML = (conv.pinned ? ICON_STAR_FILLED : ICON_STAR) + " " + (conv.pinned ? "Unstar" : "Star");
  }
  starItem.addEventListener("click", (e) => {
    e.stopPropagation();
    if (!isConnected() || isPending) return;
    state.pendingPinIds.add(conv.id);
    send({
      type: conv.pinned ? "unpin_conversation" : "pin_conversation",
      conversation_id: conv.id,
    });
    closeConvMenu();
  });
  menu.appendChild(starItem);

  // Rename
  const renameItem = document.createElement("button");
  renameItem.className = "conv-menu-item";
  renameItem.innerHTML = ICON_RENAME + " Rename";
  renameItem.addEventListener("click", (e) => {
    e.stopPropagation();
    const convEl = anchorEl.closest(".conv-item");
    startRename(conv, convEl);
  });
  menu.appendChild(renameItem);

  // Separator
  const sep = document.createElement("div");
  sep.className = "conv-menu-separator";
  menu.appendChild(sep);

  // Delete
  const deleteItem = document.createElement("button");
  deleteItem.className = "conv-menu-item danger";
  deleteItem.innerHTML = ICON_TRASH + " Delete";
  deleteItem.addEventListener("click", (e) => {
    e.stopPropagation();
    closeConvMenu();
    showDeleteDialog(conv);
  });
  menu.appendChild(deleteItem);

  document.body.appendChild(menu);

  const menuW = menu.offsetWidth;
  let left = rect.right - menuW;
  let top = rect.bottom + 4;

  if (left < 4) left = 4;
  if (top + menu.offsetHeight > window.innerHeight - 4) {
    top = rect.top - menu.offsetHeight - 4;
  }

  menu.style.left = left + "px";
  menu.style.top = top + "px";

  activeConvMenu = { el: menu, anchor: anchorEl };
}

export function closeConvMenu() {
  if (activeConvMenu) {
    activeConvMenu.el.remove();
    activeConvMenu = null;
  }
}

// ---- Rename ----

function startRename(conv, convItemEl) {
  closeConvMenu();
  const previewEl = convItemEl.querySelector(".conv-item-preview");
  if (!previewEl) return;
  const originalText = previewEl.textContent;

  const input = document.createElement("input");
  input.type = "text";
  input.className = "conv-rename-input";
  input.value = conv.preview !== "(empty)" ? conv.preview : "";

  previewEl.replaceWith(input);
  input.focus();
  input.select();

  let finished = false;
  function finishRename(save) {
    if (finished) return;
    finished = true;
    const newTitle = input.value.trim();
    const newPreview = document.createElement("div");
    newPreview.className = "conv-item-preview";

    if (save && newTitle && newTitle !== originalText) {
      newPreview.textContent = newTitle;
      input.replaceWith(newPreview);
      if (isConnected()) {
        send({
          type: "rename_conversation",
          conversation_id: conv.id,
          title: newTitle,
          platform_id: conv.platform_id,
        });
      }
    } else {
      newPreview.textContent = originalText;
      input.replaceWith(newPreview);
    }
  }

  // -- IME composition guard --
  let isComposing = false;
  let saveAfterComposition = false;

  input.addEventListener("compositionstart", () => {
    isComposing = true;
  });

  input.addEventListener("compositionend", () => {
    isComposing = false;
    if (saveAfterComposition) {
      saveAfterComposition = false;
      finishRename(true);
    }
  });

  input.addEventListener("keydown", (e) => {
    if (e.isComposing || isComposing || e.keyCode === 229) return;
    if (e.key === "Enter") {
      e.preventDefault();
      e.stopPropagation();
      finishRename(true);
    }
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      finishRename(false);
    }
  });

  input.addEventListener("blur", () => {
    if (isComposing) {
      saveAfterComposition = true;
      return;
    }
    finishRename(true);
  });

  input.addEventListener("click", (e) => {
    e.stopPropagation();
  });
}

// ---- Delete ----

function showDeleteDialog(conv) {
  closeDeleteDialog();
  const overlay = document.createElement("div");
  overlay.className = "delete-dialog-overlay";
  overlay.id = "delete-dialog-overlay";

  const dialog = document.createElement("div");
  dialog.className = "delete-dialog";

  const title = document.createElement("h3");
  title.textContent = "Delete Conversation";

  const body = document.createElement("p");
  const convTitle = conv.preview && conv.preview !== "(empty)" ? conv.preview : "this conversation";
  body.textContent = 'Are you sure you want to delete "' + convTitle + '"?';

  const btns = document.createElement("div");
  btns.className = "delete-dialog-btns";

  const cancelBtn = document.createElement("button");
  cancelBtn.className = "delete-dialog-cancel";
  cancelBtn.textContent = "Cancel";
  cancelBtn.addEventListener("click", closeDeleteDialog);

  const confirmBtn = document.createElement("button");
  confirmBtn.className = "delete-dialog-confirm";
  confirmBtn.textContent = "Delete";
  confirmBtn.addEventListener("click", () => {
    if (isConnected()) {
      send({
        type: "delete_conversation",
        conversation_id: conv.id,
        platform_id: conv.platform_id,
      });
    }
    closeDeleteDialog();
  });

  btns.appendChild(cancelBtn);
  btns.appendChild(confirmBtn);
  dialog.appendChild(title);
  dialog.appendChild(body);
  dialog.appendChild(btns);
  overlay.appendChild(dialog);

  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) closeDeleteDialog();
  });

  document.body.appendChild(overlay);
}

function closeDeleteDialog() {
  const existing = document.getElementById("delete-dialog-overlay");
  if (existing) existing.remove();
}

// ---- Bind events ----

export function initConversations() {
  dom.panelToggle.addEventListener("click", openPanel);
  dom.panelOverlay.addEventListener("click", closePanel);
  dom.newConvBtn.addEventListener("click", () => {
    if (!isConnected()) return;
    send({ type: "new_conversation" });
  });

  // Close context menu on outside click
  document.addEventListener("click", (e) => {
    if (!e.target.closest(".conv-menu") && !e.target.closest(".conv-menu-btn")) {
      closeConvMenu();
    }
  });
}
