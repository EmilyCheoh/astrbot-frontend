/* ================================================================
   Den — Time
   AstrBot stores conversation timestamps in UTC.
   Change this one value when Den moves to another timezone.
   Taiwan: 8 | Ohio winter: -5 | Ohio summer: -4
   ================================================================ */

export const UTC_OFFSET_HOURS = 8;

const HOUR_MS = 60 * 60 * 1000;

function parseAstrBotUtc(ts) {
  if (!ts) return null;

  const raw = String(ts).trim();
  let normalized = raw.replace(" ", "T");

  const hasTimezone =
    normalized.endsWith("Z") ||
    /[+-]\d{2}:\d{2}$/.test(normalized);

  if (!hasTimezone) {
    normalized += "Z";
  }

  const date = new Date(normalized);

  return Number.isNaN(date.getTime()) ? null : date;
}

export function formatTime(ts) {
  const utcDate = parseAstrBotUtc(ts);

  if (!utcDate) {
    return ts || "";
  }

  const shifted = new Date(utcDate.getTime() + UTC_OFFSET_HOURS * HOUR_MS);

  const month  = String(shifted.getUTCMonth() + 1).padStart(2, "0");
  const day    = String(shifted.getUTCDate()).padStart(2, "0");
  const hour   = String(shifted.getUTCHours()).padStart(2, "0");
  const minute = String(shifted.getUTCMinutes()).padStart(2, "0");

  return `${month}-${day} ${hour}:${minute}`;
}
