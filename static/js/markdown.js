/* ================================================================
   Den — Markdown Rendering
   Shared module: marked + DOMPurify with fallback.
   Supports GitHub-style Callouts, {thoughts}, and calendar cards.
   ================================================================ */

// Calendar styles are separate from the existing message/callout styles.
// Load them once without changing Den's HTML entry point.
const calendarStylesheet = document.createElement("link");
calendarStylesheet.rel = "stylesheet";
calendarStylesheet.href = new URL("../css/calendar.css", import.meta.url).href;
document.head.appendChild(calendarStylesheet);

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

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[char]);
}

function installCalloutRenderer() {
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

// Match only the plugin's standalone, complete {calendar} blocks.
// The backend uses the same outer markers and excludes fenced code blocks.
const CALENDAR_BLOCK_PATTERN = /^[ \t]*\{calendar\}[ \t]*\r?\n([\s\S]*?)^[ \t]*\{\/calendar\}[ \t]*(?:\r?\n|$)/gm;
const FENCE_PATTERN = /^[ \t]{0,3}(`{3,}|~{3,})/;
const CALENDAR_KEYS = new Set(["TITLE", "START", "END", "DESC", "LOC", "ALL_DAY", "RECURRENCE_RULE"]);
const MONTHS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
const WEEKDAYS = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];
const RR_DAYS = { MO: "周一", TU: "周二", WE: "周三", TH: "周四", FR: "周五", SA: "周六", SU: "周日" };

function fencedSpans(text) {
  const spans = [];
  let marker = null;
  let start = 0;
  let offset = 0;
  for (const line of text.match(/[^\n]*\n|[^\n]+$/g) || []) {
    const fence = FENCE_PATTERN.exec(line);
    if (!marker && fence) {
      marker = fence[1];
      start = offset;
    } else if (marker && fence && fence[1][0] === marker[0] && fence[1].length >= marker.length) {
      spans.push([start, offset + line.length]);
      marker = null;
    }
    offset += line.length;
  }
  if (marker) spans.push([start, text.length]);
  return spans;
}

function parseCalendarFields(body) {
  const fields = {};
  for (const line of body.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const colon = line.indexOf(":");
    if (colon < 0) return null;
    const key = line.slice(0, colon).trim().toUpperCase();
    if (!CALENDAR_KEYS.has(key) || Object.hasOwn(fields, key)) return null;
    let rawValue = line.slice(colon + 1).trim();
    if (rawValue.endsWith(",")) rawValue = rawValue.slice(0, -1).trimEnd();
    if (key === "ALL_DAY" && /^(?:true|false|t|f)$/i.test(rawValue.replace(/^["']|["']$/g, ""))) {
      fields[key] = /^(?:true|t)$/i.test(rawValue.replace(/^["']|["']$/g, ""));
    } else {
      try { fields[key] = JSON.parse(rawValue); }
      catch { return null; }
    }
  }
  if (typeof fields.TITLE !== "string" || !fields.TITLE.trim()
    || typeof fields.START !== "string" || !fields.START.trim()) return null;
  if (fields.ALL_DAY !== undefined && typeof fields.ALL_DAY !== "boolean") return null;
  for (const key of ["END", "DESC", "LOC", "RECURRENCE_RULE"]) {
    if (fields[key] !== undefined && typeof fields[key] !== "string") return null;
  }
  return fields;
}

function parseCalendarDate(raw, allDay) {
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::\d{2}(?:\.\d+)?)?(Z|[+-]\d{2}:\d{2}))?$/.exec(raw);
  if (!match || (!allDay && !match[4])) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const d = new Date(Date.UTC(year, month - 1, day));
  if (d.getUTCFullYear() !== year || d.getUTCMonth() !== month - 1 || d.getUTCDate() !== day) return null;
  if (match[4] && (Number(match[4]) > 23 || Number(match[5]) > 59)) return null;
  return { year, month, day, date: `${match[1]}-${match[2]}-${match[3]}`, time: match[4] ? `${match[4]}:${match[5]}` : "", weekday: WEEKDAYS[d.getUTCDay()] };
}

function recurrenceLabel(rule) {
  if (!rule) return "";
  const parts = Object.fromEntries(rule.toUpperCase().split(";").map(x => x.split("=", 2)));
  const base = { DAILY: "每天", WEEKLY: "每周", MONTHLY: "每月", YEARLY: "每年" }[parts.FREQ];
  if (!base) return rule;
  const interval = parts.INTERVAL && /^\d+$/.test(parts.INTERVAL) ? Number(parts.INTERVAL) : 1;
  let label = interval > 1 ? `每 ${interval} ${{ DAILY: "天", WEEKLY: "周", MONTHLY: "个月", YEARLY: "年" }[parts.FREQ]}` : base;
  if (parts.BYDAY && parts.BYDAY.split(",").every(day => RR_DAYS[day])) {
    label += ` · ${parts.BYDAY.split(",").map(day => RR_DAYS[day]).join("、")}`;
  } else if (parts.BYDAY || parts.BYMONTHDAY || parts.BYMONTH) {
    return rule; // Keep complex rules exact rather than summarizing incorrectly.
  }
  if (parts.COUNT) label += ` · 共 ${parts.COUNT} 次`;
  if (parts.UNTIL) label += ` · 至 ${parts.UNTIL}`;
  return label;
}

function renderCalendarCard(body) {
  const fields = parseCalendarFields(body);
  if (!fields) return null;
  const allDay = fields.ALL_DAY === true;
  const start = parseCalendarDate(fields.START, allDay);
  const end = fields.END ? parseCalendarDate(fields.END, allDay) : null;
  if (!start || (fields.END && !end)) return null;
  if (end && allDay && end.date <= start.date) return null;
  if (end && !allDay) {
    const startTimestamp = Date.parse(fields.START);
    const endTimestamp = Date.parse(fields.END);
    if (!Number.isFinite(startTimestamp) || !Number.isFinite(endTimestamp)
      || endTimestamp <= startTimestamp) return null;
  }

  let timeLabel = "全天";
  if (allDay) {
    if (end) {
      // CalDAV DTEND is exclusive for all-day events.
      const last = new Date(Date.UTC(end.year, end.month - 1, end.day) - 86400000);
      const lastDate = `${last.getUTCFullYear()}-${String(last.getUTCMonth() + 1).padStart(2, "0")}-${String(last.getUTCDate()).padStart(2, "0")}`;
      if (lastDate !== start.date) timeLabel = `全天 · ${start.date} – ${lastDate}`;
    }
  } else if (!end) {
    timeLabel = start.time;
  } else if (start.date === end.date) {
    timeLabel = `${start.time} – ${end.time}`;
  } else {
    timeLabel = `${start.date} ${start.time} → ${end.date} ${end.time}`;
  }

  const detail = (icon, content) => `<div class="calendar-card-detail"><span class="calendar-card-detail-icon" aria-hidden="true">${icon}</span><span>${escapeHtml(content)}</span></div>`;
  const description = fields.DESC ? `<div class="calendar-card-description">${escapeHtml(fields.DESC)}</div>` : "";
  const location = fields.LOC ? detail("📍", fields.LOC) : "";
  const recurrence = fields.RECURRENCE_RULE ? detail("🔁", recurrenceLabel(fields.RECURRENCE_RULE)) : "";

  return `<aside class="calendar-card">`
    + `<div class="calendar-card-main">`
    + `<div class="calendar-card-date" aria-label="${escapeHtml(start.date)}">`
    + `<span class="calendar-card-month">${MONTHS[start.month - 1]}</span>`
    + `<strong class="calendar-card-day">${start.day}</strong>`
    + `<span class="calendar-card-weekday">${start.weekday}</span>`
    + `</div>`
    + `<div class="calendar-card-body">`
    + `<div class="calendar-card-title">${escapeHtml(fields.TITLE)}</div>`
    + detail("🕒", timeLabel)
    + location + recurrence
    + `</div></div>`
    + description
    + `</aside>`;
}

function renderCalendarMarkdown(text) {
  if (!text.includes("{calendar}")) return renderPlainMarkdown(text);

  const fenced = fencedSpans(text);
  const chunks = [];
  let cursor = 0;
  CALENDAR_BLOCK_PATTERN.lastIndex = 0;
  for (const match of text.matchAll(CALENDAR_BLOCK_PATTERN)) {
    const start = match.index;
    const end = start + match[0].length;
    if (fenced.some(([left, right]) => left < end && start < right)) continue;
    const card = renderCalendarCard(match[1]);
    if (!card) continue; // Preserve malformed blocks as ordinary raw Markdown.
    chunks.push(renderPlainMarkdown(text.slice(cursor, start)), card);
    cursor = end;
  }
  if (!chunks.length) return renderPlainMarkdown(text);
  chunks.push(renderPlainMarkdown(text.slice(cursor)));
  return chunks.join("");
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
  if (!open) return renderCalendarMarkdown(text);

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

  return disclosure + renderCalendarMarkdown(answer);
}
