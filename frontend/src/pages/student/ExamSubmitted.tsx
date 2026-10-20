import { useState } from "react";

export default function ExamSubmitted() {
  const [feedback, setFeedback] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function finish(skipFeedback = false) {
    const sessionId = sessionStorage.getItem("oralexam_exam_session_id") || "";
    if (!sessionId) {
      setError("The exam session ID is missing. Your exam may already be recorded, but feedback could not be linked.");
      if (skipFeedback) returnHome();
      return;
    }

    setBusy(true);
    setError("");

    try {
      const response = await fetch("/api/exam/feedback", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          session_id: sessionId,
          feedback: skipFeedback ? "" : feedback.trim(),
        }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(data.detail || `Feedback could not be saved (${response.status}).`);
      }
      returnHome();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to save feedback.");
    } finally {
      setBusy(false);
    }
  }

  function returnHome() {
    for (const key of [
      "oralexam_student_eid",
      "oralexam_student_id",
      "oralexam_student_name",
      "oralexam_face_check_passed",
      "oralexam_exam_session_id",
    ]) sessionStorage.removeItem(key);
    window.location.href = "/";
  }

  return (
    <div className="student-submission-page">
      <div className="student-submission-card">
        <div className="submission-success-icon">✓</div>
        <p className="submission-eyebrow">EXAM COMPLETE</p>
        <h1>Your exam has been submitted</h1>
        <p className="submission-message">
          Your responses have been recorded for professor review. Before returning
          to the main screen, you can share feedback about your experience.
        </p>

        <div className="submission-divider" />
        <div className="submission-status">
          <div className="submission-status-row"><span>Exam status</span><strong>Submitted ✓</strong></div>
          <div className="submission-status-row"><span>Responses</span><strong>Recorded ✓</strong></div>
          <div className="submission-status-row"><span>Grading</span><strong>Pending professor review</strong></div>
        </div>

        <label className="settings-field">
          <span>Feedback (optional)</span>
          <textarea
            value={feedback}
            onChange={(event) => setFeedback(event.target.value)}
            placeholder="How was your examination experience? What could be improved?"
            rows={4}
            maxLength={4000}
            disabled={busy}
          />
        </label>

        {error && <p className="exam-error" role="alert">{error}</p>}

        <button
          type="button"
          className="submission-exit-button"
          disabled={busy}
          onClick={() => void finish(false)}
        >
          {busy ? "Saving..." : "Submit Feedback & Return Home"}
        </button>
        <button
          type="button"
          className="back-button"
          disabled={busy}
          onClick={() => void finish(true)}
        >
          Skip Feedback & Return Home
        </button>
      </div>
    </div>
  );
}
