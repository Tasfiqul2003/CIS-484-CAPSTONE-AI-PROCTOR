import { useState } from "react";
import JACardScanner from "../../components/JACardScanner";

type Student = {
  id: string;
  name: string;
  eid: string;
};

type LookupResponse = {
  student: Student;
  exams: Array<{ id: string; status: string }>;
};

export default function StudentVerification() {
  const [student, setStudent] = useState<Student | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function handleCardSwipe(eid: string) {
    setBusy(true);
    setError("");
    setStudent(null);

    try {
      const response = await fetch("/api/exam/student/available", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ eid }),
      });
      const data = await response.json().catch(() => ({}));

      if (!response.ok) {
        throw new Error(data.detail || `Card verification failed (${response.status}).`);
      }

      const result = data as LookupResponse;
      sessionStorage.setItem("oralexam_student_eid", result.student.eid);
      sessionStorage.setItem("oralexam_student_id", result.student.id);
      sessionStorage.setItem("oralexam_student_name", result.student.name);
      sessionStorage.removeItem("oralexam_face_check_passed");
      sessionStorage.removeItem("oralexam_exam_session_id");
      setStudent(result.student);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to verify this card.");
    } finally {
      setBusy(false);
    }
  }

  function continueToFaceCheck() {
    if (!student) return;
    window.location.href = "/student/face-verification";
  }

  function restart() {
    setStudent(null);
    setError("");
    sessionStorage.removeItem("oralexam_student_eid");
    sessionStorage.removeItem("oralexam_student_id");
    sessionStorage.removeItem("oralexam_student_name");
    sessionStorage.removeItem("oralexam_face_check_passed");
  }

  return (
    <div className="verification-page">
      <header className="simple-header">
        <div className="logo"><span className="logo-icon">◉</span><span>OralExam AI</span></div>
      </header>

      <main className="verification-content">
        <div className="verification-card">
          <div className="verification-icon">💳</div>
          <p className="eyebrow">STUDENT VERIFICATION</p>
          <h1>Verify your identity</h1>

          {!student ? (
            <>
              <p className="verification-description">
                Swipe your JACard to look up your student record.
              </p>
              <JACardScanner onSwipe={handleCardSwipe} busy={busy} />
            </>
          ) : (
            <>
              <p className="verification-description">
                We found the following student record. Confirm that this information is yours.
              </p>
              <div className="student-identity">
                <div className="student-avatar">👤</div>
                <div className="student-details">
                  <p className="student-label">STUDENT</p>
                  <h2>{student.name}</h2>
                  <p>JMU EID: {student.eid}</p>
                </div>
                <div className="verified-badge">✓ EID Matched</div>
              </div>

              <div className="verification-warning">
                <strong>Next: video check</strong>
                <p>
                  The next screen is a prototype placeholder. It does not
                  perform actual facial recognition yet.
                </p>
              </div>

              <button type="button" className="continue-button" onClick={continueToFaceCheck}>
                Confirm Identity & Continue →
              </button>
              <button type="button" className="back-button" onClick={restart}>
                This isn't me / Scan another card
              </button>
            </>
          )}

          {error && <p role="alert" className="exam-error">{error}</p>}

          <button
            type="button"
            className="back-button"
            onClick={() => { window.location.href = "/"; }}
          >
            ← Return Home
          </button>
        </div>
      </main>
    </div>
  );
}
