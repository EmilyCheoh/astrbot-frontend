/* ================================================================
   Den — Selection Menu
   Desktop text selection → floating "Bookmark / Cite" menu.
   Only active on fine-pointer devices.
   ================================================================ */

import { dom } from "./dom.js";
import { state } from "./state.js";
import { openNotePopover } from "./bookmarks.js";
import { setPendingQuote } from "./quote.js";

// ---- Selection snapshot ----

let selectionSnapshot = null;

// ---- Semantic block matching ----

const SEMANTIC_SELECTORS = [
  ".msg-user",
  ".msg-bot-text",
  ".cot-content",
  ".tool-call-args",
  ".tool-call-result",
];

const SEMANTIC_SELECTOR = SEMANTIC_SELECTORS.join(",");

function findSemanticBlock(node) {
  const el = node.nodeType === Node.TEXT_NODE ? node.parentElement : node;
  if (!el) return null;
  return el.closest(SEMANTIC_SELECTOR);
}

function detectSourceType(block) {
  if (block.classList.contains("msg-user")) return "user";
  if (block.classList.contains("msg-bot-text")) return "assistant";
  if (block.classList.contains("cot-content")) return "cot";
  if (block.classList.contains("tool-call-args") || block.classList.contains("tool-call-result")) return "tool";
  return "";
}

function detectSourceName(block) {
  if (block.classList.contains("tool-call-args") || block.classList.contains("tool-call-result")) {
    const toolBlock = block.closest(".tool-call-block");
    if (toolBlock) {
      const summary = toolBlock.querySelector("summary");
      return summary ? summary.textContent.trim() : "";
    }
  }
  return "";
}

// ---- Menu positioning ----

const GAP = 6;

function showMenu(range) {
  const rect = range.getBoundingClientRect();
  const menu = dom.selectionMenu;

  // Temporarily unhide to measure
  menu.classList.remove("hidden");
  const menuRect = menu.getBoundingClientRect();

  // Horizontal: centered on selection, clamped to viewport
  let left = rect.left + rect.width / 2 - menuRect.width / 2;
  left = Math.max(4, Math.min(left, window.innerWidth - menuRect.width - 4));

  // Vertical: prefer above, flip below if not enough space
  let top = rect.top - menuRect.height - GAP;
  if (top < 4) {
    top = rect.bottom + GAP;
  }

  menu.style.left = left + "px";
  menu.style.top = top + "px";
}

// ---- Menu hiding ----

function hideMenuOnly() {
  dom.selectionMenu.classList.add("hidden");
}

export function hideSelectionMenu() {
  hideMenuOnly();
  // Only clear snapshot if note popover is not open
  if (dom.notePopover.classList.contains("hidden")) {
    selectionSnapshot = null;
  }
}

// ---- Selection validation (debounced) ----

let debounceTimer = null;

function onSelectionChange() {
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(validateSelection, 150);
}

function validateSelection() {
  const sel = window.getSelection();

  // No selection or collapsed
  if (!sel || sel.rangeCount === 0 || sel.isCollapsed) {
    hideSelectionMenu();
    return;
  }

  const range = sel.getRangeAt(0);
  const text = range.toString();

  // Empty or whitespace-only
  if (!text || !text.trim()) {
    hideSelectionMenu();
    return;
  }

  // Both endpoints must be within dom.messages
  if (!dom.messages.contains(range.startContainer) || !dom.messages.contains(range.endContainer)) {
    hideSelectionMenu();
    return;
  }

  // Find semantic blocks for both endpoints
  const startBlock = findSemanticBlock(range.startContainer);
  const endBlock = findSemanticBlock(range.endContainer);

  // Both must have a matching ancestor
  if (!startBlock || !endBlock) {
    hideSelectionMenu();
    return;
  }

  // Must be the same semantic block element (no cross-block selection)
  if (startBlock !== endBlock) {
    hideSelectionMenu();
    return;
  }

  // Valid — save snapshot and show menu
  selectionSnapshot = {
    text: text,
    sourceType: detectSourceType(startBlock),
    sourceName: detectSourceName(startBlock),
    platformId: state.currentPlatformId,
    conversationId: state.currentConversationId,
    conversationTitle: state.currentConvTitle || "",
  };

  showMenu(range);
}

// ---- Button handlers ----

function onBookmarkClick() {
  if (!selectionSnapshot) return;

  const draft = {
    platformId: selectionSnapshot.platformId,
    conversationId: selectionSnapshot.conversationId,
    conversationTitle: selectionSnapshot.conversationTitle,
    sourceType: selectionSnapshot.sourceType,
    sourceName: selectionSnapshot.sourceName,
    captureType: "selection",
    branchIndex: 0,
    content: selectionSnapshot.text,
    context: "",
  };

  openNotePopover(draft, dom.selMenuBookmark);
  hideMenuOnly(); // hide menu but keep snapshot alive for the popover
}

function onCiteClick() {
  if (!selectionSnapshot) return;

  setPendingQuote({
    text: selectionSnapshot.text,
    sourceType: selectionSnapshot.sourceType,
    sourceName: selectionSnapshot.sourceName,
  });

  hideSelectionMenu();
  dom.msgInput.focus();
}

// ---- Initialization ----

export function initSelectionMenu() {
  // Only on fine pointer (desktop) devices
  if (!window.matchMedia("(pointer: fine)").matches) return;

  // Selection change (debounced)
  document.addEventListener("selectionchange", onSelectionChange);

  // Button clicks
  dom.selMenuBookmark.addEventListener("click", onBookmarkClick);
  dom.selMenuCite.addEventListener("click", onCiteClick);

  // Prevent selection clearing on pointerdown on menu buttons
  dom.selMenuBookmark.addEventListener("pointerdown", (e) => e.preventDefault());
  dom.selMenuCite.addEventListener("pointerdown", (e) => e.preventDefault());

  // Scroll on messages container hides menu
  dom.messages.addEventListener("scroll", hideSelectionMenu, { passive: true });

  // Scroll within inner scrollable blocks (CoT, tool results) — use capture
  // on the messages container to catch scroll events from dynamic children
  dom.messages.addEventListener("scroll", (e) => {
    if (e.target === dom.messages) return; // already handled above
    const t = e.target;
    if (
      t.classList &&
      (t.classList.contains("cot-content") || t.classList.contains("tool-call-result"))
    ) {
      hideSelectionMenu();
    }
  }, { passive: true, capture: true });

  // Click outside menu → hide
  document.addEventListener("pointerdown", (e) => {
    if (dom.selectionMenu.classList.contains("hidden")) return;
    if (dom.selectionMenu.contains(e.target)) return;
    if (!dom.notePopover.classList.contains("hidden") && dom.notePopover.contains(e.target)) return;
    hideSelectionMenu();
  });
}
