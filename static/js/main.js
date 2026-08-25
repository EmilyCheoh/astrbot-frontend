/* ================================================================
   Den — Main Entry Point
   <script type="module"> — top-level dispatch, event wiring.
   No circular dependencies: socket dispatches here, UI modules
   are called from here.
   ================================================================ */

import { state } from "./state.js";
import { dom } from "./dom.js";
import { connectWS, send } from "./socket.js";
import { cycleTheme, cycleFont } from "./preferences.js";
import {
  appendBot, renderHistory, scrollToBottom,
  setComposerReadonly, updateLastActions,
} from "./messages.js";
import { sendMessage, initComposer } from "./composer.js";
import {
  openPanel, closePanel, renderConvList, closeConvMenu,
  initConversations,
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
      break;

    case "error":
      alert(data.message || "Authentication failed");
      state.savedToken = null;
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
      break;

    case "message": {
      const segs = data.segments || [];
      const isIntermediate = segs.length > 0
        && segs.every(s => s.type === "reasoning" || s.type === "tool_call");
      if (!isIntermediate) {
        state.isProcessing = false;
        dom.thinkingIndicator.classList.add("hidden");
      }
      if (segs.length > 0) appendBot(segs);
      break;
    }

    case "history":
      state.currentMessages = data.messages || [];
      state.isReadonly = data.readonly || false;
      dom.messages.innerHTML = "";
      renderHistory(state.currentMessages);
      setComposerReadonly(state.isReadonly);
      break;

    case "conversations_list":
      state.lastConvListData = data;
      renderConvList(data);
      break;

    case "conversation_switched":
      state.isReadonly = false;
      setComposerReadonly(false);
      closePanel();
      break;

    case "conversation_created":
      state.currentMessages = [];
      state.isReadonly = false;
      dom.messages.innerHTML = "";
      setComposerReadonly(false);
      closePanel();
      break;

    case "search_results":
      renderSearchResults(data.results || [], data.mode);
      break;

    case "pin_updated":
      state.pinnedIds = data.pinned || [];
      if (state.lastConvListData) {
        for (const conv of state.lastConvListData.conversations) {
          conv.pinned = state.pinnedIds.includes(conv.id);
        }
        renderConvList(state.lastConvListData);
      }
      break;

    case "conversation_renamed":
      if (state.lastConvListData) {
        const rc = state.lastConvListData.conversations.find(c => c.id === data.conversation_id);
        if (rc) {
          rc.preview = data.title || "(empty)";
          renderConvList(state.lastConvListData);
        }
      }
      break;

    case "conversation_deleted":
      if (state.lastConvListData) {
        const dc = state.lastConvListData.conversations.find(
          c => c.id === data.conversation_id && c.active
        );
        state.lastConvListData.conversations = state.lastConvListData.conversations.filter(
          c => c.id !== data.conversation_id
        );
        state.lastConvListData.total = Math.max(0, state.lastConvListData.total - 1);
        renderConvList(state.lastConvListData);
        if (dc) {
          send({ type: "new_conversation" });
        }
      }
      break;
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
