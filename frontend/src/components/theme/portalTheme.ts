export type PortalTheme = "light" | "dark";

// One preference follows the user between both portals. Public pages stay light.
export const PORTAL_THEME_KEY = "oralexam:portal-theme:v1";

export function isPortalPath(path = window.location.pathname): boolean {
  return /^\/(student|professor)(\/|$)/.test(path);
}

export function readPortalTheme(): PortalTheme {
  try {
    return localStorage.getItem(PORTAL_THEME_KEY) === "dark" ? "dark" : "light";
  } catch {
    try {
      return sessionStorage.getItem(PORTAL_THEME_KEY) === "dark" ? "dark" : "light";
    } catch {
      return "light";
    }
  }
}

export function applyPortalTheme(theme = readPortalTheme()): PortalTheme {
  const active = isPortalPath() ? theme : "light";
  document.documentElement.dataset.theme = active;
  return active;
}

export function savePortalTheme(theme: PortalTheme): void {
  try {
    localStorage.setItem(PORTAL_THEME_KEY, theme);
  } catch {
    // If persistent storage is blocked, retain the choice in this tab when possible.
    try { sessionStorage.setItem(PORTAL_THEME_KEY, theme); } catch { /* In-page switching still works. */ }
  }
  applyPortalTheme(theme);
}
