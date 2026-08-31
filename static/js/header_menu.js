/* ================================================================
   Den — Header Menu
   Overflow menu, Star/Unstar, and Delete.
   ================================================================ */

import { state } from "./state.js";
import { dom } from "./dom.js";
import { send, isConnected } from "./socket.js";
import { showDeleteDialog } from "./conversations.js";

const ICON_STAR = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>';
const ICON_STAR_FILLED = '<svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>';

// ---- Overflow menu ----

function toggleMoreMenu() {
  const wasHidden = dom.moreMenu.classList.contains("hidden");
  dom.moreMenu.classList.toggle("hidden");
  if (wasHidden) updatePinButton();
}

function closeMoreMenu() {
  dom.moreMenu.classList.add("hidden");
}

// ---- Pin button state ----

function updatePinButton() {
  const cid = state.currentConversationId;
  if (!cid) {
    dom.morePinBtn.disabled = true;
    dom.morePinBtn.innerHTML = ICON_STAR + " Star";
    return;
  }
  const conv = state.conversationById.get(cid);
  const isPinned = conv && conv.pinned;
  const isPending = state.pendingPinIds.has(cid);

  if (isPending) {
    dom.morePinBtn.innerHTML = (isPinned ? ICON_STAR_FILLED : ICON_STAR) + " ...";
    dom.morePinBtn.disabled = true;
  } else {
    dom.morePinBtn.innerHTML = (isPinned ? ICON_STAR_FILLED : ICON_STAR) + " " + (isPinned ? "Unstar" : "Star");
    dom.morePinBtn.disabled = false;
  }
}

// ---- Pin action ----

function handlePin() {
  const cid = state.currentConversationId;
  if (!cid || !isConnected() || state.pendingPinIds.has(cid)) return;

  const conv = state.conversationById.get(cid);
  const isPinned = conv && conv.pinned;

  state.pendingPinIds.add(cid);
  send({
    type: isPinned ? "unpin_conversation" : "pin_conversation",
    conversation_id: cid,
  });
  closeMoreMenu();
}

// ---- Delete action ----

function handleDelete() {
  const cid = state.currentConversationId;
  if (!cid) return;

  // Build a minimal conv object for the dialog
  const conv = state.conversationById.get(cid) || {
    id: cid,
    preview: state.currentConvTitle || "(empty)",
    platform_id: "Abyss_Den",
  };

  closeMoreMenu();
  showDeleteDialog(conv);
}

// ---- Bind events ----

export function initHeaderMenu() {
  dom.moreMenuBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    toggleMoreMenu();
  });

  document.addEventListener("click", (e) => {
    if (!e.target.closest(".more-menu-wrapper")) {
      closeMoreMenu();
    }
  });

  dom.morePinBtn.addEventListener("click", handlePin);
  dom.moreDeleteBtn.addEventListener("click", handleDelete);
}
