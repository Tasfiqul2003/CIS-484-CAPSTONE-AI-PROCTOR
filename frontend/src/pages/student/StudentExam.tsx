import { useCallback, useEffect, useRef, useState } from "react";
import { formatRemaining, readExamClock, remainingTime } from "./examTiming";
import type { ExamClock, ExamTiming, RemainingTime } from "./examTiming";
import LiveExamPresentation from "../../components/avatar/LiveExamPresentation";

type StartResponse = ExamTiming & {
  session_id: string;
  session_token?: string;
  status: string;
  sequence_num: number;
  question: string;
};

type AnswerResponse = { done: true; reason?: string }
  | (ExamTiming & { done: false; sequence_num: number; question: string });

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
  const [assisting, setAssisting] = useState(false);
  const [textSize, setTextSize] = useState(16);
  const [error, setError] = useState("");
  const started = useRef(false);
  const sessionToken = useRef("");
  const [remaining, setRemaining] = useState<RemainingTime>({ exam: null, question: null });
  const clock = useRef<ExamClock | null>(null);
  const submittingRequest = useRef(false);
  const automaticSubmission = useRef<number | null>(null);
  const expired = remaining.exam === 0 || remaining.question === 0;

  const updateClock = useCallback((timing: ExamTiming) => {
    const value = readExamClock(timing, performance.now());
    clock.current = value;
    setRemaining(remainingTime(value, performance.now()));
  }, []);

  useEffect(() => {
    const tick = () => {
      const value = clock.current;
      if (value) {
        const next = remainingTime(value, performance.now());
        setRemaining(current => current.exam === next.exam && current.question === next.question ? current : next);
      }
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
      if (result.status === "in_progress") updateClock(result);
      setSessionId(result.session_id);
      sessionStorage.setItem("oralexam_exam_session_id", result.session_id);
      setQuestion(result.question);
      setQuestionNumber(result.sequence_num);
      if (result.status !== "in_progress") {
        setCompletedQuestions(result.sequence_num);
        setShowConfirmation(true);
        return;
      }
    }
    void loadAttempt().catch((err: unknown) => {
      setError(err instanceof Error ? err.message : "Unable to start the exam.");
    }).finally(() => setLoading(false));
  }, [updateClock]);

  const handleNext = useCallback(async () => {
    const current = clock.current ? remainingTime(clock.current, performance.now()) : remaining;
    const timedOut = current.exam === 0 || current.question === 0;
    if (!sessionId || (!answer.trim() && !timedOut) || submittingRequest.current || assisting) return;

    submittingRequest.current = true;
    setSubmitting(true);
    setError("");

    try {
      const result = await apiRequest<AnswerResponse>("/exam/answer", {
        session_id: sessionId,
        answer_transcript: timedOut ? "" : answer.trim(),
        question_sequence_num: questionNumber,
      }, sessionToken.current);

      if (result.done) {
        clock.current = null;
        setCompletedQuestions(questionNumber);
        setShowConfirmation(true);
        return;
      }

      if (!result.question) {
        throw new Error("The server did not return the next question.");
      }

      updateClock(result);
      setQuestion(result.question);
      setQuestionNumber(result.sequence_num);
      setAnswer("");
    } catch (err: unknown) {
      // A submission may have committed even when its response was lost. Resume
      // before retrying so an old sequence cannot answer the following question.
      try {
        const response = await fetch(`/api/exam/sessions/${encodeURIComponent(sessionId)}`, {
          headers: { Authorization: `Bearer ${sessionToken.current}` },
        });
        if (!response.ok) throw new Error("Unable to resume the attempt.");
        const state = await response.json() as StartResponse;
        if (state.status !== "in_progress") {
          clock.current = null;
          setCompletedQuestions(state.sequence_num);
          setShowConfirmation(true);
          return;
        }
        updateClock(state);
        if (state.sequence_num !== questionNumber) {
          setQuestion(state.question);
          setQuestionNumber(state.sequence_num);
          setAnswer("");
          return;
        }
      } catch {
        // Keep the submitted question and show the original error for retry.
      }
      setError(
        err instanceof Error
          ? err.message
          : "Your answer could not be submitted. Please try again.",
      );
    } finally {
      submittingRequest.current = false;
      setSubmitting(false);
    }
  }, [sessionId, answer, questionNumber, remaining, updateClock, assisting]);

  useEffect(() => {
    if (!expired || loading || showConfirmation || submitting || assisting || !sessionId
        || automaticSubmission.current === questionNumber) return;
    automaticSubmission.current = questionNumber;
    void handleNext();
  }, [expired, loading, showConfirmation, submitting, assisting, sessionId, questionNumber, handleNext]);

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
          <div className="exam-countdown" role="timer" aria-label="Exam time remaining" aria-live="off">
            {remaining.exam === null ? "No exam time limit" : `Exam time left: ${formatRemaining(remaining.exam)}`}
          </div>
          {remaining.question !== null && <div className="exam-countdown" role="timer" aria-label="Question time remaining" aria-live="off">
            Question time left: {formatRemaining(remaining.question)}
          </div>}
        </div>
      </header>

      <main className="student-exam-content">
        <div className="exam-question-card" style={{ fontSize: textSize }}>
          <div className="exam-question-number">
            QUESTION {questionNumber}
          </div>

          <h1 style={{ fontSize: `${textSize * 1.5}px` }}>{question}</h1>
          {remaining.question !== null && !expired && <p>
            Submit before the question timer reaches zero. When it expires, this question is marked unanswered.
          </p>}
          {expired && !assisting && <p role="status">{remaining.exam === 0
            ? "Exam time has expired. Finishing your attempt."
            : "Question time has expired. Continuing with this question marked unanswered."}
            {error && " Use Retry submission to continue."}
          </p>}

          <LiveExamPresentation sessionId={sessionId} token={sessionToken.current} question={question}
            sequence={questionNumber} answer={answer} expired={expired && !assisting} submitting={submitting}
            onTiming={updateClock} onBusyChange={setAssisting} onTextSizeChange={setTextSize} />

          <textarea
            className="student-answer-input"
            value={answer}
            onChange={(event) => setAnswer(event.target.value)}
            placeholder="Speak your answer or type your response..."
            disabled={submitting || (expired && !assisting)}
            style={{ fontSize: textSize }}
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
              disabled={(!answer.trim() && !expired) || submitting || assisting}
            >
              {submitting ? "Please wait..." : expired ? "Retry submission →" : "Submit Answer →"}
            </button>
          </div>
        </div>
      </main>
    </div>
  );
}
