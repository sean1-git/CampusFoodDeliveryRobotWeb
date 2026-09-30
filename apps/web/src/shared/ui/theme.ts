import { useSyncExternalStore } from "react";

export type Theme = "light" | "dark";
export type ThemePreference = Theme | "system";
const storageKey = "campus-color-theme";
const listeners = new Set<() => void>();
let preference: ThemePreference = "system";
let resolved: Theme = "light";
let media: MediaQueryList | undefined;
const validPreference = (value: unknown): ThemePreference => value === "light" || value === "dark" ? value : "system";

function applyTheme() {
  resolved = preference === "system" ? media?.matches ? "dark" : "light" : preference;
  document.documentElement.dataset.theme = resolved;
  document.documentElement.style.colorScheme = resolved;
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", resolved === "dark" ? "#101827" : "#142b52");
  listeners.forEach(listener => listener());
}

// Initialize before mounting React, including on offline PWA launches. Storage
// can be blocked in private browsing; the theme still works for this visit.
export function initializeTheme() {
  if (media) return;
  media = window.matchMedia("(prefers-color-scheme: dark)");
  try { preference = validPreference(localStorage.getItem(storageKey)); } catch { /* Use the device setting. */ }
  media.addEventListener("change", () => { if (preference === "system") applyTheme(); });
  window.addEventListener("storage", event => {
    if (event.key === storageKey || event.key === null) {
      preference = validPreference(event.newValue);
      applyTheme();
    }
  });
  applyTheme();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
export function setThemePreference(value: ThemePreference) {
  preference = validPreference(value);
  try { localStorage.setItem(storageKey, preference); } catch { /* Keep the in-memory selection. */ }
  applyTheme();
}
export const useTheme = () => useSyncExternalStore(subscribe, () => resolved, () => "light" as Theme);
export const useThemePreference = () => useSyncExternalStore(subscribe, () => preference, () => "system" as ThemePreference);
