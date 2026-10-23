import { useCallback, useEffect, useState } from "react";
import OralExamMark from "../../components/brand/OralExamMark";

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

  async function handleLogout() {
    try {
      await fetch("/api/auth/logout", {
        method: "POST",
        credentials: "include",
      });
    } finally {
      window.location.href = "/professor/login";
    }
  }

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

  async function deleteExam(exam: Exam) {
    const confirmed = window.confirm(
      `Delete "${exam.title}"? This cannot be undone. Exams with student sessions cannot be deleted.`
    );

    if (!confirmed) return;

    setSaving(true);
    setError("");

    try {
      const response = await fetch(
        `/api/exam/templates/${exam.id}`,
        {
          method: "DELETE",
          credentials: "include",
        }
      );

      const data = await response.json().catch(() => ({}));

      if (!response.ok) {
        throw new Error(
          getErrorMessage(data, "Unable to delete this exam.")
        );
      }

      await loadExams();
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : "Unable to delete this exam."
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
      <header className="simple-header">
        <a className="logo dashboard-brand" href="/professor/dashboard">
          <span className="logo-icon" aria-hidden="true">
            <OralExamMark size={34} />
          </span>
          <span className="dashboard-brand-copy">
            <strong>OralExam <span>AI</span></strong>
            <small>PROFESSOR WORKSPACE</small>
          </span>
        </a>

        <div className="dashboard-header-right">
          <span className="dashboard-role-label">
            <span className="dashboard-role-dot" />
            Professor Workspace
          </span>
          <button
            type="button"
            className="dashboard-logout"
            onClick={handleLogout}
          >
            <span>Log out</span>
          </button>
        </div>
      </header>

      <main className="professor-dashboard-content">
        <section className="dashboard-welcome">
          <p className="eyebrow">PROFESSOR PORTAL</p>
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

        <section className="dashboard-overview" aria-label="Exam overview">
          <div className="dashboard-overview-heading">
            <div>
              <p className="eyebrow">AT A GLANCE</p>
              <h2>Your overview</h2>
            </div>
            <span className="dashboard-overview-context">
              Based on your examinations
            </span>
          </div>

          <div className="dashboard-overview-grid">
            <article className="dashboard-overview-card">
              <span className="dashboard-overview-icon overview-icon-purple" aria-hidden="true">
                <span>▤</span>
              </span>
              <div className="dashboard-overview-label">Total examinations</div>
              <strong>{exams.length}</strong>
              <span className="dashboard-overview-detail">Created in your workspace</span>
            </article>

            <article className="dashboard-overview-card">
              <span className="dashboard-overview-icon overview-icon-green" aria-hidden="true">
                <span>✓</span>
              </span>
              <div className="dashboard-overview-label">Published</div>
              <strong>{publishedCount}</strong>
              <span className="dashboard-overview-detail">Available to students</span>
            </article>

            <article className="dashboard-overview-card">
              <span className="dashboard-overview-icon overview-icon-amber" aria-hidden="true">
                <span>◷</span>
              </span>
              <div className="dashboard-overview-label">Drafts</div>
              <strong>{draftCount}</strong>
              <span className="dashboard-overview-detail">Still being prepared</span>
            </article>

            <article className="dashboard-overview-card">
              <span className="dashboard-overview-icon overview-icon-blue" aria-hidden="true">
                <span>▥</span>
              </span>
              <div className="dashboard-overview-label">Awaiting grading</div>
              <strong>{awaitingGradingCount}</strong>
              <span className="dashboard-overview-detail">
                {submissionCount} total submission{submissionCount === 1 ? "" : "s"}
              </span>
            </article>
          </div>
        </section>

        <section className="dashboard-actions">
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
        </section>

        <div className="dashboard-section-heading">
          <div>
            <p className="eyebrow">EXAM MANAGEMENT</p>
            <h2>Your examinations</h2>
          </div>
          <span>
            {exams.length} exam{exams.length === 1 ? "" : "s"}
          </span>
        </div>

        <section className="professor-exams-content">
          {exams.length === 0 ? (
            <div className="dashboard-empty">
              <h3>No exams yet</h3>
              <p>Create your first exam to get started.</p>
            </div>
          ) : (
            <div className="exam-grid">
              {exams.map((exam) => (
                <article
                  className="professor-exam-card"
                  key={exam.id}
                >
                  <div className="exam-card-title">
                    <div className="professor-exam-icon">
                      {exam.icon || "🎙️"}
                    </div>

                    <div>
                      <div className="exam-course">
                        {exam.course || "ORAL EXAM"}
                      </div>
                      <h2>{exam.title}</h2>
                    </div>

                    <span
                      className={`exam-status-badge ${
                        exam.status === "published"
                          ? "published"
                          : "draft"
                      }`}
                    >
                      {exam.status === "published"
                        ? "Published"
                        : "Draft"}
                    </span>
                  </div>

                  <p className="exam-description">
                    {exam.description ||
                      "Manage questions, course materials, and exam settings."}
                  </p>

                  <div className="exam-stats exam-stats-detailed">
                    <div className="exam-stat">
                      <span className="exam-stat-label">Questions</span>
                      <strong>{exam.question_count}</strong>
                    </div>

                    <div className="exam-stat">
                      <span className="exam-stat-label">Submissions</span>
                      <strong>{exam.submission_count}</strong>
                    </div>

                    <div className="exam-stat">
                      <span className="exam-stat-label">Completed</span>
                      <strong>{exam.completed_count}</strong>
                    </div>

                    <div className="exam-stat">
                      <span className="exam-stat-label">In Progress</span>
                      <strong>{exam.in_progress_count}</strong>
                    </div>

                    <div className="exam-stat">
                      <span className="exam-stat-label">Awaiting Grading</span>
                      <strong>{exam.awaiting_grading_count}</strong>
                    </div>

                    <div className="exam-stat">
                      <span className="exam-stat-label">Flagged</span>
                      <strong>{exam.flagged_count}</strong>
                    </div>
                  </div>

                  <div className="exam-card-actions">
                    <a href={`/professor/exams/${exam.id}`}>
                      Manage Exam
                    </a>

                    <a
                      className="view-submissions-button"
                      href={`/professor/exams/${exam.id}/submissions`}
                    >
                      View Submissions
                    </a>

                    <button
                      type="button"
                      className={`publication-button ${
                        exam.status === "published"
                          ? "is-published"
                          : "is-draft"
                      }`}
                      disabled={saving}
                      onClick={() => togglePublication(exam)}
                    >
                      {exam.status === "published"
                        ? "Make Draft"
                        : "Publish Exam"}
                    </button>

                    <button
                      type="button"
                      className="delete-exam-button"
                      disabled={saving}
                      onClick={() => deleteExam(exam)}
                    >
                      Delete Exam
                    </button>
                  </div>
                </article>
              ))}
            </div>
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
