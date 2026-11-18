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
import ProfessorHeader from "../../components/professor/ProfessorHeader";
import DownloadAllButton from '../../components/professor/DownloadAllButton';
import { recordingLabels } from '../student/examRecording';
import type { RecordingStatus } from '../student/examRecording';

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
  identity_check_completed?: boolean;
  identity_review_required?: boolean;
  identity_verification_attempts?: number;
  face_check_attempt_count?: number;
  face_check_help_required?: boolean;
  video_recording_status?: RecordingStatus | null;
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
  // The summary boxes filter the table.
  const [filter, setFilter] = useState<"all" | "not_started" | "in_progress" | "awaiting" | "photo">("all");
  // Which exam this is, for the page heading.
  const [exam, setExam] = useState<{ title: string; course: string | null } | null>(null);

  useEffect(() => {
    let alive = true;
    fetch("/api/auth/professor/exams", { credentials: "include" })
      .then(response => response.ok ? response.json() : [])
      .then((list: Array<{ id: string; title: string; course?: string | null }>) => {
        const found = Array.isArray(list) ? list.find(item => item.id === examId) : undefined;
        if (alive && found) setExam({ title: found.title, course: found.course ?? null });
      })
      .catch(() => undefined);
    return () => { alive = false; };
  }, [examId]);

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

  const visible = students.filter(student => (statusFilter === "all"
    || (statusFilter === "not_started" ? !student.session_id || !student.status : student.status === statusFilter)))
    .filter(student => filter === "all" ? true
    : filter === "not_started" ? !student.session_id || !student.status
    : filter === "in_progress" ? student.status === "in_progress"
    : filter === "awaiting" ? student.status === "pending_grading" && !student.developer_demo
    : student.identity_review_required === true || student.face_check_help_required === true);

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
    identityReview: students.filter(
      student => student.identity_review_required === true
        || student.face_check_help_required === true,
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
    <div className="professor-dashboard professor-progress-page">
      <ProfessorHeader title="Student progress" />

      <main className="dashboard-main">
        <a href="/professor/exams" className="back-to-exam-button progress-back-row">
          <ArrowLeft size={16} aria-hidden="true" />
          Back to My Exams
        </a>
        <section className="dashboard-welcome progress-heading">
          <div>
            {exam?.course && <p className="progress-heading-course">{exam.course}</p>}
            <h1>{exam?.title || "Student Progress"}</h1>
            <p>Who has taken this exam, who is still working, and which attempts are ready for you to review.</p>
          </div>

          <div className="exam-download-actions">
          <DownloadAllButton examId={examId} disabled={loading || !!error || !students.some(student =>
            !student.developer_demo && ['pending_grading', 'flagged', 'graded'].includes(student.status ?? ''))} />
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
          </div>
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
          <button type="button" className="progress-summary-card" aria-pressed={filter === "all"}
            onClick={() => setFilter("all")}>
            <Users size={20} aria-hidden="true" />
            <span>All students</span>
            <strong>{loading ? "—" : counts.total}</strong>
          </button>

          <button type="button" className="progress-summary-card" aria-pressed={filter === "not_started"}
            onClick={() => setFilter("not_started")}>
            <Clock3 size={20} aria-hidden="true" />
            <span>Not started</span>
            <strong>{loading ? "—" : counts.notStarted}</strong>
          </button>

          <button type="button" className="progress-summary-card" aria-pressed={filter === "in_progress"}
            onClick={() => setFilter("in_progress")}>
            <LoaderCircle size={20} aria-hidden="true" />
            <span>In progress</span>
            <strong>{loading ? "—" : counts.inProgress}</strong>
          </button>

          <button type="button" className="progress-summary-card" aria-pressed={filter === "awaiting"}
            onClick={() => setFilter("awaiting")}>
            <GraduationCap size={20} aria-hidden="true" />
            <span>Awaiting review</span>
            <strong>{loading ? "—" : counts.awaitingReview}</strong>
          </button>
          <button type="button" className="progress-summary-card" aria-pressed={filter === "photo"}
            onClick={() => setFilter("photo")}>
            <AlertCircle size={20} aria-hidden="true" />
            <span>Photo check exceptions</span>
            <strong>{loading ? "—" : counts.identityReview}</strong>
          </button>
        </section>

        <section className="progress-table-section">
          <div className="dashboard-section-heading">
            <div>
              <h2>{{ all: "All students", not_started: "Not started", in_progress: "In progress",
                awaiting: "Awaiting review", photo: "Photo check exceptions" }[filter]}</h2>
            </div>
            {!loading && (
              <span className="progress-count">
                {visible.length} of {students.length} student{students.length === 1 ? "" : "s"}
                {filter !== "all" && <button type="button" className="progress-filter-clear" onClick={() => setFilter("all")}>Show all</button>}
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
          ) : !error && visible.length === 0 ? (
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
                    <th scope="col">Photo comparison</th>
                    <th scope="col">Recording</th>
                    <th scope="col">Started</th>
                    <th scope="col">Elapsed</th>
                    <th scope="col">Completed</th>
                    <th scope="col">Remaining</th>
                    <th scope="col">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {visible.map((student) => (
                    <tr key={student.student_id}>
                      <td>
                        <div className="progress-student-name">
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
                      <td>
                        {!student.session_id
                          ? student.face_check_help_required
                            ? `Blocked · ${student.face_check_attempt_count ?? 3} failed matches; professor help required`
                            : (student.face_check_attempt_count ?? 0) > 0
                              ? `${student.face_check_attempt_count} attempt${student.face_check_attempt_count === 1 ? "" : "s"} · not verified`
                              : "Not checked"
                          : student.identity_review_required && student.identity_check_completed === false && student.identity_verification_attempts === 0
                            ? "Unverified: photo check skipped for testing"
                          : student.identity_review_required
                            ? `Review required · ${student.identity_verification_attempts ?? 3} failed matches`
                            : student.identity_check_completed
                              ? "No exception flagged"
                              : "No photo-check record"}
                      </td>
                      <td>{student.video_recording_status ? recordingLabels[student.video_recording_status] : '-'}</td>
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
                            <a className="student-review-roster-link"
                              href={`/professor/exams/${encodeURIComponent(examId || '')}/submissions/${encodeURIComponent(student.session_id)}`}>
                              Recording details
                            </a>
                            <a className="student-review-roster-link"
                              href={`/professor/exam-sessions/${encodeURIComponent(student.session_id)}/review`}>
                              Detailed assessment
                            </a>
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
