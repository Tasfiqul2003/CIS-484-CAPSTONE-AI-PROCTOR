import { useCallback, useEffect, useRef, useState } from "react";
import AIAvatar from "../AIAvatar";
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
  onTiming, onBusyChange, onTextSizeChange,
}: {
  sessionId: string; token: string; question: string; sequence: number; answer: string; expired: boolean; submitting: boolean;
  onTiming: (timing: ExamTiming) => void; onBusyChange: (busy: boolean) => void; onTextSizeChange: (size: number) => void;
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
  const [assistance, setAssistance] = useState<AssistanceState | null>(null);
  const [assistanceBusy, setAssistanceBusy] = useState(false);
  const [assistanceError, setAssistanceError] = useState("");
  const [assistanceText, setAssistanceText] = useState("");
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
  const latestSpeech = useRef({ presentation, preferences, audioEnabled, speechSupported });
  latestSpeech.current = { presentation, preferences, audioEnabled, speechSupported };

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
    if ("speechSynthesis" in window && "SpeechSynthesisUtterance" in window) {
      speaker.current = createExamSpeaker(window.speechSynthesis, text => new SpeechSynthesisUtterance(text));
      setSpeechSupported(true);
    }
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setBrowserReducedMotion(query.matches);
    update(); query.addEventListener("change", update);
    return () => {
      alive.current = false;
      speaker.current?.stop();
      const current = reading.current;
      reading.current = null;
      if (current) void completeAssistance(sessionId, token, current.sequence, current.id).catch(() => undefined);
      if (pauseCap.current !== null) window.clearTimeout(pauseCap.current);
      query.removeEventListener("change", update);
      onBusyChange(false);
    };
  }, [sessionId, token, onBusyChange]);

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
  }, [sessionId, token, sequence, onTiming, onBusyChange, finishReading, watchPauseCap]);
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
    if (!speaker.current || !current.presentation || !current.preferences || current.preferences.volume === 0) { after?.(); return; }
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
    if (!audioEnabled || !presentation || !preferences || preferences.volume === 0 || expired || submitting || assistanceBusy || readQuestions.current.has(sequence)) return;
    readQuestions.current.add(sequence);
    speak(question);
  }, [audioEnabled, presentation, preferences, expired, submitting, assistanceBusy, sequence, question, speak]);
  useEffect(() => { if ((expired || submitting) && !assistanceBusy) stopSpeech(); }, [expired, submitting, assistanceBusy, stopSpeech]);

  const updatePreferences = (next: StudentPreferences) => {
    preferenceGeneration.current += 1;
    latestSpeech.current.preferences = next;
    stopSpeech(); setPreferences(next); setPreferenceStatus(""); onTextSizeChange(next.textSize);
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
      if (!alive.current || generation !== questionGeneration.current) return;
      onTiming(result); setAssistance(result);
      watchPauseCap(result, request);
      preparing.current = false;
      if (result.status !== "succeeded" || !result.text) {
        if (result.status === "failed") retry.current = null;
        setAssistanceError(result.status === "reserved" ? "Assistance is still being prepared. Retry this request to recover its result." : "Assistance is unavailable. You can try the action again.");
        await finishReading(request.id); return;
      }
      retry.current = null; setAssistanceText(result.text);
      const currentSpeech = latestSpeech.current;
      if (currentSpeech.audioEnabled && currentSpeech.speechSupported && currentSpeech.preferences && currentSpeech.preferences.volume > 0) speak(result.text, () => void finishReading(request.id));
      else await finishReading(request.id);
    } catch (failure) {
      preparing.current = false;
      await reloadAssistance();
      if (alive.current && generation === questionGeneration.current) setAssistanceError(`${failure instanceof Error ? failure.message : "Unable to request assistance."} Retry the same assistance request to recover its result.`);
    } finally {
      if (generation === questionGeneration.current) preparing.current = false;
    }
  }

  if (!presentation || !preferences) return <section className="live-exam-presentation" aria-label="Examiner">
    <AIAvatar state={presentationError ? "Error" : "Thinking"} reducedMotion />
    <p role={presentationError ? "alert" : "status"}>{presentationError || "Loading your examiner settings..."}</p>
    {presentationError && <button type="button" onClick={() => void loadPresentation()}>Reload examiner settings</button>}
  </section>;

  const reducedMotion = browserReducedMotion || preferences.reducedMotion || presentation.policy.defaults.reducedMotion;
  const state = submitting || (assistanceBusy && speechState !== "Speaking") ? "Thinking" : speechState;
  return <section className="live-exam-presentation" aria-label="Examiner and assistance" style={{ fontSize: preferences.textSize }}>
    <div className="live-exam-avatar-row">
      <AIAvatar avatar={preferences.avatar} background={preferences.background}
        customAvatar={presentation.policy.defaults.customAvatar} customBackground={presentation.policy.defaults.customBackground}
        animation={presentation.policy.defaults.animation} reducedMotion={reducedMotion} state={state} />
      <div>
        <strong>OralExam AI</strong>
        <p>Read the question or enable the browser's standard English voice.</p>
        <div className="live-exam-controls">
          <button type="button" ref={launchButton} onClick={() => setPanelOpen(true)}>Student settings</button>
          {speechSupported && <button type="button" disabled={expired || submitting || assistanceBusy} onClick={() => {
            if (audioEnabled) { latestSpeech.current.audioEnabled = false; setAudioEnabled(false); stopSpeech(); }
            else { latestSpeech.current.audioEnabled = true; setAudioEnabled(true); if (preferences.volume > 0 && !readQuestions.current.has(sequence)) { readQuestions.current.add(sequence); speak(question); } }
          }}>{audioEnabled ? "Disable question audio" : "Enable question audio"}</button>}
          {(speechState === "Speaking" || (assistanceBusy && assistanceText)) && <button type="button" onClick={stopSpeech}>Stop reading</button>}
          {speechError && speechSupported && !assistanceBusy && <button type="button" disabled={expired || submitting} onClick={() => speak(question)}>Retry question audio</button>}
        </div>
        {!speechSupported && <p>Speech is unavailable in this browser. All questions and assistance remain readable.</p>}
        {speechError && <p role="alert">{speechError}</p>}
        <small>Saved examiner policy revision {presentation.revision}{assistance ? ` · ${assistance.mode} exam` : ""}</small>
      </div>
    </div>
    {assistance && Object.keys(assistance.actions).length > 0 && <section className="live-exam-assistance" aria-labelledby="live-assistance-heading">
      <h2 id="live-assistance-heading">Question assistance</h2>
      <p>Allowances apply to this question. Preference changes and reloads do not restore uses.</p>
      {assistanceActions.filter(action => assistance.actions[action]).map(action => {
        const allowance = assistance.actions[action]!;
        return <div className="live-exam-assistance-item" key={action}>
          <div><strong>{actionLabels[action]}</strong><span>{allowance.remaining} of {allowance.limit} remaining</span></div>
          <button type="button" disabled={allowance.remaining === 0 || expired || submitting || assistanceBusy || (action === "correctness" && !answer.trim())}
            onClick={() => void ask(action)}>{actionLabels[action]}</button>
        </div>;
      })}
      {assistanceBusy && <p role="status">{assistanceText ? "Reading assistance. Select Stop reading to continue." : "Preparing assistance..."}</p>}
      {assistanceText && <div className="live-exam-assistance-text" role="status">{assistanceText}</div>}
    </section>}
    {assistanceError && <p role="alert">{assistanceError}</p>}
    <div className="live-exam-controls">
      <button type="button" disabled={preparing.current || submitting} onClick={() => void reloadAssistance()}>Reload assistance</button>
      {retry.current && <button type="button" disabled={preparing.current || submitting} onClick={() => void ask(retry.current!.action)}>Retry assistance request</button>}
      {reading.current && !preparing.current && <button type="button" disabled={!!releasing.current} onClick={() => { speaker.current?.stop(); setSpeechState("Idle"); void finishReading(reading.current?.id); }}>Retry resume</button>}
    </div>
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
