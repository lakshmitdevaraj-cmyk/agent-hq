// Theme choice: "auto" follows the Mac (prefers-color-scheme); "light" / "dark" force one. Kept in localStorage.
export type ThemeChoice = "auto" | "light" | "dark";
export const THEME_KEY = "alcance_theme";

export function getTheme(): ThemeChoice {
  try {
    const v = localStorage.getItem(THEME_KEY);
    if (v === "light" || v === "dark") return v;
  } catch { /* storage blocked: stay on auto */ }
  return "auto";
}

export function applyTheme(c: ThemeChoice) {
  const el = document.documentElement;
  if (c === "auto") el.removeAttribute("data-theme");
  else el.setAttribute("data-theme", c);
}

export function setTheme(c: ThemeChoice) {
  try {
    if (c === "auto") localStorage.removeItem(THEME_KEY);
    else localStorage.setItem(THEME_KEY, c);
  } catch { /* ignore */ }
  applyTheme(c);
  window.dispatchEvent(new Event("alcance-theme"));
}
