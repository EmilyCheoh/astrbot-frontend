/* ================================================================
   Den — Preferences (Theme + Font + Chat Size)
   ================================================================ */

import { dom } from "./dom.js";

// ---- Theme — Light / Dark / Auto (3-state cycle) ----

const THEME_MODES = ["light", "dark", "auto"];
const THEME_ICONS = { light: "\u2600\uFE0E", dark: "\u263E", auto: "\u25D0" };

function getResolvedTheme(mode) {
  if (mode === "auto") {
    return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  }
  return mode;
}

export function applyTheme(mode) {
  const resolved = getResolvedTheme(mode);
  document.documentElement.setAttribute("data-theme", resolved);
  localStorage.setItem("den-theme", mode);
  if (dom.themeToggle) {
    dom.themeToggle.textContent = THEME_ICONS[mode];
    dom.themeToggle.title = "Theme: " + mode;
  }
}

export function cycleTheme() {
  const current = localStorage.getItem("den-theme") || "auto";
  const next = THEME_MODES[(THEME_MODES.indexOf(current) + 1) % THEME_MODES.length];
  applyTheme(next);
}

// Re-apply when system preference changes (only matters in auto mode)
window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
  if ((localStorage.getItem("den-theme") || "auto") === "auto") {
    applyTheme("auto");
  }
});


// ---- Font — Serif / Sans-serif ----

const FONT_SERIF = 'Georgia, "Times New Roman", serif';
const FONT_SANS  = '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';

export function applyFont(family) {
  const isSerif = family === "serif";
  document.documentElement.style.setProperty(
    "--font-bot",
    isSerif ? FONT_SERIF : FONT_SANS
  );
  localStorage.setItem("den-font", family);
  if (dom.fontToggle) {
    dom.fontToggle.className = "icon-btn " + (isSerif ? "serif" : "sans");
  }
  // Sync popover font buttons
  if (dom.fontSerifBtn) dom.fontSerifBtn.setAttribute("aria-pressed", isSerif);
  if (dom.fontSansBtn)  dom.fontSansBtn.setAttribute("aria-pressed", !isSerif);
  updateFontToggleTitle();
}


// ---- Chat Size — Small / Medium / Large (segmented) ----

const CHAT_SIZE_PRESETS = {
  small:  { message: "15px", cot: "14px", cotTitle: "13px", code: "13px", table: "14px" },
  medium: { message: "17px", cot: "16px", cotTitle: "15px", code: "15px", table: "16px" },
  large:  { message: "19px", cot: "18px", cotTitle: "17px", code: "17px", table: "18px" },
};

const SIZE_BTNS = () => [
  { key: "small",  el: dom.fontSizeSmallBtn },
  { key: "medium", el: dom.fontSizeMediumBtn },
  { key: "large",  el: dom.fontSizeLargeBtn },
];

export function applyChatSize(size) {
  if (!CHAT_SIZE_PRESETS[size]) size = "medium";
  const p = CHAT_SIZE_PRESETS[size];
  const root = document.documentElement;
  root.style.setProperty("--chat-message-size", p.message);
  root.style.setProperty("--chat-cot-size", p.cot);
  root.style.setProperty("--chat-cot-title-size", p.cotTitle);
  root.style.setProperty("--chat-code-size", p.code);
  root.style.setProperty("--chat-table-size", p.table);
  localStorage.setItem("den-chat-size", size);
  // Sync popover size buttons
  for (const { key, el } of SIZE_BTNS()) {
    if (el) el.setAttribute("aria-pressed", key === size);
  }
  updateFontToggleTitle();
}


// ---- Font-toggle title helper ----

function updateFontToggleTitle() {
  if (!dom.fontToggle) return;
  const font = (localStorage.getItem("den-font") || "serif") === "serif" ? "Serif" : "Sans";
  const rawSize = localStorage.getItem("den-chat-size") || "medium";
  const size = CHAT_SIZE_PRESETS[rawSize] ? rawSize : "medium";
  const sizeLabel = size.charAt(0).toUpperCase() + size.slice(1);
  dom.fontToggle.title = font + " \u00B7 " + sizeLabel;
}


// ---- Font settings popover open / close ----

export function toggleFontSettings() {
  if (!dom.fontSettings) return;
  const opening = dom.fontSettings.classList.contains("hidden");
  dom.fontSettings.classList.toggle("hidden");
  dom.fontToggle.setAttribute("aria-expanded", opening);
}

export function closeFontSettings() {
  if (!dom.fontSettings) return;
  dom.fontSettings.classList.add("hidden");
  if (dom.fontToggle) dom.fontToggle.setAttribute("aria-expanded", "false");
}

export function isFontSettingsOpen() {
  return dom.fontSettings ? !dom.fontSettings.classList.contains("hidden") : false;
}


// ---- Bookmarks Font — Georgia / System (independent) ----

const FONT_BOOKMARK_SERIF = 'Georgia, "Times New Roman", serif';
const FONT_BOOKMARK_SANS  = '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';

export function applyBookmarksFont(mode) {
  const isGeorgia = mode === "georgia";
  document.documentElement.style.setProperty(
    "--font-bookmark",
    isGeorgia ? FONT_BOOKMARK_SERIF : FONT_BOOKMARK_SANS
  );
  localStorage.setItem("den-bookmarks-font", mode);
  if (dom.bookmarksFontToggle) {
    dom.bookmarksFontToggle.className = "icon-btn bookmarks-icon-btn " + (isGeorgia ? "serif" : "sans");
    dom.bookmarksFontToggle.title = "Bookmarks font: " + (isGeorgia ? "Georgia" : "System");
  }
}

export function cycleBookmarksFont() {
  const current = localStorage.getItem("den-bookmarks-font") || "georgia";
  applyBookmarksFont(current === "georgia" ? "system" : "georgia");
}


// ---- Initialize on import ----
applyTheme(localStorage.getItem("den-theme") || "auto");
applyFont(localStorage.getItem("den-font") || "serif");
applyChatSize(localStorage.getItem("den-chat-size") || "medium");
applyBookmarksFont(localStorage.getItem("den-bookmarks-font") || "georgia");
