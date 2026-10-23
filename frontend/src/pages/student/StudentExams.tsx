import { useEffect, useState } from "react";
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
};

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

      const query = new URLSearchParams({ templateId: exam.id, studentId });
      window.location.href = `/student/exam?${query.toString()}`;
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to start this exam.");
      setStartingExam("");
    }
  }

  function changeStudent() {
    for (const key of [
      "oralexam_student_eid",
      "oralexam_student_id",
      "oralexam_student_name",
      "oralexam_face_check_passed",
      "oralexam_exam_session_id",
    ]) sessionStorage.removeItem(key);
    window.location.href = "/student/verification";
  }

  return (
    <div className="student-exams-page">
      <header className="simple-header">
        <div className="logo"><span className="logo-icon" aria-hidden="true"><OralExamMark size={34} /></span><span>OralExam AI</span></div>
      </header>

      <main className="student-exams-content">
        <div className="student-exams-heading">
          <p className="eyebrow">STUDENT PORTAL</p>
          <h1>Your Assigned Exams</h1>
          <p>Select a published oral examination assigned to you by your instructor.</p>
        </div>

        {loading ? (
          <section className="exam-card"><h2>Loading your exams...</h2></section>
        ) : error && !student ? (
          <section className="exam-card">
            <p className="exam-error" role="alert">{error}</p>
            <button type="button" className="back-button" onClick={changeStudent}>Restart Verification</button>
          </section>
        ) : (
          <>
            {student && (
              <section className="exam-card">
                <p className="eyebrow">IDENTITY CONFIRMED</p>
                <h2>Welcome, {student.name}</h2>
                <p>JMU EID: {student.eid}</p>
                <button type="button" className="back-button" onClick={changeStudent}>
                  End Session
                </button>
              </section>
            )}

            {error && <p className="exam-error" role="alert">{error}</p>}

            <div className="exam-list">
              {exams.length === 0 ? (
                <section className="exam-card">
                  <div className="exam-icon">📚</div>
                  <h2>No exams currently available</h2>
                  <p>
                    There are no published exams assigned to your student record.
                    Contact your instructor if you expected an exam here.
                  </p>
                </section>
              ) : exams.map((exam) => (
                <article className="exam-card" key={exam.id}>
                  <div className="exam-card-top">
                    <div className="exam-icon">{exam.icon || "🎓"}</div>
                    <div>
                      <span className="exam-status">AVAILABLE</span>
                      <h2>{exam.title}</h2>
                    </div>
                  </div>
                  <div className="exam-details">
                    {exam.course && <span>{exam.course}</span>}
                    {exam.course && exam.time_limit_minutes != null && <span>•</span>}
                    {exam.time_limit_minutes != null && <span>{exam.time_limit_minutes} minutes</span>}
                  </div>
                  {exam.description && <p>{exam.description}</p>}
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
