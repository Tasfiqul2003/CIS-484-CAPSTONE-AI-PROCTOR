import OralExamMark from "../brand/OralExamMark";

/** One top bar for professor pages: logo, page title in the middle, and a way back to the dashboard. */
export default function ProfessorHeader({ title, current }: { title?: string; current?: "dashboard" | "exams" }) {
  const logOut = async () => {
    try { await fetch("/api/auth/logout", { method: "POST", credentials: "include" }); }
    finally { window.location.href = "/professor/login"; }
  };
  return <header className="simple-header professor-topbar">
    <a className="logo" href="/professor/dashboard" aria-label="OralExam AI dashboard">
      <span className="logo-icon" aria-hidden="true"><OralExamMark size={34} /></span>
      <span>OralExam AI</span>
    </a>
    {title && <p className="professor-topbar-title">{title}</p>}
    <nav className="professor-topbar-nav" aria-label="Professor pages">
      <a href="/professor/dashboard" aria-current={current === "dashboard" ? "page" : undefined}>Dashboard</a>
      <a href="/professor/exams" aria-current={current === "exams" ? "page" : undefined}>My Exams</a>
      <button type="button" className="dashboard-logout" onClick={() => void logOut()}>Log Out</button>
    </nav>
  </header>;
}
