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
  allowed_seconds: number | null;
  elapsed_seconds: number | null;
  remaining_seconds: number | null;
  server_now: string | null;
  developer_demo?: boolean;
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

function formatDuration(seconds: number | null) {
  if (seconds === null || !Number.isFinite(seconds)) return "—";

  const total = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const remainingSeconds = total % 60;

  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${remainingSeconds}s`;
  return `${remainingSeconds}s`;
}

type StudentReport = {
  session?: { video_file_ref?: string | null };
  interactions?: {
    sequence_num: number;
    question_text?: string | null;
    student_answer_transcript?: string | null;
  }[];
  grades?: {
    rubric_criterion: string;
    max_score: number;
    model_suggested_score?: number | null;
    score?: number | null;
    professor_notes?: string | null;
  }[];
};

function downloadRosterFile(filename: string, content: string) {
  const blob = new Blob([content], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

async function getStudentReport(sessionId: string): Promise<StudentReport> {
  const response = await fetch(
    `/api/exam/${encodeURIComponent(sessionId)}/report`,
    { credentials: "include" },
  );

  if (!response.ok) {
    throw new Error(`Unable to retrieve student report (${response.status}).`);
  }

  return await response.json() as StudentReport;
}

async function downloadStudentTranscript(sessionId: string) {
  try {
    const report = await getStudentReport(sessionId);
    const content = (report.interactions || []).map(item => [
      `Question ${item.sequence_num}`,
      item.question_text || "Question unavailable",
      "Student answer:",
      item.student_answer_transcript || "No transcript saved.",
      "",
    ].join("\n")).join("\n");

    downloadRosterFile(
      `exam-transcript-${sessionId}.txt`,
      content || "No transcripts available.",
    );
  } catch (error) {
    window.alert(error instanceof Error ? error.message : "Transcript download failed.");
  }
}

async function downloadStudentGrade(sessionId: string) {
  try {
    const report = await getStudentReport(sessionId);
    const content = (report.grades || []).map(grade => [
      `Criterion: ${grade.rubric_criterion}`,
      `Recommended score: ${grade.model_suggested_score ?? "Not available"}`,
      `Maximum score: ${grade.max_score}`,
      `Professor-confirmed score: ${grade.score ?? "Not confirmed"}`,
      `AI rationale: ${grade.professor_notes || "None provided"}`,
      "",
    ].join("\n")).join("\n");

    downloadRosterFile(
      `recommended-grades-${sessionId}.txt`,
      content || "No recommended grades have been generated.",
    );
  } catch (error) {
    window.alert(error instanceof Error ? error.message : "Grade download failed.");
  }
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
  const [statusFilter, setStatusFilter] = useState("all");

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
          } else {
            message = JSON.stringify(body);
          }
        } catch {
          // Keep the fallback message if the response isn't JSON.
        }

        throw new Error(
          `Request failed (${response.status} ${response.statusText}): ${message}`,
        );
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
    demos: students.filter(student => student.developer_demo === true).length,
    total: students.length,
    notStarted: students.filter(
      (student) => !student.session_id || !student.status,
    ).length,
    inProgress: students.filter(
      (student) => student.status === "in_progress",
    ).length,
    awaitingReview: students.filter(
      (student) => student.status === "pending_grading" && !student.developer_demo,
    ).length,
    completed: students.filter(
      (student) => student.status === "graded",
    ).length,
    flagged: students.filter(
      (student) => student.status === "flagged",
    ).length,
  };

  const filteredStudents = students.filter((student) => {
    if (statusFilter === "all") return true;
    if (statusFilter === "not_started") {
      return !student.session_id || !student.status;
    }
    if (statusFilter === "pending_grading") {
      return student.status === statusFilter && !student.developer_demo;
    }
    return student.status === statusFilter;
  });

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
        {counts.demos > 0 && <aside className="developer-demo-note" aria-label="Saved developer demos">
          <strong>{counts.demos} developer demo attempt{counts.demos === 1 ? "" : "s"}</strong>
          <p>Labeled demos cannot receive grades and are excluded from the awaiting review count.</p>
        </aside>}

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
                {filteredStudents.length} of {students.length} student{students.length === 1 ? "" : "s"}
              </span>
            )}
          </div>

          {!loading && !error && students.length > 0 && (
            <div className="progress-filter">
              <label htmlFor="progress-status-filter">Filter students by status</label>
              <select
                id="progress-status-filter"
                value={statusFilter}
                onChange={(event) => setStatusFilter(event.target.value)}
              >
                <option value="all">All students</option>
                <option value="not_started">Not started</option>
                <option value="in_progress">In progress</option>
                <option value="pending_grading">Awaiting review</option>
                <option value="graded">Graded</option>
                <option value="flagged">Flagged</option>
                <option value="abandoned">Abandoned</option>
              </select>
            </div>
          )}

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
          ) : !error && filteredStudents.length === 0 ? (
            <div className="progress-empty-state">
              <Users size={28} aria-hidden="true" />
              <h3>No students match this filter</h3>
              <p>Choose another status to see more students.</p>
            </div>
          ) : !error ? (
            <div className="progress-table-wrap" role="region" aria-label="Student examination status" tabIndex={0}>
              <table className="progress-table">
                <thead>
                  <tr>
                    <th scope="col">Student</th>
                    <th scope="col">EID</th>
                    <th scope="col">Status</th>
                    <th scope="col">Started</th>
                    <th scope="col">Elapsed</th>
                    <th scope="col">Completed</th>
                    <th scope="col">Remaining</th>
                    <th scope="col">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredStudents.map((student) => (
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
                          {student.developer_demo ? "Demo · no grading" : getStatus(student)}
                        </span>
                      </td>
                      <td>{formatDate(student.started_at)}</td>
                      <td>{formatDuration(student.elapsed_seconds)}</td>
                      <td>{formatDate(student.ended_at)}</td>
                      <td>
                        {student.status === "in_progress"
                          ? formatDuration(student.remaining_seconds)
                          : "—"}
                      </td>
                      <td>
                        {!student.developer_demo &&
                        student.session_id &&
                        ["pending_grading", "flagged", "graded"].includes(student.status || "") ? (
                          <div className="student-review-roster-actions">
                            <a
                              className="student-review-roster-link"
                              href={`/professor/exams/${encodeURIComponent(examId || "")}/submissions/${encodeURIComponent(student.session_id)}`}
                            >
                              Review
                            </a>
                            <button
                              type="button"
                              className="student-review-roster-action"
                              onClick={() => void downloadStudentTranscript(student.session_id!)}
                            >
                              Download transcripts
                            </button>
                            <button
                              type="button"
                              className="student-review-roster-action"
                              onClick={() => void downloadStudentGrade(student.session_id!)}
                            >
                              Download recommended grade
                            </button>
                            <button
                              type="button"
                              className="student-review-roster-action"
                              disabled
                              title="Secure video retrieval is not available yet."
                            >
                              Video unavailable
                            </button>
                          </div>
                        ) : "—"}
                      </td>
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
