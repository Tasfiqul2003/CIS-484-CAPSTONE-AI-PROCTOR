import { useEffect, useRef, useState } from "react";

const studentId = "6dd26f70-d6a2-4a0f-8ce5-76ab35f16f29";
const defaultTemplateId = "37031160-d701-4284-b3de-5a00ea8fa8cb";

type StartResponse = {
  session_id: string;
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
): Promise<T> {
  const response = await fetch(`/api${endpoint}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
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

  useEffect(() => {
    // Avoid starting two sessions during React's development checks.
    if (started.current) return;
    started.current = true;

    const params = new URLSearchParams(window.location.search);
    const examTemplateId =
      params.get("templateId") || defaultTemplateId;

    apiRequest<StartResponse>("/exam/start", {
      student_id: studentId,
      exam_template_id: examTemplateId,
    })
      .then((result) => {
        setSessionId(result.session_id);
        setQuestion(result.question);
        setQuestionNumber(result.sequence_num);
      })
      .catch((err: unknown) => {
        setError(
          err instanceof Error ? err.message : "Unable to start the exam.",
        );
      })
      .finally(() => setLoading(false));
  }, []);

  const handleNext = async () => {
    if (!sessionId || !answer.trim() || submitting) return;

    setSubmitting(true);
    setError("");

    try {
      const result = await apiRequest<AnswerResponse>("/exam/answer", {
        session_id: sessionId,
        answer_transcript: answer.trim(),
      });

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
        </div>
      </header>

      <main className="student-exam-content">
        <div className="exam-question-card">
          <div className="exam-question-number">
            QUESTION {questionNumber}
          </div>

          <h1>{question}</h1>

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
