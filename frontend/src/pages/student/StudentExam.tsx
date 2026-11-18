import { useCallback, useEffect, useRef, useState } from "react";
import { formatRemaining, readExamClock, remainingTime } from "./examTiming";
import type { ExamClock, ExamTiming, RemainingTime } from "./examTiming";
import LiveExamPresentation from "../../components/avatar/LiveExamPresentation";
import AvatarVideoStage from "../../components/avatar/AvatarVideoStage";
import AnswerRecorder from "../../components/avatar/AnswerRecorder";
import { fetchAvatarStatus, fetchExaminerPoster } from "../../components/avatar/avatarService";
import { isClarifyRequest, isRepeatRequest } from "../../components/avatar/voiceCommands";
import type { AssistanceAction } from "../../components/avatar/sessionAssistance";
import { createRecordingMix } from "../../components/exam-recording/recordingMix";
import type { RecordingMix } from "../../components/exam-recording/recordingMix";
import { startPresenceMonitor } from "../../components/exam-recording/presenceMonitor";
import type { AvatarStatus } from "../../components/avatar/avatarService";
import OralExamMark from "../../components/brand/OralExamMark";
import { DemoAttemptNotice, useDeveloperDemo } from "../../components/developer-demo/DemoWorkspace";
import "./StudentExam.css";
import { ExamRecording, recordingLabels } from "./examRecording";
import type { RecordingStatus } from "./examRecording";

type StartResponse = ExamTiming & {
  session_id: string;
  session_token?: string;
  status: string;
  sequence_num: number;
  question: string;
  /** A ready-made line the examiner says before the question (a greeting, or "Thank you."). */
  reaction?: string;
  developer_demo?: boolean;
  record_examination?: boolean;
  generate_transcript?: boolean;
  recording_consent_status?: "not_required" | "pending" | "consented" | "declined";
  recording_consent_decided_at?: string | null;
  exam_title?: string;
  started_at?: string | null;
};

type AnswerResponse = { done: true; reason?: string }
  | (ExamTiming & { done: false; sequence_num: number; question: string; reaction?: string });


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
  // A short line the talking examiner says before the next bank question ("Thank you.").
  const [reaction, setReaction] = useState("");
  const [questionNumber, setQuestionNumber] = useState(1);
  const [completedQuestions, setCompletedQuestions] = useState(0);
  const [answer, setAnswer] = useState("");
  const [showConfirmation, setShowConfirmation] = useState(false);
  const [recordingConsentStatus, setRecordingConsentStatus] = useState<
    "not_required" | "pending" | "consented" | "declined"
  >("not_required");
  const [consentSubmitting, setConsentSubmitting] = useState(false);
  const [recordExamination, setRecordExamination] = useState(false);
  const [recordingStatus, setRecordingStatus] = useState<RecordingStatus>('not_required');
  const examRecording = useRef<ExamRecording | null>(null);
  const [loading, setLoading] = useState(true);
  const [consentAccepted, setConsentAccepted] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [assisting, setAssisting] = useState(false);
  const [recordingActive, setRecordingActive] = useState(false);
  const [textSize, setTextSize] = useState(16);
  const [error, setError] = useState("");
  const started = useRef(false);
  const mounted = useRef(false);
  const sessionToken = useRef("");
  const [remaining, setRemaining] = useState<RemainingTime>({ exam: null, question: null });
  const clock = useRef<ExamClock | null>(null);
  const submittingRequest = useRef(false);
  const automaticSubmission = useRef<number | null>(null);
  const mediaStream = useRef<MediaStream | null>(null);
  const expired = remaining.exam === 0 || remaining.question === 0;
  const [avatar, setAvatar] = useState<AvatarStatus | null>(null);
  const [recording, setRecording] = useState(false);
  // Hands-free: listen when the examiner finishes and stop when the student goes quiet.
  // The student always submits; an earlier auto-submit sent room conversation as an answer.
  const [handsFree, setHandsFree] = useState(() => {
    try { return localStorage.getItem("oralexam_hands_free") !== "off"; } catch { return true; }
  });
  const [listenSignal, setListenSignal] = useState(0);
  const [examTitle, setExamTitle] = useState("");
  const [elapsedSeconds, setElapsedSeconds] = useState<number | null>(null);
  const examStart = useRef<number | null>(null);
  const [examinerSpeech, setExaminerSpeech] = useState<{ id: number; text: string } | null>(null);
  const [voiceNotice, setVoiceNotice] = useState("");
  const [assistRequest, setAssistRequest] = useState<{ id: number; action: AssistanceAction } | null>(null);
  const [poster, setPoster] = useState("");
  // The question text appears once the examiner has said it (or on request), so it is not read ahead.
  const [spokenFor, setSpokenFor] = useState(0);
  const [questionTextShown, setQuestionTextShown] = useState(false);
  const recordingMix = useRef<RecordingMix | null>(null);
  const examinerVideo = useRef<HTMLVideoElement | null>(null);
  // The talking avatar and spoken answers appear only when this server runs the avatar service.
  const avatarOn = !!avatar?.enabled && !developerMinimal && !!sessionId;
  if (!examRecording.current) examRecording.current = new ExamRecording(status => {
    setRecordingStatus(status);
    mediaStream.current = examRecording.current?.getMediaStream() ?? null;
    setRecordingActive(status === 'recording');
  }, {
    prepareStream: stream => {
      recordingMix.current = createRecordingMix(stream);
      if (recordingMix.current && examinerVideo.current) recordingMix.current.attach(examinerVideo.current);
      return recordingMix.current?.stream ?? stream;
    },
    releaseStream: () => { recordingMix.current?.close(); recordingMix.current = null; },
  });


  useEffect(() => {
    const controller = new AbortController();
    void fetchAvatarStatus(controller.signal).then(setAvatar);
    return () => controller.abort();
  }, []);

  const updateClock = useCallback((timing: ExamTiming) => {
    const value = readExamClock(timing, performance.now());
    clock.current = value;
    setRemaining(remainingTime(value, performance.now()));
  }, []);

  useEffect(() => {
    mounted.current = true;
    const interrupt = () => examRecording.current?.interrupt();
    window.addEventListener('pagehide', interrupt);
    return () => {
      mounted.current = false;
      window.removeEventListener('pagehide', interrupt);
      interrupt();
    };
  }, []);

  useEffect(() => {
    if (showConfirmation) void examRecording.current?.finish();
  }, [showConfirmation]);

  useEffect(() => {
    const tick = () => {
      if (examStart.current !== null) {
        const seconds = Math.max(0, Math.floor((performance.now() - examStart.current) / 1000));
        setElapsedSeconds(current => current === seconds ? current : seconds);
      }
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

  async function beginExam() {
    if (started.current) return;
    started.current = true;
    setLoading(true);
    setError("");
    const params = new URLSearchParams(window.location.search);
    const examTemplateId = params.get("templateId");
    const studentId = params.get("studentId");
    if (!examTemplateId || !studentId
        || sessionStorage.getItem("oralexam_face_check_passed") !== "true"
        || sessionStorage.getItem("oralexam_student_id") !== studentId) {
      window.location.href = "/student/verification";
      return;
    }
    const storageKey = `oralexam_attempt:${examTemplateId}:${studentId}`;
    try {
      let result: StartResponse;
      const saved = sessionStorage.getItem(storageKey);
      if (saved) {
        const attempt = JSON.parse(saved) as { id: string; token: string };
        const response = await fetch(`/api/exam/sessions/${encodeURIComponent(attempt.id)}`,
          { headers: { Authorization: `Bearer ${attempt.token}` } });
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
      if (!mounted.current) return;
      setSessionId(result.session_id);
      setDemoAttempt(result.developer_demo === true);
      setRecordExamination(result.record_examination === true);
      setRecordingConsentStatus(result.recording_consent_status ?? "not_required");
      setExamTitle(result.exam_title ?? "");
      if (result.status === "in_progress" && result.recording_consent_status !== "pending") {
        updateClock(result);
        if (result.started_at && result.server_now) {
          const elapsed = Date.parse(result.server_now) - Date.parse(result.started_at);
          if (Number.isFinite(elapsed)) examStart.current = performance.now() - Math.max(0, elapsed);
        }
      }
      sessionStorage.setItem("oralexam_exam_session_id", result.session_id);
      sessionStorage.setItem("oralexam_exam_session_token", sessionToken.current);
      sessionStorage.setItem("oralexam_developer_demo", String(result.developer_demo === true));
      setReaction(result.reaction ?? "");
      setQuestion(result.question);
      setQuestionNumber(result.sequence_num);
      void examRecording.current?.start(result, sessionToken.current);
      if (result.status !== "in_progress") {
        setCompletedQuestions(result.sequence_num);
        setShowConfirmation(true);
      }
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Unable to start the exam.");
      started.current = false;
    } finally {
      setLoading(false);
    }
  }

  // In-exam presence checks run while the assessed recording runs.
  useEffect(() => {
    if (!recordingActive || !sessionId || demoAttempt || !mediaStream.current) return;
    return startPresenceMonitor(sessionId, sessionToken.current, mediaStream.current);
  }, [recordingActive, sessionId, demoAttempt]);

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
    setShowConfirmation(true);
    void examRecording.current?.finish();
  }

  const handleRecordingConsent = useCallback(async (consent: boolean) => {
    if (!sessionId || !sessionToken.current || consentSubmitting) return;

    setConsentSubmitting(true);
    setError("");

    try {
      const result = await apiRequest<ExamTiming & {
        recording_consent_status: "consented" | "declined" | "not_required";
        recording_enabled: boolean;
        decided_at?: string | null;
      }>(
        `/exam/sessions/${encodeURIComponent(sessionId)}/recording-consent`,
        { consent },
        sessionToken.current,
      );

      // The saved choice includes authoritative server deadlines. Capture
      // initialization runs independently and never delays questions/answers.
      if (!mounted.current) return;
      setRecordingConsentStatus(result.recording_consent_status);
      updateClock(result);
      examStart.current = performance.now();
      void examRecording.current?.start({ session_id: sessionId, status: 'in_progress',
        developer_demo: demoAttempt, record_examination: recordExamination,
        recording_consent_status: result.recording_consent_status }, sessionToken.current);
    } catch (err: unknown) {
      setError(
        err instanceof Error
          ? err.message
          : "Unable to save your recording consent choice. Please try again."
      );
    } finally {
      setConsentSubmitting(false);
    }
  }, [sessionId, consentSubmitting, updateClock, demoAttempt, recordExamination]);

  const handleNext = useCallback(async () => {
    const current = clock.current ? remainingTime(clock.current, performance.now()) : remaining;
    const timedOut = current.exam === 0 || current.question === 0;
    if (!sessionId || (!answer.trim() && !timedOut) || submittingRequest.current
        || assisting) return;

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
      setReaction(result.reaction ?? "");
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
          // The server greets the student before the first question; later questions carry their own line.
          setReaction(state.reaction ?? "");
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
    finalizeCompletedExam,
  ]);

  useEffect(() => { setVoiceNotice(""); setQuestionTextShown(false); }, [questionNumber]);

  useEffect(() => {
    if (!avatarOn || !sessionId) return;
    const controller = new AbortController();
    let url = "";
    void fetchExaminerPoster(sessionId, sessionToken.current, controller.signal).then(value => { url = value; setPoster(value); });
    return () => { controller.abort(); if (url) URL.revokeObjectURL(url); };
  }, [avatarOn, sessionId]);

  useEffect(() => {
    if (!expired || loading || showConfirmation || submitting || assisting || !sessionId
        || automaticSubmission.current === questionNumber) return;
    automaticSubmission.current = questionNumber;
    void handleNext();
  }, [expired, loading, showConfirmation, submitting, assisting, sessionId, questionNumber, handleNext]);

  const submitExam = async () => {
    // The backend has already ended the session when it returns done: true.
    await examRecording.current?.finish();
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
          <h1>Before your examination</h1>
          <p>
            Your professor's recording settings apply to this attempt. If recording
            is enabled, you will be asked to accept or decline before any camera
            or microphone recording begins. You can take and submit the exam
            if you decline or recording is unavailable.
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
              Begin examination
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
              have been saved to the exam server. Recording status is shown below.
            </p>

            <div className="confirmation-summary">
              {!demoAttempt && <p role="status">{recordingLabels[recordingStatus]}</p>}
              <div className="confirmation-row">
                <span>Questions completed</span>
                <strong>{completedQuestions}</strong>
              </div>
              <div className="confirmation-row">
                <span>Response status</span>
                <strong>Typed answers saved</strong>
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

  if (recordingConsentStatus === "pending" && !demoAttempt) {
    return (
      <div className="student-exam-page">
        <header className="student-exam-header">
          <div className="student-exam-logo">
            <span aria-hidden="true"><OralExamMark size={34} /></span>
            <strong>OralExam AI</strong>
          </div>
          <div className="student-exam-progress">Recording Consent</div>
        </header>

        <main className="student-exam-content">
          <section className="exam-question-card recording-consent-card">
            <p className="exam-question-number">BEFORE YOUR EXAM</p>
            <h1>Recording permission</h1>

            <p>
              Your professor has enabled the Record Examination option
              for this exam.
            </p>

            <p>
              If you allow recording, your camera and microphone will be
              recorded together for your professor to review. Your choice
              will be saved before the browser requests device permissions.
            </p>
              <p>
                When your professor enables speech transcription, a machine-generated
                transcript of the recorded audio will also be saved for your professor
                to review. Declining recording also prevents this speech transcript.
              </p>

            <p>
              You may continue with your examination whether you allow
              or decline recording.
            </p>

            {error && (
              <p role="alert" className="exam-error">{error}</p>
            )}

            <div className="recording-consent-actions">
              <button
                type="button"
                className="exam-next-button"
                disabled={consentSubmitting}
                onClick={() => void handleRecordingConsent(true)}
              >
                {consentSubmitting ? "Saving choice…" : "Allow recording"}
              </button>

              <button
                type="button"
                className="recording-decline-button"
                disabled={consentSubmitting}
                onClick={() => void handleRecordingConsent(false)}
              >
                {consentSubmitting ? "Saving choice…" : "Decline recording"}
              </button>
            </div>
          </section>
        </main>
      </div>
    );
  }
  const examinerFinished = () => {
    setSpokenFor(questionNumber);
    if (handsFree && recordingConsentStatus === 'consented' && !demoAttempt
        && !answer.trim() && !submitting) setListenSignal(value => value + 1);
  };
  const toggleHandsFree = (on: boolean) => {
    setHandsFree(on);
    try { localStorage.setItem("oralexam_hands_free", on ? "on" : "off"); } catch { /* per-browser preference only */ }
  };
  const examinerElement = (element: HTMLVideoElement | null) => {
    examinerVideo.current = element;
    if (element) recordingMix.current?.attach(element);
  };
  const examinerSays = (text: string) => setExaminerSpeech(current => ({ id: (current?.id ?? 0) + 1, text }));
  const heardAnswer = (text: string) => {
    // "Can you repeat the question?" or "can you clarify?" asks the examiner; it is not part of the answer.
    const request: AssistanceAction | null = isRepeatRequest(text) ? "repeat" : isClarifyRequest(text) ? "clarification" : null;
    if (request) {
      setVoiceNotice("");
      setAssistRequest(current => ({ id: (current?.id ?? 0) + 1, action: request }));
      return false;
    }
    setVoiceNotice("");
    setAnswer(current => current.trim() ? `${current.trim()} ${text}` : text);
    return true;
  };

  const sampleQuestion = question.startsWith("[Developer demo] ");
  const questionText = sampleQuestion ? question.slice("[Developer demo] ".length) : question;
  const answerForm = <form className="exam-answer-form" onSubmit={event => { event.preventDefault(); void handleNext(); }} style={{ fontSize: textSize }}>
    <p className="exam-question-number">{sampleQuestion ? "Sample question" : `Question ${questionNumber}`}</p>
    {!avatarOn || spokenFor === questionNumber || questionTextShown
      ? <h2 className="exam-current-question" aria-live="polite">{questionText}</h2>
      : <div className="exam-question-waiting">
          <p>Listen to the examiner. The question appears here once it has been asked.</p>
          <button type="button" className="exam-question-show" onClick={() => setQuestionTextShown(true)}>Show the question now</button>
        </div>}
    <label className="student-answer-label" htmlFor="student-exam-answer">{demoAttempt ? "Test answer" : "Your answer"}</label>
    <textarea id="student-exam-answer" className="student-answer-input" value={answer}
      onChange={event => setAnswer(event.target.value)} placeholder={demoAttempt ? "Type your test answer here…" : "Type your response…"}
      disabled={submitting || (expired && !assisting)} />
    {avatarOn && <AnswerRecorder sessionId={sessionId} token={sessionToken.current}
      sharedStream={recordingActive ? mediaStream.current : null}
      disabled={demoAttempt || submitting || (expired && !assisting)} onRecordingChange={setRecording}
      listenSignal={listenSignal} handsFree={handsFree && recordingConsentStatus === 'consented' && !demoAttempt} onTranscript={heardAnswer} />}
    {avatarOn && voiceNotice && <p className="answer-recorder-note" role="status">{voiceNotice}</p>}
    {avatarOn && <label className="hands-free-toggle">
      <input type="checkbox" checked={handsFree} onChange={event => toggleHandsFree(event.target.checked)} />
      Hands-free: start listening after each question
    </label>}
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
      {examTitle && <p className="student-exam-title">{examTitle}</p>}
      <div className="exam-header-controls">
        {!demoAttempt && <span role="status" className="exam-recording-status">
          {recordingLabels[recordingStatus]}
          {['permission_denied', 'unavailable', 'upload_failed', 'interrupted'].includes(recordingStatus)
            && '. Continue using typed answers.'}
        </span>}
        <div className="exam-settings-slot" ref={setSettingsTarget} />
        {elapsedSeconds !== null && <div className="exam-timer-chip" role="timer" aria-label="Time elapsed" aria-live="off">
          <span>Time elapsed</span><strong>{formatRemaining(elapsedSeconds).padStart(5, "0")}</strong>
        </div>}
        {remaining.exam === null && remaining.question === null
          ? <div className="exam-timer-chip" aria-label="This exam has no time limit">
              <span>Time limit</span><strong>None</strong>
            </div>
          : <>
            <div className="exam-timer-chip" role="timer" aria-label="Exam time remaining" aria-live="off">
              <span>Exam time left</span><strong>{remaining.exam === null ? "No limit" : formatRemaining(remaining.exam).padStart(5, "0")}</strong>
            </div>
            <div className="exam-timer-chip" role="timer" aria-label="Question time remaining" aria-live="off">
              <span>Question time left</span><strong>{remaining.question === null ? "No limit" : formatRemaining(remaining.question).padStart(5, "0")}</strong>
            </div>
            </>}
      </div>
    </header>
    <main className={`student-exam-content student-exam-stage-content${avatarOn ? " is-two-column" : ""}`}>
      <h1 className="exam-screen-reader">Oral examination · Question {questionNumber}</h1>
      <LiveExamPresentation sessionId={sessionId}
        stage={avatarOn ? <AvatarVideoStage sessionId={sessionId} token={sessionToken.current} text={questionText}
          sequence={questionNumber} hold={recording || submitting} onFinished={examinerFinished}
          announce={examinerSpeech} onVideoElement={examinerElement} poster={poster} lead={reaction}
          startDelayMs={questionNumber <= 1 ? 2500 : 700} /> : null}
        examinerSpeaks={avatarOn ? examinerSays : undefined} assistRequest={assistRequest} token={sessionToken.current} question={question}
        developerDemo={demoAttempt} developerMinimal={developerMinimal} settingsTarget={settingsTarget}
        sequence={questionNumber} answer={answer} expired={expired && !assisting} submitting={submitting}
        onTiming={updateClock} onBusyChange={setAssisting} onTextSizeChange={setTextSize} />
      {demoAttempt ? <section className="developer-exam-panel" aria-labelledby="developer-exam-heading">
        <div className="developer-exam-heading"><h2 id="developer-exam-heading">Developer mode</h2><strong className="developer-exam-badge">Test attempt · no grading</strong></div>
        <p className="developer-exam-services">{developerMinimal ? "AI, FlashHead, voice, microphone and camera are off." : "Developer test attempt. Optional service availability follows this serverâ€™s configuration."}</p>
        {answerForm}
      </section> : <details className="exam-response-panel" open>
        <summary>Question and answer</summary>
        <p>{avatarOn ? (handsFree
          ? "After the examiner asks, start talking. Pause for 3 seconds when you are finished, check the transcript, then select Submit answer. To hear the question again, say “repeat the question”."
          : "Speak your answer or type it. Check the transcript before you submit.") : "Microphone transcription is not connected. Your typed answer is saved when you submit."}</p>
        {answerForm}
      </details>}
    </main>
  </div>;
}
