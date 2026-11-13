/* Den — shared Markdown rendering: CoT, Callouts, Calendar. */

import { installCalloutRenderer } from "./callout.js";
import { renderCalendarMarkdown } from "./calendar.js";

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[char]);
}


function renderPlainMarkdown(text) {
  if (!text) return "";
  if (typeof window.marked !== "undefined" && typeof window.DOMPurify !== "undefined") {
    installCalloutRenderer();
    const html = window.marked.parse(text, { breaks: true, gfm: true });
    return window.DOMPurify.sanitize(html, {
      ADD_TAGS: ["details", "summary"],
      ADD_ATTR: ["open"],
    });
  }
  // Fallback: escape HTML and convert newlines to <br>.
  const el = document.createElement("span");
  el.textContent = text;
  return el.innerHTML.replace(/\n/g, "<br>");
}


export function renderMarkdown(text) {
  if (!text) return "";

  // Support both thoughts and recursion_trace.
  const markers = {
    "{thoughts}": "{/thoughts}",
    "{recursion_trace}": "{/recursion_trace}",
  };
  const start = text.length - text.trimStart().length;
  const open = Object.keys(markers).find(marker => text.startsWith(marker, start));
  if (!open) return renderCalendarMarkdown(text, renderPlainMarkdown);

  const close = markers[open];
  const end = text.indexOf(close, start + open.length);
  if (end < 0) return renderPlainMarkdown(text); // Incomplete: show original.

  const thoughts = text.slice(start + open.length, end).trim();
  const answer = text.slice(end + close.length).trimStart();

  // Display thoughts as literal text in the existing CoT disclosure style.
  const disclosure = thoughts
    ? '<details class="cot-block">'
    + '<summary>Thinking\u2026</summary>'
    + '<div class="cot-content">' + escapeHtml(thoughts) + '</div>'
    + '</details>'
    : "";

  return disclosure + renderCalendarMarkdown(answer, renderPlainMarkdown);
}
