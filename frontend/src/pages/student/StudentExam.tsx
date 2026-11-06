import { useCallback, useEffect, useRef, useState } from "react";
import { formatRemaining, readExamClock, remainingTime } from "./examTiming";
import type { ExamClock, ExamTiming, RemainingTime } from "./examTiming";
import LiveExamPresentation from "../../components/avatar/LiveExamPresentation";
import OralExamMark from "../../components/brand/OralExamMark";
import { DemoAttemptNotice, useDeveloperDemo } from "../../components/developer-demo/DemoWorkspace";
import "./StudentExam.css";

type StartResponse = ExamTiming & {
  session_id: string;
  session_token?: string;
  status: string;
  sequence_num: number;
  question: string;
  developer_demo?: boolean;
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
  const developer = useDeveloperDemo();
  const [demoAttempt, setDemoAttempt] = useState(false);
  const [settingsTarget, setSettingsTarget] = useState<HTMLDivElement | null>(null);
  const developerMinimal = demoAttempt && developer.enabled && developer.minimal === true;
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
      setDemoAttempt(result.developer_demo === true);
      sessionStorage.setItem("oralexam_exam_session_id", result.session_id);
      sessionStorage.setItem("oralexam_exam_session_token", sessionToken.current);
      // Display only: permission to use substitutes and to grade is enforced by the server.
      sessionStorage.setItem("oralexam_developer_demo", String(result.developer_demo === true));
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
            <span aria-hidden="true"><OralExamMark size={34} /></span>
            <strong>OralExam AI</strong>
          </div>
        </header>
        <main className="student-exam-content">
          <div className="exam-question-card">
            <h1>Preparing your examination...</h1>
            <p>Connecting to the exam server and loading your first question.</p>
            <p>Speak naturally. Take your time.</p>
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
            <span aria-hidden="true"><OralExamMark size={34} /></span>
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
            <span aria-hidden="true"><OralExamMark size={34} /></span>
            <strong>OralExam AI</strong>
          </div>
          <div className="student-exam-progress">Exam Complete</div>
        </header>

        <main className="student-confirmation-content">
          <div className="student-confirmation-card">
            <div className="confirmation-icon">!</div>

            <p className="confirmation-eyebrow">FINAL CONFIRMATION</p>

            <h1>Are you ready to continue?</h1>
            {demoAttempt && <DemoAttemptNotice />}

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
                <strong>{demoAttempt ? "Demo saved · no grading" : "Pending professor review"}</strong>
              </div>
            </div>

            <div className="confirmation-warning">
              <strong>You cannot return to the completed exam.</strong>
              <span>
                {demoAttempt ? "This developer demo is saved separately from assessed work and cannot receive grades." : "Your professor will review your recorded responses."}
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

  const sampleQuestion = question.startsWith("[Developer demo] ");
  const questionText = sampleQuestion ? question.slice("[Developer demo] ".length) : question;
  const answerForm = <form className="exam-answer-form" onSubmit={event => { event.preventDefault(); void handleNext(); }} style={{ fontSize: textSize }}>
    <p className="exam-question-number">{sampleQuestion ? "Sample question" : `Question ${questionNumber}`}</p>
    <h2 className="exam-current-question" aria-live="polite">{questionText}</h2>
    <label className="student-answer-label" htmlFor="student-exam-answer">{demoAttempt ? "Test answer" : "Your answer"}</label>
    <textarea id="student-exam-answer" className="student-answer-input" value={answer}
      onChange={event => setAnswer(event.target.value)} placeholder={demoAttempt ? "Type your test answer here…" : "Type your response…"}
      disabled={submitting || (expired && !assisting)} />
    {expired && !assisting && <p role="status">{remaining.exam === 0
      ? "Exam time has expired. Finishing your attempt."
      : "Question time has expired. Continuing with this question marked unanswered."}
      {error && " Use Retry submission to continue."}</p>}
    {error && <p role="alert" className="exam-error">{error}</p>}
    <div className="exam-question-footer">
      <span role="status">{submitting ? "Saving response…" : ""}</span>
      <button type="submit" className="exam-next-button" disabled={(!answer.trim() && !expired) || submitting || assisting}>
        {submitting ? "Saving…" : expired ? "Retry submission →" : demoAttempt ? "Submit test answer →" : "Submit answer →"}
      </button>
    </div>
  </form>;

  return <div className="student-exam-page">
    <header className="student-exam-header">
      <div className="student-exam-logo"><span aria-hidden="true"><OralExamMark size={40} /></span><strong>OralExam AI</strong></div>
      <div className="exam-header-controls">
        <div className="exam-settings-slot" ref={setSettingsTarget} />
        <div className="exam-timer-chip" role="timer" aria-label="Exam time remaining" aria-live="off">
          <span>Exam time left</span><strong>{remaining.exam === null ? "No limit" : formatRemaining(remaining.exam).padStart(5, "0")}</strong>
        </div>
        <div className="exam-timer-chip" role="timer" aria-label="Question time remaining" aria-live="off">
          <span>Question time left</span><strong>{remaining.question === null ? "No limit" : formatRemaining(remaining.question).padStart(5, "0")}</strong>
        </div>
      </div>
    </header>
    <main className="student-exam-content student-exam-stage-content">
      <h1 className="exam-screen-reader">Oral examination · Question {questionNumber}</h1>
      <LiveExamPresentation sessionId={sessionId} token={sessionToken.current} question={question}
        developerDemo={demoAttempt} developerMinimal={developerMinimal} settingsTarget={settingsTarget}
        sequence={questionNumber} answer={answer} expired={expired && !assisting} submitting={submitting}
        onTiming={updateClock} onBusyChange={setAssisting} onTextSizeChange={setTextSize} />
      {demoAttempt ? <section className="developer-exam-panel" aria-labelledby="developer-exam-heading">
        <div className="developer-exam-heading"><h2 id="developer-exam-heading">Developer mode</h2><strong className="developer-exam-badge">Test attempt · no grading</strong></div>
        <p className="developer-exam-services">{developerMinimal ? "AI, FlashHead, voice, microphone and camera are off." : "Developer test attempt. Optional service availability follows this server’s configuration."}</p>
        {answerForm}
      </section> : <details className="exam-response-panel" open>
        <summary>Question and answer</summary>
        <p>Microphone transcription is not connected. Your typed answer is saved when you submit.</p>
        {answerForm}
      </details>}
    </main>
  </div>;
}
