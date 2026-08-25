/* ================================================================
   Den — Preferences (Theme + Font toggle)
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


// ---- Font — Serif / Sans-serif toggle ----

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
    dom.fontToggle.title = "Font: " + family;
  }
}

export function cycleFont() {
  const current = localStorage.getItem("den-font") || "serif";
  applyFont(current === "serif" ? "sans-serif" : "serif");
}


// ---- Initialize on import ----
applyTheme(localStorage.getItem("den-theme") || "auto");
applyFont(localStorage.getItem("den-font") || "serif");
