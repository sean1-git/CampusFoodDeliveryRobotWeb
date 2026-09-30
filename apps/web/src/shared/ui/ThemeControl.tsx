import { setThemePreference, useTheme, useThemePreference, type ThemePreference } from "./theme";

export function ThemeControl() {
  const theme = useTheme(), preference = useThemePreference();
  return <label className="theme-control">
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
      {theme === "dark" ? <path d="M20.6 14.2A9 9 0 0 1 9.8 3.4 9 9 0 1 0 20.6 14.2Z" />
        : <><circle cx="12" cy="12" r="4" /><path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.4 1.4m11.2 11.2L19 19M5 19l1.4-1.4M17.6 6.4 19 5" /></>}
    </svg>
    <span className="sr-only">Color theme</span>
    <select value={preference} onChange={event => setThemePreference(event.target.value as ThemePreference)}>
      <option value="system">System</option>
      <option value="light">Light</option>
      <option value="dark">Dark</option>
    </select>
  </label>;
}
