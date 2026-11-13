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

type RecordingChunk = { index: number; blob: Blob };

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
  const [consentAccepted, setConsentAccepted] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [assisting, setAssisting] = useState(false);
  const [recordingActive, setRecordingActive] = useState(false);
  const [recordingError, setRecordingError] = useState("");
  const [finalizationPending, setFinalizationPending] = useState(false);
  const [textSize, setTextSize] = useState(16);
  const [error, setError] = useState("");
  const started = useRef(false);
  const sessionToken = useRef("");
  const [remaining, setRemaining] = useState<RemainingTime>({ exam: null, question: null });
  const clock = useRef<ExamClock | null>(null);
  const submittingRequest = useRef(false);
  const automaticSubmission = useRef<number | null>(null);
  const mediaStream = useRef<MediaStream | null>(null);
  const mediaRecorder = useRef<MediaRecorder | null>(null);
  const recordingChunks = useRef<RecordingChunk[]>([]);
  const nextChunkIndex = useRef(0);
  const uploadPromise = useRef<Promise<void> | null>(null);
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

  async function flushRecordingChunks(id: string, token: string) {
    if (uploadPromise.current) {
      await uploadPromise.current;
    } else {
      const operation = (async () => {
        while (recordingChunks.current.length > 0) {
          const next = recordingChunks.current[0];
          const formData = new FormData();
          formData.append("index", String(next.index));
          formData.append("chunk", next.blob, `chunk-${next.index}.webm`);
          const response = await fetch(
            `/api/exam/sessions/${encodeURIComponent(id)}/video-recording/chunks`,
            {
              method: "POST",
              headers: { Authorization: `Bearer ${token}` },
              body: formData,
            },
          );
          if (!response.ok) {
            const body = await response.json().catch(() => ({}));
            throw new Error(
              typeof body.detail === "string"
                ? body.detail
                : `Unable to save the exam recording (${response.status}).`,
            );
          }
          recordingChunks.current.shift();
        }
        setRecordingError("");
      })();
      uploadPromise.current = operation;
      try {
        await operation;
      } finally {
        if (uploadPromise.current === operation) uploadPromise.current = null;
      }
    }

    if (recordingChunks.current.length > 0) {
      await flushRecordingChunks(id, token);
    }
  }

  function getRecordingMimeType() {
    const mimeType = [
      "video/webm;codecs=vp8,opus",
      "video/webm",
    ].find(type => MediaRecorder.isTypeSupported(type));
    if (!mimeType) {
      throw new Error("This browser cannot record the required WebM exam video.");
    }
    return mimeType;
  }

  function startMediaRecording(
    id: string,
    token: string,
    stream: MediaStream,
    mimeType: string,
  ) {
    const recorder = new MediaRecorder(stream, {
      mimeType,
      videoBitsPerSecond: 500_000,
      audioBitsPerSecond: 64_000,
    });
    recordingChunks.current = [];
    nextChunkIndex.current = 0;
    recorder.addEventListener("dataavailable", event => {
      if (event.data.size === 0) return;
      recordingChunks.current.push({
        index: nextChunkIndex.current++,
        blob: event.data,
      });
      void flushRecordingChunks(id, token).catch(error => {
        setRecordingError(
          error instanceof Error
            ? error.message
            : "The exam recording could not be saved.",
        );
        if (recorder.state === "recording") recorder.stop();
      });
    });
    recorder.addEventListener("error", () => {
      setRecordingError("The camera or microphone recording stopped unexpectedly.");
      setRecordingActive(false);
    });
    recorder.start(2000);
    mediaRecorder.current = recorder;
    mediaStream.current = stream;
    setRecordingActive(true);
  }

  async function finishRecording(id: string, token: string) {
    const recorder = mediaRecorder.current;
    if (recorder?.state === "recording") {
      await new Promise<void>(resolve => {
        recorder.addEventListener("stop", () => resolve(), { once: true });
        recorder.stop();
      });
    }
    await flushRecordingChunks(id, token);
    const response = await fetch(
      `/api/exam/sessions/${encodeURIComponent(id)}/video-recording/complete`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ expected_chunk_count: nextChunkIndex.current }),
      },
    );
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      throw new Error(
        typeof body.detail === "string"
          ? body.detail
          : `Unable to finalize the exam recording (${response.status}).`,
      );
    }
    mediaStream.current?.getTracks().forEach(track => track.stop());
    mediaStream.current = null;
    mediaRecorder.current = null;
    setRecordingActive(false);
    setRecordingError("");
    setFinalizationPending(false);
  }

  async function beginExam() {
    if (started.current) return;
    started.current = true;
    setLoading(true);
    setError("");

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
    let stream: MediaStream | null = null;
    try {
      const studentToken = sessionStorage.getItem(
        `oralexam_exam_token:${examTemplateId}:${studentId}`,
      );
      if (!studentToken) {
        throw new Error("Exam authorization is missing. Return to your exam list to start.");
      }
      const preflight = await apiRequest<{
        ready: boolean;
        recording_required: boolean;
      }>("/exam/video-recording/preflight", {
        student_id: studentId,
        exam_template_id: examTemplateId,
        student_token: studentToken,
      });
      if (!preflight.ready || typeof preflight.recording_required !== "boolean") {
        throw new Error("The server did not confirm exam recording readiness.");
      }
      let mimeType = "";
      if (preflight.recording_required) {
        if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
          throw new Error("Camera and microphone access requires a trusted HTTPS connection.");
        }
        if (typeof MediaRecorder === "undefined") {
          throw new Error("This browser does not support exam video recording.");
        }
        mimeType = getRecordingMimeType();
        stream = await navigator.mediaDevices.getUserMedia({
          video: { width: { ideal: 640 }, height: { ideal: 480 } },
          audio: true,
        });
      }

      const saved = sessionStorage.getItem(storageKey);
      if (saved && preflight.recording_required) {
        throw new Error(
          "This attempt may have an interrupted recording and cannot be safely resumed. Contact your professor.",
        );
      }

      let result: StartResponse;
      if (saved) {
        const attempt = JSON.parse(saved) as { id: string; token: string };
        const response = await fetch(
          `/api/exam/sessions/${encodeURIComponent(attempt.id)}`,
          { headers: { Authorization: `Bearer ${attempt.token}` } },
        );
        if (!response.ok) {
          throw new Error("Unable to resume this attempt. Please contact your professor.");
        }
        result = await response.json();
        sessionToken.current = attempt.token;
      } else {
        const newAttempt = await apiRequest<StartResponse>("/exam/start", {
          student_id: studentId,
          exam_template_id: examTemplateId,
          student_token: studentToken,
        });
        result = newAttempt;
        if (!result.session_token) throw new Error("Session authorization is missing.");
        sessionToken.current = result.session_token;
        sessionStorage.setItem(
          storageKey,
          JSON.stringify({ id: result.session_id, token: result.session_token }),
        );
      }

      if (preflight.recording_required && result.developer_demo !== true) {
        if (!stream) throw new Error("Camera and microphone access is required.");
        const startResponse = await fetch(
          `/api/exam/sessions/${encodeURIComponent(result.session_id)}/video-recording/start`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${sessionToken.current}`,
            },
            body: JSON.stringify({ content_type: mimeType }),
          },
        );
        if (!startResponse.ok) {
          const body = await startResponse.json().catch(() => ({}));
          throw new Error(
            typeof body.detail === "string"
              ? body.detail
              : `Unable to start secure video recording (${startResponse.status}).`,
          );
        }
        startMediaRecording(result.session_id, sessionToken.current, stream, mimeType);
        stream = null;
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
      }
    } catch (err) {
      stream?.getTracks().forEach(track => track.stop());
      setError(err instanceof Error ? err.message : "Unable to start the exam.");
      started.current = false;
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    return () => {
      if (mediaRecorder.current?.state === "recording") mediaRecorder.current.stop();
      mediaStream.current?.getTracks().forEach(track => track.stop());
    };
  }, []);

  useEffect(() => {
    if (!recordingActive || !sessionId) return;
    const warnBeforeLeaving = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warnBeforeLeaving);
    return () => window.removeEventListener("beforeunload", warnBeforeLeaving);
  }, [recordingActive, sessionId]);

  async function finalizeCompletedExam() {
    if (!sessionId) return;
    setFinalizationPending(true);
    try {
      if (!demoAttempt) await finishRecording(sessionId, sessionToken.current);
      setShowConfirmation(true);
      setRecordingError("");
      setFinalizationPending(false);
    } catch (err) {
      setRecordingError(
        err instanceof Error
          ? err.message
          : "The exam recording could not be finalized.",
      );
    }
  }

  const handleNext = useCallback(async () => {
    const current = clock.current ? remainingTime(clock.current, performance.now()) : remaining;
    const timedOut = current.exam === 0 || current.question === 0;
    if (!sessionId || (!answer.trim() && !timedOut) || submittingRequest.current
        || assisting || (!demoAttempt && (!recordingActive || Boolean(recordingError)))) return;

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
        await finalizeCompletedExam();
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
          await finalizeCompletedExam();
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
  }, [
    sessionId,
    answer,
    questionNumber,
    remaining,
    updateClock,
    assisting,
    demoAttempt,
    recordingActive,
    recordingError,
    finalizeCompletedExam,
  ]);

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

  if (!consentAccepted && !sessionId) {
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
          <h1>Exam recording notice</h1>
          <p>
            Assessed exams record camera video and microphone audio while the
            exam is in progress. The recording and your submitted answers are
            stored on the exam server and made available to the professor who
            owns this exam. The video is retained until the configured end of
            the semester.
          </p>
          <p>
            Camera, microphone, and server storage must remain available for
            the full exam. If recording cannot be started or saved, the exam
            cannot proceed or be submitted.
          </p>
          <p>Developer demo attempts are not recorded or graded.</p>
          <div className="confirmation-actions">
            <button
              type="button"
              className="confirmation-submit-button"
              onClick={() => {
                setConsentAccepted(true);
                void beginExam();
              }}
            >
              I understand — start recording and exam
            </button>
            <button
              type="button"
              className="back-button"
              onClick={() => { window.location.href = "/student/exams"; }}
            >
              Cancel and return to exams
            </button>
          </div>
        </div>
      </main>
    </div>
    );
  }

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
              You have reached the end of your oral examination. Your answers
              and the exam recording have been saved to the exam server.
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
                {demoAttempt
                  ? "This developer demo is saved separately from assessed work and cannot receive grades."
                  : "Your professor can review the video, audio, and submitted answer transcript."}
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
    {recordingError && (
      <div role="alert" className="exam-error">
        <p>{recordingError}</p>
        {finalizationPending ? (
          <button type="button" onClick={() => void finalizeCompletedExam()}>
            Retry saving the completed recording
          </button>
        ) : (
          <button
            type="button"
            onClick={() => {
              if (!sessionId) return;
              void flushRecordingChunks(sessionId, sessionToken.current)
                .then(() => setRecordingError(""))
                .catch(retryError => setRecordingError(
                  retryError instanceof Error ? retryError.message : "The recording upload failed.",
                ));
            }}
          >
            Retry recording upload
          </button>
        )}
        {!recordingActive && !finalizationPending && (
          <p>Recording stopped. Do not continue; contact your professor for help.</p>
        )}
      </div>
    )}
    {!demoAttempt && !recordingActive && !showConfirmation && (
      <p role="status">Exam interaction is paused until recording is active.</p>
    )}
    <div className="exam-question-footer">
      <span role="status">
        {submitting ? "Saving response…" : recordingActive ? "Recording video and audio…" : ""}
      </span>
      <button
        type="submit"
        className="exam-next-button"
        disabled={(!answer.trim() && !expired) || submitting || assisting
          || (!demoAttempt && (!recordingActive || Boolean(recordingError)))}
      >
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
