import { useCallback, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { createPortal } from "react-dom";
import { Keyboard, Settings } from "lucide-react";
import ExamStageAvatar from "./ExamStageAvatar";
import QuestionAudioPlayer from './QuestionAudioPlayer';
import type { MediaEventKind } from '../media/mediaTimeline';
import type { AIAvatarState } from "../AIAvatar";
import StudentSettingsPanel from "../student-settings/StudentSettingsPanel";
import type { StudentPreferences } from "../student-settings/studentSettings";
import { loadSessionPresentation, saveSessionPresentation } from "./sessionPresentation";
import type { SessionPresentation } from "./sessionPresentation";
import { createExamSpeaker } from "./examSpeech";
import { assistanceActions, loadAssistance, requestAssistance, completeAssistance, pendingAssistanceRequest } from "./sessionAssistance";
import type { AssistanceAction, AssistanceState, PendingAssistanceRequest } from "./sessionAssistance";
import type { ExamTiming } from "../../pages/student/examTiming";
import "./live-exam-presentation.css";

const actionLabels: Record<AssistanceAction, string> = {
  repeat: "Repeat exact question", clarification: "Clarify question wording", hint: "Request hint",
  explanation: "Request explanation", correctness: "Request correctness feedback",
};

export default function LiveExamPresentation({ sessionId, token, question, sequence, answer, expired, submitting,
  developerDemo = false, developerMinimal = false, settingsTarget = null, stage = null, examinerSpeaks, assistRequest = null, onTiming, onBusyChange, onTextSizeChange,
  onQuestionAudioBusy, onMediaObservation,
}: {
  sessionId: string; token: string; question: string; sequence: number; answer: string; expired: boolean; submitting: boolean;
  developerDemo?: boolean;
  developerMinimal?: boolean;
  settingsTarget?: HTMLElement | null;
  /** Replaces the static examiner in the stage, for example the talking avatar video. */
  stage?: ReactNode;
  /** When the talking avatar is on, it speaks questions and assistance instead of browser read-aloud. */
  examinerSpeaks?: (text: string, operationId?: string) => void;
  /** A spoken request ("repeat the question", "can you clarify"); each new id is handled once. */
  assistRequest?: { id: number; action: AssistanceAction } | null;
  onTiming: (timing: ExamTiming) => void; onBusyChange: (busy: boolean) => void; onTextSizeChange: (size: number) => void;
  onQuestionAudioBusy?: (busy: boolean) => void;
  onMediaObservation?: (kind: MediaEventKind, sequence: number, assetId?: string) => Promise<unknown>;
}) {
  const [presentation, setPresentation] = useState<SessionPresentation | null>(null);
  const [preferences, setPreferences] = useState<StudentPreferences | null>(null);
  const [presentationError, setPresentationError] = useState("");
  const [saving, setSaving] = useState(false);
  const [preferenceStatus, setPreferenceStatus] = useState("");
  const [panelOpen, setPanelOpen] = useState(false);
  const [browserReducedMotion, setBrowserReducedMotion] = useState(false);
  const [speechState, setSpeechState] = useState<AIAvatarState>("Idle");
  const [speechError, setSpeechError] = useState("");
  const [speechSupported, setSpeechSupported] = useState(false);
  const [audioEnabled, setAudioEnabled] = useState(false);
  const [savedAudioBusy, setSavedAudioBusy] = useState(false);
  const updateSavedAudioBusy = useCallback((busy: boolean) => {
    setSavedAudioBusy(busy); onQuestionAudioBusy?.(busy);
  }, [onQuestionAudioBusy]);
  const [assistance, setAssistance] = useState<AssistanceState | null>(null);
  const [assistanceBusy, setAssistanceBusy] = useState(false);
  const [assistanceError, setAssistanceError] = useState("");
  const [assistanceText, setAssistanceText] = useState("");
  const [assistanceNotice, setAssistanceNotice] = useState<{ id: number; text: string } | null>(null);
  const speaker = useRef<ReturnType<typeof createExamSpeaker> | null>(null);
  const reading = useRef<{ id: string; sequence: number } | null>(null);
  const retry = useRef<PendingAssistanceRequest | null>(null);
  const preparing = useRef(false);
  const releasing = useRef<string | null>(null);
  const readQuestions = useRef(new Set<number>());
  const preferenceGeneration = useRef(0);
  const questionGeneration = useRef(0);
  const alive = useRef(true);
  const pauseCap = useRef<number | null>(null);
  const launchButton = useRef<HTMLButtonElement>(null);
  const options = useRef<HTMLDetailsElement>(null);
  const latestSpeech = useRef({ presentation, preferences, audioEnabled, speechSupported, developerMinimal, savedAudioBusy });
  latestSpeech.current = { presentation, preferences, audioEnabled, speechSupported, developerMinimal, savedAudioBusy };
  // Short "Repeat used · 1 left" pop-up after an assistance action.
  useEffect(() => {
    if (!assistanceNotice) return;
    const timer = window.setTimeout(() => setAssistanceNotice(null), 4000);
    return () => window.clearTimeout(timer);
  }, [assistanceNotice]);

  useEffect(() => {
    // Reveal recovery/help without closing a disclosure the student opened after reading ends.
    if (options.current && (assistanceBusy || assistanceError || speechError)) options.current.open = true;
  }, [assistanceBusy, assistanceError, speechError]);

  const watchPauseCap = useCallback((state: AssistanceState, request: { id: string; sequence: number }) => {
    if (pauseCap.current !== null) window.clearTimeout(pauseCap.current);
    const check = async () => {
      if (!alive.current || reading.current?.id !== request.id) return;
      speaker.current?.stop(); setSpeechState("Idle");
      try {
        const current = await loadAssistance(sessionId, token, request.sequence);
        if (!alive.current || reading.current?.id !== request.id) return;
        onTiming(current); setAssistance(current);
        const hold = current.pause_until ? Date.parse(current.pause_until) - Date.parse(current.server_now) : 0;
        if (hold > 0) pauseCap.current = window.setTimeout(() => void check(), hold + 50);
        else { reading.current = null; setAssistanceBusy(false); onBusyChange(false); }
      } catch {
        if (alive.current) setAssistanceError("Unable to verify the exam clock. Use Reload assistance or Retry resume before continuing.");
      }
    };
    const hold = state.pause_until ? Math.max(0, Date.parse(state.pause_until) - Date.parse(state.server_now)) : 120000;
    pauseCap.current = window.setTimeout(() => void check(), hold + 50);
  }, [sessionId, token, onTiming, onBusyChange]);

  const finishReading = useCallback(async (expectedId?: string) => {
    const current = reading.current;
    if (!current || (expectedId && current.id !== expectedId) || releasing.current === current.id) return;
    releasing.current = current.id;
    try {
      const result = await completeAssistance(sessionId, token, current.sequence, current.id);
      if (!alive.current || current.sequence !== sequence) return;
      onTiming(result);
      setAssistance(result);
      if (result.status === "reserved") {
        setAssistanceError("Assistance is still being prepared. Retry the request to recover its result.");
        watchPauseCap(result, current); return;
      }
      if (reading.current?.id === current.id) {
        reading.current = null;
        if (pauseCap.current !== null) window.clearTimeout(pauseCap.current);
        setAssistanceBusy(false); onBusyChange(false);
      }
    } catch (failure) {
      if (alive.current) setAssistanceError(`${failure instanceof Error ? failure.message : "Unable to resume the exam clock."} Use Retry resume or Reload assistance.`);
    } finally {
      if (releasing.current === current.id) releasing.current = null;
    }
  }, [sessionId, token, sequence, onTiming, onBusyChange, watchPauseCap]);

  const stopSpeech = useCallback(() => {
    speaker.current?.stop();
    setSpeechState("Idle");
    if (!preparing.current) void finishReading();
  }, [finishReading]);

  useEffect(() => {
    alive.current = true;
    setSpeechSupported(false);
    if (developerMinimal) setAudioEnabled(false);
    if (!developerMinimal && "speechSynthesis" in window && "SpeechSynthesisUtterance" in window) {
      speaker.current = createExamSpeaker(window.speechSynthesis, text => new SpeechSynthesisUtterance(text));
      setSpeechSupported(true);
    }
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setBrowserReducedMotion(query.matches);
    update(); query.addEventListener("change", update);
    return () => {
      alive.current = false;
      speaker.current?.stop();
      speaker.current = null;
      const current = reading.current;
      reading.current = null;
      if (current) void completeAssistance(sessionId, token, current.sequence, current.id).catch(() => undefined);
      if (pauseCap.current !== null) window.clearTimeout(pauseCap.current);
      query.removeEventListener("change", update);
      onBusyChange(false);
    };
  }, [sessionId, token, developerMinimal, onBusyChange]);

  const loadPresentation = useCallback(async (signal?: AbortSignal) => {
    setPresentationError("");
    try {
      const value = await loadSessionPresentation(sessionId, token, signal);
      if (signal?.aborted || !alive.current) return;
      setPresentation(value); setPreferences(value.preferences);
      onTextSizeChange(value.preferences.textSize);
    } catch (failure) {
      if (!signal?.aborted && alive.current) setPresentationError(failure instanceof Error ? failure.message : "Unable to load examiner settings.");
    }
  }, [sessionId, token, onTextSizeChange]);
  useEffect(() => {
    const controller = new AbortController();
    void loadPresentation(controller.signal);
    return () => controller.abort();
  }, [loadPresentation]);

  const reloadAssistance = useCallback(async (signal?: AbortSignal) => {
    if (developerMinimal) return;
    setAssistanceError("");
    try {
      const value = await loadAssistance(sessionId, token, sequence, signal);
      if (signal?.aborted || !alive.current) return;
      setAssistance(value); onTiming(value);
      if (value.active_request_id) {
        const current = { id: value.active_request_id, sequence };
        reading.current = current; setAssistanceBusy(true); onBusyChange(true); watchPauseCap(value, current);
        // Reloading starts no old audio. Release its server-tracked reading pause.
        if (!preparing.current) await finishReading(current.id);
      } else if (!preparing.current) {
        reading.current = null; setAssistanceBusy(false); onBusyChange(false);
      }
    } catch (failure) {
      if (!signal?.aborted && alive.current) setAssistanceError(failure instanceof Error ? failure.message : "Unable to load assistance allowances.");
    }
  }, [sessionId, token, sequence, developerMinimal, onTiming, onBusyChange, finishReading, watchPauseCap]);
  useEffect(() => {
    questionGeneration.current += 1;
    speaker.current?.stop(); setSpeechState("Idle"); setSpeechError("");
    setAssistance(null); setAssistanceText(""); setAssistanceError("");
    retry.current = null; reading.current = null; preparing.current = false;
    setAssistanceBusy(false); onBusyChange(false);
    const controller = new AbortController();
    void reloadAssistance(controller.signal);
    return () => controller.abort();
  }, [reloadAssistance, onBusyChange]);

  const speak = useCallback((text: string, after?: () => void) => {
    const current = latestSpeech.current;
    if (current.developerMinimal || current.savedAudioBusy || !speaker.current || !current.presentation || !current.preferences || current.preferences.volume === 0) { after?.(); return; }
    setSpeechError("");
    try {
      speaker.current.speak(text, current.presentation.voice_profile, current.preferences.speed, current.preferences.volume,
        state => { setSpeechState(state); if (state === "Idle") after?.(); },
        message => { setSpeechError(message); after?.(); });
    } catch (failure) {
      setSpeechState("Error"); setSpeechError(failure instanceof Error ? failure.message : "Question audio is unavailable."); after?.();
    }
  }, []);

  useEffect(() => {
    if (developerMinimal || !audioEnabled || savedAudioBusy || !presentation || !preferences || preferences.volume === 0 || expired || submitting || assistanceBusy || readQuestions.current.has(sequence)) return;
    readQuestions.current.add(sequence);
    speak(question);
  }, [developerMinimal, audioEnabled, savedAudioBusy, presentation, preferences, expired, submitting, assistanceBusy, sequence, question, speak]);
  useEffect(() => { if ((expired || submitting) && !assistanceBusy) stopSpeech(); }, [expired, submitting, assistanceBusy, stopSpeech]);

  const updatePreferences = (next: StudentPreferences) => {
    preferenceGeneration.current += 1;
    latestSpeech.current.preferences = next;
    if (next.volume !== preferences?.volume || next.speed !== preferences?.speed) stopSpeech();
    setPreferences(next); setPreferenceStatus(""); onTextSizeChange(next.textSize);
  };
  const savePreferences = async () => {
    if (!preferences || saving) return;
    setSaving(true); setPresentationError("");
    const generation = preferenceGeneration.current;
    try {
      const next = await saveSessionPresentation(sessionId, token, preferences);
      if (!alive.current) return;
      setPresentation(next);
      if (generation === preferenceGeneration.current) setPreferences(next.preferences);
      setPreferenceStatus("Preferences saved for this attempt. Exam rules and assistance usage are unchanged.");
    } catch (failure) { if (alive.current) setPresentationError(failure instanceof Error ? failure.message : "Unable to save preferences."); }
    finally { if (alive.current) setSaving(false); }
  };

  async function ask(action: AssistanceAction) {
    if (developerMinimal || savedAudioBusy) return;
    const allowed = assistance?.actions[action];
    const recovering = retry.current?.action === action && retry.current.sequence === sequence;
    if ((!allowed && !recovering) || (allowed?.remaining === 0 && !recovering) ||
        (expired && !recovering) || submitting || preparing.current || (assistanceBusy && !recovering)) return;
    preparing.current = true;
    stopSpeech(); setAssistanceBusy(true); onBusyChange(true); setAssistanceError(""); setAssistanceText("");
    const generation = questionGeneration.current;
    const request = pendingAssistanceRequest(retry.current, sequence, action, answer, () => crypto.randomUUID());
    retry.current = request;
    reading.current = { id: request.id, sequence };
    try {
      const result = await requestAssistance(sessionId, token, sequence, action, request.id, request.answer);
      if (!alive.current || generation !== questionGeneration.current) {
        // A mode/question change can happen while a reserved request is preparing.
        // Its eventual response must release its old pause without updating this UI.
        if (result.status !== "reserved") void completeAssistance(sessionId, token, sequence, request.id).catch(() => undefined);
        return;
      }
      onTiming(result); setAssistance(result);
      watchPauseCap(result, request);
      preparing.current = false;
      if (result.status !== "succeeded" || !result.text) {
        if (result.status === "failed") retry.current = null;
        setAssistanceError(result.status === "reserved" ? "Assistance is still being prepared. Retry this request to recover its result." : "Assistance is unavailable. You can try the action again.");
        await finishReading(request.id); return;
      }
      retry.current = null; setAssistanceText(result.text);
      const used = result.actions[action];
      setAssistanceNotice(current => ({ id: (current?.id ?? 0) + 1,
        text: `${actionLabels[action]} used${used ? ` · ${used.remaining} left` : ""}` }));
      if (examinerSpeaks) { examinerSpeaks(result.text, request.id); await finishReading(request.id); return; }
      const currentSpeech = latestSpeech.current;
      if (!currentSpeech.developerMinimal && currentSpeech.audioEnabled && currentSpeech.speechSupported && currentSpeech.preferences && currentSpeech.preferences.volume > 0) speak(result.text, () => void finishReading(request.id));
      else await finishReading(request.id);
    } catch (failure) {
      if (!alive.current || generation !== questionGeneration.current) return;
      preparing.current = false;
      await reloadAssistance();
      if (alive.current && generation === questionGeneration.current) setAssistanceError(`${failure instanceof Error ? failure.message : "Unable to request assistance."} Retry the same assistance request to recover its result.`);
    } finally {
      if (generation === questionGeneration.current) preparing.current = false;
    }
  }

  useEffect(() => {
    if (!assistRequest) return;
    const allowance = assistance?.actions[assistRequest.action];
    if (!allowance && assistRequest.action === "repeat" && examinerSpeaks) {
      // This exam sets no repeat limit: replay the question freely.
      examinerSpeaks(question);
      return;
    }
    if (!allowance || allowance.remaining === 0) {
      setAssistanceNotice(current => ({ id: (current?.id ?? 0) + 1,
        text: allowance ? `No ${assistRequest.action === "repeat" ? "repeats" : "clarifications"} left for this question`
          : `${actionLabels[assistRequest.action]} is not available for this exam` }));
      return;
    }
    void ask(assistRequest.action);
  // A new request id is the only trigger; ask() reads the latest state itself.
  }, [assistRequest?.id]);

  const settingsButton = <button type="button" className="live-exam-settings-launch" ref={launchButton}
    disabled={!presentation || !preferences} onClick={() => setPanelOpen(true)}><Settings size={22} aria-hidden="true" />Student settings</button>;
  const settingsAccess = settingsTarget ? createPortal(settingsButton, settingsTarget) : <div className="live-exam-settings-access">{settingsButton}</div>;

  if (!presentation || !preferences) return <section className="live-exam-presentation" aria-label="Examiner">
    {settingsAccess}
    <div className="exam-avatar-stage">
      {stage ?? <ExamStageAvatar state={presentationError ? "Error" : "Thinking"} reducedMotion developerMinimal={developerMinimal} />}
    </div>
    <p className="live-exam-load-status" role={presentationError ? "alert" : "status"}>{presentationError || "Loading your examiner settings..."}</p>
    {presentationError && <button type="button" onClick={() => void loadPresentation()}>Reload examiner settings</button>}
  </section>;

  const reducedMotion = browserReducedMotion || preferences.reducedMotion || presentation.policy.defaults.reducedMotion;
  const state = developerMinimal ? "Idle" : submitting || (assistanceBusy && speechState !== "Speaking") ? "Thinking" : speechState;
  const status = developerMinimal ? "Typed answer mode" : submitting ? "Submitting answer" : speechState === "Speaking"
    ? "Reading aloud" : assistanceBusy ? "Preparing assistance" : expired ? "Answering window ended" : "Ready for your answer";
  return <section className={`live-exam-presentation${developerMinimal ? " live-exam-presentation-minimal" : ""}`} aria-label="Examiner and assistance" style={{ fontSize: preferences.textSize }}>
    {settingsAccess}
    <div className="exam-avatar-stage">
      <ExamStageAvatar avatar={preferences.avatar} background={preferences.background}
        customAvatar={presentation.policy.defaults.customAvatar} customBackground={presentation.policy.defaults.customBackground}
        animation={!developerMinimal && presentation.policy.defaults.animation} reducedMotion={developerMinimal || reducedMotion}
        state={state} developerMinimal={developerMinimal}>{stage}</ExamStageAvatar>
      <p className="live-exam-stage-status" role="status">{developerMinimal ? <Keyboard size={24} aria-hidden="true" /> : <span aria-hidden="true" />}{status}</p>
    </div>
    {assistanceNotice && <div className="live-exam-assist-toast" role="status" key={assistanceNotice.id}>{assistanceNotice.text}</div>}
    {!developerMinimal && <details className="live-exam-options" ref={options}>
      <summary>Examiner controls and assistance</summary>
      <div className="live-exam-options-content">
        <p>{examinerSpeaks
          ? "The examiner reads each question aloud. To hear it again, say “repeat the question”, or use the buttons below."
          : "Use the question and typed answer below. Optional read-aloud uses your browser's standard English voice; microphone capture is not connected."}</p>
        {!developerDemo && <QuestionAudioPlayer key={`${sessionId}:${sequence}:${preferences.speed}`}
          sessionId={sessionId} token={token} sequence={sequence} speed={preferences.speed} volume={preferences.volume}
          disabled={expired || submitting || assistanceBusy} onBusy={updateSavedAudioBusy} onState={setSpeechState}
          beforePlay={() => { stopSpeech(); readQuestions.current.add(sequence); latestSpeech.current.audioEnabled = false; setAudioEnabled(false); }}
          onObservation={onMediaObservation} />}
        <div className="live-exam-controls">
          {speechSupported && !examinerSpeaks && <button type="button" disabled={expired || submitting || savedAudioBusy || assistanceBusy || preferences.volume === 0} onClick={() => {
            latestSpeech.current.audioEnabled = true; setAudioEnabled(true); readQuestions.current.add(sequence); speak(question);
          }}>Read question aloud</button>}
          {!savedAudioBusy && (speechState === "Speaking" || (assistanceBusy && assistanceText)) && <button type="button" onClick={stopSpeech}>Stop reading</button>}
          {speechError && speechSupported && !assistanceBusy && <button type="button" disabled={expired || submitting || savedAudioBusy || preferences.volume === 0} onClick={() => speak(question)}>Retry question audio</button>}
        </div>
        {preferences.volume === 0 && !examinerSpeaks && <p>Question audio is muted. Change volume in Student settings to use read-aloud.</p>}
        {!speechSupported && !examinerSpeaks && <p>Speech is unavailable in this browser. All questions and assistance remain readable.</p>}
        {speechError && <p role="alert">{speechError}</p>}
        {developerDemo && <p className="developer-demo-note">Demo media: the on-screen examiner works without an external avatar service. If browser speech is unavailable, use the readable question and assistance text. No voice cloning or video recording is simulated.</p>}
        <small>Saved examiner policy revision {presentation.revision}{assistance ? ` · ${assistance.mode} rules` : ""}{developerDemo ? " · demo attempt" : ""}</small>
        {assistance && Object.keys(assistance.actions).length > 0 && <section className="live-exam-assistance" aria-labelledby="live-assistance-heading">
          <h2 id="live-assistance-heading">Question assistance</h2>
          <p>{examinerSpeaks ? "You can also ask out loud, for example “repeat the question” or “can you clarify”. " : ""}
            Allowances apply to each question. Preference changes and reloads do not restore uses.</p>
          {assistanceActions.filter(action => assistance.actions[action]).map(action => {
            const allowance = assistance.actions[action]!;
            return <div className="live-exam-assistance-item" key={action}>
              <div><strong>{actionLabels[action]}</strong><span id={`live-assistance-${action}-remaining`} aria-live="polite">{allowance.remaining} of {allowance.limit} remaining</span></div>
              <button type="button" disabled={allowance.remaining === 0 || expired || submitting || savedAudioBusy || assistanceBusy || (action === "correctness" && !answer.trim())}
                aria-describedby={`live-assistance-${action}-remaining`}
                onClick={() => void ask(action)}>{actionLabels[action]}</button>
            </div>;
          })}
          {assistanceBusy && <p role="status">{assistanceText ? "Reading assistance…" : "Preparing assistance…"}</p>}
          {assistanceText && <div className="live-exam-assistance-text" role="status">{assistanceText}</div>}
        </section>}
        {assistanceError && <p role="alert">{assistanceError}</p>}
        <div className="live-exam-controls">
          {assistanceError && <button type="button" disabled={preparing.current || submitting} onClick={() => void reloadAssistance()}>Retry loading assistance</button>}
          {retry.current && <button type="button" disabled={preparing.current || submitting} onClick={() => void ask(retry.current!.action)}>Retry assistance request</button>}
          {reading.current && !preparing.current && <button type="button" disabled={!!releasing.current} onClick={() => { speaker.current?.stop(); setSpeechState("Idle"); void finishReading(reading.current?.id); }}>Retry resume</button>}
        </div>
      </div>
    </details>}
    <StudentSettingsPanel open={panelOpen} policy={presentation.policy} preferences={preferences}
      onChange={updatePreferences} onClose={() => { setPanelOpen(false); launchButton.current?.focus(); }}
      onSave={() => void savePreferences()} onReset={() => {
        const defaults = presentation.policy.defaults;
        updatePreferences({ volume: 70, textSize: 16, reducedMotion: defaults.reducedMotion, avatar: defaults.avatar, background: defaults.background, speed: defaults.speed });
        setPreferenceStatus("Defaults restored. Save to keep them for this attempt.");
      }} dirty={JSON.stringify(preferences) !== JSON.stringify(presentation.preferences)} status={preferenceStatus}
      error={presentationError} browserReducedMotion={browserReducedMotion} persistence="session" saving={saving} />
  </section>;
}
