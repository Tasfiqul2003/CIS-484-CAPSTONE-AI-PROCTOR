import { useEffect, useRef, useState } from "react";
import JACardScanner from "../../components/JACardScanner";
import OralExamMark from "../../components/brand/OralExamMark";

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
  const headingRef = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    if (student) headingRef.current?.focus();
  }, [student]);

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
      sessionStorage.removeItem("oralexam_exam_session_token");
      sessionStorage.removeItem("oralexam_developer_demo");
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
      <a className="student-skip-link" href="#main-content">Skip to content</a>
      <header className="simple-header">
        <a className="logo" href="/" aria-label="OralExam AI home">
          <span className="logo-icon" aria-hidden="true"><OralExamMark size={34} /></span>
          <span>OralExam AI</span>
        </a>
      </header>

      <main id="main-content" className="verification-content" aria-labelledby="verification-heading">
        <div className="verification-card">
          <p className="eyebrow">STEP 1 OF 3</p>
          <h1 id="verification-heading" ref={headingRef} tabIndex={-1}>
            {student ? "Confirm your record" : "Check your JACard"}
          </h1>

          {!student ? (
            <>
              <p className="verification-description">Swipe your card or enter your JMU EID.</p>
              <JACardScanner onSwipe={handleCardSwipe} busy={busy} />
            </>
          ) : (
            <>
              <p className="verification-description">Is this you?</p>
              <div className="student-identity">
                <div className="student-details">
                  <h2>{student.name}</h2>
                  <p>JMU EID · {student.eid}</p>
                </div>
                <span className="verified-badge">Record found</span>
              </div>

              <div className="verification-warning">
                <strong>Next: photo check</strong>
                <p>Look at the camera for 3–6 seconds. No need to hold your card.</p>
              </div>

              <button type="button" className="continue-button" onClick={continueToFaceCheck}>
                Continue to photo check
              </button>
              <button type="button" className="back-button" onClick={restart}>
                Not you? Scan another card
              </button>
            </>
          )}

          {error && <p role="alert" className="exam-error">{error}</p>}

          <a className="back-button student-home-link" href="/">
            Home
          </a>
        </div>
      </main>
    </div>
  );
}
