import { useEffect, useState, type ReactNode } from "react";
import { examManagementPath } from "./examSettingsNavigation";
import "./exam-management.css";

type Exam = {
  id: string;
  title: string;
  course: string;
  description?: string;
  icon?: string;
};

export default function ExamManagementLayout({ examId, category, children }: {
  examId: string;
  category?: string;
  children: (exam: Exam) => ReactNode;
}) {
  const [exam, setExam] = useState<Exam | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setExam(null);
    setError("");
    async function loadExam() {
      try {
        if (!examId) throw new Error("Invalid exam URL.");
        // Keep the existing ownership check before mounting any settings editor.
        const response = await fetch("/api/auth/professor/exams", {
          credentials: "include", signal: controller.signal,
        });
        if (!response.ok) throw new Error("Unable to load your examinations.");
        const exams: Exam[] = await response.json();
        const selected = exams.find(item => item.id === examId);
        if (!selected) throw new Error("Exam not found, or you do not have permission to access it.");
        if (!controller.signal.aborted) setExam(selected);
      } catch (failure) {
        if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : "Unable to load the examination.");
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    }
    void loadExam();
    return () => controller.abort();
  }, [examId]);

  return <div className="professor-dashboard-page manage-exam-page">
    <header className="simple-header">
      <div className="logo"><span className="logo-icon">◉</span><span>OralExam AI</span></div>
      <button type="button" className="dashboard-logout" onClick={async () => {
        try { await fetch("/api/auth/logout", { method: "POST", credentials: "include" }); }
        finally { window.location.href = "/professor/login"; }
      }}>Log Out</button>
    </header>
    <main className="professor-dashboard-content">
      <a href={category ? examManagementPath(examId) : "/professor/dashboard"} className="back-to-exam-button">
        {category ? "← Back to Manage Exam" : "← Back to Dashboard"}
      </a>
      {loading ? <p role="status">Loading examination...</p> : error || !exam ? <p role="alert">{error || "Examination not found."}</p> : <>
        <section className="manage-exam-header" aria-label="Selected examination">
          <div className="manage-exam-title">
            <div className="manage-exam-icon" aria-hidden="true">{exam.icon || "🎓"}</div>
            <div>
              <p className="eyebrow">{category ? `EXAM SETTINGS · ${category}` : "EXAM MANAGEMENT"}</p>
              <h1>{exam.title}</h1>
              <p>{exam.course}{exam.description ? ` • ${exam.description}` : ""}</p>
            </div>
          </div>
          <span className="exam-status-badge">Active</span>
        </section>
        {children(exam)}
      </>}
    </main>
    <footer className="home-footer"><p>OralExam AI</p><p>AI-assisted oral examination platform</p></footer>
  </div>;
}
