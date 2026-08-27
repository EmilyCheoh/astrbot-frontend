/* ================================================================
   Den — Header Menu (Pin, Export, Delete) + Markdown export
   ================================================================ */

import { state } from "./state.js";
import { dom } from "./dom.js";
import { send, isConnected } from "./socket.js";
import { showDeleteDialog } from "./conversations.js";

const TIMESTAMP_TAG_RE = /<(?:current_)?date_and_time>[\s\S]*?<\/(?:current_)?date_and_time>\s*$/;

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
    dom.morePinBtn.innerHTML = ICON_STAR + " Pin";
    return;
  }
  const conv = state.conversationById.get(cid);
  const isPinned = conv && conv.pinned;
  const isPending = state.pendingPinIds.has(cid);

  if (isPending) {
    dom.morePinBtn.innerHTML = (isPinned ? ICON_STAR_FILLED : ICON_STAR) + " ...";
    dom.morePinBtn.disabled = true;
  } else {
    dom.morePinBtn.innerHTML = (isPinned ? ICON_STAR_FILLED : ICON_STAR) + " " + (isPinned ? "Unpin" : "Pin");
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

// ---- Export ----

function exportMarkdown() {
  if (!state.currentMessages.length) return;

  let md = "";

  for (const msg of state.currentMessages) {
    const role = msg.role || "system";

    if (role === "tool") {
      const resultText = typeof msg.content === "string"
        ? msg.content
        : JSON.stringify(msg.content, null, 2);
      md += "<details><summary>\u2192 result</summary>\n\n```\n" + resultText + "\n```\n\n</details>\n\n---\n\n";
      continue;
    }

    const prefix = role === "user" ? "**User:**"
      : role === "assistant" ? "**Assistant:**"
      : "**" + role + ":**";

    let text = "";
    if (Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (block.type === "thinking" || block.type === "think") {
          const thinkText = block.thinking || block.think || block.text || block.content || "";
          text += "<details><summary>thinking</summary>\n\n" + thinkText + "\n\n</details>\n\n";
        } else if (block.type === "text") {
          text += block.text || block.content || "";
        } else if (typeof block === "string") {
          text += block;
        } else {
          text += block.text || block.content || JSON.stringify(block);
        }
      }
    } else {
      text = typeof msg.content === "string"
        ? msg.content
        : JSON.stringify(msg.content);
    }

    text = text.replace(TIMESTAMP_TAG_RE, "").trim();

    if (role === "assistant" && msg.tool_calls && msg.tool_calls.length > 0) {
      for (const tc of msg.tool_calls) {
        const fn = tc.function || {};
        let args = fn.arguments || "";
        if (typeof args === "string") {
          try { args = JSON.stringify(JSON.parse(args), null, 2); } catch {}
        } else {
          args = JSON.stringify(args, null, 2);
        }
        text += "\n\n<details><summary>\u26A1 " + (fn.name || "tool call") + "</summary>\n\n```\n" + args + "\n```\n\n</details>";
      }
    }

    md += prefix + "\n\n" + text.trim() + "\n\n---\n\n";
  }

  const blob = new Blob([md], { type: "text/markdown;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  const safeName = (state.currentConvTitle || "conversation").slice(0, 50).replace(/[/\\?%*:|"<>]/g, "_");
  a.download = safeName + ".md";
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);

  closeMoreMenu();
}

// ---- Bind events ----

export function initExport() {
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
  dom.exportMdBtn.addEventListener("click", exportMarkdown);
  dom.moreDeleteBtn.addEventListener("click", handleDelete);
}
