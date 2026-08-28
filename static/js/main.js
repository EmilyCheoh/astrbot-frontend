/* ================================================================
   Den — Main Entry Point
   <script type="module"> — top-level dispatch, event wiring.
   No circular dependencies: socket dispatches here, UI modules
   are called from here.
   ================================================================ */

import { state } from "./state.js";
import { dom } from "./dom.js";
import { connectWS, send, stopReconnect } from "./socket.js";
import { cycleTheme, cycleFont } from "./preferences.js";
import {
  appendBot, renderHistory, scrollToBottom,
  setComposerReadonly, updateLastActions, initScrollButton,
} from "./messages.js";
import { sendMessage, initComposer, updateComposerAvailability } from "./composer.js";
import {
  openPanel, closePanel, closeConvMenu,
  initConversations, mergeConversations, setFavorites,
  updateConversation, removeConversation, renderSidebar,
} from "./conversations.js";
import { renderSearchResults, closeSearch, initSearch } from "./search.js";
import { initExport } from "./export.js";

// ---- Message dispatch (called by socket.js on every WS message) ----

function handleMessage(data) {
  switch (data.type) {
    case "auth_ok":
      dom.login.classList.add("hidden");
      dom.chat.classList.remove("hidden");
      dom.thinkingIndicator.classList.add("hidden");
      dom.msgInput.focus();
      // Clear stale state from previous connection
      state.pendingPinIds.clear();
      state.pendingConversationId = null;
      state.activeAnchorId = null;
      break;

    case "error":
      alert(data.message || "Something went wrong");
      // Only kill reconnect for auth errors (no message id)
      if (!data.id) stopReconnect();
      break;

    case "message_ack":
      break;

    case "status":
      if (data.status === "thinking") {
        state.isProcessing = true;
        dom.thinkingIndicator.classList.remove("hidden");
        scrollToBottom();
      } else {
        state.isProcessing = false;
        dom.thinkingIndicator.classList.add("hidden");
      }
      updateComposerAvailability();
      break;

    case "message": {
      const segs = data.segments || [];
      const isIntermediate = segs.length > 0
        && segs.every(s => s.type === "reasoning" || s.type === "tool_call");
      if (!isIntermediate) {
        state.isProcessing = false;
        dom.thinkingIndicator.classList.add("hidden");
        updateComposerAvailability();
      }
      if (segs.length > 0) appendBot(segs);
      break;
    }

    case "history": {
      state.currentConversationId = data.conversation_id || null;
      state.pendingConversationId = null;
      // Clear search anchor if we navigated away from it
      if (state.activeAnchorId && state.activeAnchorId !== data.conversation_id) {
        state.activeAnchorId = null;
      }
      state.currentMessages = data.messages || [];
      state.isReadonly = data.readonly || false;

      // Derive conversation title: Map entry > first user message > fallback
      const knownConv = state.conversationById.get(data.conversation_id);
      if (knownConv && knownConv.preview && knownConv.preview !== "(empty)") {
        state.currentConvTitle = knownConv.preview;
      } else {
        const firstUser = state.currentMessages.find(m => m.role === "user");
        const raw = firstUser
          ? (typeof firstUser.content === "string"
            ? firstUser.content
            : Array.isArray(firstUser.content)
              ? (firstUser.content.find(b => b.type === "text") || {}).text || ""
              : "")
          : "";
        state.currentConvTitle = raw.trim().split("\n")[0].slice(0, 80) || "conversation";
      }

      dom.messages.innerHTML = "";
      renderHistory(state.currentMessages);
      setComposerReadonly(state.isReadonly);
      renderSidebar();
      break;
    }

    case "favorites_list":
      setFavorites(data.favorites || []);
      break;

    case "conversations_list":
      mergeConversations(
        data.conversations || [],
        data.next_cursor || null,
        data.has_more !== false,
        data.generation,
      );
      break;

    case "conversations_list_failed":
      // Only handle if generation matches (not stale)
      if (data.generation === undefined || data.generation === state.listGeneration) {
        state.isLoadingMore = false;
        state.listError = true;
        renderSidebar();
      }
      break;

    case "navigation_failed":
      // Only clear pending/anchor if they match the failed navigation
      if (state.pendingConversationId === data.conversation_id) {
        state.pendingConversationId = null;
      }
      if (state.activeAnchorId === data.conversation_id) {
        state.activeAnchorId = null;
      }
      renderSidebar();
      break;

    case "conversation_switched":
      closePanel();
      break;

    case "conversation_created":
      state.currentConversationId = data.conversation_id || null;
      state.pendingConversationId = null;
      state.activeAnchorId = null;
      state.currentMessages = [];
      state.isReadonly = false;
      dom.messages.innerHTML = "";
      setComposerReadonly(false);
      closePanel();
      break;

    case "search_results":
      renderSearchResults(data.results || [], data.mode);
      break;

    case "pin_updated": {
      // Clear pending state for this conversation
      state.pendingPinIds.delete(data.conversation_id);
      // Update the pinned flag in the Map
      const pinnedConv = state.conversationById.get(data.conversation_id);
      if (pinnedConv) {
        pinnedConv.pinned = data.pinned;
      }
      // Replace favorites with authoritative server data
      setFavorites(data.favorites || []);
      break;
    }

    case "pin_update_failed":
      // Clear pending state — button unlocks, no change applied
      state.pendingPinIds.delete(data.conversation_id);
      renderSidebar();
      break;

    case "conversation_renamed": {
      const newTitle = data.title || "(empty)";
      updateConversation(data.conversation_id, { preview: newTitle });
      break;
    }

    case "conversation_deleted": {
      const wasViewing = state.currentConversationId === data.conversation_id;
      removeConversation(data.conversation_id);
      if (wasViewing) {
        send({ type: "new_conversation" });
      }
      break;
    }
  }
}

// ---- Login ----

dom.loginBtn.addEventListener("click", () => connectWS(dom.tokenInput.value, handleMessage));
dom.tokenInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") connectWS(dom.tokenInput.value, handleMessage);
});

// ---- Header buttons ----

dom.themeToggle.addEventListener("click", cycleTheme);
dom.fontToggle.addEventListener("click", cycleFont);

// ---- Global ESC ----

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    if (!dom.searchOverlay.classList.contains("hidden")) {
      closeSearch();
    }
  }
});

// ---- Init sub-modules ----

initComposer();
initConversations();
initSearch();
initExport();
initScrollButton();
