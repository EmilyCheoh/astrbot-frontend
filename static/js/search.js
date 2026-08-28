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
  setSearchMode("content");
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

    const placeholders = {
      content: "Search content...",
      cot: "Search CoT...",
      title: "Search titles...",
    };
    dom.searchInput.placeholder = placeholders[mode] || "Search content...";
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

// ---- Navigation handler ----

function openSearchResult(r) {
  state.currentConvTitle = r.preview || "conversation";
  state.conversationById.set(r.id, r);
  state.pendingConversationId = r.id;
  state.activeAnchorId = r.id;

  closeSearch();

  if (!isConnected()) return;

  if (r.platform_id === "Abyss") {
    send({ type: "view_history", conversation_id: r.id });
  } else {
    send({ type: "switch_conversation", conversation_id: r.id });
  }
}

// ---- Match element builder ----

function createMatchButton(result, match) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "search-result-match";

  button.appendChild(document.createTextNode(match.before || ""));

  const mark = document.createElement("mark");
  mark.textContent = match.match || "";
  button.appendChild(mark);

  button.appendChild(document.createTextNode(match.after || ""));

  button.addEventListener("click", () => {
    openSearchResult(result);
  });

  return button;
}

// ---- Render results ----

export function renderSearchResults(results) {
  dom.searchResults.innerHTML = "";

  if (results.length === 0) {
    dom.searchResults.innerHTML = '<div class="search-empty">No results found</div>';
    return;
  }

  for (const r of results) {
    const item = document.createElement("div");
    item.className = "search-result-item";

    // -- Clickable heading --
    const heading = document.createElement("button");
    heading.type = "button";
    heading.className = "search-result-heading";
    heading.addEventListener("click", () => {
      openSearchResult(r);
    });

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

    heading.appendChild(topRow);
    item.appendChild(heading);

    // -- Match list --
    const matches = Array.isArray(r.matches) ? r.matches : [];

    if (matches.length > 0) {
      const matchList = document.createElement("div");
      matchList.className = "search-result-matches";

      const matchButtons = matches.map((match, index) => {
        const button = createMatchButton(r, match);
        button.hidden = index >= 3;
        matchList.appendChild(button);
        return button;
      });

      item.appendChild(matchList);

      if (matches.length > 3) {
        const toggle = document.createElement("button");
        toggle.type = "button";
        toggle.className = "search-result-toggle";
        toggle.textContent = `Show all ${matches.length} matches`;

        let expanded = false;

        toggle.addEventListener("click", () => {
          expanded = !expanded;

          matchButtons.forEach((button, index) => {
            button.hidden = !expanded && index >= 3;
          });

          toggle.textContent = expanded
            ? "Show less"
            : `Show all ${matches.length} matches`;
        });

        item.appendChild(toggle);
      }
    }

    // -- Timestamp --
    const time = document.createElement("div");
    time.className = "search-result-time";
    time.textContent = formatTime(r.updated_at);
    item.appendChild(time);

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
