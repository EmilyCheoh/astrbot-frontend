/* ================================================================
   Den — Bookmarks
   Full bookmarks page, note popover, card rendering, search,
   filtering, sorting, grouping, editing, deleting, drag-and-drop
   reorder.  Module-private state — only exports used by main.js,
   header_menu.js, messages.js and selection_menu.js.
   ================================================================ */

import { dom } from "./dom.js";
import { send, isConnected } from "./socket.js";
import { utcToLocalDate, utcToLocalDisplay } from "./time.js";

// ================================================================
//  Module state (private)
// ================================================================

let allBookmarks = [];          // full list from server, canonical Custom order
let currentSort = "custom";     // "custom" | "newest" | "oldest"
let isGrouped = false;
let searchQuery = "";
let dateFrom = "";
let dateTo = "";
let savedScrollTop = 0;
let pendingRequests = new Map(); // request_id -> { type, btn, ... }
let editingId = null;           // id of bookmark being edited, or null
let editingSnapshot = null;     // pre-edit content/context/note for cancel
let editingDraft = null;        // { content, context, note } — live editing state
let updatePending = null;       // null or { requestId, bookmarkId }
let reorderPending = false;
let preReorderIds = null;       // snapshot before drag
let pendingDraft = null;        // draft for note popover
let pendingAnchor = null;       // anchor element for note popover positioning
let pendingStarBtn = null;      // star button to mark filled after successful create
let activeCreateRequestId = null; // request_id of the create that owns the note popover

// ================================================================
//  Drag state
// ================================================================

let dragState = null;
// { cardEl, pointerId, startY, offsetY, startIndex, currentIndex,
//   placeholder, listRect, cardRects, scrollInterval, pointerY }

// ================================================================
//  Helpers
// ================================================================

function generateRequestId() {
  return `bk_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function isDragEnabled() {
  return (
    currentSort === "custom" &&
    !searchQuery &&
    !dateFrom &&
    !dateTo &&
    !isGrouped &&
    !reorderPending &&
    editingId === null
  );
}

function getCardSourceLabel(bookmark) {
  switch (bookmark.source_type) {
    case "user":      return "You";
    case "assistant":  return "Abyss";
    case "cot":        return "Abyss \u00B7 CoT";
    case "tool":
      return bookmark.source_name
        ? `Tool \u00B7 ${bookmark.source_name}`
        : "Tool";
    default:           return bookmark.source_type;
  }
}

function restoreOrderFromIds(ids) {
  if (!ids) return;
  const byId = new Map(allBookmarks.map(b => [b.id, b]));
  allBookmarks = ids.map(id => byId.get(id)).filter(Boolean);
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
  // Save chat scroll position
  savedScrollTop = dom.chatScroll.scrollTop;

  // Reset filters to defaults
  currentSort = "custom";
  searchQuery = "";
  dateFrom = "";
  dateTo = "";
  isGrouped = false;

  // Clear UI inputs
  dom.bookmarksSearch.value = "";
  dom.bookmarksDateFrom.value = "";
  dom.bookmarksDateTo.value = "";

  // Update sort button active states
  updateSortButtons();
  updateGroupToggle();

  // Restore "No results." text (only showBookmarkListError changes it)
  dom.bookmarksNoResults.textContent = "No results.";

  // Show bookmarks page
  dom.bookmarksPage.classList.remove("hidden");

  // Request full list from server
  requestBookmarkList();
}

export function closeBookmarksPage() {
  dom.bookmarksPage.classList.add("hidden");

  // Cancel any editing state
  cancelEdit();

  // Restore chat scroll position
  requestAnimationFrame(() => {
    dom.chatScroll.scrollTop = savedScrollTop;
  });
}

export function isBookmarksPageOpen() {
  return !dom.bookmarksPage.classList.contains("hidden");
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
        // If this create request owns the current note popover, close it
        if (activeCreateRequestId === reqId) {
          closeNotePopover();
        }
        break;
      case "update":
        // Release update lock but keep editing draft intact
        updatePending = null;
        break;
      case "reorder":
        if (preReorderIds) {
          restoreOrderFromIds(preReorderIds);
        }
        reorderPending = false;
        preReorderIds = null;
        break;
      // list and delete: just clear pending
    }
  }
  pendingRequests.clear();

  if (isBookmarksPageOpen()) {
    showBookmarkListError();
  }
}

export function handleBookmarkAuthenticated() {
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
  dom.notePopoverSave.disabled = false;

  // Position the popover
  const isFinePointer = window.matchMedia("(pointer: fine)").matches;

  if (isFinePointer && anchorEl) {
    // Desktop: near the anchor element
    const rect = anchorEl.getBoundingClientRect();
    const popoverWidth = 280;
    const popoverHeight = 140; // approximate

    // Position above or below the anchor
    let top = rect.bottom + 8;
    let left = rect.left + rect.width / 2 - popoverWidth / 2;

    // If below goes off-screen, put above
    if (top + popoverHeight > window.innerHeight) {
      top = rect.top - popoverHeight - 8;
    }

    // Clamp horizontal
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
    // Mobile: bottom sheet
    dom.notePopover.style.position = "fixed";
    dom.notePopover.style.bottom = "0";
    dom.notePopover.style.left = "0";
    dom.notePopover.style.right = "0";
    dom.notePopover.style.top = "";
    dom.notePopover.style.width = "";
    dom.notePopover.style.borderRadius = "10px 10px 0 0";
  }

  // Show and focus
  dom.notePopover.classList.remove("hidden");
  requestAnimationFrame(() => dom.notePopoverInput.focus());
}

export function isNotePopoverOpen() {
  return !dom.notePopover.classList.contains("hidden");
}

export function closeNotePopover() {
  activeCreateRequestId = null;

  dom.notePopover.classList.add("hidden");
  dom.notePopoverSave.disabled = false;
  pendingDraft = null;
  pendingAnchor = null;
  pendingStarBtn = null;
}

function saveBookmark() {
  if (!pendingDraft) return;
  if (!isConnected()) return;

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
  };

  // Disable save button to prevent double-click
  dom.notePopoverSave.disabled = true;

  // Disable the star button to prevent double-click
  if (pendingStarBtn) pendingStarBtn.disabled = true;

  // Track pending request (store the star btn for marking filled later)
  pendingRequests.set(requestId, { type: "create", starBtn: pendingStarBtn });

  // This create request now owns the note popover
  activeCreateRequestId = requestId;

  send(msg);
}

// ================================================================
//  Response handler — called from main.js
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
    case "bookmarks_reordered":
      onReordered(data);
      break;
    case "bookmark_failed":
      onFailed(data);
      break;
  }
}

function onBookmarksList(data) {
  // Clear matching pending request
  if (data.request_id) {
    pendingRequests.delete(data.request_id);
  }

  // Restore "No results." text (only showBookmarkListError changes it)
  dom.bookmarksNoResults.textContent = "No results.";

  allBookmarks = data.bookmarks || [];

  // Handle editing state after reconnect
  if (editingId !== null && editingDraft) {
    const authoritative = allBookmarks.find(b => b.id === editingId);
    if (authoritative) {
      editingSnapshot = {
        content: authoritative.content,
        context: authoritative.context,
        note: authoritative.note,
      };
    } else {
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
    // Add to front of allBookmarks (lowest sort_order)
    allBookmarks.unshift(data.bookmark);
  }

  // Mark the star button as filled (if it exists and is still in the DOM)
  if (pending.starBtn?.isConnected) {
    markStarFilled(pending.starBtn);
  }

  if (data.already_exists) {
    // Show brief "Already saved." feedback
    showToast("Already saved.");
  }

  // Only close the note popover if the response matches the active request
  if (activeCreateRequestId === data.request_id) {
    closeNotePopover();
  }

  // Re-render if bookmarks page is open
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
  renderBookmarks();
}

function onReordered(data) {
  const pending = pendingRequests.get(data.request_id);
  if (pending) pendingRequests.delete(data.request_id);

  reorderPending = false;
  preReorderIds = null;

  // Server confirmed — keep current order
  renderBookmarks();
}

function onFailed(data) {
  const pending = pendingRequests.get(data.request_id);
  if (!pending) return;
  pendingRequests.delete(data.request_id);

  switch (pending.type) {
    case "create":
      // Re-enable star
      if (pending.starBtn?.isConnected) {
        pending.starBtn.disabled = false;
      }
      // Only touch the note popover if it belongs to this request
      if (activeCreateRequestId === data.request_id) {
        activeCreateRequestId = null;
        dom.notePopoverSave.disabled = false;
      }
      break;

    case "update":
      // Release update lock, keep editingId/Draft/Snapshot intact
      updatePending = null;
      renderBookmarks(); // Re-render with buttons enabled now
      break;

    case "delete":
      // Restore delete button
      renderBookmarks();
      break;

    case "reorder":
      // Revert to pre-reorder order
      reorderPending = false;
      if (preReorderIds) {
        restoreOrderFromIds(preReorderIds);
        preReorderIds = null;
      }
      renderBookmarks();
      break;

    case "list":
      showBookmarkListError();
      break;
  }
}

// ================================================================
//  Star button helper
// ================================================================

const ICON_STAR_OUTLINE = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>';
const ICON_STAR_FILLED = '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>';

/**
 * Mark a star button as filled and disable further clicks.
 * Exported so messages.js can use it (once it creates stars).
 */
export function markStarFilled(btn) {
  btn.innerHTML = ICON_STAR_FILLED;
  btn.disabled = true;
  btn.title = "Bookmarked";
}

// ================================================================
//  Toast (brief feedback near the top)
// ================================================================

function showToast(message) {
  // Reuse existing toast or create one
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
//  Rendering
// ================================================================

function getFilteredSorted() {
  let list = allBookmarks;

  // Text search (case-insensitive on content and note, not context)
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

  // Sort
  if (!isGrouped) {
    switch (currentSort) {
      case "custom":
        // Original order from server (sort_order ASC) — already correct
        break;
      case "newest":
        list = [...list].sort(
          (a, b) => (b.created_at || "").localeCompare(a.created_at || "")
        );
        break;
      case "oldest":
        list = [...list].sort(
          (a, b) => (a.created_at || "").localeCompare(b.created_at || "")
        );
        break;
    }
  }

  return list;
}

function renderBookmarks() {
  const filtered = getFilteredSorted();

  dom.bookmarksList.innerHTML = "";

  if (allBookmarks.length === 0) {
    // No bookmarks at all
    dom.bookmarksList.classList.add("hidden");
    dom.bookmarksEmpty.classList.remove("hidden");
    dom.bookmarksNoResults.classList.add("hidden");
    return;
  }

  if (filtered.length === 0) {
    // Have bookmarks but filters matched nothing
    dom.bookmarksList.classList.add("hidden");
    dom.bookmarksEmpty.classList.add("hidden");
    dom.bookmarksNoResults.classList.remove("hidden");
    return;
  }

  // Show list
  dom.bookmarksList.classList.remove("hidden");
  dom.bookmarksEmpty.classList.add("hidden");
  dom.bookmarksNoResults.classList.add("hidden");

  if (isGrouped) {
    renderGrouped(filtered);
  } else {
    for (const bookmark of filtered) {
      dom.bookmarksList.appendChild(createBookmarkCard(bookmark));
    }
  }
}

function renderGrouped(filtered) {
  // Group by platform_id + "|" + conversation_id
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

  // Sort groups by newest created_at descending
  const sortedGroups = [...groups.values()].sort(
    (a, b) => (b.newest || "").localeCompare(a.newest || "")
  );

  for (const group of sortedGroups) {
    // Sort within group by created_at descending
    group.bookmarks.sort(
      (a, b) => (b.created_at || "").localeCompare(a.created_at || "")
    );

    // Group container
    const groupEl = document.createElement("div");
    groupEl.className = "bookmark-group";

    // Group header
    const header = document.createElement("div");
    header.className = "bookmark-group-header";

    const titleSpan = document.createElement("span");
    titleSpan.textContent = group.title;

    const countSpan = document.createElement("span");
    countSpan.className = "bookmark-group-count";
    countSpan.textContent = group.bookmarks.length;

    header.appendChild(titleSpan);
    header.appendChild(countSpan);

    // Toggle collapse on click
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

  // Drag handle (only when drag is enabled)
  if (isDragEnabled()) {
    const handle = document.createElement("div");
    handle.className = "bookmark-drag-handle";
    handle.textContent = "\u2807"; // vertical six dots
    handle.addEventListener("pointerdown", (e) => onDragStart(e, card));
    card.appendChild(handle);
  }

  const body = document.createElement("div");
  body.className = "bookmark-card-body";

  // Note (if exists)
  if (bookmark.note) {
    const noteEl = document.createElement("div");
    noteEl.className = "bookmark-note";
    noteEl.textContent = bookmark.note;
    body.appendChild(noteEl);
  }

  // Content
  const contentEl = document.createElement("div");
  contentEl.className = "bookmark-content";
  contentEl.textContent = bookmark.content;

  // Collapsible for long content (>300 chars or >8 lines)
  const contentLines = bookmark.content.split("\n").length;
  if (bookmark.content.length > 300 || contentLines > 8) {
    contentEl.classList.add("bookmark-collapsible", "collapsed");
    body.appendChild(contentEl);

    const toggle = document.createElement("button");
    toggle.className = "bookmark-expand-toggle";
    toggle.textContent = "Show more";
    toggle.addEventListener("click", () => {
      contentEl.classList.toggle("collapsed");
      toggle.textContent = contentEl.classList.contains("collapsed")
        ? "Show more"
        : "Show less";
    });
    body.appendChild(toggle);
  } else {
    body.appendChild(contentEl);
  }

  // Context (if exists)
  if (bookmark.context) {
    const ctxLabel = document.createElement("div");
    ctxLabel.className = "bookmark-context-label";
    ctxLabel.textContent = "Context";
    body.appendChild(ctxLabel);

    const ctxEl = document.createElement("div");
    ctxEl.className = "bookmark-context";
    ctxEl.textContent = bookmark.context;

    const ctxLines = bookmark.context.split("\n").length;
    if (bookmark.context.length > 200 || ctxLines > 5) {
      ctxEl.classList.add("bookmark-collapsible", "collapsed");
      body.appendChild(ctxEl);

      const ctxToggle = document.createElement("button");
      ctxToggle.className = "bookmark-expand-toggle";
      ctxToggle.textContent = "Show more";
      ctxToggle.addEventListener("click", () => {
        ctxEl.classList.toggle("collapsed");
        ctxToggle.textContent = ctxEl.classList.contains("collapsed")
          ? "Show more"
          : "Show less";
      });
      body.appendChild(ctxToggle);
    } else {
      body.appendChild(ctxEl);
    }
  }

  // Source info line
  const sourceLine = document.createElement("div");
  sourceLine.className = "bookmark-source";
  const sourceLabel = getCardSourceLabel(bookmark);
  const dateStr = utcToLocalDisplay(bookmark.created_at);
  sourceLine.textContent = `${bookmark.conversation_title || "Untitled"} \u00B7 ${sourceLabel} \u00B7 ${dateStr}`;
  body.appendChild(sourceLine);

  // Action buttons
  const actions = document.createElement("div");
  actions.className = "bookmark-actions";

  const editBtn = document.createElement("button");
  editBtn.className = "bookmark-action-btn";
  editBtn.textContent = "Edit";
  editBtn.addEventListener("click", () => startEdit(bookmark.id));

  const deleteBtn = document.createElement("button");
  deleteBtn.className = "bookmark-action-btn bookmark-delete-btn";
  deleteBtn.textContent = "Delete";
  deleteBtn.addEventListener("click", () => confirmDelete(bookmark.id));

  actions.appendChild(editBtn);
  actions.appendChild(deleteBtn);
  body.appendChild(actions);

  card.appendChild(body);

  // If this card is currently being edited, render edit fields
  if (editingId === bookmark.id) {
    activateEditUI(card, bookmark);
  }

  return card;
}

// ================================================================
//  Edit flow
// ================================================================

function startEdit(id) {
  if (updatePending !== null) return;

  if (editingId !== null) {
    // Cancel previous edit first
    cancelEdit();
  }

  const bookmark = allBookmarks.find(b => b.id === id);
  if (!bookmark) return;

  editingId = id;
  editingSnapshot = {
    content: bookmark.content,
    context: bookmark.context,
    note: bookmark.note,
  };
  editingDraft = {
    content: bookmark.content,
    context: bookmark.context,
    note: bookmark.note,
  };

  renderBookmarks();
}

function activateEditUI(card, bookmark) {
  card.classList.add("editing");

  const body = card.querySelector(".bookmark-card-body");

  // Insert edit fields before the source line
  const sourceLine = body.querySelector(".bookmark-source");

  // Use editingDraft if available, otherwise fall back to bookmark values
  const draftContent = editingDraft ? editingDraft.content : (bookmark.content || "");
  const draftContext = editingDraft ? editingDraft.context : (bookmark.context || "");
  const draftNote = editingDraft ? editingDraft.note : (bookmark.note || "");

  // Check if an update is pending for this bookmark
  const isUpdatePending = updatePending?.bookmarkId === bookmark.id;

  // Note edit
  const noteField = document.createElement("textarea");
  noteField.className = "bookmark-edit-field";
  noteField.placeholder = "Note";
  noteField.value = draftNote;
  noteField.rows = 2;
  noteField.disabled = isUpdatePending;
  noteField.addEventListener("input", () => {
    if (editingDraft) editingDraft.note = noteField.value;
  });
  body.insertBefore(noteField, body.firstChild);

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

  // Replace action buttons with Save / Cancel
  const existingActions = body.querySelector(".bookmark-actions");
  if (existingActions) existingActions.classList.add("hidden");

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

    if (!newContent) {
      contentField.focus();
      return;
    }

    // Confirmation
    if (!window.confirm("Save changes to this bookmark?")) return;

    if (!isConnected()) return;

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

    send({
      type: "bookmark_update",
      request_id: requestId,
      id: bookmark.id,
      content: newContent,
      context: newContext,
      note: newNote,
    });
  });

  editActions.appendChild(cancelBtn);
  editActions.appendChild(saveBtn);
  body.insertBefore(editActions, sourceLine);

  // Auto-resize textareas
  [noteField, contentField, contextField].forEach(ta => {
    ta.addEventListener("input", () => {
      ta.style.height = "auto";
      ta.style.height = Math.min(ta.scrollHeight, 300) + "px";
    });
    // Initial sizing
    requestAnimationFrame(() => {
      ta.style.height = Math.min(ta.scrollHeight, 300) + "px";
    });
  });
}

export function cancelEdit() {
  if (editingId === null) return;
  if (updatePending !== null && updatePending.bookmarkId === editingId) return;

  // Restore snapshot if we have one
  if (editingSnapshot) {
    const bookmark = allBookmarks.find(b => b.id === editingId);
    if (bookmark) {
      bookmark.content = editingSnapshot.content;
      bookmark.context = editingSnapshot.context;
      bookmark.note = editingSnapshot.note;
    }
  }

  editingId = null;
  editingSnapshot = null;
  editingDraft = null;

  if (isBookmarksPageOpen()) {
    renderBookmarks();
  }
}

export function isEditing() {
  return editingId !== null;
}

export function isDragging() {
  return dragState !== null;
}

export function cancelDrag() {
  if (!dragState) return;

  if (dragState.scrollInterval) {
    clearInterval(dragState.scrollInterval);
  }

  const card = dragState.cardEl;
  card.classList.remove("dragging");
  card.style.position = "";
  card.style.zIndex = "";
  card.style.transform = "";

  // Remove event listeners from the handle
  const handle = card.querySelector(".bookmark-drag-handle");
  if (handle) {
    handle.removeEventListener("pointermove", onDragMove);
    handle.removeEventListener("pointerup", onDragEnd);
    handle.removeEventListener("pointercancel", onDragCancel);
  }

  dragState = null;
  // Revert to pre-drag order — since no splice was done yet, just re-render
  renderBookmarks();
}

// ================================================================
//  Delete flow
// ================================================================

function confirmDelete(id) {
  if (!window.confirm("Delete this bookmark?")) return;
  if (!isConnected()) return;

  const requestId = generateRequestId();
  pendingRequests.set(requestId, { type: "delete", bookmarkId: id });

  send({
    type: "bookmark_delete",
    request_id: requestId,
    id: id,
  });
}

// ================================================================
//  Drag and drop (Pointer Events)
// ================================================================

function getCardIndex(card) {
  const cards = [...dom.bookmarksList.querySelectorAll(".bookmark-card")];
  return cards.indexOf(card);
}

function updateDragTarget(pointerY) {
  if (!dragState) return;
  const cards = [...dom.bookmarksList.querySelectorAll(".bookmark-card")];
  let newIndex = 0;
  for (let i = 0; i < cards.length; i++) {
    if (cards[i] === dragState.cardEl) continue;
    const rect = cards[i].getBoundingClientRect();
    const midpoint = rect.top + rect.height / 2;
    if (pointerY > midpoint) {
      newIndex = i < dragState.startIndex ? i + 1 : i;
    }
  }
  dragState.currentIndex = newIndex;
}

function onDragStart(e, card) {
  if (!isDragEnabled()) return;
  e.preventDefault();

  const handle = e.currentTarget;
  handle.setPointerCapture(e.pointerId);

  const rect = card.getBoundingClientRect();
  const listRect = dom.bookmarksList.getBoundingClientRect();

  // Snapshot positions of all cards
  const allCards = [...dom.bookmarksList.querySelectorAll(".bookmark-card")];
  const cardRects = allCards.map(c => c.getBoundingClientRect());

  dragState = {
    cardEl: card,
    pointerId: e.pointerId,
    startY: e.clientY,
    offsetY: e.clientY - rect.top,
    startIndex: getCardIndex(card),
    currentIndex: getCardIndex(card),
    listRect,
    cardRects,
    scrollInterval: null,
    pointerY: e.clientY,
  };

  card.classList.add("dragging");
  card.style.position = "relative";
  card.style.zIndex = "10";

  handle.addEventListener("pointermove", onDragMove);
  handle.addEventListener("pointerup", onDragEnd);
  handle.addEventListener("pointercancel", onDragCancel);
}

function onDragMove(e) {
  if (!dragState) return;

  const deltaY = e.clientY - dragState.startY;
  dragState.cardEl.style.transform = `translateY(${deltaY}px)`;

  dragState.pointerY = e.clientY;
  updateDragTarget(dragState.pointerY);

  // Auto-scroll the bookmarks list if near edges
  const listRect = dom.bookmarksList.getBoundingClientRect();
  const edgeZone = 40;

  if (dragState.scrollInterval) {
    clearInterval(dragState.scrollInterval);
    dragState.scrollInterval = null;
  }

  if (e.clientY < listRect.top + edgeZone && dom.bookmarksList.scrollTop > 0) {
    dragState.scrollInterval = setInterval(() => {
      dom.bookmarksList.scrollTop -= 5;
      updateDragTarget(dragState.pointerY);
    }, 16);
  } else if (
    e.clientY > listRect.bottom - edgeZone &&
    dom.bookmarksList.scrollTop < dom.bookmarksList.scrollHeight - dom.bookmarksList.clientHeight
  ) {
    dragState.scrollInterval = setInterval(() => {
      dom.bookmarksList.scrollTop += 5;
      updateDragTarget(dragState.pointerY);
    }, 16);
  }
}

function onDragEnd(e) {
  if (!dragState) return;

  const handle = e.currentTarget;
  handle.removeEventListener("pointermove", onDragMove);
  handle.removeEventListener("pointerup", onDragEnd);
  handle.removeEventListener("pointercancel", onDragCancel);

  if (dragState.scrollInterval) {
    clearInterval(dragState.scrollInterval);
  }

  const card = dragState.cardEl;
  card.classList.remove("dragging");
  card.style.position = "";
  card.style.zIndex = "";
  card.style.transform = "";

  const fromIndex = dragState.startIndex;
  const toIndex = dragState.currentIndex;

  dragState = null;

  if (fromIndex === toIndex) return;

  // Snapshot the pre-move order for rollback on failure
  preReorderIds = allBookmarks.map(b => b.id);

  // Apply the move
  const moved = allBookmarks.splice(fromIndex, 1)[0];
  allBookmarks.splice(toIndex, 0, moved);

  if (!sendReorder()) {
    restoreOrderFromIds(preReorderIds);
    preReorderIds = null;
  }

  renderBookmarks();
}

function sendReorder() {
  if (!isConnected()) return false;

  reorderPending = true;

  const requestId = generateRequestId();
  pendingRequests.set(requestId, { type: "reorder" });

  send({
    type: "bookmark_reorder",
    request_id: requestId,
    ordered_ids: allBookmarks.map(b => b.id),
  });

  return true;
}

function onDragCancel(e) {
  if (!dragState) return;

  const handle = e.currentTarget;
  handle.removeEventListener("pointermove", onDragMove);
  handle.removeEventListener("pointerup", onDragEnd);
  handle.removeEventListener("pointercancel", onDragCancel);

  if (dragState.scrollInterval) {
    clearInterval(dragState.scrollInterval);
  }

  const card = dragState.cardEl;
  card.classList.remove("dragging");
  card.style.position = "";
  card.style.zIndex = "";
  card.style.transform = "";

  dragState = null;
}

// ================================================================
//  Sort / Group UI
// ================================================================

function updateSortButtons() {
  dom.bookmarksSortCustom.classList.toggle("active", currentSort === "custom");
  dom.bookmarksSortNewest.classList.toggle("active", currentSort === "newest");
  dom.bookmarksSortOldest.classList.toggle("active", currentSort === "oldest");
}

function updateGroupToggle() {
  dom.bookmarksGroupToggle.classList.toggle("active", isGrouped);
}

function handleSortClick(mode) {
  if (currentSort === mode) return;
  currentSort = mode;
  updateSortButtons();
  renderBookmarks();
}

function handleGroupToggle() {
  isGrouped = !isGrouped;
  updateGroupToggle();
  renderBookmarks();
}

// ================================================================
//  Event binding (self-initializing)
// ================================================================

function initBookmarks() {
  // Sort buttons
  dom.bookmarksSortCustom.addEventListener("click", () => handleSortClick("custom"));
  dom.bookmarksSortNewest.addEventListener("click", () => handleSortClick("newest"));
  dom.bookmarksSortOldest.addEventListener("click", () => handleSortClick("oldest"));

  // Group toggle
  dom.bookmarksGroupToggle.addEventListener("click", handleGroupToggle);

  // Search input
  dom.bookmarksSearch.addEventListener("input", () => {
    searchQuery = dom.bookmarksSearch.value.trim();
    renderBookmarks();
  });

  // Date inputs
  dom.bookmarksDateFrom.addEventListener("change", () => {
    dateFrom = dom.bookmarksDateFrom.value;
    renderBookmarks();
  });
  dom.bookmarksDateTo.addEventListener("change", () => {
    dateTo = dom.bookmarksDateTo.value;
    renderBookmarks();
  });

  // Close button
  dom.bookmarksCloseBtn.addEventListener("click", closeBookmarksPage);

  // Esc on bookmarks page
  dom.bookmarksPage.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      // If dragging, cancel drag first
      if (dragState !== null) {
        cancelDrag();
        e.stopPropagation();
        return;
      }
      // If editing, cancel edit first
      if (editingId !== null) {
        cancelEdit();
        e.stopPropagation();
        return;
      }
      closeBookmarksPage();
      e.stopPropagation();
    }
  });

  // Note popover: Save button
  dom.notePopoverSave.addEventListener("click", saveBookmark);

  // Note popover: Cancel button
  dom.notePopoverCancel.addEventListener("click", closeNotePopover);

  // Note popover: keyboard shortcuts
  dom.notePopoverInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
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
      // Don't close if clicking on the star button that opened it
      (!pendingAnchor || !pendingAnchor.contains(e.target))
    ) {
      closeNotePopover();
    }
  });
}

// Initialize on module load
initBookmarks();
