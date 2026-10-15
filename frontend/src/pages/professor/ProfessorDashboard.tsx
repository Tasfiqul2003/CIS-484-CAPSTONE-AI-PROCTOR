import { useCallback, useEffect, useState } from "react";

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

  return (
    <div className="professor-dashboard-page">
      <header className="simple-header">
        <div className="logo">
          <span className="logo-icon">◉</span>
          <span>OralExam AI</span>
        </div>

        <button
          type="button"
          className="dashboard-logout"
          onClick={handleLogout}
        >
          Log Out
        </button>
      </header>

      <main className="professor-dashboard-content">
        <section className="dashboard-welcome">
          <p className="eyebrow">PROFESSOR PORTAL</p>
          <h1>Welcome, Professor {professorName}</h1>
          <p>
            Create and manage your oral examinations and review student
            submissions.
          </p>
        </section>

        {error && (
          <p className="dashboard-error" role="alert">
            {error}
          </p>
        )}

        <section className="dashboard-actions">
          <a
            href="/professor/exams/new"
            className="dashboard-action primary"
          >
            <span className="dashboard-action-icon">+</span>
            <div>
              <strong>Create New Exam</strong>
              <p>
                Create an examination and add its questions and course
                materials.
              </p>
            </div>
            <span className="dashboard-action-arrow">→</span>
          </a>
        </section>

        <div className="dashboard-section-heading">
          <div>
            <p className="eyebrow">YOUR EXAMINATIONS</p>
            <h2>My Exams</h2>
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

                  <div className="exam-stats">
                    <div>
                      <strong>{exam.question_count}</strong>
                      <span>Questions</span>
                    </div>

                    <div>
                      <strong>{exam.submission_count}</strong>
                      <span>Submissions</span>
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
