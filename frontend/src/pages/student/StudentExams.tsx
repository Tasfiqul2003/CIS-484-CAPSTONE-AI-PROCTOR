import { useEffect, useState } from "react";
import { CheckCircle2, Clock, ListChecks, LogOut, Timer } from "lucide-react";
import OralExamMark from "../../components/brand/OralExamMark";

type Student = {
  id: string;
  name: string;
  eid: string;
};

type AssignedExam = {
  id: string;
  title: string;
  course: string | null;
  description: string | null;
  icon: string | null;
  time_limit_minutes: number | null;
  status: string;
  question_count?: number;
  extended_time_multiplier?: number;
  completed_at?: string | null;
};

function formatCompleted(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value
    : date.toLocaleString(undefined, { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" });
}

type LookupResponse = {
  student: Student;
  exams: AssignedExam[];
};

export default function StudentExams() {
  const [student, setStudent] = useState<Student | null>(null);
  const [exams, setExams] = useState<AssignedExam[]>([]);
  const [loading, setLoading] = useState(true);
  const [startingExam, setStartingExam] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    const eid = sessionStorage.getItem("oralexam_student_eid") || "";
    const studentId = sessionStorage.getItem("oralexam_student_id") || "";
    const faceCheckPassed = sessionStorage.getItem("oralexam_face_check_passed") === "true";

    if (!eid || !studentId || !faceCheckPassed) {
      window.location.href = "/student/verification";
      return;
    }

    let cancelled = false;

    async function loadExams() {
      try {
        const response = await fetch("/api/exam/student/available", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify({ eid }),
        });
        const data = await response.json().catch(() => ({}));

        if (!response.ok) {
          throw new Error(data.detail || `Unable to load exams (${response.status}).`);
        }

        const result = data as LookupResponse;
        if (result.student.id !== studentId) {
          throw new Error("The stored student identity no longer matches. Please swipe your card again.");
        }

        if (!cancelled) {
          setStudent(result.student);
          setExams(result.exams.filter((exam) => exam.status === "published"));
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Unable to load your assigned exams.");
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    void loadExams();
    return () => { cancelled = true; };
  }, []);

  async function startExam(exam: AssignedExam) {
    const eid = sessionStorage.getItem("oralexam_student_eid") || "";
    setStartingExam(exam.id);
    setError("");

    try {
      // Recheck this exact exam against the student's roster immediately before navigation.
      const response = await fetch("/api/exam/verify-eid", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ eid, exam_template_id: exam.id }),
      });
      const data = await response.json().catch(() => ({}));

      if (!response.ok) {
        throw new Error(data.detail || `Exam authorization failed (${response.status}).`);
      }

      const studentId = sessionStorage.getItem("oralexam_student_id") || "";
      if (data.student_id !== studentId) {
        throw new Error("The student identity did not match. Please start verification again.");
      }

      if (!data.student_token) throw new Error("The server did not return exam authorization.");
      sessionStorage.setItem(`oralexam_exam_token:${exam.id}:${studentId}`, data.student_token);
      const query = new URLSearchParams({ templateId: exam.id, studentId });
      window.location.href = `/student/exam?${query.toString()}`;
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to start this exam.");
      setStartingExam("");
    }
  }

  function logOut() {
    for (const key of [
      "oralexam_student_eid",
      "oralexam_student_id",
      "oralexam_student_name",
      "oralexam_face_check_passed",
      "oralexam_exam_session_id",
      "oralexam_exam_session_token",
      "oralexam_developer_demo",
    ]) sessionStorage.removeItem(key);
    window.location.href = "/";
  }

  const openExams = exams.filter(exam => !exam.completed_at);
  const completedExams = exams.filter(exam => exam.completed_at);

  return (
    <div className="student-exams-page">
      <a className="student-skip-link" href="#main-content">Skip to content</a>
      <header className="simple-header">
        <a className="logo" href="/" aria-label="OralExam AI home">
          <span className="logo-icon" aria-hidden="true"><OralExamMark size={34} /></span>
          <span>OralExam AI</span>
        </a>
      </header>

      <main id="main-content" className="student-exams-content" aria-labelledby="student-exams-heading">
        <div className="student-exams-heading">
          <p className="eyebrow">STUDENT PORTAL</p>
          <h1 id="student-exams-heading">Your exams</h1>
        </div>

        {loading ? (
          <section className="exam-card" role="status" aria-live="polite">
            <h2>Loading exams…</h2>
          </section>
        ) : error && !student ? (
          <section className="exam-card">
            <p className="exam-error" role="alert">{error}</p>
            <button type="button" className="back-button" onClick={logOut}>Start over</button>
          </section>
        ) : (
          <>
            <section className="student-exams-panel" aria-label="Your assigned exams">
              {student && <header className="student-exams-panel-header">
                <div>
                  <p className="eyebrow">Signed in</p>
                  <h2>Welcome, {student.name}</h2>
                  <p>EID · {student.eid}</p>
                </div>
                <button type="button" className="student-logout-button" onClick={logOut}>
                  <LogOut size={18} aria-hidden="true" />Log out
                </button>
              </header>}

              {error && <p className="exam-error" role="alert">{error}</p>}
              {error === "Complete the student photo check before starting this exam." && (
                <button
                  type="button"
                  className="continue-button"
                  onClick={() => { window.location.href = "/student/face-verification"; }}
                >
                  Repeat Photo Check
                </button>
              )}

              <div className="exam-list" aria-label="Available exams">
                {openExams.length === 0 ? (
                  <div className="student-exams-empty">
                    <h3>No exams available</h3>
                    <p>{completedExams.length ? "You have completed every exam assigned to you." : "Ask your instructor if you expected one."}</p>
                  </div>
                ) : openExams.map((exam) => (
                  <article className="student-exam-item" key={exam.id}>
                    <div className="student-exam-item-main">
                      <div className="exam-icon" aria-hidden="true">{exam.icon || "🎓"}</div>
                      <div>
                        {exam.course && <p className="student-exam-item-course">{exam.course}</p>}
                        <h3>{exam.title}</h3>
                        {exam.description && <p className="student-exam-item-description">{exam.description}</p>}
                        <ul className="student-exam-item-facts">
                          {exam.question_count != null && exam.question_count > 0 && <li><ListChecks size={16} aria-hidden="true" />{exam.question_count} question{exam.question_count === 1 ? "" : "s"} (plus follow-ups)</li>}
                          <li><Clock size={16} aria-hidden="true" />{exam.time_limit_minutes != null ? `${Math.round(exam.time_limit_minutes)} minutes` : "No time limit"}</li>
                          {exam.extended_time_multiplier != null && exam.extended_time_multiplier > 1 && <li><Timer size={16} aria-hidden="true" />Extended time ({exam.extended_time_multiplier}×) applied</li>}
                        </ul>
                      </div>
                    </div>
                    <button
                      type="button"
                      className="exam-start-button"
                      disabled={!!startingExam}
                      onClick={() => void startExam(exam)}
                    >
                      {startingExam === exam.id ? "Checking authorization..." : "Start Exam →"}
                    </button>
                  </article>
                ))}
              </div>

              {completedExams.length > 0 && <div className="student-exams-completed">
                <h3>Completed</h3>
                <ul>
                  {completedExams.map(exam => <li key={exam.id}>
                    <CheckCircle2 size={18} aria-hidden="true" />
                    <span><strong>{exam.title}</strong>{exam.course ? ` · ${exam.course}` : ""}</span>
                    <span className="student-exams-completed-time">Completed {formatCompleted(exam.completed_at!)}</span>
                  </li>)}
                </ul>
              </div>}
            </section>
          </>
        )}
      </main>

      <footer className="home-footer">
        <p>OralExam AI</p>
        <p>AI-assisted oral examination platform</p>
      </footer>
    </div>
  );
}
