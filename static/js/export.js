/* ================================================================
   Den — Export
   Markdown export of current conversation.
   ================================================================ */

import { state } from "./state.js";
import { dom } from "./dom.js";

const TIMESTAMP_TAG_RE = /<(?:current_)?date_and_time>[\s\S]*?<\/(?:current_)?date_and_time>\s*$/;

// ---- Overflow menu ----

function toggleMoreMenu() {
  dom.moreMenu.classList.toggle("hidden");
}

function closeMoreMenu() {
  dom.moreMenu.classList.add("hidden");
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

  dom.exportMdBtn.addEventListener("click", exportMarkdown);
}
