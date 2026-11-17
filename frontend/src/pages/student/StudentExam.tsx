import { useCallback, useEffect, useRef, useState } from "react";
import { formatRemaining, readExamClock, remainingTime } from "./examTiming";
import type { ExamClock, ExamTiming, RemainingTime } from "./examTiming";
import LiveExamPresentation from "../../components/avatar/LiveExamPresentation";
import SpeechDraft from "../../components/exam/SpeechDraftPanel";
import EnvironmentPreview from "../../components/avatar/EnvironmentPreview";
import type { StudentPreferences } from "../../components/student-settings/studentSettings";
import { pendingAnswer, type PendingAnswer, type AnswerMetadata } from "./answerSubmission";
import { createLiveVideo, type LiveVideoState } from "../../components/media/liveVideo";
import { createMediaTimeline, type MediaEventKind } from '../../components/media/mediaTimeline';
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
    const recorder = new MediaRecorder(stream, {
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
    } finally { releaseRecordingDevices(); }
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
    let startedAttempt: StartResponse | null = null;
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
      if (!mounted.current) throw new Error('Exam startup was cancelled when leaving the page.');
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
        if (!mounted.current) throw new Error('Exam startup was cancelled when leaving the page.');
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
        if (!mounted.current) throw new Error('Exam startup was cancelled when leaving the page.');
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
      if (mediaRecorder.current?.state === 'recording') {
        interruptRecording('The recording was interrupted when leaving the attempt.');
      }
      releaseRecordingDevices();
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

  const handleNext = useCallback(async () => {
    const current = clock.current ? remainingTime(clock.current, performance.now()) : remaining;
    const timedOut = current.exam === 0 || current.question === 0;
    if (recordingInterrupted.current || !sessionId || (!answer.trim() && !timedOut) || submittingRequest.current
        || assisting || speechBusy || questionAudioBusy || (!demoAttempt && (!recordingActive || Boolean(recordingError)))) return;

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
    recordingError,
    finalizeCompletedExam,
  ]);

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
            exam is in progress. The recording and your submitted answers are
            stored on the exam server and made available to the professor who
            owns this exam for later review. The owning professor may also view
            your video live during the active attempt. Saved recordings follow
            this server's configured retention deadline.
          </p>
          <p>
            Camera, microphone, and server storage must remain available for
            the full exam. If recording cannot be started or saved, the exam
            cannot proceed or be submitted.
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
    {!developerMinimal && <SpeechDraft sessionId={sessionId} token={sessionToken.current}
      sequence={questionNumber} stream={mediaStream.current}
      disabled={submitting || assisting || questionAudioBusy || expired || (!demoAttempt && (!recordingActive || Boolean(recordingError)))}
      onBusyChange={setSpeechBusy} onDraftConfirmed={(text, metadata) => {
        setAnswer(text); answerMetadata.current = metadata; answerRequest.current = null; setConfirmedSpeechUsed(true);
      }} />}
    <label className="student-answer-label" htmlFor="student-exam-answer">{demoAttempt ? "Test answer" : "Your answer"}</label>
    <textarea id="student-exam-answer" className="student-answer-input" value={answer}
      onChange={event => { setAnswer(event.target.value); answerRequest.current = null; }} placeholder={demoAttempt ? "Type your test answer here…" : "Type your response…"}
      disabled={interruptedRecording || submitting || (expired && !assisting)} />
    {confirmedSpeechUsed && <p role="status">Answer source: reviewed speech draft. Further edits preserve the original draft provenance.{' '}
      <button type="button" disabled={submitting || expired} onClick={() => {
        answerMetadata.current = { input_source: 'typed' }; answerRequest.current = null; setConfirmedSpeechUsed(false);
      }}>Use typed answer</button></p>}
    {expired && !assisting && !interruptedRecording && <p role="status">{remaining.exam === 0
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
    {!demoAttempt && !recordingActive && !showConfirmation && !interruptedRecording && (
      <p role="status">Exam interaction is paused until recording is active.</p>
    )}
    <div className="exam-question-footer">
      <span role="status">
        {submitting ? "Saving response…" : recordingActive ? "Recording video and audio…" : ""}
      </span>
      <button
        type="submit"
        className="exam-next-button"
        disabled={(!answer.trim() && !expired) || submitting || assisting || speechBusy || questionAudioBusy
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
      {!demoAttempt && <details className="exam-response-panel">
        <summary>Camera, microphone and live viewing</summary>
        <video muted playsInline autoPlay aria-label="Your camera preview"
          ref={element => { if (element && element.srcObject !== mediaStream.current) element.srcObject = mediaStream.current; }}
          style={{ width: '100%', maxWidth: 320, background: '#172033', borderRadius: 8 }} />
        <p role="status">Recording: {recordingActive ? 'active' : 'inactive'}. Live viewing: {liveStatus}. {liveMessage}</p>
        {timelineWarning && <p role="status">{timelineWarning}</p>}
      </details>}
      {!interruptedRecording && <LiveExamPresentation sessionId={sessionId} token={sessionToken.current} question={question}
        developerDemo={demoAttempt} developerMinimal={developerMinimal} settingsTarget={settingsTarget}
        sequence={questionNumber} answer={answer} expired={expired && !assisting} submitting={submitting || speechBusy}
        onTiming={updateClock} onBusyChange={setAssisting} onTextSizeChange={setTextSize}
        onQuestionAudioBusy={setQuestionAudioBusy} onMediaObservation={recordMediaObservation} />}
      {demoAttempt ? <section className="developer-exam-panel" aria-labelledby="developer-exam-heading">
        <div className="developer-exam-heading"><h2 id="developer-exam-heading">Developer mode</h2><strong className="developer-exam-badge">Test attempt · no grading</strong></div>
        <p className="developer-exam-services">{developerMinimal ? "AI, FlashHead, voice, microphone and camera are off." : "Developer test attempt. Optional service availability follows this server’s configuration."}</p>
        {answerForm}
      </section> : <details className="exam-response-panel" open>
        <summary>Question and answer</summary>
        <p>Type an answer or use an available speech draft. Review your answer and submit when ready.</p>
        {answerForm}
      </details>}
    </main>
  </div>;
}
