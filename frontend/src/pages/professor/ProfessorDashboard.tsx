import { useCallback, useEffect, useState } from "react";
import ProfessorHeader from "../../components/professor/ProfessorHeader";
import ExamRow from "../../components/professor/ExamRow";

type Professor = {
  username: string;
  role: string;
};

type Exam = {
  id: string;
  title: string;
  course: string;
  description: string | null;
  icon: string | null;
  created_at: string | null;
  status: "draft" | "published";
  question_count: number;
  submission_count: number;
  in_progress_count: number;
  awaiting_grading_count: number;
  completed_count: number;
  flagged_count: number;
  submitted_student_count?: number;
  roster_count?: number;
};

function getErrorMessage(data: any, fallback: string): string {
  const detail = data?.detail;

  if (typeof detail === "string") return detail;

  if (Array.isArray(detail)) {
    return detail
      .map((item) =>
        typeof item === "string"
          ? item
          : item?.msg || JSON.stringify(item)
      )
      .join("; ");
  }

  if (detail && typeof detail === "object") {
    return detail.message || JSON.stringify(detail);
  }

  return fallback;
}

export default function ProfessorDashboard() {
  const [professor, setProfessor] = useState<Professor | null>(null);
  const [exams, setExams] = useState<Exam[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  // Clicking an overview card shows just those exams.
  const [filter, setFilter] = useState<"all" | "published" | "draft" | "awaiting">("all");

  const loadExams = useCallback(async () => {
    const response = await fetch("/api/auth/professor/exams", {
      credentials: "include",
    });

    const data = await response.json().catch(() => null);

    if (!response.ok) {
      if (response.status === 401 || response.status === 403) {
        window.location.href = "/professor/login";
        return;
      }

      throw new Error(
        getErrorMessage(data, "Unable to load your examinations.")
      );
    }

    setExams(data ?? []);
  }, []);

  useEffect(() => {
    async function initialize() {
      try {
        const response = await fetch("/api/auth/me", {
          credentials: "include",
        });

        if (!response.ok) {
          window.location.href = "/professor/login";
          return;
        }

        const user = await response.json();

        if (user.role !== "professor") {
          setError("This account does not have professor access.");
          return;
        }

        setProfessor(user);
        await loadExams();
      } catch (err) {
        setError(
          err instanceof Error
            ? err.message
            : "Unable to connect to the server."
        );
      } finally {
        setLoading(false);
      }
    }

    initialize();
  }, [loadExams]);


  async function togglePublication(exam: Exam) {
    const action =
      exam.status === "published" ? "unpublish" : "publish";

    setSaving(true);
    setError("");

    try {
      const response = await fetch(
        `/api/exam/templates/${exam.id}/${action}`,
        {
          method: "POST",
          credentials: "include",
        }
      );

      const data = await response.json().catch(() => ({}));

      if (!response.ok) {
        throw new Error(
          getErrorMessage(data, `Unable to ${action} this exam.`)
        );
      }

      await loadExams();
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : "Unable to update exam status."
      );
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return (
      <main className="professor-dashboard-content">
        <p>Loading your dashboard...</p>
      </main>
    );
  }

  if (error && !professor) {
    return (
      <main className="professor-dashboard-content">
        <p role="alert">{error}</p>
        <a href="/professor/login">Return to login</a>
      </main>
    );
  }

  if (!professor) {
    return (
      <main className="professor-dashboard-content">
        <p>Please sign in again.</p>
        <a href="/professor/login">Return to login</a>
      </main>
    );
  }

  const professorName =
    professor.username
      .split(".")
      .pop()
      ?.replace(/^./, (letter) => letter.toUpperCase()) || "Professor";

  const visibleExams = exams.filter(exam => filter === "all" ? true
    : filter === "awaiting" ? exam.awaiting_grading_count > 0 : exam.status === filter);

  const publishedCount = exams.filter(
    (exam) => exam.status === "published"
  ).length;
  const draftCount = exams.filter(
    (exam) => exam.status === "draft"
  ).length;
  const submissionCount = exams.reduce(
    (total, exam) => total + exam.submission_count,
    0
  );
  const awaitingGradingCount = exams.reduce(
    (total, exam) => total + exam.awaiting_grading_count,
    0
  );

  return (
    <div className="professor-dashboard-page">
      <ProfessorHeader title="Professor portal" current="dashboard" />

      <main className="professor-dashboard-content">
        <section className="dashboard-welcome">
          <h1>Welcome back, {professorName}.</h1>
          <p>
            Your oral examinations, student activity, and grading
            workflow — all in one place.
          </p>
        </section>

        {error && (
          <p className="dashboard-error" role="alert">
            {error}
          </p>
        )}

        <section className="dashboard-actions" aria-labelledby="dashboard-actions-heading">
          <h2 id="dashboard-actions-heading" className="dashboard-section-title">Create and set up</h2>
          <a
            href="/professor/exams/new"
            className="dashboard-action primary"
          >
            <span className="dashboard-action-icon" aria-hidden="true">+</span>
            <div>
              <strong>Create a new examination</strong>
              <p>
                Start an oral assessment, add questions, and upload
                course materials.
              </p>
            </div>
            <span className="dashboard-action-arrow" aria-hidden="true">→</span>
          </a>
          <a href="/professor/avatar" className="dashboard-action primary dashboard-action-avatar">
            <span className="dashboard-action-icon" aria-hidden="true">◉</span>
            <div>
              <strong>Set up your exam avatar</strong>
              <p>Upload a photo and a short voice sample so the examiner looks and sounds like you.</p>
            </div>
            <span className="dashboard-action-arrow" aria-hidden="true">→</span>
          </a>
        </section>

        <section className="dashboard-overview" aria-label="Exam overview">
          <div className="dashboard-overview-heading">
            <div>
              <h2 className="dashboard-section-title">Your overview</h2>
            </div>
            <span className="dashboard-overview-context">
              Select a box to see those exams
            </span>
          </div>

          <div className="dashboard-overview-grid">
            <button type="button" className="dashboard-overview-card" aria-pressed={filter === "all"}
              onClick={() => { setFilter("all"); document.getElementById("dashboard-exams")?.scrollIntoView({ behavior: "smooth", block: "start" }); }}>
              <span className="dashboard-overview-icon overview-icon-purple" aria-hidden="true">
                <span>▤</span>
              </span>
              <div className="dashboard-overview-label">Total examinations</div>
              <strong>{exams.length}</strong>
              <span className="dashboard-overview-detail">Created in your workspace</span>
            </button>

            <button type="button" className="dashboard-overview-card" aria-pressed={filter === "published"}
              onClick={() => { setFilter("published"); document.getElementById("dashboard-exams")?.scrollIntoView({ behavior: "smooth", block: "start" }); }}>
              <span className="dashboard-overview-icon overview-icon-green" aria-hidden="true">
                <span>✓</span>
              </span>
              <div className="dashboard-overview-label">Published</div>
              <strong>{publishedCount}</strong>
              <span className="dashboard-overview-detail">Available to students</span>
            </button>

            <button type="button" className="dashboard-overview-card" aria-pressed={filter === "draft"}
              onClick={() => { setFilter("draft"); document.getElementById("dashboard-exams")?.scrollIntoView({ behavior: "smooth", block: "start" }); }}>
              <span className="dashboard-overview-icon overview-icon-amber" aria-hidden="true">
                <span>◷</span>
              </span>
              <div className="dashboard-overview-label">Drafts</div>
              <strong>{draftCount}</strong>
              <span className="dashboard-overview-detail">Still being prepared</span>
            </button>

            <button type="button" className="dashboard-overview-card" aria-pressed={filter === "awaiting"}
              onClick={() => { setFilter("awaiting"); document.getElementById("dashboard-exams")?.scrollIntoView({ behavior: "smooth", block: "start" }); }}>
              <span className="dashboard-overview-icon overview-icon-blue" aria-hidden="true">
                <span>▥</span>
              </span>
              <div className="dashboard-overview-label">Awaiting grading</div>
              <strong>{awaitingGradingCount}</strong>
              <span className="dashboard-overview-detail">
                {submissionCount} total submission{submissionCount === 1 ? "" : "s"}
              </span>
            </button>
          </div>
        </section>



        <div className="dashboard-section-heading">
          <div className="dashboard-section-heading-main">
            <h2 id="dashboard-exams" className="dashboard-section-title">
              {filter === "all" ? "Your examinations" : filter === "published" ? "Published exams"
                : filter === "draft" ? "Draft exams" : "Exams awaiting grading"}
            </h2>
            {filter !== "all" && <button type="button" className="dashboard-filter-clear" onClick={() => setFilter("all")}>Show all exams</button>}
          </div>
          <span>
            {filter === "all" ? exams.length : `${visibleExams.length} of ${exams.length}`} exam{exams.length === 1 ? "" : "s"}
          </span>
        </div>

        <section className="professor-exams-content">
          {visibleExams.length === 0 ? (
            <div className="dashboard-empty">
              {exams.length === 0 ? <>
                <h3>No exams yet</h3>
                <p>Create your first exam to get started.</p>
              </> : <>
                <h3>No exams in this group</h3>
                <p>Select another box above, or show all exams.</p>
              </>}
            </div>
          ) : (
            <ul className="exam-rows" aria-label="Your examinations">
              {visibleExams.map((exam) => (
                <ExamRow key={exam.id} exam={exam} busy={saving} onTogglePublication={() => togglePublication(exam)} />
              ))}
            </ul>
          )}
        </section>
      </main>

      <footer className="home-footer">
        <p>OralExam AI</p>
        <p>AI-assisted oral examination platform</p>
      </footer>
    </div>
  );
}
