/* ================================================================
   Den — Search
   Search overlay + results.
   Sets activeAnchorId + pendingConversationId on result click.
   ================================================================ */

import { state } from "./state.js";
import { dom } from "./dom.js";
import { send, isConnected } from "./socket.js";
import { closePanel } from "./conversations.js";
import { formatTime } from "./time.js";

// ---- Open / Close ----

export function openSearch() {
  closePanel();
  dom.searchOverlay.classList.remove("hidden");
  dom.searchInput.value = "";
  dom.searchResults.innerHTML = "";
  setSearchMode("title");
  requestAnimationFrame(() => dom.searchInput.focus());
}

export function closeSearch() {
  dom.searchOverlay.classList.add("hidden");
  dom.searchInput.value = "";
  dom.searchResults.innerHTML = "";
}

// ---- Search mode ----

function setSearchMode(mode) {
  state.searchMode = mode;
  document.querySelectorAll(".search-mode-btn").forEach(btn => {
    btn.classList.toggle("active", btn.dataset.mode === mode);
  });

  if (mode === "date") {
    dom.searchInputRow.classList.add("hidden");
    dom.searchDateInputs.classList.remove("hidden");
  } else {
    dom.searchInputRow.classList.remove("hidden");
    dom.searchDateInputs.classList.add("hidden");
    dom.searchInput.placeholder = mode === "title" ? "Search titles..." : "Search content...";
    dom.searchInput.focus();
  }

  dom.searchResults.innerHTML = "";
}

// ---- Execute search ----

function doSearch() {
  if (!isConnected()) return;

  if (state.searchMode === "date") {
    const from = dom.searchDateFrom.value;
    const to = dom.searchDateTo.value;
    if (from && to) {
      send({
        type: "search_conversations",
        mode: "date",
        date_from: from,
        date_to: to,
      });
    }
    return;
  }

  const q = dom.searchInput.value.trim();
  if (!q) {
    dom.searchResults.innerHTML = "";
    return;
  }
  send({
    type: "search_conversations",
    mode: state.searchMode,
    q: q,
  });
}

// ---- Render results ----

export function renderSearchResults(results) {
  dom.searchResults.innerHTML = "";

  if (results.length === 0) {
    dom.searchResults.innerHTML = '<div class="search-empty">No results found</div>';
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
      state.currentConvTitle = r.preview || "conversation";

      // Store the full result object in the Map for anchor rendering
      state.conversationById.set(r.id, r);

      // Set pending + anchor state
      state.pendingConversationId = r.id;
      state.activeAnchorId = r.id;

      closeSearch();

      if (!isConnected()) return;

      if (r.platform_id === "Abyss") {
        send({ type: "view_history", conversation_id: r.id });
      } else {
        send({ type: "switch_conversation", conversation_id: r.id });
      }
    });

    dom.searchResults.appendChild(item);
  }
}

// ---- Bind events ----

export function initSearch() {
  dom.searchBtn.addEventListener("click", openSearch);

  dom.searchOverlay.addEventListener("click", (e) => {
    if (e.target === dom.searchOverlay) closeSearch();
  });

  dom.searchInput.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeSearch();
    if (e.key === "Enter") {
      e.preventDefault();
      doSearch();
    }
  });

  document.querySelectorAll(".search-mode-btn").forEach(btn => {
    btn.addEventListener("click", () => setSearchMode(btn.dataset.mode));
  });

  dom.searchDateApply.addEventListener("click", doSearch);
}
