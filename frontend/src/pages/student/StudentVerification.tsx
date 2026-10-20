import { useState } from "react";

type VerificationResult = {
  verified: boolean;
  student_id: string;
  name: string;
  eid: string;
  exam_template_id: string;
};

export default function StudentVerification() {
  const params = new URLSearchParams(window.location.search);
  const examTemplateId = params.get("templateId") || "";

  const [eid, setEid] = useState("");
  const [student, setStudent] = useState<VerificationResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function simulateCardSwipe() {
    if (!examTemplateId) {
      setError("No exam was selected. Return to the exam list and select an exam.");
      return;
    }

    if (!eid.trim()) {
      setError("Enter your JMU EID before simulating the card swipe.");
      return;
    }

    setBusy(true);
    setError("");
    setStudent(null);

    try {
      const response = await fetch("/api/exam/verify-eid", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          eid: eid.trim(),
          exam_template_id: examTemplateId,
        }),
      });

      const data = await response.json().catch(() => ({}));

      if (!response.ok) {
        throw new Error(
          data.detail || `Verification failed (${response.status}).`
        );
      }

      setStudent(data as VerificationResult);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Unable to verify your JMU EID."
      );
    } finally {
      setBusy(false);
    }
  }

  function continueToFaceVerification() {
    if (!student) return;

    const query = new URLSearchParams({
      templateId: student.exam_template_id,
      studentId: student.student_id,
    });

    window.location.href = `/student/face-verification?${query.toString()}`;
  }

  return (
    <div className="verification-page">
      <header className="simple-header">
        <div className="logo">
          <span className="logo-icon">◉</span>
          <span>OralExam AI</span>
        </div>
      </header>

      <main className="verification-content">
        <div className="verification-card">
          <div className="verification-icon">💳</div>

          <p className="eyebrow">STUDENT VERIFICATION</p>
          <h1>Verify your identity</h1>

          {!student ? (
            <>
              <p className="verification-description">
                Enter your JMU EID, then simulate swiping your JACard. Your EID
                must be on the roster for the selected, published exam.
              </p>

              <label className="settings-field">
                <span>JMU EID</span>
                <input
                  type="text"
                  autoComplete="username"
                  value={eid}
                  onChange={(event) => setEid(event.target.value)}
                  placeholder="Enter your EID"
                  disabled={busy}
                />
              </label>

              <div className="jacard-placeholder">
                <div className="card-icon">💳</div>
                <h2>Swipe your JACard</h2>
                <p>
                  {busy
                    ? "Checking the exam roster..."
                    : "Ready to simulate a card swipe"}
                </p>

                <button
                  type="button"
                  onClick={simulateCardSwipe}
                  disabled={busy}
                >
                  {busy ? "Verifying..." : "Simulate JACard Swipe"}
                </button>
              </div>
            </>
          ) : (
            <>
              <p className="verification-description">
                The EID matched a student on this exam's roster.
              </p>

              <div className="student-identity">
                <div className="student-avatar">👤</div>
                <div className="student-details">
                  <p className="student-label">STUDENT</p>
                  <h2>{student.name}</h2>
                  <p>JMU EID: {student.eid}</p>
                </div>
                <div className="verified-badge">✓ Verified</div>
              </div>

              <div className="verification-warning">
                <strong>Continue to the next step</strong>
                <p>
                  The EID check succeeded. The next page is currently a
                  face-verification placeholder.
                </p>
              </div>

              <button
                type="button"
                className="continue-button"
                onClick={continueToFaceVerification}
              >
                Continue to Face Verification →
              </button>

              <button
                type="button"
                className="back-button"
                onClick={() => {
                  setStudent(null);
                  setError("");
                }}
              >
                Use a different EID
              </button>
            </>
          )}

          {error && <p role="alert" className="exam-error">{error}</p>}

          <button
            type="button"
            className="back-button"
            onClick={() => {
              window.location.href = "/student/exams";
            }}
          >
            ← Back to Exams
          </button>
        </div>
      </main>
    </div>
  );
}
