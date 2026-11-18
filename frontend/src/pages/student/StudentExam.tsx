import { useCallback, useEffect, useRef, useState } from "react";
import { formatRemaining, readExamClock, remainingTime } from "./examTiming";
import type { ExamClock, ExamTiming, RemainingTime } from "./examTiming";
import LiveExamPresentation from "../../components/avatar/LiveExamPresentation";
import AutomaticOralExam from "../../components/exam/AutomaticOralExam";
import SpeechDraft from "../../components/exam/SpeechDraftPanel";
import EnvironmentPreview from "../../components/avatar/EnvironmentPreview";
import type { StudentPreferences } from "../../components/student-settings/studentSettings";
import { pendingAnswer, type PendingAnswer, type AnswerMetadata } from "./answerSubmission";
import { createLiveVideo, type LiveVideoState } from "../../components/media/liveVideo";
import { createMediaTimeline, type MediaEventKind } from '../../components/media/mediaTimeline';
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
import "./examiner-workspace.css";
import { hasStudentFaceAccess } from './studentIdentity';

type StartResponse = ExamTiming & {
  session_id: string;
  session_token?: string;
  status: string;
  sequence_num: number;
  question: string;
  /** A ready-made line the examiner says before the question (a greeting, or "Thank you."). */
  reaction?: string;
  developer_demo?: boolean;
  exam_title?: string;
  started_at?: string | null;
  identity_check_completed?: boolean;
  identity_review_required?: boolean;
  technical_restart_allowed?: boolean;
  record_examination?: boolean;
  generate_transcript?: boolean;
  recording_consent_status?: string;
};

type AnswerResponse = { done: true; reason?: string }
  | (ExamTiming & { done: false; sequence_num: number; question: string; reaction?: string });

type RecordingChunk = { index: number; blob: Blob };

async function saveRecordingRequest(endpoint: string, init: RequestInit, failureMessage: string) {
  const controller = new AbortController();
  const deadline = window.setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch(endpoint, { ...init, signal: controller.signal });
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      throw new Error(typeof body.detail === 'string' ? body.detail : `${failureMessage} (${response.status}).`);
    }
  } catch (failure) {
    if (controller.signal.aborted) throw new Error(`${failureMessage} The recording request timed out.`);
    throw failure;
  } finally { window.clearTimeout(deadline); }
}

async function apiRequest<T>(
  endpoint: string,
  body: Record<string, unknown>,
  token?: string,
  signal?: AbortSignal,
): Promise<T> {
  const response = await fetch(`/api${endpoint}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
    signal,
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
  const [endConfirmation, setEndConfirmation] = useState(false);
  const [endingExam, setEndingExam] = useState(false);
  const [endRequested, setEndRequested] = useState(false);
  const endRequestedRef = useRef(false);
  const endDialog = useRef<HTMLDialogElement | null>(null);
  useEffect(() => {
    if (endConfirmation && !endDialog.current?.open) endDialog.current?.showModal();
    else if (!endConfirmation) endDialog.current?.close();
  }, [endConfirmation]);
  const [keyboardMode, setKeyboardMode] = useState(false);
  const oralSubmission = useRef<number | null>(null);
  const [demoAttempt, setDemoAttempt] = useState(false);
  const [identityReviewRequired, setIdentityReviewRequired] = useState(false);
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
  const [loading, setLoading] = useState(true);
  const [consentAccepted, setConsentAccepted] = useState(false);
  const [environmentPreferences, setEnvironmentPreferences] = useState<StudentPreferences | null>(null);
  const answerRequest = useRef<PendingAnswer | null>(null);
  const recordingStartedAt = useRef<number | null>(null);
  const questionMediaStart = useRef<number | null>(null);
  const answerMetadata = useRef<AnswerMetadata>({ input_source: 'typed' });
  const [submitting, setSubmitting] = useState(false);
  const [assisting, setAssisting] = useState(false);
  const [speechBusy, setSpeechBusy] = useState(false);
  const [questionAudioBusy, setQuestionAudioBusy] = useState(false);
  const [timelineWarning, setTimelineWarning] = useState('');
  const timeline = useRef<ReturnType<typeof createMediaTimeline> | null>(null);
  const currentQuestion = useRef(questionNumber);
  currentQuestion.current = questionNumber;
  const recordMediaObservation = useCallback(async (kind: MediaEventKind, sequence: number, assetId?: string) => {
    if (!timeline.current) return;
    try { await timeline.current.record(kind, sequence, assetId); }
    catch (failure) { setTimelineWarning('Some playback observations could not be saved. The exam recording continues separately.'); throw failure; }
  }, []);
  const [confirmedSpeechUsed, setConfirmedSpeechUsed] = useState(false);
  const [captureRequired, setCaptureRequired] = useState(true);
  const [recordingActive, setRecordingActive] = useState(false);
  const [recordingError, setRecordingError] = useState("");
  const [interruptedRecording, setInterruptedRecording] = useState(false);
  const [partialRecordingSaved, setPartialRecordingSaved] = useState(false);
  const [savingPartialRecording, setSavingPartialRecording] = useState(false);
  const recordingInterrupted = useRef(false);
  const finishingRecording = useRef(false);
  const interruptionReport = useRef<Promise<unknown> | null>(null);
  const [liveStatus, setLiveStatus] = useState<LiveVideoState>('waiting');
  const [liveMessage, setLiveMessage] = useState('No live connection has started.');
  const liveController = useRef<ReturnType<typeof createLiveVideo> | null>(null);
  const [recordingNotice, setRecordingNotice] = useState<{ready: boolean; recording_required: boolean; retention_until?: string} | null>(null);
  const [noticeError, setNoticeError] = useState('');
  const [noticeRetry, setNoticeRetry] = useState(0);
  const [finalizationPending, setFinalizationPending] = useState(false);
  const [textSize, setTextSize] = useState(16);
  const [error, setError] = useState("");
  const started = useRef(false);
  const mounted = useRef(true);
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
  const [examinerSpeech, setExaminerSpeech] = useState<{ id: number; text: string; operationId?: string } | null>(null);
  const [voiceNotice, setVoiceNotice] = useState("");
  const [assistRequest, setAssistRequest] = useState<{ id: number; action: AssistanceAction } | null>(null);
  const [poster, setPoster] = useState("");
  // The question text appears once the examiner has said it (or on request), so it is not read ahead.
  const [spokenFor, setSpokenFor] = useState(0);
  const [questionTextShown, setQuestionTextShown] = useState(false);
  const recordingMix = useRef<RecordingMix | null>(null);
  const examinerVideo = useRef<HTMLVideoElement | null>(null);
  // The talking avatar and spoken answers appear only when this server runs the avatar service.
  const avatarOn = !!avatar?.enabled && !developerMinimal && !!sessionId && (demoAttempt || recordingActive);

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

  useEffect(() => {
    if (!environmentPreferences || sessionId || consentAccepted) return;
    let cancelled = false;
    setRecordingNotice(null); setNoticeError('');
    const params = new URLSearchParams(window.location.search);
    const exam = params.get('templateId'); const student = params.get('studentId');
    const studentToken = exam && student ? sessionStorage.getItem(`oralexam_exam_token:${exam}:${student}`) : null;
    if (!studentToken) { setNoticeError('Exam authorization is missing. Return to the exam list.'); return; }
    void apiRequest<{ready: boolean; recording_required: boolean; retention_until?: string}>(
      '/exam/video-recording/preflight', { student_id: student, exam_template_id: exam, student_token: studentToken }
    ).then(value => {
      if (cancelled) return;
      if (value.ready !== true || typeof value.recording_required !== 'boolean'
          || (value.recording_required && (!value.retention_until || !Number.isFinite(Date.parse(value.retention_until))))) {
        throw new Error('Recording readiness and retention could not be confirmed.');
      }
      setRecordingNotice(value);
    }).catch(failure => {
      if (!cancelled) setNoticeError(failure instanceof Error ? failure.message : 'Recording readiness is unavailable.');
    });
    return () => { cancelled = true; };
  }, [environmentPreferences, sessionId, consentAccepted, noticeRetry]);

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
          await saveRecordingRequest(
            `/api/exam/sessions/${encodeURIComponent(id)}/video-recording/chunks`,
            {
              method: "POST",
              headers: { Authorization: `Bearer ${token}` },
              body: formData,
            },
            'Unable to save the exam recording.',
          );
          recordingChunks.current.shift();
        }
        if (!recordingInterrupted.current) setRecordingError("");
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

  async function reportRecordingInterruption() {
    if (!timeline.current) throw new Error('The recording interruption could not be reported. Retry saving the partial recording.');
    if (!interruptionReport.current) {
      const operation = recordMediaObservation('recording_interrupted', currentQuestion.current);
      interruptionReport.current = operation;
      void operation.catch(() => {
        if (interruptionReport.current === operation) interruptionReport.current = null;
      });
    }
    await interruptionReport.current;
  }

  function releaseRecordingDevices() {
    liveController.current?.stop(); liveController.current = null;
    mediaStream.current?.getTracks().forEach(track => track.stop());
    mediaStream.current = null;
    recordingMix.current?.close(); recordingMix.current = null;
    setRecordingActive(false);
  }

  function interruptRecording(message: string) {
    if (!recordingInterrupted.current) {
      // Sticky and synchronous: final dataavailable/upload success must never
      // restore an assessed recorder which has stopped.
      recordingInterrupted.current = true;
      setInterruptedRecording(true);
      setRecordingError(message);
      void reportRecordingInterruption().catch(() => undefined);
      recordingStartedAt.current = null;
      questionMediaStart.current = null;
    }
    if (mediaRecorder.current?.state === 'recording' || mediaRecorder.current?.state === 'paused') mediaRecorder.current.stop();
    releaseRecordingDevices();
    setLiveStatus('ended'); setLiveMessage('Recording was interrupted. Live viewing has stopped.');
  }

  function startMediaRecording(
    id: string,
    token: string,
    stream: MediaStream,
    mimeType: string,
  ) {
    // Record the examiner's voice too, not only the student's microphone.
    recordingMix.current = createRecordingMix(stream);
    if (recordingMix.current && examinerVideo.current) recordingMix.current.attach(examinerVideo.current);
    const recorder = new MediaRecorder(recordingMix.current?.stream ?? stream, {
      mimeType,
      videoBitsPerSecond: 500_000,
      audioBitsPerSecond: 64_000,
    });
    recordingChunks.current = [];
    nextChunkIndex.current = 0;
    recordingInterrupted.current = false;
    finishingRecording.current = false;
    interruptionReport.current = null;
    setInterruptedRecording(false); setPartialRecordingSaved(false);
    recorder.addEventListener("dataavailable", event => {
      if (event.data.size === 0) return;
      const buffered = recordingChunks.current.reduce((total, chunk) => total + chunk.blob.size, 0);
      if (buffered + event.data.size > 16 * 1024 * 1024) {
        interruptRecording('The recording upload buffer reached its limit. Save the partial recording and contact your professor.');
        return;
      }
      recordingChunks.current.push({
        index: nextChunkIndex.current++,
        blob: event.data,
      });
      void flushRecordingChunks(id, token).catch(error => {
        const message = error instanceof Error ? error.message : 'The exam recording could not be saved.';
        if (finishingRecording.current && !recordingInterrupted.current) {
          // All answers have ended and capture is intentionally stopping. An
          // upload retry can still save this complete, continuous recording.
          setRecordingError(message); releaseRecordingDevices();
        } else interruptRecording(message);
      });
    });
    recorder.addEventListener("error", () => {
      interruptRecording('The camera or microphone recording stopped unexpectedly.');
    });
    recorder.addEventListener('stop', () => {
      if (!finishingRecording.current && !recordingInterrupted.current) {
        interruptRecording('The exam recorder stopped before the attempt ended.');
      }
    });
    stream.getTracks().forEach(track => track.addEventListener('ended', () => {
      if (!finishingRecording.current) interruptRecording('The camera or microphone was disconnected.');
    }, { once: true }));
    recorder.start(2000);
    recordingStartedAt.current = performance.now();
    timeline.current = createMediaTimeline(id, token, () => recordingStartedAt.current === null ? null
      : (performance.now() - recordingStartedAt.current) / 1000);
    questionMediaStart.current = 0;
    mediaRecorder.current = recorder;
    mediaStream.current = stream;
    liveController.current?.stop();
    liveController.current = createLiveVideo({ sessionId: id, token, role: 'student', stream,
      onState: (state, message) => { setLiveStatus(state); setLiveMessage(message); } });
    setRecordingActive(true);
  }

  async function finishRecording(id: string, token: string) {
    finishingRecording.current = true;
    liveController.current?.stop(); liveController.current = null;
    setLiveStatus('ended'); setLiveMessage('The attempt ended. Live viewing has stopped.');
    try {
      const recorder = mediaRecorder.current;
      if (recorder?.state === "recording") {
        await new Promise<void>(resolve => {
          recorder.addEventListener("stop", () => resolve(), { once: true });
          recorder.stop();
        });
      }
      releaseRecordingDevices();
      await flushRecordingChunks(id, token);
      if (recordingInterrupted.current) await reportRecordingInterruption();
      else await recordMediaObservation('recording_ended', currentQuestion.current).catch(() => undefined);
      await saveRecordingRequest(
        `/api/exam/sessions/${encodeURIComponent(id)}/video-recording/complete`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({ expected_chunk_count: nextChunkIndex.current }),
        },
        'Unable to finalize the exam recording.',
      );
      mediaRecorder.current = null;
      if (!recordingInterrupted.current) setRecordingError("");
      setFinalizationPending(false);
    } finally {
      releaseRecordingDevices();
      recordingMix.current?.close(); recordingMix.current = null;
    }
  }

  async function saveInterruptedRecording() {
    if (!sessionId || savingPartialRecording || partialRecordingSaved) return;
    setSavingPartialRecording(true);
    try {
      // Ensure the server has terminated the attempt before finalizing the
      // retained partial bytes. This never submits or invents another answer.
      await reportRecordingInterruption();
      await finishRecording(sessionId, sessionToken.current);
      setPartialRecordingSaved(true);
    } catch (failure) {
      setRecordingError(failure instanceof Error ? failure.message : 'The partial recording could not be saved. Retry or contact your professor.');
    } finally { setSavingPartialRecording(false); }
  }

  async function beginExam(recordMedia = true) {
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
      !hasStudentFaceAccess(studentId) ||
      sessionStorage.getItem("oralexam_student_id") !== studentId
    ) {
      window.location.href = "/student/verification";
      return;
    }

    const storageKey = `oralexam_attempt:${examTemplateId}:${studentId}`;
    let stream: MediaStream | null = null;
    let startedAttempt: StartResponse | null = null;
    try {
      const studentToken = sessionStorage.getItem(
        `oralexam_exam_token:${examTemplateId}:${studentId}`,
      );
      if (!studentToken) {
        throw new Error("Exam authorization is missing. Return to your exam list to start.");
      }
      const preflight = recordMedia ? await apiRequest<{
        ready: boolean;
        recording_required: boolean;
      }>("/exam/video-recording/preflight", {
        student_id: studentId,
        exam_template_id: examTemplateId,
        student_token: studentToken,
      }) : { ready: true, recording_required: false };
      if (!preflight.ready || typeof preflight.recording_required !== "boolean") {
        throw new Error("The server did not confirm exam recording readiness.");
      }
      if (!mounted.current) throw new Error('Exam startup was cancelled when leaving the page.');
      let mimeType = "";


      let saved = sessionStorage.getItem(storageKey);
      if (saved) {
        let previous: StartResponse;
        try {
          const attempt = JSON.parse(saved) as { id: string; token: string };
          const response = await fetch(`/api/exam/sessions/${encodeURIComponent(attempt.id)}`,
            { headers: { Authorization: `Bearer ${attempt.token}` } });
          if (!response.ok) throw new Error('Unable to read the saved attempt.');
          previous = await response.json() as StartResponse;
        } catch {
          throw new Error('Unable to safely resume this attempt. Contact your professor.');
        }
        if (previous.status === 'flagged' && previous.technical_restart_allowed === true) {
          // A technical restart creates a new attempt and preserves the old evidence.
          sessionStorage.removeItem(storageKey); saved = null;
        } else if (previous.status !== 'in_progress') {
          sessionStorage.removeItem(storageKey);
          throw new Error('You have already completed this exam.');
        } else if (previous.recording_consent_status === 'consented'
          || (previous.recording_consent_status === undefined && previous.record_examination !== false && !previous.developer_demo)) {
          throw new Error('This attempt may have an interrupted recording and cannot be safely resumed. Contact your professor.');
        }
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
          presentation_preferences: environmentPreferences,
        });
        result = newAttempt;
        if (!result.session_token) throw new Error("Session authorization is missing.");
        sessionToken.current = result.session_token;
        startedAttempt = result;
        sessionStorage.setItem(
          storageKey,
          JSON.stringify({ id: result.session_id, token: result.session_token }),
        );
      }

      if (!mounted.current) throw new Error('Exam startup was cancelled when leaving the page.');
      if (result.recording_consent_status === 'pending') {
        const choice = await apiRequest<ExamTiming & { recording_consent_status: string; decided_at?: string }>(
          `/exam/sessions/${encodeURIComponent(result.session_id)}/recording-consent`,
          { consent: recordMedia }, sessionToken.current);
        result = { ...result, ...choice, started_at: choice.decided_at ?? result.started_at };
      }
      const shouldCapture = result.developer_demo !== true && result.record_examination !== false
        && result.recording_consent_status !== 'declined' && preflight.recording_required;
      setCaptureRequired(shouldCapture);
      if (!shouldCapture) setKeyboardMode(true);
      if (shouldCapture) {

        try {
          if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
            throw new Error("Camera and microphone access requires a trusted HTTPS connection.");
          }
          if (typeof MediaRecorder === "undefined") {
            throw new Error("This browser does not support exam video recording.");
          }
          mimeType = getRecordingMimeType();
          stream = await navigator.mediaDevices.getUserMedia({
            video: { width: { ideal: 640, max: 640 }, height: { ideal: 480, max: 480 }, frameRate: { ideal: 15, max: 15 } },
            audio: true,
          });
          if (!mounted.current) throw new Error('Exam startup was cancelled when leaving the page.');

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
          if (!mounted.current) throw new Error('Exam startup was cancelled when leaving the page.');
          startMediaRecording(result.session_id, sessionToken.current, stream, mimeType);
          stream = null;
        } catch (failure) {
          if (!mounted.current) throw failure;
          (stream as MediaStream | null)?.getTracks().forEach(track => track.stop()); stream = null;
          setCaptureRequired(false); setKeyboardMode(true);
          setLiveMessage('Recording is unavailable. This attempt uses typed answers.');
          const status = failure instanceof DOMException && ['NotAllowedError', 'SecurityError'].includes(failure.name)
            ? 'permission_denied' : 'unavailable';
          await apiRequest(`/exam/sessions/${encodeURIComponent(result.session_id)}/video-recording/failure`,
            { status }, sessionToken.current).catch(() => undefined);
        }
      }

      if (result.status === "in_progress") updateClock(result);
      setExamTitle(result.exam_title ?? "");
      if (result.started_at && result.server_now) {
        const alreadyElapsed = Date.parse(result.server_now) - Date.parse(result.started_at);
        if (Number.isFinite(alreadyElapsed)) examStart.current = performance.now() - Math.max(0, alreadyElapsed);
      }
      setSessionId(result.session_id);
      setDemoAttempt(result.developer_demo === true);
      setIdentityReviewRequired(result.identity_check_completed === false && result.identity_review_required === true);
      sessionStorage.setItem("oralexam_exam_session_id", result.session_id);
      sessionStorage.setItem("oralexam_exam_session_token", sessionToken.current);
      // Display only: permission to use substitutes and to grade is enforced by the server.
      sessionStorage.setItem("oralexam_developer_demo", String(result.developer_demo === true));
      setReaction(result.reaction ?? "");
      setQuestion(result.question);
      setQuestionNumber(result.sequence_num);
      if (result.status !== "in_progress") {
        setCompletedQuestions(result.sequence_num);
        setShowConfirmation(true);
      }
    } catch (err) {
      (stream as MediaStream | null)?.getTracks().forEach(track => track.stop());
      if (startedAttempt && startedAttempt.developer_demo !== true && sessionToken.current) {
        if (mediaRecorder.current) interruptRecording('Recording could not be started safely. Contact your professor.');
        else void createMediaTimeline(startedAttempt.session_id, sessionToken.current, () => null)
          .record('recording_interrupted', startedAttempt.sequence_num).catch(() => undefined);
      }
      if (!mounted.current) {
        // A successful start may arrive after navigation. Preserve its receipt
        // and report termination; never start a recorder from that late result.
        return;
      }
      setError(err instanceof Error ? err.message : "Unable to start the exam.");
      started.current = false;
    } finally {
      if (mounted.current) setLoading(false);
    }
  }

  useEffect(() => {
    if (!sessionId || demoAttempt || !recordingActive || !timeline.current) return;
    void recordMediaObservation('question_presented', questionNumber).catch(() => undefined);
  }, [sessionId, demoAttempt, recordingActive, questionNumber, recordMediaObservation]);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (mediaRecorder.current?.state === "recording") interruptRecording('The recording was interrupted when leaving the attempt.');
      releaseRecordingDevices();
      recordingMix.current?.close();
    };
  }, []);

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
    if (!sessionId) return;
    setFinalizationPending(true);
    try {
      if (!demoAttempt && mediaRecorder.current) await finishRecording(sessionId, sessionToken.current);
      if (recordingInterrupted.current) { setPartialRecordingSaved(true); return; }
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

  async function endExamNow() {
    if (!sessionId || submittingRequest.current || recordingInterrupted.current) return;
    endRequestedRef.current = true; setEndRequested(true);
    submittingRequest.current = true; setEndingExam(true); setSubmitting(true); setError("");
    oralSubmission.current = null;
    const controller = new AbortController();
    const deadline = window.setTimeout(() => controller.abort(), 15000);
    try {
      const result = await apiRequest<{done: boolean}>(`/exam/sessions/${encodeURIComponent(sessionId)}/end`, {}, sessionToken.current, controller.signal);
      if (!result.done) throw new Error('The server did not confirm that the exam ended.');
      clock.current = null;
      setCompletedQuestions(Math.max(0, questionNumber - 1));
      setEndConfirmation(false);
      await finalizeCompletedExam();
    } catch (failure) {
      setError(controller.signal.aborted ? 'Ending the exam timed out. Retry ending the exam; your unfinished answer will not be submitted.'
        : failure instanceof Error ? failure.message : 'The exam could not be ended. Retry ending the exam.');
      setEndConfirmation(false);
    } finally {
      window.clearTimeout(deadline);
      submittingRequest.current = false; setSubmitting(false); setEndingExam(false);
    }
  }

  const handleNext = useCallback(async () => {
    const current = clock.current ? remainingTime(clock.current, performance.now()) : remaining;
    const timedOut = current.exam === 0 || current.question === 0;
    if (endRequestedRef.current || recordingInterrupted.current || !sessionId || (!answer.trim() && !timedOut) || submittingRequest.current
        || assisting || speechBusy || questionAudioBusy || (captureRequired && !demoAttempt && (!recordingActive || Boolean(recordingError)))) return;

    submittingRequest.current = true;
    setSubmitting(true);
    setError("");

    try {
      // Client-reported approximate exchange bounds in the continuous recording.
      const end = recordingStartedAt.current === null ? undefined : (performance.now() - recordingStartedAt.current) / 1000;
      const start = questionMediaStart.current ?? undefined;
      const validBounds = start !== undefined && end !== undefined && Number.isFinite(start) && Number.isFinite(end) && start >= 0 && end >= start;
      const request = pendingAnswer(answerRequest.current, sessionId, questionNumber, answer, timedOut, () => crypto.randomUUID(), {
        ...answerMetadata.current,
        ...(validBounds ? { answer_timestamp_start: start, answer_timestamp_end: end } : {}),
      });
      answerRequest.current = request;
      const result = await apiRequest<AnswerResponse>("/exam/answer", {
        session_id: request.session_id,
        answer_transcript: request.answer_transcript,
        question_sequence_num: request.question_sequence_num,
        request_id: request.request_id,
        input_source: request.input_source,
        transcript_draft_id: request.transcript_draft_id,
        machine_draft: request.machine_draft,
        transcript_receipt: request.transcript_receipt,
        answer_timestamp_start: request.answer_timestamp_start,
        answer_timestamp_end: request.answer_timestamp_end,
      }, sessionToken.current);

      if (recordingInterrupted.current) {
        setError('Recording was interrupted while the response was being saved. Contact your professor to review the saved material.');
        return;
      }

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
      answerRequest.current = null;
      answerMetadata.current = { input_source: 'typed' };
        setConfirmedSpeechUsed(false);
      questionMediaStart.current = recordingStartedAt.current === null ? null : (performance.now() - recordingStartedAt.current) / 1000;
    } catch (err: unknown) {
      if (recordingInterrupted.current) {
        setError('Recording was interrupted. Save the partial recording and contact your professor.');
        return;
      }
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
          answerRequest.current = null;
          answerMetadata.current = { input_source: 'typed' };
        setConfirmedSpeechUsed(false);
          questionMediaStart.current = recordingStartedAt.current === null ? null : (performance.now() - recordingStartedAt.current) / 1000;
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
    speechBusy,
    questionAudioBusy,
    demoAttempt,
    recordingActive,
    captureRequired,
    recordingError,
    finalizeCompletedExam,
  ]);

  useEffect(() => {
    if (oralSubmission.current !== questionNumber || submitting || assisting || speechBusy || questionAudioBusy
        || interruptedRecording || (captureRequired && !demoAttempt && (!recordingActive || Boolean(recordingError)))) return;
    oralSubmission.current = null;
    void handleNext();
  }, [answer, questionNumber, submitting, assisting, speechBusy, questionAudioBusy, interruptedRecording,
      demoAttempt, captureRequired, recordingActive, recordingError, handleNext]);

  useEffect(() => { setVoiceNotice(""); setQuestionTextShown(false); }, [questionNumber]);

  useEffect(() => {
    if (!avatarOn || !sessionId) return;
    const controller = new AbortController();
    let url = "";
    void fetchExaminerPoster(sessionId, sessionToken.current, controller.signal).then(value => { url = value; setPoster(value); });
    return () => { controller.abort(); if (url) URL.revokeObjectURL(url); };
  }, [avatarOn, sessionId]);

  useEffect(() => {
    if (interruptedRecording || !expired || loading || showConfirmation || submitting || assisting || speechBusy || questionAudioBusy || !sessionId
        || automaticSubmission.current === questionNumber) return;
    automaticSubmission.current = questionNumber;
    void handleNext();
  }, [interruptedRecording, expired, loading, showConfirmation, submitting, assisting, speechBusy, questionAudioBusy, sessionId, questionNumber, handleNext]);

  const submitExam = () => {
    // The backend has already ended the session when it returns done: true.
    window.location.href = "/student/exam/submitted";
  };

  if (!environmentPreferences && !sessionId) return <EnvironmentPreview onContinue={setEnvironmentPreferences} />;

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
            exam is in progress. If you consent, the recording and your submitted answers are
            stored on the exam server and made available to the professor who
            owns this exam for later review. The owning professor may also view
            your video live during the active attempt. Saved recordings follow
            this server's configured retention deadline.
          </p>
          <p>
            Recording is optional. You may decline and submit typed answers. Your
            professor will see that no recording was saved. Professor assessment
            requires a completed retained recording under this server's policy.
            During a recorded spoken attempt, a recording interruption ends the attempt
            for professor review; it cannot be resumed.
          </p>
          {recordingNotice?.recording_required && <p>
            Recording retention deadline: <strong>{new Date(recordingNotice.retention_until!).toLocaleString(undefined, { timeZoneName: 'short' })}</strong>.
            Submitted answers and backups have separate retention policies; ask your professor for those policies.
          </p>}
          {!recordingNotice && !noticeError && <p role="status">Checking recording readiness and retention…</p>}
          {noticeError && <div role="alert"><p>{noticeError}</p>
            <button type="button" onClick={() => setNoticeRetry(value => value + 1)}>Retry recording readiness</button></div>}
          <p>Developer demo attempts are not recorded or graded.</p>
          <div className="confirmation-actions">
            <button
              type="button"
              className="confirmation-submit-button"
              disabled={!recordingNotice?.ready}
              onClick={() => {
                setConsentAccepted(true);
                void beginExam();
              }}
            >
              I consent — start recording and exam
            </button>
            <button type="button" className="back-button" onClick={() => {
              setConsentAccepted(true); void beginExam(false);
            }}>Decline recording and use typed answers</button>
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

  const examinerFinished = () => {
    setSpokenFor(questionNumber);
    if (handsFree && !answer.trim() && !submitting) setListenSignal(value => value + 1);
  };
  const toggleHandsFree = (on: boolean) => {
    setHandsFree(on);
    try { localStorage.setItem("oralexam_hands_free", on ? "on" : "off"); } catch { /* per-browser preference only */ }
  };
  const examinerElement = (element: HTMLVideoElement | null) => {
    examinerVideo.current = element;
    if (element) recordingMix.current?.attach(element);
  };
  const examinerSays = (text: string, operationId?: string) => setExaminerSpeech(current => ({ id: (current?.id ?? 0) + 1, text, operationId }));
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
  const endExamButton = <button type="button" className="exam-end-button"
    disabled={submitting || endingExam || interruptedRecording || finalizationPending || (captureRequired && !demoAttempt && !recordingActive)}
    onClick={() => endRequested ? void endExamNow() : setEndConfirmation(true)}>
    {endingExam ? 'Ending exam…' : endRequested ? 'Retry ending exam' : 'End exam'}
  </button>;
  const answerForm = <form className="exam-answer-form" onSubmit={event => { event.preventDefault(); void handleNext(); }} style={{ fontSize: textSize }}>
    <p className="exam-question-number">{sampleQuestion ? "Sample question" : `Question ${questionNumber}`}</p>
    {!avatarOn || spokenFor === questionNumber || questionTextShown
      ? <h2 className="exam-current-question" aria-live="polite">{questionText}</h2>
      : <div className="exam-question-waiting">
          <p>Listen to the examiner. The question appears here once it has been asked.</p>
          <button type="button" className="exam-question-show" onClick={() => setQuestionTextShown(true)}>Show the question now</button>
        </div>}
    {!developerMinimal && (demoAttempt || recordingActive) && <SpeechDraft sessionId={sessionId} token={sessionToken.current}
      sequence={questionNumber} stream={mediaStream.current}
      disabled={endRequested || submitting || assisting || questionAudioBusy || expired || (!demoAttempt && (!recordingActive || Boolean(recordingError)))}
      onBusyChange={setSpeechBusy} onDraftConfirmed={(text, metadata) => {
        setAnswer(text); answerMetadata.current = metadata; answerRequest.current = null; setConfirmedSpeechUsed(true);
      }} />}
    <label className="student-answer-label" htmlFor="student-exam-answer">{demoAttempt ? "Test answer" : "Your answer"}</label>
    <textarea id="student-exam-answer" className="student-answer-input" value={answer}
      onChange={event => { setAnswer(event.target.value); answerRequest.current = null; }} placeholder={demoAttempt ? "Type your test answer here…" : "Type your response…"}
      disabled={endRequested || interruptedRecording || submitting || (expired && !assisting)} />
    {confirmedSpeechUsed && <p role="status">Answer source: reviewed speech draft. Further edits preserve the original draft provenance.{' '}
      <button type="button" disabled={submitting || expired} onClick={() => {
        answerMetadata.current = { input_source: 'typed' }; answerRequest.current = null; setConfirmedSpeechUsed(false);
      }}>Use typed answer</button></p>}
    {avatarOn && <AnswerRecorder sessionId={sessionId} token={sessionToken.current}
      sharedStream={recordingActive ? mediaStream.current : null}
      disabled={endRequested || submitting || (expired && !assisting)} onRecordingChange={setRecording}
      listenSignal={listenSignal} handsFree={handsFree} onTranscript={heardAnswer} />}
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
    {recordingError && (
      <div role="alert" className="exam-error">
        <p>{recordingError}</p>
        {interruptedRecording ? (
          <>
            <p>The assessed attempt cannot continue safely. Contact your professor. Retrying an upload does not resume the exam.</p>
            {partialRecordingSaved ? <p role="status">The available partial recording was saved for professor review. This does not complete unanswered questions.</p>
              : <button type="button" disabled={savingPartialRecording} onClick={() => void saveInterruptedRecording()}>
                {savingPartialRecording ? 'Saving partial recording…' : 'Save interrupted recording'}
              </button>}
          </>
        ) : finalizationPending ? (
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
    {captureRequired && !demoAttempt && !recordingActive && !showConfirmation && !interruptedRecording && (
      <p role="status">Exam interaction is paused until recording is active.</p>
    )}
    <div className="exam-question-footer">
      {endExamButton}
      <span role="status">
        {submitting ? "Saving response…" : recordingActive ? "Recording video and audio…" : ""}
      </span>
      <button
        type="submit"
        className="exam-next-button"
        disabled={endRequested || (!answer.trim() && !expired) || submitting || assisting || speechBusy || questionAudioBusy
          || (captureRequired && !demoAttempt && (!recordingActive || Boolean(recordingError)))}
      >
        {submitting ? "Saving…" : expired ? "Retry submission →" : demoAttempt ? "Submit test answer →" : "Submit answer →"}
      </button>
    </div>
  </form>;

  return <div className="student-exam-page student-exam-active">
    <header className="student-exam-header">
      <div className="student-exam-logo"><span aria-hidden="true"><OralExamMark size={40} /></span><strong>OralExam AI</strong></div>
      {examTitle && <p className="student-exam-title">{examTitle}</p>}
      <div className="exam-header-controls">
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
      {identityReviewRequired && <p className="exam-identity-notice" role="status">Developer photo-check bypass · identity is unverified and requires professor review.</p>}
      <h1 className="exam-screen-reader">Oral examination · Question {questionNumber}</h1>
      {!interruptedRecording && !developerMinimal && !keyboardMode && <AutomaticOralExam
        sessionId={sessionId} token={sessionToken.current} sequence={questionNumber} question={questionText}
        disabled={endRequested || submitting || expired || (!demoAttempt && (!recordingActive || Boolean(recordingError)))}
        flashhead={avatarOn} poster={poster} stream={recordingActive ? mediaStream.current : null}
        preferences={environmentPreferences} onTiming={updateClock} onMediaElement={examinerElement} onObservation={recordMediaObservation}
        onResumeAudio={() => recordingMix.current?.resume() ?? Promise.resolve()}
        onAnswer={(text, metadata) => {
          if (endRequestedRef.current || recordingInterrupted.current || submittingRequest.current) return;
          answerMetadata.current = metadata; answerRequest.current = null;
          oralSubmission.current = questionNumber; setAnswer(text);
        }} />}
      {!demoAttempt && <details className="exam-response-panel exam-capture-panel">
        <summary>Camera, microphone and live viewing</summary>
        <video muted playsInline autoPlay aria-label="Your camera preview"
          ref={element => { if (element && element.srcObject !== mediaStream.current) element.srcObject = mediaStream.current; }}
          style={{ width: '100%', maxWidth: 320, background: '#172033', borderRadius: 8 }} />
        <p role="status">Recording: {recordingActive ? 'active' : 'inactive'}. Live viewing: {liveStatus}. {liveMessage}</p>
        {timelineWarning && <p role="status">{timelineWarning}</p>}
      </details>}
      {!developerMinimal && !interruptedRecording && <details className="exam-response-panel exam-recovery-panel">
        <summary>Accessibility and recovery</summary>
        <p>The examiner asks, listens, and continues automatically. You can say “repeat the question”, “can you clarify”, or “move on”.
          After two retries without an intelligible response, the examiner moves on and records the question as unanswered.</p>
        <button type="button" disabled={endRequested || submitting || recording || speechBusy || questionAudioBusy || (!demoAttempt && !recordingActive)} onClick={() => setKeyboardMode(value => !value)}>
          {keyboardMode ? 'Return to spoken exam' : 'Use keyboard controls'}
        </button>
      </details>}
      {!keyboardMode && !developerMinimal && !recordingError && <div className="exam-end-actions">{endExamButton}</div>}
      {!keyboardMode && !developerMinimal && error && <div role="alert" className="exam-error">
        <p>{error}</p>{!endRequested && <button type="button" disabled={submitting} onClick={() => void handleNext()}>Retry saving answer</button>}
      </div>}
      {!keyboardMode && !developerMinimal && recordingError && <div role="alert" className="exam-error">
        <p>{recordingError}</p>{answerForm}
      </div>}
      {!interruptedRecording && (keyboardMode || developerMinimal) && <LiveExamPresentation sessionId={sessionId}
        stage={avatarOn ? <AvatarVideoStage sessionId={sessionId} token={sessionToken.current} text={questionText}
          sequence={questionNumber} hold={recording || submitting} onFinished={examinerFinished}
          announce={examinerSpeech} onVideoElement={examinerElement} poster={poster} lead={reaction}
          startDelayMs={questionNumber <= 1 ? 2500 : 700} /> : null}
        examinerSpeaks={avatarOn ? examinerSays : undefined} assistRequest={assistRequest} token={sessionToken.current} question={question}
        developerDemo={demoAttempt} developerMinimal={developerMinimal} settingsTarget={settingsTarget}
        sequence={questionNumber} answer={answer} expired={expired && !assisting} submitting={endRequested || submitting || speechBusy}
        onTiming={updateClock} onBusyChange={setAssisting} onTextSizeChange={setTextSize}
        onQuestionAudioBusy={setQuestionAudioBusy} onMediaObservation={recordMediaObservation} />}
      {(keyboardMode || developerMinimal) && (demoAttempt ? <section className="developer-exam-panel" aria-labelledby="developer-exam-heading">
        <div className="developer-exam-heading"><h2 id="developer-exam-heading">Developer mode</h2><strong className="developer-exam-badge">Test attempt · no grading</strong></div>
        <p className="developer-exam-services">{developerMinimal ? "AI, FlashHead, voice, microphone and camera are off." : "Developer test attempt. Optional service availability follows this server’s configuration."}</p>
        {answerForm}
      </section> : <details className="exam-response-panel" open>
        <summary>Question and answer</summary>
        <p>{avatarOn ? (handsFree
          ? "After the examiner asks, start talking. Pause for 3 seconds when you are finished, check the transcript, then select Submit answer. To hear the question again, say “repeat the question”."
          : "Speak your answer or type it. Check the transcript before you submit.") : "Type an answer or use an available speech draft. Review your answer and submit when ready."}</p>
        {answerForm}
      </details>)}
      <dialog className="exam-end-dialog" ref={endDialog} aria-labelledby="end-exam-title"
        onCancel={event => { if (endingExam) event.preventDefault(); else setEndConfirmation(false); }}>
        <h2 id="end-exam-title">End this exam?</h2>
        <p>Your submitted answers and available recording will be saved for professor review.
          Any answer you are still speaking or typing will not be submitted. You cannot resume this attempt after ending it.</p>
        <p>The exam continues until you confirm.</p>
        <div className="exam-end-dialog-actions">
          <button type="button" autoFocus disabled={endingExam || submitting} onClick={() => setEndConfirmation(false)}>Continue exam</button>
          <button type="button" className="exam-end-button" disabled={endingExam || submitting} onClick={() => void endExamNow()}>
            {endingExam ? 'Ending exam…' : 'End exam and save'}
          </button>
        </div>
      </dialog>
    </main>
  </div>;
}
