import { useEffect, useState } from "react";
import { UserRound } from "lucide-react";
import OralExamMark from "../brand/OralExamMark";
import PortalThemeToggle from "../theme/PortalThemeToggle";

let signedInName: Promise<string> | null = null;

/** The signed-in professor's display name, fetched once per page load. */
function loadName(): Promise<string> {
  signedInName ??= fetch("/api/auth/me", { credentials: "include" })
    .then(response => response.ok ? response.json() : null)
    .then((me: { name?: string | null; username?: string } | null) => me?.name || me?.username || "")
    .catch(() => "");
  return signedInName;
}

/** One top bar for professor pages: logo; page title, navigation and who is signed in centred; Log Out at the right. */
export default function ProfessorHeader({ title, current }: { title?: string; current?: "dashboard" | "exams" | "avatar" }) {
  const [name, setName] = useState("");
  useEffect(() => {
    let alive = true;
    void loadName().then(value => { if (alive) setName(value); });
    return () => { alive = false; };
  }, []);
  const logOut = async () => {
    try { await fetch("/api/auth/logout", { method: "POST", credentials: "include" }); }
    finally { window.location.href = "/professor/login"; }
  };
  return <header className="simple-header professor-topbar">
    <a className="logo" href="/professor/dashboard" aria-label="OralExam AI dashboard">
      <span className="logo-icon" aria-hidden="true"><OralExamMark size={34} /></span>
      <span>OralExam AI</span>
    </a>
    <div className="professor-topbar-center">
      {title && <p className="professor-topbar-title">{title}</p>}
      <nav className="professor-topbar-nav" aria-label="Professor pages">
        <a href="/professor/dashboard" aria-current={current === "dashboard" ? "page" : undefined}>Dashboard</a>
        <a href="/professor/exams" aria-current={current === "exams" ? "page" : undefined}>My Exams</a>
        <a href="/professor/avatar" aria-current={current === "avatar" ? "page" : undefined}>Avatar</a>
      </nav>
      {name && <span className="professor-topbar-user"><UserRound size={16} aria-hidden="true" />{name}</span>}
    </div>
    <div className="portal-header-actions">
      <PortalThemeToggle />
      <button type="button" className="dashboard-logout professor-topbar-logout" onClick={() => void logOut()}>Log Out</button>
    </div>
  </header>;
}
