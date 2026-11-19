import { useEffect, useState } from "react";
import { Moon } from "lucide-react";
import { applyPortalTheme, PORTAL_THEME_KEY, savePortalTheme } from "./portalTheme";

export default function PortalThemeToggle() {
  const [theme, setTheme] = useState(() => applyPortalTheme());

  useEffect(() => {
    const sync = () => setTheme(applyPortalTheme());
    const onStorage = (event: StorageEvent) => {
      if (event.key === PORTAL_THEME_KEY || event.key === null) sync();
    };
    window.addEventListener("storage", onStorage);
    window.addEventListener("pageshow", sync);
    return () => {
      window.removeEventListener("storage", onStorage);
      window.removeEventListener("pageshow", sync);
    };
  }, []);

  return <button type="button" role="switch" aria-checked={theme === "dark"}
    className="portal-theme-toggle" onClick={() => {
      const next = theme === "dark" ? "light" : "dark";
      savePortalTheme(next);
      setTheme(next);
    }}>
    <Moon size={15} aria-hidden="true" />
    <span>Dark mode</span>
    <span className="portal-theme-track" aria-hidden="true"><span /></span>
  </button>;
}
