/* Den — {calendar} display only. No iCloud writes or side effects on history. */

// Calendar styles are separate from the existing message/callout styles.
// Load them once without changing Den's HTML entry point.
const calendarStylesheet = document.createElement("link");
calendarStylesheet.rel = "stylesheet";
calendarStylesheet.href = new URL("../css/calendar.css", import.meta.url).href;
document.head.appendChild(calendarStylesheet);

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[char]);
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
  let label = interval > 1 ? `每 ${interval} ${ { DAILY: "天", WEEKLY: "周", MONTHLY: "个月", YEARLY: "年" }[parts.FREQ] }` : base;
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

export function renderCalendarMarkdown(text, renderPlainMarkdown) {
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

