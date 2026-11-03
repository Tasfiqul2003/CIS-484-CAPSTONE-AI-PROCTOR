import { useCallback, useEffect, useState } from "react";
import {
  AlertCircle,
  ArrowLeft,
  Clock3,
  GraduationCap,
  LoaderCircle,
  RefreshCw,
  Users,
} from "lucide-react";
import OralExamMark from "../../components/brand/OralExamMark";

type StudentProgress = {
  student_id: string;
  student_name: string;
  email: string;
  eid: string | null;
  session_id: string | null;
  status: string | null;
  started_at: string | null;
  ended_at: string | null;
};

function formatDate(value: string | null) {
  if (!value) return "—";

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";

  return date.toLocaleString([], {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

function getStatus(student: StudentProgress) {
  if (!student.session_id || !student.status) {
    return "Not started";
  }

  return student.status
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function statusClass(student: StudentProgress) {
  if (!student.session_id || !student.status) {
    return "progress-status status-not-started";
  }

  switch (student.status) {
    case "in_progress":
      return "progress-status status-in-progress";
    case "pending_grading":
      return "progress-status status-pending";
    case "graded":
      return "progress-status status-graded";
    case "flagged":
      return "progress-status status-flagged";
    case "abandoned":
      return "progress-status status-abandoned";
    default:
      return "progress-status status-unknown";
  }
}

export default function ExamSubmissions() {
  const examId = window.location.pathname
    .split("/")
    .filter(Boolean)
    .at(-2);

  const [students, setStudents] = useState<StudentProgress[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState("");

  const loadProgress = useCallback(async (manual = false) => {
    if (!examId) {
      setError("The exam ID is missing from the page URL.");
      setLoading(false);
      return;
    }

    if (manual) {
      setRefreshing(true);
    } else {
      setLoading(true);
    }

    setError("");

    try {
      const response = await fetch(
        `/api/exam/templates/${encodeURIComponent(examId)}/progress`,
        { credentials: "include" },
      );

      if (!response.ok) {
        let message = "Unable to load exam progress.";

        try {
          const body = await response.json();
          if (typeof body.detail === "string") {
            message = body.detail;
          }
        } catch {
          // Keep the fallback message if the response isn't JSON.
        }

        throw new Error(message);
      }

      const data: unknown = await response.json();

      if (!Array.isArray(data)) {
        throw new Error("The server returned an unexpected progress response.");
      }

      setStudents(data as StudentProgress[]);
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : "An unexpected error occurred while loading progress.",
      );
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [examId]);

  useEffect(() => {
    void loadProgress();
  }, [loadProgress]);

  const counts = {
    total: students.length,
    notStarted: students.filter(
      (student) => !student.session_id || !student.status,
    ).length,
    inProgress: students.filter(
      (student) => student.status === "in_progress",
    ).length,
    awaitingReview: students.filter(
      (student) => student.status === "pending_grading",
    ).length,
    completed: students.filter(
      (student) => student.status === "graded",
    ).length,
    flagged: students.filter(
      (student) => student.status === "flagged",
    ).length,
  };

  return (
    <div className="professor-dashboard">
      <header className="dashboard-header">
        <a
          href="/professor/dashboard"
          className="dashboard-brand"
          aria-label="Return to professor dashboard"
        >
          <OralExamMark />
          <span>OralExam AI</span>
        </a>

        <a href="/professor/dashboard" className="progress-back-link">
          <ArrowLeft size={16} aria-hidden="true" />
          Dashboard
        </a>
      </header>

      <main className="dashboard-main">
        <section className="dashboard-welcome">
          <div>
            <p className="eyebrow">EXAM MANAGEMENT</p>
            <h1>Student Progress</h1>
            <p>
              Monitor roster participation and review each student&apos;s
              latest examination status.
            </p>
          </div>

          <button
            type="button"
            className="progress-refresh-button"
            onClick={() => void loadProgress(true)}
            disabled={loading || refreshing}
          >
            {refreshing ? (
              <LoaderCircle size={16} className="progress-spin" />
            ) : (
              <RefreshCw size={16} />
            )}
            Refresh
          </button>
        </section>

        {error && (
          <section className="progress-error" role="alert">
            <AlertCircle size={20} aria-hidden="true" />
            <div>
              <strong>Progress could not be loaded</strong>
              <p>{error}</p>
              <button
                type="button"
                onClick={() => void loadProgress(true)}
              >
                Try again
              </button>
            </div>
          </section>
        )}

        <section className="progress-summary" aria-label="Exam progress summary">
          <article className="progress-summary-card">
            <Users size={20} aria-hidden="true" />
            <span>Rostered students</span>
            <strong>{loading ? "—" : counts.total}</strong>
          </article>

          <article className="progress-summary-card">
            <Clock3 size={20} aria-hidden="true" />
            <span>Not started</span>
            <strong>{loading ? "—" : counts.notStarted}</strong>
          </article>

          <article className="progress-summary-card">
            <LoaderCircle size={20} aria-hidden="true" />
            <span>In progress</span>
            <strong>{loading ? "—" : counts.inProgress}</strong>
          </article>

          <article className="progress-summary-card">
            <GraduationCap size={20} aria-hidden="true" />
            <span>Awaiting review</span>
            <strong>{loading ? "—" : counts.awaitingReview}</strong>
          </article>
        </section>

        <section className="progress-table-section">
          <div className="dashboard-section-heading">
            <div>
              <p className="eyebrow">ROSTER</p>
              <h2>Student examination status</h2>
            </div>
            {!loading && (
              <span className="progress-count">
                {students.length} student{students.length === 1 ? "" : "s"}
              </span>
            )}
          </div>

          {loading ? (
            <div className="progress-empty-state" role="status">
              <LoaderCircle size={24} className="progress-spin" />
              <p>Loading student progress…</p>
            </div>
          ) : !error && students.length === 0 ? (
            <div className="progress-empty-state">
              <Users size={28} aria-hidden="true" />
              <h3>No students on this roster</h3>
              <p>Upload a student roster for this exam to see participation here.</p>
            </div>
          ) : !error ? (
            <div className="progress-table-wrap">
              <table className="progress-table">
                <thead>
                  <tr>
                    <th scope="col">Student</th>
                    <th scope="col">EID</th>
                    <th scope="col">Status</th>
                    <th scope="col">Started</th>
                    <th scope="col">Ended</th>
                  </tr>
                </thead>
                <tbody>
                  {students.map((student) => (
                    <tr key={student.student_id}>
                      <td>
                        <div className="progress-student-name">
                          <span className="progress-student-avatar">
                            {(student.student_name || "?")
                              .trim()
                              .charAt(0)
                              .toUpperCase()}
                          </span>
                          <div>
                            <strong>{student.student_name || "Unnamed student"}</strong>
                            <span>{student.email}</span>
                          </div>
                        </div>
                      </td>
                      <td>{student.eid || "—"}</td>
                      <td>
                        <span className={statusClass(student)}>
                          {getStatus(student)}
                        </span>
                      </td>
                      <td>{formatDate(student.started_at)}</td>
                      <td>{formatDate(student.ended_at)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}

          {!loading && !error && students.length > 0 && (
            <p className="progress-status-note">
              {counts.completed} graded · {counts.flagged} flagged ·{" "}
              {counts.awaitingReview} awaiting review
            </p>
          )}
        </section>
      </main>
    </div>
  );
}
