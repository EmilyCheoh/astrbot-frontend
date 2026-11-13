/* Den — GitHub-style Markdown Callouts. */

// GitHub-style Markdown Callouts, with optional custom titles.
// Only blockquotes are inspected, so fenced code blocks stay unchanged.
const CALLOUT_PATTERN = /^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION|LOVE)\](?:[ \t]+([^\r\n]*))?(?:\r?\n|$)/i;

const CALLOUT_LABELS = {
  note: "Note",
  tip: "Tip",
  important: "Important",
  warning: "Warning",
  caution: "Caution",
  love: "Love",
};

const CALLOUT_ICONS = {
  note: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5m0-8h.01"/>',
  tip: '<path d="M9 18h6m-5 3h4m-5-6a7 7 0 1 1 6 0c-.7.6-1 1.3-1 2H10c0-.7-.3-1.4-1-2Z"/>',
  important: '<path d="M12 3 3 8v8l9 5 9-5V8l-5-5Z"/><path d="M12 8v5m0 3h.01"/>',
  warning: '<path d="m10.3 4.3-8.2 14a2 2 0 0 0 1.7 3h16.4a2 2 0 0 0 1.7-3l-8.2-14a2 2 0 0 0-3.4 0Z"/><path d="M12 9v4m0 4h.01"/>',
  caution: '<path d="M8 3h8l5 5v8l-5 5V8l-5-5Z"/><path d="M12 8v5m0 4h.01"/>',
  love: '<path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78Z"/>',
};

let calloutRendererInstalledOn = null;

export function installCalloutRenderer() {
  const marked = window.marked;
  if (calloutRendererInstalledOn === marked) return;

  marked.use({
    renderer: {
      blockquote(token) {
        const source = token.text || "";
        const match = CALLOUT_PATTERN.exec(source);
        if (!match) return false; // Keep the default renderer for normal quotes.

        const kind = match[1].toLowerCase();
        const title = marked.parseInline(match[2]?.trim() || CALLOUT_LABELS[kind], { gfm: true });
        const body = source.slice(match[0].length);
        const content = body ? marked.parse(body, { breaks: true, gfm: true }) : "";
        const icon = `<svg class="md-callout-icon" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${CALLOUT_ICONS[kind]}</svg>`;

        return `<aside class="md-callout md-callout--${kind}">`
          + `<div class="md-callout-title">${icon}<span>${title}</span></div>`
          + `<div class="md-callout-content">${content}</div>`
          + `</aside>`;
      },
    },
  });
  calloutRendererInstalledOn = marked;
}

