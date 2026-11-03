import { useEffect, useRef, useState } from "react";


type StartResponse = {
  session_id: string;
  session_token?: string;
  status: string;
  deadline: string | null;
  server_now: string;
  sequence_num: number;
  question: string;
};

type AnswerResponse = {
  done: boolean;
  sequence_num?: number;
  question?: string;
  reason?: string;
};

async function apiRequest<T>(
  endpoint: string,
  body: Record<string, unknown>,
  token?: string,
): Promise<T> {
  const response = await fetch(`/api${endpoint}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const details = await response.text();
    throw new Error(
      `Request failed (${response.status}): ${details || response.statusText}`,
    );
  }

  return response.json() as Promise<T>;
}

export default function StudentExam() {
  const [sessionId, setSessionId] = useState("");
  const [question, setQuestion] = useState("");
  const [questionNumber, setQuestionNumber] = useState(1);
  const [completedQuestions, setCompletedQuestions] = useState(0);
  const [answer, setAnswer] = useState("");
  const [showConfirmation, setShowConfirmation] = useState(false);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const started = useRef(false);
  const sessionToken = useRef("");
  const [remaining, setRemaining] = useState<number | null>(null);
  const clock = useRef<{ deadline: number; serverNow: number; received: number } | null>(null);

  useEffect(() => {
    const tick = () => {
      const value = clock.current;
      if (value) setRemaining(Math.max(0, Math.ceil((value.deadline - value.serverNow - (performance.now() - value.received)) / 1000)));
    };
    const timer = window.setInterval(tick, 250);
    tick();
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    // Avoid starting two sessions during React's development checks.
    if (started.current) return;
    started.current = true;

    const params = new URLSearchParams(window.location.search);
    const examTemplateId = params.get("templateId");
    const studentId = params.get("studentId");

    if (
      !examTemplateId ||
      !studentId ||
      sessionStorage.getItem("oralexam_face_check_passed") !== "true" ||
      sessionStorage.getItem("oralexam_student_id") !== studentId
    ) {
      window.location.href = "/student/verification";
      return;
    }

    const storageKey = `oralexam_attempt:${examTemplateId}:${studentId}`;
    async function loadAttempt() {
      let result: StartResponse;
      const saved = sessionStorage.getItem(storageKey);
      if (saved) {
        const attempt = JSON.parse(saved) as { id: string; token: string };
        const response = await fetch(`/api/exam/sessions/${encodeURIComponent(attempt.id)}`, {
          headers: { Authorization: `Bearer ${attempt.token}` },
        });
        if (!response.ok) throw new Error("Unable to resume this attempt. Please contact your professor.");
        result = await response.json();
        sessionToken.current = attempt.token;
      } else {
        const token = sessionStorage.getItem(`oralexam_exam_token:${examTemplateId}:${studentId}`);
        if (!token) throw new Error("Exam authorization is missing. Return to your exam list to start.");
        result = await apiRequest<StartResponse>("/exam/start", {
          student_id: studentId, exam_template_id: examTemplateId, student_token: token,
        });
        if (!result.session_token) throw new Error("Session authorization is missing.");
        sessionToken.current = result.session_token;
        sessionStorage.setItem(storageKey, JSON.stringify({ id: result.session_id, token: result.session_token }));
      }
      setSessionId(result.session_id);
      sessionStorage.setItem("oralexam_exam_session_id", result.session_id);
      setQuestion(result.question);
      setQuestionNumber(result.sequence_num);
      if (result.status !== "in_progress") {
        setCompletedQuestions(result.sequence_num);
        setShowConfirmation(true);
        return;
      }
      if (result.deadline !== null) {
        const deadline = Date.parse(result.deadline);
        const serverNow = Date.parse(result.server_now);
        if (!Number.isFinite(deadline) || !Number.isFinite(serverNow)) throw new Error("The server returned invalid timing information.");
        clock.current = { deadline, serverNow, received: performance.now() };
        setRemaining(Math.max(0, Math.ceil((deadline - serverNow) / 1000)));
      }
    }
    void loadAttempt().catch((err: unknown) => {
      setError(err instanceof Error ? err.message : "Unable to start the exam.");
    }).finally(() => setLoading(false));
  }, []);

  const handleNext = async () => {
    if (!sessionId || !answer.trim() || submitting) return;

    setSubmitting(true);
    setError("");

    try {
      const result = await apiRequest<AnswerResponse>("/exam/answer", {
        session_id: sessionId,
        answer_transcript: answer.trim(),
      }, sessionToken.current);

      if (result.done) {
        setCompletedQuestions(questionNumber);
        setShowConfirmation(true);
        return;
      }

      if (!result.question) {
        throw new Error("The server did not return the next question.");
      }

      setQuestion(result.question);
      setQuestionNumber(result.sequence_num ?? questionNumber + 1);
      setAnswer("");
    } catch (err: unknown) {
      setError(
        err instanceof Error
          ? err.message
          : "Your answer could not be submitted. Please try again.",
      );
    } finally {
      setSubmitting(false);
    }
  };

  const submitExam = () => {
    // The backend has already ended the session when it returns done: true.
    window.location.href = "/student/exam/submitted";
  };

  if (loading) {
    return (
      <div className="student-exam-page">
        <header className="student-exam-header">
          <div className="student-exam-logo">
            <span>◉</span>
            <strong>OralExam AI</strong>
          </div>
        </header>
        <main className="student-exam-content">
          <div className="exam-question-card">
            <h1>Preparing your examination...</h1>
            <p>Connecting to the exam server and loading your first question.</p>
          </div>
        </main>
      </div>
    );
  }

  if (error && !sessionId) {
    return (
      <div className="student-exam-page">
        <header className="student-exam-header">
          <div className="student-exam-logo">
            <span>◉</span>
            <strong>OralExam AI</strong>
          </div>
        </header>
        <main className="student-exam-content">
          <div className="exam-question-card">
            <h1>Unable to start your exam</h1>
            <p role="alert">{error}</p>
            <button
              type="button"
              className="exam-next-button"
              onClick={() => {
                window.location.href = "/student/exams";
              }}
            >
              Return to Exams
            </button>
          </div>
        </main>
      </div>
    );
  }

  if (showConfirmation) {
    return (
      <div className="student-exam-page">
        <header className="student-exam-header">
          <div className="student-exam-logo">
            <span>◉</span>
            <strong>OralExam AI</strong>
          </div>
          <div className="student-exam-progress">Exam Complete</div>
        </header>

        <main className="student-confirmation-content">
          <div className="student-confirmation-card">
            <div className="confirmation-icon">!</div>

            <p className="confirmation-eyebrow">FINAL CONFIRMATION</p>

            <h1>Are you ready to continue?</h1>

            <p className="confirmation-message">
              You have reached the end of your oral examination. Your
              responses have been sent to the exam server.
            </p>

            <div className="confirmation-summary">
              <div className="confirmation-row">
                <span>Questions completed</span>
                <strong>{completedQuestions}</strong>
              </div>
              <div className="confirmation-row">
                <span>Response status</span>
                <strong>Recorded</strong>
              </div>
              <div className="confirmation-row">
                <span>Exam status</span>
                <strong>Pending professor review</strong>
              </div>
            </div>

            <div className="confirmation-warning">
              <strong>You cannot return to the completed exam.</strong>
              <span>
                Your professor will review your recorded responses.
              </span>
            </div>

            <div className="confirmation-actions">
              <button
                type="button"
                className="confirmation-submit-button"
                onClick={submitExam}
              >
                Continue to Submission
              </button>
            </div>
          </div>
        </main>
      </div>
    );
  }

  return (
    <div className="student-exam-page">
      <header className="student-exam-header">
        <div className="student-exam-logo">
          <span>◉</span>
          <strong>OralExam AI</strong>
        </div>
        <div className="student-exam-progress">
          Question {questionNumber}
          <div className="exam-countdown" role="timer" aria-label="Time remaining" aria-live="off">
            {remaining === null ? "No time limit" : `Time left: ${Math.floor(remaining / 60)}:${String(remaining % 60).padStart(2, "0")}`}
          </div>
        </div>
      </header>

      <main className="student-exam-content">
        <div className="exam-question-card">
          <div className="exam-question-number">
            QUESTION {questionNumber}
          </div>

          <h1>{question}</h1>
          {remaining === 0 && <p role="status">Time has expired. Submit your current response to finish the attempt.</p>}

          <div className="ai-avatar-container">
            <div className="ai-avatar">AI</div>
            <div>
              <strong>OralExam AI</strong>
              <p>Take your time and explain your answer clearly.</p>
            </div>
          </div>

          <textarea
            className="student-answer-input"
            value={answer}
            onChange={(event) => setAnswer(event.target.value)}
            placeholder="Speak your answer or type your response..."
            disabled={submitting}
          />

          {error && (
            <p role="alert" className="exam-error">
              {error}
            </p>
          )}

          <div className="exam-question-footer">
            <span>
              {submitting
                ? "Submitting response..."
                : answer.trim()
                  ? "Response ready to submit"
                  : "Waiting for response..."}
            </span>

            <button
              type="button"
              className="exam-next-button"
              onClick={handleNext}
              disabled={!answer.trim() || submitting}
            >
              {submitting ? "Please wait..." : "Submit Answer →"}
            </button>
          </div>
        </div>
      </main>
    </div>
  );
}
