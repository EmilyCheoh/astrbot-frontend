/* ================================================================
   Den — Quote / Citation Preview
   Manages the pending quote above the composer: set, clear,
   format for send, and render preview.
   ================================================================ */

import { state } from "./state.js";
import { dom } from "./dom.js";

// ---- Source label mapping ----

function getSourceLabel(sourceType, sourceName) {
  switch (sourceType) {
    case "user":      return "You";
    case "assistant":  return "Noir";
    case "cot":        return "Noir (CoT)";
    case "tool":       return `Tool (${sourceName})`;
    default:           return "Unknown";
  }
}

// ---- Preview rendering ----

function renderQuotePreview() {
  const q = state.pendingQuote;
  if (!q) return;
  dom.quotePreviewSource.textContent = getSourceLabel(q.sourceType, q.sourceName);
  dom.quotePreviewText.textContent = q.text;
  dom.quotePreview.classList.remove("hidden");
}

// ---- Public API ----

export function setPendingQuote(quote) {
  state.pendingQuote = quote;
  renderQuotePreview();
}

export function clearPendingQuote() {
  state.pendingQuote = null;
  dom.quotePreview.classList.add("hidden");
}

export function hasPendingQuote() {
  return state.pendingQuote !== null;
}

export function formatQuoteForSend(userText) {
  if (!state.pendingQuote) return userText;
  const q = state.pendingQuote;
  const sourceLabel = getSourceLabel(q.sourceType, q.sourceName);
  const quotedLines = q.text.split("\n").map(line => `> ${line}`).join("\n");
  return `${userText}\n\nCiting ${sourceLabel}:\n${quotedLines}`;
}

// ---- Init ----

export function initQuote() {
  dom.quotePreviewClose.addEventListener("click", clearPendingQuote);
}
