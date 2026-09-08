/* ================================================================
   Den — Bookmarks
   Full bookmarks page with label support, note popover, card
   rendering, search, filtering, grouped/sorted views, editing,
   deleting, label management.  Module-private state — only exports
   used by main.js, header_menu.js, messages.js, selection_menu.js.
   ================================================================ */

import { dom } from "./dom.js";
import { send, isConnected } from "./socket.js";
import { state } from "./state.js";
import { utcToLocalDate, utcToLocalDisplay } from "./time.js";
import { renderMarkdown } from "./markdown.js";

// ================================================================
//  Module state (private)
// ================================================================

let allBookmarks = [];
let allLabels = [];
let labelsLoaded = false;
let labelsLoadPending = false;
let viewMode = "grouped";         // grouped | newest | oldest
let selectedLabelId = null;       // null = ALL
let searchDraft = "";
let dateFromDraft = "";
let dateToDraft = "";
let searchQuery = "";             // applied after Enter / Search click
let dateFrom = "";
let dateTo = "";
let editingId = null;
let editingSnapshot = null;
let editingDraft = null;          // { content, context, note, labelId }
let selectedCreateLabelId = null; // for note popover picker
let labelRowDraft = null;         // { mode, id, emoji, note, snapshot, pending }
let openCardMenuId = null;
let activeBookmarkDialog = null;  // DOM reference to current confirm dialog
let activeLabelRequestId = null;
let pendingRequests = new Map();
let savedScrollTop = 0;
let updatePending = null;         // null or { requestId, bookmarkId }
let pendingDraft = null;
let pendingAnchor = null;
let pendingStarBtn = null;
let activeCreateRequestId = null;
let labelManagerEl = null;        // DOM reference to label manager popover

// ================================================================
//  Helpers
// ================================================================

function generateRequestId() {
  return `bk_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function normalizeLabels(arr) {
  if (!Array.isArray(arr)) return [];
  return arr.map(l => ({
    id: l.id,
    emoji: l.emoji || "",
    note: l.note || "",
  }));
}

function getLabelById(id) {
  return allLabels.find(l => l.id === id) || null;
}

function getDefaultLabel() {
  return allLabels.length > 0 ? allLabels[0] : null;
}

function getCardSourceLabel(bookmark) {
  switch (bookmark.source_type) {
    case "user": return "Felis Abyssalis";
    case "assistant": return "Abyss";
    case "cot": return "Abyss \u00B7 CoT";
    case "tool":
      return bookmark.source_name
        ? `Tool \u00B7 ${bookmark.source_name}`
        : "Tool";
    default: return bookmark.source_type;
  }
}

function isBookmarksPageOpen() {
  return !dom.bookmarksPage.classList.contains("hidden");
}

function isNotePopoverOpen() {
  return !dom.notePopover.classList.contains("hidden");
}

function isLabelManagerOpen() {
  return labelManagerEl !== null && labelManagerEl.isConnected;
}

function isLabelFilterDropdownOpen() {
  return !dom.bookmarksLabelDropdown.classList.contains("hidden");
}

// ================================================================
//  Label loading
// ================================================================

function requestLabelList() {
  if (labelsLoadPending) return;
  if (!isConnected()) return;

  labelsLoadPending = true;
  const requestId = generateRequestId();
  pendingRequests.set(requestId, { type: "label_list" });
  send({ type: "bookmark_label_list", request_id: requestId });
}

function repairLabelSelections() {
  // Repair create picker selection
  if (selectedCreateLabelId !== null) {
    if (!getLabelById(selectedCreateLabelId)) {
      selectedCreateLabelId = getDefaultLabel()?.id ?? null;
    }
  }
  // Repair edit draft
  if (editingDraft && editingDraft.labelId !== undefined) {
    if (!getLabelById(editingDraft.labelId)) {
      editingDraft.labelId = getDefaultLabel()?.id ?? null;
    }
  }
  // Repair filter
  if (selectedLabelId !== null) {
    if (!getLabelById(selectedLabelId)) {
      selectedLabelId = null;
      updateFilterButton();
    }
  }
}

// ================================================================
//  Bookmarks page open / close
// ================================================================

function requestBookmarkList() {
  dom.bookmarksLoading.classList.remove("hidden");
  dom.bookmarksList.classList.add("hidden");
  dom.bookmarksEmpty.classList.add("hidden");
  dom.bookmarksNoResults.classList.add("hidden");

  if (!isConnected()) {
    showBookmarkListError();
    return;
  }

  const requestId = generateRequestId();
  pendingRequests.set(requestId, { type: "list" });
  send({ type: "bookmark_list", request_id: requestId });
}

function showBookmarkListError(message = "Couldn't load bookmarks.") {
  dom.bookmarksLoading.classList.add("hidden");
  dom.bookmarksList.classList.add("hidden");
  dom.bookmarksEmpty.classList.add("hidden");
  dom.bookmarksNoResults.textContent = message;
  dom.bookmarksNoResults.classList.remove("hidden");
}

export function openBookmarksPage() {
  savedScrollTop = dom.chatScroll.scrollTop;

  // Reset filters to defaults
  viewMode = "grouped";
  selectedLabelId = null;
  searchQuery = "";
  dateFrom = "";
  dateTo = "";
  searchDraft = "";
  dateFromDraft = "";
  dateToDraft = "";
  openCardMenuId = null;

  // Clear UI inputs
  dom.bookmarksSearchInput.value = "";
  dom.bookmarksDateFrom.value = "";
  dom.bookmarksDateTo.value = "";

  // Close search panel
  dom.bookmarksSearchPanel.classList.add("hidden");
  dom.bookmarksSearchError.classList.add("hidden");

  // Update view button active states
  updateViewButtons();
  updateFilterButton();

  // Restore "No results." text
  dom.bookmarksNoResults.textContent = "No results.";

  // Show bookmarks page
  dom.bookmarksPage.classList.remove("hidden");

  // Request full list from server
  requestBookmarkList();
}

export function closeBookmarksPage() {
  dom.bookmarksPage.classList.add("hidden");

  // Close any open layers
  closeCardMenu();
  closeLabelFilterDropdown();
  closeLabelManager();
  closeActiveDialog();
  cancelEdit();

  requestAnimationFrame(() => {
    dom.chatScroll.scrollTop = savedScrollTop;
  });
}

// ================================================================
//  WebSocket disconnect / reconnect handlers
// ================================================================

export function handleBookmarkConnectionLost() {
  for (const [reqId, pending] of pendingRequests) {
    switch (pending.type) {
      case "create":
        if (pending.starBtn?.isConnected) {
          pending.starBtn.disabled = false;
        }
        if (activeCreateRequestId === reqId) {
          closeNotePopover();
        }
        break;
      case "update":
        updatePending = null;
        break;
    }
  }
  pendingRequests.clear();

  labelsLoaded = false;
  labelsLoadPending = false;

  // Unlock any pending label row
  if (labelRowDraft && labelRowDraft.pending) {
    labelRowDraft.pending = false;
    if (isLabelManagerOpen()) renderLabelManager();
  }

  if (isBookmarksPageOpen()) {
    showBookmarkListError();
  }
}

export function handleBookmarkAuthenticated() {
  // Always request labels after auth
  requestLabelList();

  if (isBookmarksPageOpen()) {
    requestBookmarkList();
  }
}

// ================================================================
//  Note popover
// ================================================================

export function openNotePopover(draft, anchorEl, starBtn) {
  activeCreateRequestId = null;

  pendingDraft = draft;
  pendingAnchor = anchorEl;
  pendingStarBtn = starBtn ?? null;

  // Clear input
  dom.notePopoverInput.value = "";

  // Render label picker — always reset to default for each new bookmark
  if (labelsLoaded && allLabels.length > 0) {
    selectedCreateLabelId = getDefaultLabel()?.id ?? null;
    renderCreateLabelPicker();
    dom.notePopoverSave.disabled = false;
  } else {
    dom.notePopoverLabelPicker.innerHTML = "";
    const loadingSpan = document.createElement("span");
    loadingSpan.className = "note-popover-label-loading";
    loadingSpan.textContent = "Loading\u2026";
    dom.notePopoverLabelPicker.appendChild(loadingSpan);
    dom.notePopoverSave.disabled = true;
    requestLabelList();
  }

  // Position the popover
  const isFinePointer = window.matchMedia("(pointer: fine)").matches;

  if (isFinePointer && anchorEl) {
    const rect = anchorEl.getBoundingClientRect();
    const popoverWidth = 280;
    const popoverHeight = 160;

    let top = rect.bottom + 8;
    let left = rect.left + rect.width / 2 - popoverWidth / 2;

    if (top + popoverHeight > window.innerHeight) {
      top = rect.top - popoverHeight - 8;
    }

    left = Math.max(8, Math.min(left, window.innerWidth - popoverWidth - 8));
    top = Math.max(8, top);

    dom.notePopover.style.position = "fixed";
    dom.notePopover.style.top = top + "px";
    dom.notePopover.style.left = left + "px";
    dom.notePopover.style.right = "";
    dom.notePopover.style.bottom = "";
    dom.notePopover.style.width = popoverWidth + "px";
    dom.notePopover.style.borderRadius = "10px";
  } else {
    dom.notePopover.style.position = "fixed";
    dom.notePopover.style.bottom = "0";
    dom.notePopover.style.left = "0";
    dom.notePopover.style.right = "0";
    dom.notePopover.style.top = "";
    dom.notePopover.style.width = "";
    dom.notePopover.style.borderRadius = "10px 10px 0 0";
  }

  dom.notePopover.classList.remove("hidden");
  requestAnimationFrame(() => dom.notePopoverInput.focus());
}

function closeNotePopover() {
  activeCreateRequestId = null;
  dom.notePopover.classList.add("hidden");
  dom.notePopoverSave.disabled = false;
  pendingDraft = null;
  pendingAnchor = null;
  pendingStarBtn = null;
}

function renderCreateLabelPicker() {
  dom.notePopoverLabelPicker.innerHTML = "";
  for (const label of allLabels) {
    const btn = document.createElement("button");
    btn.className = "note-popover-label-btn" + (label.id === selectedCreateLabelId ? " active" : "");
    btn.textContent = label.emoji;
    btn.dataset.id = String(label.id);
    btn.type = "button";
    btn.addEventListener("click", () => {
      selectedCreateLabelId = label.id;
      // Update active class
      dom.notePopoverLabelPicker.querySelectorAll(".note-popover-label-btn").forEach(b => {
        b.classList.toggle("active", b.dataset.id === String(label.id));
      });
    });
    dom.notePopoverLabelPicker.appendChild(btn);
  }
}

function saveBookmark() {
  if (!pendingDraft) return;
  if (!isConnected()) return;

  // Validate labels loaded and label exists
  if (!labelsLoaded || !selectedCreateLabelId || !getLabelById(selectedCreateLabelId)) {
    return;
  }

  const note = dom.notePopoverInput.value.trim();
  const requestId = generateRequestId();
  const msg = {
    type: "bookmark_create",
    request_id: requestId,
    platform_id: pendingDraft.platformId,
    conversation_id: pendingDraft.conversationId,
    conversation_title: pendingDraft.conversationTitle,
    source_type: pendingDraft.sourceType,
    source_name: pendingDraft.sourceName || "",
    capture_type: pendingDraft.captureType,
    branch_index: pendingDraft.branchIndex || 0,
    content: pendingDraft.content,
    context: pendingDraft.context || "",
    note: note,
    label_id: selectedCreateLabelId,
  };

  dom.notePopoverSave.disabled = true;
  if (pendingStarBtn) pendingStarBtn.disabled = true;

  pendingRequests.set(requestId, { type: "create", starBtn: pendingStarBtn });
  activeCreateRequestId = requestId;

  send(msg);
}

// ================================================================
//  Star button helper
// ================================================================

const ICON_STAR_OUTLINE = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>';
const ICON_STAR_FILLED = '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>';

export function markStarFilled(btn) {
  btn.innerHTML = ICON_STAR_FILLED;
  btn.disabled = true;
  btn.title = "Bookmarked";
}

// ================================================================
//  Toast
// ================================================================

function showToast(message) {
  let toast = document.querySelector(".bookmarks-toast");
  if (!toast) {
    toast = document.createElement("div");
    toast.className = "bookmarks-toast";
    document.body.appendChild(toast);
  }
  toast.textContent = message;
  toast.classList.remove("hidden");
  toast.classList.add("visible");

  setTimeout(() => {
    toast.classList.remove("visible");
    toast.classList.add("hidden");
  }, 1800);
}

// ================================================================
//  Confirm dialog helper
// ================================================================

function showBookmarkDialog({ title, body, confirmText, confirmClass, onConfirm }) {
  closeActiveDialog();

  const overlay = document.createElement("div");
  overlay.className = "delete-dialog-overlay";

  const dialog = document.createElement("div");
  dialog.className = "delete-dialog";

  const titleEl = document.createElement("h3");
  titleEl.textContent = title;

  const bodyEl = document.createElement("p");
  bodyEl.textContent = body;

  const btns = document.createElement("div");
  btns.className = "delete-dialog-btns";

  const cancelBtn = document.createElement("button");
  cancelBtn.className = "delete-dialog-cancel";
  cancelBtn.textContent = "Cancel";

  const confirmBtn = document.createElement("button");
  confirmBtn.className = "delete-dialog-confirm";
  if (confirmClass === "accent") {
    confirmBtn.style.background = "var(--accent)";
    confirmBtn.style.color = "#fff";
  }
  confirmBtn.textContent = confirmText || "Confirm";

  let pending = false;

  const dismiss = () => {
    overlay.remove();
    if (activeBookmarkDialog === overlay) {
      activeBookmarkDialog = null;
    }
  };

  const cancel = () => {
    if (!pending) dismiss();
  };

  cancelBtn.addEventListener("click", cancel);
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) cancel();
  });

  confirmBtn.addEventListener("click", () => {
    if (pending) return;
    pending = true;
    cancelBtn.disabled = true;
    confirmBtn.disabled = true;
    onConfirm(dismiss);
  });

  btns.appendChild(cancelBtn);
  btns.appendChild(confirmBtn);
  dialog.appendChild(titleEl);
  dialog.appendChild(bodyEl);
  dialog.appendChild(btns);
  overlay.appendChild(dialog);

  document.body.appendChild(overlay);
  activeBookmarkDialog = overlay;

  return close;
}

function closeActiveDialog() {
  if (activeBookmarkDialog && activeBookmarkDialog.isConnected) {
    activeBookmarkDialog.remove();
  }
  activeBookmarkDialog = null;
}

// ================================================================
//  View mode
// ================================================================

export function setViewMode(mode) {
  if (!["grouped", "newest", "oldest"].includes(mode)) return;
  if (mode === viewMode) return;
  viewMode = mode;
  closeCardMenu();
  updateViewButtons();
  renderBookmarks();
}

function updateViewButtons() {
  document.querySelectorAll(".bookmarks-view-btn").forEach(btn => {
    btn.classList.toggle("active", btn.dataset.view === viewMode);
  });
}

// ================================================================
//  Search panel
// ================================================================

export function toggleBookmarkSearchPanel() {
  const panel = dom.bookmarksSearchPanel;
  if (panel.classList.contains("hidden")) {
    panel.classList.remove("hidden");
    requestAnimationFrame(() => dom.bookmarksSearchInput.focus());
  } else {
    panel.classList.add("hidden");
    // Don't clear applied filters on close
  }
}

function updateSearchIconState() {
  const active = !!(searchQuery || dateFrom || dateTo);
  dom.bookmarksSearchToggle.classList.toggle("active", active);
}

function applySearch() {
  searchQuery = dom.bookmarksSearchInput.value.trim();
  dateFrom = dom.bookmarksDateFrom.value;
  dateTo = dom.bookmarksDateTo.value;
  dom.bookmarksSearchError.classList.add("hidden");
  updateSearchIconState();
  renderBookmarks();
}

function clearSearch() {
  searchQuery = "";
  dateFrom = "";
  dateTo = "";
  dom.bookmarksSearchInput.value = "";
  dom.bookmarksDateFrom.value = "";
  dom.bookmarksDateTo.value = "";
  dom.bookmarksSearchError.classList.add("hidden");
  updateSearchIconState();
  renderBookmarks();
}

// ================================================================
//  Label filter dropdown
// ================================================================

export function toggleLabelFilterDropdown() {
  if (isLabelFilterDropdownOpen()) {
    closeLabelFilterDropdown();
  } else {
    openLabelFilterDropdown();
  }
}

function openLabelFilterDropdown() {
  renderLabelFilterDropdown();
  dom.bookmarksLabelDropdown.classList.remove("hidden");
}

function closeLabelFilterDropdown() {
  dom.bookmarksLabelDropdown.classList.add("hidden");
}

function renderLabelFilterDropdown() {
  dom.bookmarksLabelDropdown.innerHTML = "";

  // ALL option
  const allBtn = document.createElement("button");
  allBtn.className = "bookmarks-label-dropdown-item" + (selectedLabelId === null ? " active" : "");
  allBtn.textContent = "ALL";
  allBtn.addEventListener("click", () => selectLabelFilter(null));
  dom.bookmarksLabelDropdown.appendChild(allBtn);

  for (const label of allLabels) {
    const btn = document.createElement("button");
    btn.className = "bookmarks-label-dropdown-item" + (selectedLabelId === label.id ? " active" : "");
    btn.textContent = label.emoji;
    btn.addEventListener("click", () => selectLabelFilter(label.id));
    dom.bookmarksLabelDropdown.appendChild(btn);
  }
}

function selectLabelFilter(id) {
  selectedLabelId = id;
  closeLabelFilterDropdown();
  updateFilterButton();
  closeCardMenu();
  renderBookmarks();
}

function updateFilterButton() {
  if (selectedLabelId === null) {
    dom.bookmarksLabelFilterBtn.textContent = "ALL \u25BE";
    dom.bookmarksLabelFilterBtn.classList.remove("filtered");
  } else {
    const label = getLabelById(selectedLabelId);
    dom.bookmarksLabelFilterBtn.textContent = (label ? label.emoji : "?") + " \u25BE";
    dom.bookmarksLabelFilterBtn.classList.add("filtered");
  }
}

// ================================================================
//  Filtering & sorting
// ================================================================

function getFilteredBookmarks() {
  let list = allBookmarks;

  // Text search (case-insensitive on content + note)
  if (searchQuery) {
    const q = searchQuery.toLowerCase();
    list = list.filter(
      b =>
        (b.content && b.content.toLowerCase().includes(q)) ||
        (b.note && b.note.toLowerCase().includes(q))
    );
  }

  // Date filter
  if (dateFrom || dateTo) {
    list = list.filter(b => {
      const localDate = utcToLocalDate(b.created_at);
      if (!localDate) return false;
      if (dateFrom && localDate < dateFrom) return false;
      if (dateTo && localDate > dateTo) return false;
      return true;
    });
  }

  // Label filter
  if (selectedLabelId !== null) {
    list = list.filter(b => b.label_id === selectedLabelId);
  }

  return list;
}

// ================================================================
//  Rendering
// ================================================================

function renderBookmarks() {
  const filtered = getFilteredBookmarks();

  dom.bookmarksList.innerHTML = "";

  if (allBookmarks.length === 0) {
    dom.bookmarksList.classList.add("hidden");
    dom.bookmarksEmpty.classList.remove("hidden");
    dom.bookmarksNoResults.classList.add("hidden");
    return;
  }

  if (filtered.length === 0) {
    dom.bookmarksList.classList.add("hidden");
    dom.bookmarksEmpty.classList.add("hidden");
    dom.bookmarksNoResults.classList.remove("hidden");
    return;
  }

  dom.bookmarksList.classList.remove("hidden");
  dom.bookmarksEmpty.classList.add("hidden");
  dom.bookmarksNoResults.classList.add("hidden");

  if (viewMode === "grouped") {
    renderGrouped(filtered);
  } else {
    const sorted = [...filtered].sort((a, b) => {
      if (viewMode === "newest") {
        return (b.created_at || "").localeCompare(a.created_at || "");
      } else {
        return (a.created_at || "").localeCompare(b.created_at || "");
      }
    });
    for (const bookmark of sorted) {
      dom.bookmarksList.appendChild(createBookmarkCard(bookmark));
    }
  }
}

function renderGrouped(filtered) {
  const groups = new Map();
  for (const b of filtered) {
    const key = `${b.platform_id}|${b.conversation_id}`;
    if (!groups.has(key)) {
      groups.set(key, {
        key,
        title: b.conversation_title || "Untitled",
        bookmarks: [],
        newest: b.created_at || "",
      });
    }
    const group = groups.get(key);
    group.bookmarks.push(b);
    if ((b.created_at || "") > group.newest) {
      group.newest = b.created_at;
    }
  }

  const sortedGroups = [...groups.values()].sort(
    (a, b) => (b.newest || "").localeCompare(a.newest || "")
  );

  for (const group of sortedGroups) {
    group.bookmarks.sort(
      (a, b) => (b.created_at || "").localeCompare(a.created_at || "")
    );

    const groupEl = document.createElement("div");
    groupEl.className = "bookmark-group";

    const header = document.createElement("div");
    header.className = "bookmark-group-header";

    const titleSpan = document.createElement("span");
    titleSpan.textContent = group.title;

    const countSpan = document.createElement("span");
    countSpan.className = "bookmark-group-count";
    countSpan.textContent = group.bookmarks.length;

    header.appendChild(titleSpan);
    header.appendChild(countSpan);

    header.addEventListener("click", () => {
      groupEl.classList.toggle("collapsed");
    });

    groupEl.appendChild(header);

    for (const bookmark of group.bookmarks) {
      groupEl.appendChild(createBookmarkCard(bookmark));
    }

    dom.bookmarksList.appendChild(groupEl);
  }
}

// ================================================================
//  Bookmark card
// ================================================================

function createBookmarkCard(bookmark) {
  const card = document.createElement("div");
  card.className = "bookmark-card";
  card.dataset.id = bookmark.id;

  const body = document.createElement("div");
  body.className = "bookmark-card-body";

  // Card header: emoji badge + note + menu
  const cardHeader = document.createElement("div");
  cardHeader.className = "bookmark-card-header";

  // Note line: emoji + note text
  const label = getLabelById(bookmark.label_id) || getDefaultLabel();
  const noteLine = document.createElement("div");
  noteLine.className = "bookmark-note-line";

  const badge = document.createElement("span");
  badge.className = "bookmark-emoji-badge";
  badge.textContent = label ? label.emoji : "";
  noteLine.appendChild(badge);

  if (bookmark.note) {
    const noteText = document.createElement("span");
    noteText.className = "bookmark-note";
    noteText.textContent = bookmark.note;
    noteLine.appendChild(noteText);
  }

  cardHeader.appendChild(noteLine);

  // Spacer to push menu right
  const spacer = document.createElement("div");
  spacer.style.flex = "1";
  cardHeader.appendChild(spacer);

  // Menu button (···)
  const menuBtn = document.createElement("button");
  menuBtn.className = "bookmark-menu-btn";
  menuBtn.textContent = "\u00B7\u00B7\u00B7";
  menuBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    toggleCardMenu(bookmark.id);
  });
  cardHeader.appendChild(menuBtn);

  body.appendChild(cardHeader);

  // Saved text section
  const savedSection = document.createElement("div");
  savedSection.className = "bookmark-saved-section";

  const savedTag = document.createElement("span");
  savedTag.className = "bookmark-tag";
  savedTag.textContent = "SAVED TEXT";
  savedSection.appendChild(savedTag);

  const contentEl = document.createElement("div");
  contentEl.className = "bookmark-content collapsed-five-lines";
  contentEl.innerHTML = renderMarkdown(bookmark.content);
  savedSection.appendChild(contentEl);

  body.appendChild(savedSection);

  // Context section (hidden by default)
  let contextEl = null;
  if (bookmark.context) {
    contextEl = document.createElement("div");
    contextEl.className = "bookmark-context-section hidden";

    const ctxTag = document.createElement("span");
    ctxTag.className = "bookmark-tag";
    ctxTag.textContent = "CONTEXT";
    contextEl.appendChild(ctxTag);

    const ctxContent = document.createElement("div");
    ctxContent.className = "bookmark-context";
    ctxContent.innerHTML = renderMarkdown(bookmark.context);
    contextEl.appendChild(ctxContent);

    body.appendChild(contextEl);
  }

  // Expand button — determined after DOM insertion
  const expandBtn = document.createElement("button");
  expandBtn.className = "bookmark-expand-toggle hidden";
  expandBtn.addEventListener("click", () => toggleCardExpanded(card));
  body.appendChild(expandBtn);

  // Source footer
  const sourceLine = document.createElement("div");
  sourceLine.className = "bookmark-source";

  const convLink = document.createElement("a");
  convLink.className = "bookmark-source-link";
  convLink.textContent = bookmark.conversation_title || "Untitled";
  convLink.href = "#";
  convLink.addEventListener("click", (e) => {
    e.preventDefault();
    openBookmarkSource(bookmark);
  });
  sourceLine.appendChild(convLink);

  const sourceLabel = getCardSourceLabel(bookmark);
  const dateStr = utcToLocalDisplay(bookmark.created_at);

  const sourceInfo = document.createElement("span");
  sourceInfo.textContent = ` \u00B7 ${sourceLabel} \u00B7 ${dateStr}`;
  sourceLine.appendChild(sourceInfo);

  body.appendChild(sourceLine);

  card.appendChild(body);

  // If currently editing this card
  if (editingId === bookmark.id) {
    activateEditUI(card, bookmark);
  }

  // After DOM insertion, check overflow for expand button
  requestAnimationFrame(() => {
    if (!card.isConnected) return;
    // Edit mode: keep expand button hidden — edit UI handles content directly
    if (editingId === bookmark.id) return;

    const hasOverflow = contentEl.scrollHeight > contentEl.clientHeight + 2;
    const hasContext = !!bookmark.context;

    if (hasOverflow) {
      expandBtn.textContent = "Show more \u25BE";
      expandBtn.classList.remove("hidden");
    } else if (hasContext) {
      expandBtn.textContent = "Show context \u25BE";
      expandBtn.classList.remove("hidden");
    }
    // else: leave hidden
  });

  return card;
}

function toggleCardExpanded(card) {
  const contentEl = card.querySelector(".bookmark-content");
  const contextSection = card.querySelector(".bookmark-context-section");
  const expandBtn = card.querySelector(".bookmark-expand-toggle");
  if (!contentEl || !expandBtn) return;

  const isExpanded = !contentEl.classList.contains("collapsed-five-lines");

  if (isExpanded) {
    // Collapse
    contentEl.classList.add("collapsed-five-lines");
    if (contextSection) contextSection.classList.add("hidden");
    // Determine label
    const hasOverflow = contentEl.scrollHeight > contentEl.clientHeight + 2;
    if (hasOverflow) {
      expandBtn.textContent = "Show more \u25BE";
    } else if (contextSection) {
      expandBtn.textContent = "Show context \u25BE";
    }
  } else {
    // Expand
    contentEl.classList.remove("collapsed-five-lines");
    if (contextSection) contextSection.classList.remove("hidden");
    expandBtn.textContent = "Show less \u25B2";
  }
}

// ================================================================
//  Card menu
// ================================================================

function toggleCardMenu(bookmarkId) {
  if (openCardMenuId === bookmarkId) {
    closeCardMenu();
    return;
  }
  closeCardMenu();
  openCardMenuId = bookmarkId;

  const card = dom.bookmarksList.querySelector(`.bookmark-card[data-id="${bookmarkId}"]`);
  if (!card) return;

  const menuBtn = card.querySelector(".bookmark-menu-btn");
  if (!menuBtn) return;

  const menu = document.createElement("div");
  menu.className = "bookmark-card-menu";
  menu.addEventListener("click", (e) => e.stopPropagation());

  const editItem = document.createElement("button");
  editItem.className = "bookmark-card-menu-item";
  editItem.textContent = "Edit";
  editItem.addEventListener("click", (e) => {
    e.stopPropagation();
    closeCardMenu();
    startEdit(bookmarkId);
  });
  menu.appendChild(editItem);

  const divider = document.createElement("div");
  divider.className = "bookmark-card-menu-divider";
  menu.appendChild(divider);

  const deleteItem = document.createElement("button");
  deleteItem.className = "bookmark-card-menu-item danger";
  deleteItem.textContent = "Delete";
  deleteItem.addEventListener("click", (e) => {
    e.stopPropagation();
    closeCardMenu();
    confirmDelete(bookmarkId);
  });
  menu.appendChild(deleteItem);

  // Append to cardHeader as sibling of menuBtn (not inside menuBtn)
  const cardHeader = card.querySelector(".bookmark-card-header");
  if (cardHeader) {
    cardHeader.style.position = "relative";
    cardHeader.appendChild(menu);
  } else {
    card.appendChild(menu);
  }
}

function closeCardMenu() {
  if (openCardMenuId === null) return;
  const existing = document.querySelector(".bookmark-card-menu");
  if (existing) existing.remove();
  openCardMenuId = null;
}

// ================================================================
//  Edit flow
// ================================================================

function startEdit(id) {
  if (updatePending !== null) return;

  if (editingId !== null) {
    cancelEdit();
  }

  const bookmark = allBookmarks.find(b => b.id === id);
  if (!bookmark) return;

  editingId = id;
  editingSnapshot = {
    content: bookmark.content,
    context: bookmark.context,
    note: bookmark.note,
    labelId: bookmark.label_id,
  };
  editingDraft = {
    content: bookmark.content,
    context: bookmark.context,
    note: bookmark.note,
    labelId: bookmark.label_id,
  };

  renderBookmarks();
}

function activateEditUI(card, bookmark) {
  card.classList.add("editing");

  const body = card.querySelector(".bookmark-card-body");

  // Hide rendered card header, saved section, context, expand button
  const cardHeader = body.querySelector(".bookmark-card-header");
  if (cardHeader) cardHeader.classList.add("hidden");
  const savedSection = body.querySelector(".bookmark-saved-section");
  if (savedSection) savedSection.classList.add("hidden");
  const contextSection = body.querySelector(".bookmark-context-section");
  if (contextSection) contextSection.classList.add("hidden");
  const expandBtn = body.querySelector(".bookmark-expand-toggle");
  if (expandBtn) expandBtn.classList.add("hidden");

  const sourceLine = body.querySelector(".bookmark-source");

  const draftContent = editingDraft ? editingDraft.content : (bookmark.content || "");
  const draftContext = editingDraft ? editingDraft.context : (bookmark.context || "");
  const draftNote = editingDraft ? editingDraft.note : (bookmark.note || "");
  const draftLabelId = editingDraft ? editingDraft.labelId : bookmark.label_id;

  const isUpdatePending = updatePending?.bookmarkId === bookmark.id;

  // Meta row: [label dropdown trigger] | [note input]
  const editMetaRow = document.createElement("div");
  editMetaRow.className = "bookmark-edit-meta-row";

  // Label dropdown trigger
  const labelControl = document.createElement("div");
  labelControl.className = "bookmark-edit-label-control";

  const currentLabel = getLabelById(draftLabelId) || getDefaultLabel();
  const labelTrigger = document.createElement("button");
  labelTrigger.className = "bookmark-edit-label-trigger";
  labelTrigger.type = "button";
  labelTrigger.textContent = (currentLabel ? currentLabel.emoji : "?") + " \u25BE";
  labelTrigger.disabled = isUpdatePending;

  const editLabelDropdown = document.createElement("div");
  editLabelDropdown.className = "bookmark-edit-label-dropdown hidden";

  for (const lbl of allLabels) {
    const opt = document.createElement("button");
    opt.className = "bookmarks-label-dropdown-item" + (lbl.id === draftLabelId ? " active" : "");
    opt.textContent = lbl.emoji;
    opt.type = "button";
    opt.addEventListener("click", (e) => {
      e.stopPropagation();
      if (editingDraft) editingDraft.labelId = lbl.id;
      labelTrigger.textContent = lbl.emoji + " \u25BE";
      editLabelDropdown.querySelectorAll(".bookmarks-label-dropdown-item").forEach(b => {
        b.classList.toggle("active", b === opt);
      });
      editLabelDropdown.classList.add("hidden");
    });
    editLabelDropdown.appendChild(opt);
  }

  labelTrigger.addEventListener("click", (e) => {
    e.stopPropagation();
    if (isUpdatePending) return;
    editLabelDropdown.classList.toggle("hidden");
  });

  labelControl.appendChild(labelTrigger);
  labelControl.appendChild(editLabelDropdown);
  editMetaRow.appendChild(labelControl);

  // Divider
  const metaDivider = document.createElement("div");
  metaDivider.className = "bookmark-edit-meta-divider";
  editMetaRow.appendChild(metaDivider);

  // Note input
  const noteField = document.createElement("textarea");
  noteField.className = "bookmark-edit-note-field";
  noteField.placeholder = "Note";
  noteField.value = draftNote;
  noteField.rows = 1;
  noteField.disabled = isUpdatePending;
  noteField.addEventListener("input", () => {
    if (editingDraft) editingDraft.note = noteField.value;
    noteField.style.height = "auto";
    noteField.style.height = Math.min(noteField.scrollHeight, 120) + "px";
  });
  editMetaRow.appendChild(noteField);

  body.insertBefore(editMetaRow, sourceLine);

  // Close edit label dropdown on outside click
  const closeEditLabelDropdown = (e) => {
    if (!labelControl.contains(e.target)) {
      editLabelDropdown.classList.add("hidden");
    }
  };
  document.addEventListener("click", closeEditLabelDropdown);
  card._cleanupEditLabelDropdown = () => {
    document.removeEventListener("click", closeEditLabelDropdown);
  };

  // Content edit
  const contentField = document.createElement("textarea");
  contentField.className = "bookmark-edit-field";
  contentField.placeholder = "Content (required)";
  contentField.value = draftContent;
  contentField.rows = 4;
  contentField.disabled = isUpdatePending;
  contentField.addEventListener("input", () => {
    if (editingDraft) editingDraft.content = contentField.value;
  });
  body.insertBefore(contentField, sourceLine);

  // Context edit
  const contextField = document.createElement("textarea");
  contextField.className = "bookmark-edit-field";
  contextField.placeholder = "Context";
  contextField.value = draftContext;
  contextField.rows = 2;
  contextField.disabled = isUpdatePending;
  contextField.addEventListener("input", () => {
    if (editingDraft) editingDraft.context = contextField.value;
  });
  body.insertBefore(contextField, sourceLine);

  // Edit actions
  const editActions = document.createElement("div");
  editActions.className = "bookmark-actions bookmark-edit-actions";

  const cancelBtn = document.createElement("button");
  cancelBtn.className = "bookmark-action-btn";
  cancelBtn.textContent = "Cancel";
  cancelBtn.disabled = isUpdatePending;
  cancelBtn.addEventListener("click", () => cancelEdit());

  const saveBtn = document.createElement("button");
  saveBtn.className = "bookmark-action-btn bookmark-save-btn";
  saveBtn.textContent = "Save";
  saveBtn.disabled = isUpdatePending;
  saveBtn.addEventListener("click", () => {
    if (updatePending !== null) return;
    if (!isConnected()) return;

    const newContent = contentField.value.trim();
    const newContext = contextField.value.trim();
    const newNote = noteField.value.trim();
    const newLabelId = editingDraft ? editingDraft.labelId : bookmark.label_id;

    if (!newContent) {
      contentField.focus();
      return;
    }

    showBookmarkDialog({
      title: "Save Changes",
      body: "Save changes to this bookmark?",
      confirmText: "Save",
      confirmClass: "accent",
      onConfirm: (close) => {
        if (!isConnected()) { close(); return; }

        const requestId = generateRequestId();
        updatePending = { requestId, bookmarkId: bookmark.id };
        pendingRequests.set(requestId, {
          type: "update",
          bookmarkId: bookmark.id,
        });

        saveBtn.disabled = true;
        cancelBtn.disabled = true;
        contentField.disabled = true;
        contextField.disabled = true;
        noteField.disabled = true;
        labelTrigger.disabled = true;

        send({
          type: "bookmark_update",
          request_id: requestId,
          id: bookmark.id,
          content: newContent,
          context: newContext,
          note: newNote,
          label_id: newLabelId,
        });

        close();
      },
    });
  });

  editActions.appendChild(cancelBtn);
  editActions.appendChild(saveBtn);
  body.insertBefore(editActions, sourceLine);

  // Auto-resize textareas
  [contentField, contextField].forEach(ta => {
    ta.addEventListener("input", () => {
      ta.style.height = "auto";
      ta.style.height = Math.min(ta.scrollHeight, 300) + "px";
    });
    requestAnimationFrame(() => {
      ta.style.height = Math.min(ta.scrollHeight, 300) + "px";
    });
  });
  // Initial height for note field
  requestAnimationFrame(() => {
    noteField.style.height = Math.min(noteField.scrollHeight, 120) + "px";
  });
}

function cleanupEditCard() {
  if (editingId === null) return;
  const card = dom.bookmarksList?.querySelector(`.bookmark-card[data-id="${editingId}"]`);
  if (card && card._cleanupEditLabelDropdown) {
    card._cleanupEditLabelDropdown();
    card._cleanupEditLabelDropdown = null;
  }
}

function cancelEdit() {
  if (editingId === null) return;
  if (updatePending !== null && updatePending.bookmarkId === editingId) return;

  cleanupEditCard();

  if (editingSnapshot) {
    const bookmark = allBookmarks.find(b => b.id === editingId);
    if (bookmark) {
      bookmark.content = editingSnapshot.content;
      bookmark.context = editingSnapshot.context;
      bookmark.note = editingSnapshot.note;
      bookmark.label_id = editingSnapshot.labelId;
    }
  }

  editingId = null;
  editingSnapshot = null;
  editingDraft = null;

  if (isBookmarksPageOpen()) {
    renderBookmarks();
  }
}

// ================================================================
//  Delete flow
// ================================================================

function confirmDelete(id) {
  showBookmarkDialog({
    title: "Delete Bookmark",
    body: "Are you sure you want to delete this bookmark?",
    confirmText: "Delete",
    confirmClass: "danger",
    onConfirm: (close) => {
      if (!isConnected()) { close(); return; }

      const requestId = generateRequestId();
      pendingRequests.set(requestId, { type: "delete", bookmarkId: id });

      send({
        type: "bookmark_delete",
        request_id: requestId,
        id: id,
      });

      close();
    },
  });
}

// ================================================================
//  Source jump
// ================================================================

function openBookmarkSource(bookmark) {
  if (state.isProcessing) return;
  if (!isConnected()) return;

  // Sync state
  const entry = state.conversationById.get(bookmark.conversation_id) || {};
  state.conversationById.set(bookmark.conversation_id, {
    ...entry,
    id: bookmark.conversation_id,
    platform_id: bookmark.platform_id,
    preview: bookmark.conversation_title || entry.preview || "conversation",
  });
  state.currentConvTitle = bookmark.conversation_title || "conversation";
  state.pendingConversationId = bookmark.conversation_id;
  state.activeAnchorId = bookmark.conversation_id;

  closeBookmarksPage();

  if (bookmark.platform_id === "Abyss") {
    send({ type: "view_history", conversation_id: bookmark.conversation_id });
  } else {
    send({ type: "switch_conversation", conversation_id: bookmark.conversation_id });
  }
}

// ================================================================
//  Label Manager
// ================================================================

export function openLabelManager() {
  if (isLabelManagerOpen()) {
    closeLabelManager();
    return;
  }

  const isMobile = window.innerWidth < 768;

  labelManagerEl = document.createElement("div");
  labelManagerEl.className = isMobile ? "label-manager-sheet" : "label-manager-popover";

  renderLabelManager();

  if (isMobile) {
    // Bottom sheet with overlay
    const overlay = document.createElement("div");
    overlay.className = "label-manager-overlay";
    overlay.addEventListener("click", closeLabelManager);
    document.body.appendChild(overlay);
    document.body.appendChild(labelManagerEl);
  } else {
    // Desktop: append to bookmarks header area
    document.body.appendChild(labelManagerEl);
    // Position near the button
    const btnRect = dom.bookmarksLabelMgrBtn.getBoundingClientRect();
    labelManagerEl.style.position = "fixed";
    labelManagerEl.style.top = (btnRect.bottom + 8) + "px";
    labelManagerEl.style.left = Math.max(8, btnRect.left - 100) + "px";
  }
}

function closeLabelManager() {
  if (labelRowDraft && labelRowDraft.pending) return;

  const overlay = document.querySelector(".label-manager-overlay");
  if (overlay) overlay.remove();

  if (labelManagerEl && labelManagerEl.isConnected) {
    labelManagerEl.remove();
  }
  labelManagerEl = null;
  labelRowDraft = null;
}

function renderLabelManager() {
  if (!labelManagerEl) return;
  labelManagerEl.innerHTML = "";

  const titleEl = document.createElement("div");
  titleEl.className = "label-manager-title";
  titleEl.textContent = "Labels";
  labelManagerEl.appendChild(titleEl);

  const listEl = document.createElement("div");
  listEl.className = "label-manager-list";

  for (const label of allLabels) {
    if (labelRowDraft && labelRowDraft.mode === "update" && labelRowDraft.id === label.id) {
      listEl.appendChild(createEditableLabelRow());
      continue;
    }

    const row = document.createElement("div");
    row.className = "label-manager-row";
    row.dataset.id = String(label.id);

    const emojiSpan = document.createElement("span");
    emojiSpan.className = "label-manager-emoji";
    emojiSpan.textContent = label.emoji;
    emojiSpan.addEventListener("click", () => beginUpdateLabel(label.id));
    row.appendChild(emojiSpan);

    const noteSpan = document.createElement("span");
    noteSpan.className = "label-manager-note";
    noteSpan.textContent = label.note || "";
    noteSpan.addEventListener("click", () => beginUpdateLabel(label.id));
    row.appendChild(noteSpan);

    // Delete button (disabled if only one label)
    const delBtn = document.createElement("button");
    delBtn.className = "label-manager-delete";
    delBtn.textContent = "\u00D7";
    delBtn.disabled = allLabels.length <= 1;
    delBtn.addEventListener("click", () => requestDeleteLabel(label.id));
    row.appendChild(delBtn);

    listEl.appendChild(row);
  }

  // New label row if draft is create
  if (labelRowDraft && labelRowDraft.mode === "create") {
    listEl.appendChild(createEditableLabelRow());
  }

  labelManagerEl.appendChild(listEl);

  // Add button
  if (!labelRowDraft) {
    const addBtn = document.createElement("button");
    addBtn.className = "label-manager-add";
    addBtn.textContent = "+";
    addBtn.addEventListener("click", beginCreateLabel);
    labelManagerEl.appendChild(addBtn);
  }

  // Error display
  if (labelRowDraft && labelRowDraft.error) {
    const errEl = document.createElement("div");
    errEl.className = "label-manager-error";
    errEl.textContent = labelRowDraft.error;
    labelManagerEl.appendChild(errEl);
  }
}

function createEditableLabelRow() {
  const row = document.createElement("div");
  row.className = "label-manager-row editing";

  let isComposing = false;

  const emojiInput = document.createElement("input");
  emojiInput.className = "label-manager-emoji-input";
  emojiInput.type = "text";
  emojiInput.placeholder = "Emoji";
  emojiInput.value = labelRowDraft.emoji || "";
  emojiInput.disabled = labelRowDraft.pending;
  emojiInput.addEventListener("input", () => {
    if (labelRowDraft) labelRowDraft.emoji = emojiInput.value;
  });
  emojiInput.addEventListener("compositionstart", () => { isComposing = true; });
  emojiInput.addEventListener("compositionend", () => { isComposing = false; });
  emojiInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      if (e.isComposing || isComposing || e.keyCode === 229) return;
      e.preventDefault();
      submitLabelRow();
    }
    if (e.key === "Escape") {
      e.preventDefault();
      cancelLabelRow();
    }
  });
  row.appendChild(emojiInput);

  const noteInput = document.createElement("input");
  noteInput.className = "label-manager-note-input";
  noteInput.type = "text";
  noteInput.placeholder = "Note (optional)";
  noteInput.value = labelRowDraft.note || "";
  noteInput.disabled = labelRowDraft.pending;
  noteInput.addEventListener("input", () => {
    if (labelRowDraft) labelRowDraft.note = noteInput.value;
  });
  noteInput.addEventListener("compositionstart", () => { isComposing = true; });
  noteInput.addEventListener("compositionend", () => { isComposing = false; });
  noteInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      if (e.isComposing || isComposing || e.keyCode === 229) return;
      e.preventDefault();
      submitLabelRow();
    }
    if (e.key === "Escape") {
      e.preventDefault();
      cancelLabelRow();
    }
  });
  row.appendChild(noteInput);

  const cancelBtn = document.createElement("button");
  cancelBtn.className = "label-manager-cancel";
  cancelBtn.textContent = "\u00D7";
  cancelBtn.disabled = labelRowDraft.pending;
  cancelBtn.addEventListener("click", cancelLabelRow);
  row.appendChild(cancelBtn);

  // Focus the emoji input after render
  requestAnimationFrame(() => emojiInput.focus());

  return row;
}

function beginCreateLabel() {
  if (labelRowDraft || !isLabelManagerOpen()) return;
  labelRowDraft = { mode: "create", id: null, emoji: "", note: "", snapshot: null, pending: false, error: null };
  renderLabelManager();
}

function beginUpdateLabel(id) {
  if (labelRowDraft) return;
  const label = getLabelById(id);
  if (!label) return;
  labelRowDraft = {
    mode: "update",
    id: label.id,
    emoji: label.emoji,
    note: label.note,
    snapshot: { emoji: label.emoji, note: label.note },
    pending: false,
    error: null,
  };
  renderLabelManager();
}

function submitLabelRow() {
  if (!labelRowDraft || labelRowDraft.pending) return;

  const emoji = (labelRowDraft.emoji || "").trim();
  if (!emoji) {
    labelRowDraft.error = "Emoji is required.";
    renderLabelManager();
    return;
  }

  // Check duplicates (skip self for updates)
  const duplicate = allLabels.find(l =>
    l.emoji === emoji && (labelRowDraft.mode !== "update" || l.id !== labelRowDraft.id)
  );
  if (duplicate) {
    labelRowDraft.error = "This emoji is already used.";
    renderLabelManager();
    return;
  }

  if (!isConnected()) {
    labelRowDraft.error = "Not connected.";
    renderLabelManager();
    return;
  }

  labelRowDraft.pending = true;
  labelRowDraft.error = null;
  renderLabelManager();

  const requestId = generateRequestId();
  activeLabelRequestId = requestId;

  if (labelRowDraft.mode === "create") {
    pendingRequests.set(requestId, { type: "label_create" });
    send({
      type: "bookmark_label_create",
      request_id: requestId,
      emoji: emoji,
      note: (labelRowDraft.note || "").trim(),
    });
  } else {
    pendingRequests.set(requestId, { type: "label_update", labelId: labelRowDraft.id });
    send({
      type: "bookmark_label_update",
      request_id: requestId,
      id: labelRowDraft.id,
      emoji: emoji,
      note: (labelRowDraft.note || "").trim(),
    });
  }
}

function cancelLabelRow() {
  if (!labelRowDraft) return;
  if (labelRowDraft.pending) return;
  labelRowDraft = null;
  if (isLabelManagerOpen()) renderLabelManager();
}

function requestDeleteLabel(id) {
  const label = getLabelById(id);
  if (!label) return;
  if (allLabels.length <= 1) return;

  // Count affected bookmarks
  const count = allBookmarks.filter(b => b.label_id === id).length;

  // Determine replacement (first label that isn't the one being deleted)
  const replacement = allLabels.find(l => l.id !== id);

  let bodyText = `Delete label "${label.emoji}"?`;
  if (count > 0 && replacement) {
    bodyText += ` ${count} bookmark${count > 1 ? "s" : ""} will be moved to "${replacement.emoji}".`;
  }

  showBookmarkDialog({
    title: "Delete Label",
    body: bodyText,
    confirmText: "Delete",
    confirmClass: "danger",
    onConfirm: (close) => {
      if (!isConnected()) { close(); return; }

      const requestId = generateRequestId();
      pendingRequests.set(requestId, { type: "label_delete", labelId: id });
      send({
        type: "bookmark_label_delete",
        request_id: requestId,
        id: id,
      });

      close();
    },
  });
}

// ================================================================
//  Escape layer management
// ================================================================

export function closeTopmostBookmarkLayer() {
  // 1. Active dialog
  if (activeBookmarkDialog && activeBookmarkDialog.isConnected) {
    closeActiveDialog();
    return true;
  }

  // 2. Label row draft
  if (labelRowDraft) {
    if (!labelRowDraft.pending) {
      cancelLabelRow();
    }
    return true;
  }

  // 3. Label manager
  if (isLabelManagerOpen()) {
    closeLabelManager();
    return true;
  }

  // 4. Label filter dropdown
  if (isLabelFilterDropdownOpen()) {
    closeLabelFilterDropdown();
    return true;
  }

  // 5. Card menu
  if (openCardMenuId !== null) {
    closeCardMenu();
    return true;
  }

  // 6. Search panel
  if (!dom.bookmarksSearchPanel.classList.contains("hidden")) {
    dom.bookmarksSearchPanel.classList.add("hidden");
    return true;
  }

  // 7. Editing
  if (editingId !== null) {
    if (updatePending === null || updatePending.bookmarkId !== editingId) {
      cancelEdit();
    }
    return true;
  }

  return false;
}

// ================================================================
//  Response handler
// ================================================================

export function handleBookmarkResponse(data) {
  switch (data.type) {
    case "bookmarks_list":
      onBookmarksList(data);
      break;
    case "bookmark_create_result":
      onCreateResult(data);
      break;
    case "bookmark_updated":
      onUpdated(data);
      break;
    case "bookmark_deleted":
      onDeleted(data);
      break;
    case "bookmark_labels_list":
      onLabelsList(data);
      break;
    case "bookmark_label_created":
      onLabelCreated(data);
      break;
    case "bookmark_label_updated":
      onLabelUpdated(data);
      break;
    case "bookmark_label_deleted":
      onLabelDeleted(data);
      break;
    case "bookmark_failed":
      onFailed(data);
      break;
  }
}

function onBookmarksList(data) {
  if (data.request_id) {
    pendingRequests.delete(data.request_id);
  }

  dom.bookmarksNoResults.textContent = "No results.";

  allBookmarks = (data.bookmarks || []).map(b => ({
    ...b,
    label_id: b.label_id ?? (getDefaultLabel()?.id ?? null),
  }));

  // Handle editing state after reconnect
  if (editingId !== null && editingDraft) {
    const authoritative = allBookmarks.find(b => b.id === editingId);
    if (authoritative) {
      editingSnapshot = {
        content: authoritative.content,
        context: authoritative.context,
        note: authoritative.note,
        labelId: authoritative.label_id,
      };
    } else {
      cleanupEditCard();
      editingId = null;
      editingSnapshot = null;
      editingDraft = null;
    }
  }

  dom.bookmarksLoading.classList.add("hidden");
  renderBookmarks();
}

function onCreateResult(data) {
  const pending = pendingRequests.get(data.request_id);
  if (!pending) return;
  pendingRequests.delete(data.request_id);

  if (data.created && data.bookmark) {
    const bk = { ...data.bookmark, label_id: data.bookmark.label_id ?? selectedCreateLabelId };
    allBookmarks.unshift(bk);
  }

  if (pending.starBtn?.isConnected) {
    markStarFilled(pending.starBtn);
  }

  if (data.already_exists) {
    showToast("Already saved.");
  }

  if (activeCreateRequestId === data.request_id) {
    closeNotePopover();
  }

  if (isBookmarksPageOpen()) {
    renderBookmarks();
  }
}

function onUpdated(data) {
  const pending = pendingRequests.get(data.request_id);
  if (pending) pendingRequests.delete(data.request_id);

  if (data.bookmark) {
    const idx = allBookmarks.findIndex(b => b.id === data.bookmark.id);
    if (idx !== -1) {
      allBookmarks[idx] = data.bookmark;
    }
  }

  cleanupEditCard();
  updatePending = null;
  editingId = null;
  editingSnapshot = null;
  editingDraft = null;
  renderBookmarks();
}

function onDeleted(data) {
  const pending = pendingRequests.get(data.request_id);
  if (pending) pendingRequests.delete(data.request_id);

  allBookmarks = allBookmarks.filter(b => b.id !== data.bookmark_id);

  // Clear edit if matching
  if (editingId === data.bookmark_id) {
    cleanupEditCard();
    editingId = null;
    editingSnapshot = null;
    editingDraft = null;
  }

  renderBookmarks();
}

function onLabelsList(data) {
  if (data.request_id) {
    pendingRequests.delete(data.request_id);
  }

  allLabels = normalizeLabels(data.labels);
  labelsLoaded = true;
  labelsLoadPending = false;

  repairLabelSelections();
  refreshLabelDependents();
}

function onLabelCreated(data) {
  if (data.request_id) {
    pendingRequests.delete(data.request_id);
  }

  allLabels = normalizeLabels(data.labels);
  labelsLoaded = true;

  // Clear draft
  labelRowDraft = null;
  activeLabelRequestId = null;

  repairLabelSelections();
  refreshLabelDependents();

  // Flash accent on last label in manager
  if (isLabelManagerOpen()) {
    renderLabelManager();
    requestAnimationFrame(() => {
      const rows = labelManagerEl?.querySelectorAll(".label-manager-row");
      if (rows && rows.length > 0) {
        const last = rows[rows.length - 1];
        last.classList.add("flash-accent");
        setTimeout(() => last.classList.remove("flash-accent"), 800);
      }
    });
  }
}

function onLabelUpdated(data) {
  if (data.request_id) {
    pendingRequests.delete(data.request_id);
  }

  allLabels = normalizeLabels(data.labels);
  labelsLoaded = true;

  labelRowDraft = null;
  activeLabelRequestId = null;

  repairLabelSelections();
  refreshLabelDependents();

  if (isLabelManagerOpen()) {
    renderLabelManager();
  }
}

function onLabelDeleted(data) {
  if (data.request_id) {
    pendingRequests.delete(data.request_id);
  }

  allLabels = normalizeLabels(data.labels);
  labelsLoaded = true;

  const deletedId = data.deleted_label_id;
  const replacementId = data.replacement_label_id;

  // Migrate bookmarks
  if (deletedId != null && replacementId != null) {
    for (const b of allBookmarks) {
      if (b.label_id === deletedId) {
        b.label_id = replacementId;
      }
    }
  }

  // Sync filter — switch to replacement so migrated bookmarks stay in view
  if (selectedLabelId === deletedId) {
    selectedLabelId = replacementId ?? null;
    updateFilterButton();
  }

  // Sync create picker
  if (selectedCreateLabelId === deletedId) {
    selectedCreateLabelId = getDefaultLabel()?.id ?? null;
  }

  // Sync edit draft
  if (editingDraft && editingDraft.labelId === deletedId) {
    editingDraft.labelId = replacementId ?? (getDefaultLabel()?.id ?? null);
  }

  refreshLabelDependents();
}

function onFailed(data) {
  const pending = pendingRequests.get(data.request_id);
  if (!pending) return;
  pendingRequests.delete(data.request_id);

  switch (pending.type) {
    case "create":
      if (pending.starBtn?.isConnected) {
        pending.starBtn.disabled = false;
      }
      if (activeCreateRequestId === data.request_id) {
        activeCreateRequestId = null;
        dom.notePopoverSave.disabled = false;
      }
      break;

    case "update":
      updatePending = null;
      renderBookmarks();
      break;

    case "delete":
      renderBookmarks();
      break;

    case "list":
      showBookmarkListError();
      break;

    case "label_list":
      labelsLoadPending = false;
      break;

    case "label_create":
    case "label_update":
      if (labelRowDraft) {
        labelRowDraft.pending = false;
        labelRowDraft.error = data.message || "Operation failed.";
        if (isLabelManagerOpen()) renderLabelManager();
      }
      activeLabelRequestId = null;
      break;

    case "label_delete":
      // Nothing to restore, dialog already closed
      break;
  }
}

function refreshLabelDependents() {
  // Re-render label filter
  updateFilterButton();

  // Re-render create picker if note popover is open
  if (isNotePopoverOpen()) {
    if (labelsLoaded && allLabels.length > 0) {
      if (selectedCreateLabelId === null || !getLabelById(selectedCreateLabelId)) {
        selectedCreateLabelId = getDefaultLabel()?.id ?? null;
      }
      renderCreateLabelPicker();
      dom.notePopoverSave.disabled = false;
    }
  }

  // Re-render label manager if open
  if (isLabelManagerOpen()) {
    renderLabelManager();
  }

  // Re-render bookmarks
  if (isBookmarksPageOpen()) {
    renderBookmarks();
  }
}

// ================================================================
//  Event binding (self-initializing)
// ================================================================

function initBookmarks() {
  // Close button
  dom.bookmarksCloseBtn.addEventListener("click", closeBookmarksPage);

  // Search panel: submit
  dom.bookmarksSearchSubmit.addEventListener("click", applySearch);

  // Search panel: clear
  dom.bookmarksSearchClear.addEventListener("click", clearSearch);

  // Search input: Enter to apply (with IME guard)
  let searchComposing = false;
  dom.bookmarksSearchInput.addEventListener("compositionstart", () => { searchComposing = true; });
  dom.bookmarksSearchInput.addEventListener("compositionend", () => { searchComposing = false; });
  dom.bookmarksSearchInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      if (e.isComposing || searchComposing || e.keyCode === 229) return;
      e.preventDefault();
      applySearch();
    }
  });

  // Note popover: Save button
  dom.notePopoverSave.addEventListener("click", saveBookmark);

  // Note popover: Cancel button
  dom.notePopoverCancel.addEventListener("click", closeNotePopover);

  // Note popover: keyboard shortcuts (with IME guard)
  let noteComposing = false;
  dom.notePopoverInput.addEventListener("compositionstart", () => { noteComposing = true; });
  dom.notePopoverInput.addEventListener("compositionend", () => { noteComposing = false; });
  dom.notePopoverInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      if (e.isComposing || noteComposing || e.keyCode === 229) return;
      e.preventDefault();
      saveBookmark();
    }
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      closeNotePopover();
    }
  });

  // Click outside note popover to close
  document.addEventListener("pointerdown", (e) => {
    if (
      isNotePopoverOpen() &&
      !dom.notePopover.contains(e.target) &&
      (!pendingAnchor || !pendingAnchor.contains(e.target))
    ) {
      closeNotePopover();
    }
  });

  // Click outside label filter dropdown to close
  document.addEventListener("pointerdown", (e) => {
    if (
      isLabelFilterDropdownOpen() &&
      !dom.bookmarksLabelDropdown.contains(e.target) &&
      !dom.bookmarksLabelFilterBtn.contains(e.target)
    ) {
      closeLabelFilterDropdown();
    }
  });

  // Click outside card menu to close
  document.addEventListener("pointerdown", (e) => {
    if (openCardMenuId !== null && !e.target.closest(".bookmark-card-menu") && !e.target.closest(".bookmark-menu-btn")) {
      closeCardMenu();
    }
  });
}

initBookmarks();

// Re-export helpers used by other modules
export { isBookmarksPageOpen, isNotePopoverOpen, closeNotePopover };
