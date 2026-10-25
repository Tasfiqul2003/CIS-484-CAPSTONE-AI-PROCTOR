import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import StudentSettingsPanel from "../../components/student-settings/StudentSettingsPanel";
import {
  createPreferenceStore,
  defaultPreferences,
  getDemoPolicy,
  reconcilePreferences,
  type StudentAction,
  type StudentPreferences,
  type StudentPolicy,
} from "../../components/student-settings/studentSettings";
import { createLocalExamPolicyStore, loadExamPolicy, snapshotPolicy, toStudentPolicy, type ExamPolicy } from "../../components/avatar/examPolicy";
import "./StudentSettingsPreview.css";
import OralExamMark from "../../components/brand/OralExamMark";

const EXAM_ID = "synthetic-settings-exam";
const STUDENT_ID = "synthetic-settings-student";
const QUESTION = "What is one benefit of separating data from presentation?";
const ACTIONS: { id: StudentAction; label: string; description: string; response: string }[] = [
  { id: "repeat", label: "Repeat exact question", description: "Read the same question again without adding information.", response: QUESTION },
  { id: "clarification", label: "Clarify question wording", description: "Reword the question without providing an answer.", response: "Name one advantage of keeping application data separate from the way it is displayed." },
  { id: "hint", label: "Request hint", description: "Use the sample practice hint when you need a cue.", response: "Sample hint: Think about changing an application's layout while keeping its information the same." },
  { id: "explanation", label: "Request explanation", description: "Review a sample explanation of the concept.", response: "Sample explanation: The same information can appear in a table or a card without changing the stored data." },
  { id: "correctness", label: "Request correctness feedback", description: "Request sample practice feedback.", response: "This preview does not evaluate your response or assign a grade." },
];

function newAttempt() {
  // These counters belong only to the synthetic preview, never to saved preferences.
  return {
    counts: { repeat: 0, clarification: 0, hint: 0, explanation: 0, correctness: 0 } as Record<StudentAction, number>,
    state: "Idle",
    response: null as { label: string; text: string } | null,
  };
}

export default function StudentSettingsPreview() {
  const [configuration] = useState(() => {
    // Query parameters select an instructor demonstration; they do not authorize student access.
    const query = new URLSearchParams(window.location.search);
    const source = query.get("policySource");
    const examId = query.get("examId") ?? "";
    const instructorId = query.get("instructorId") ?? "";
    const mode = query.get("mode") ?? "practice";
    const connected = source !== null || query.has("examId");
    const valid = !connected || ((source === "local" || source === "server") && examId.trim().length > 0 && examId.length <= 200 && (source !== "local" || (instructorId.trim().length > 0 && instructorId.length <= 200)) && (mode === "practice" || mode === "assessed"));
    return { source, examId, instructorId, connected, valid, mode: mode as "practice" | "assessed" };
  });
  const [demoPolicy] = useState(getDemoPolicy);
  const [record, setRecord] = useState<ExamPolicy | null>(null);
  const activeRevision = useRef(0);
  const [pendingRevision, setPendingRevision] = useState<number | null>(null);
  const [loadError, setLoadError] = useState("");
  const [loading, setLoading] = useState(configuration.connected);
  const readPolicy = useCallback(async (signal?: AbortSignal) => {
    if (!configuration.valid) throw new Error("The policy preview link is invalid. Open a preview link from Manage Exam.");
    const next = configuration.source === "server" ? await loadExamPolicy(configuration.examId, signal) : createLocalExamPolicyStore().load(configuration.examId, configuration.instructorId);
    if (!next) throw new Error("No shared preview policy was found for this exam and instructor. Use Share Preview Policy in Manage Exam first.");
    return snapshotPolicy(next);
  }, [configuration]);
  const beginPreview = useCallback(async () => {
    try {
      const next = await readPolicy();
      activeRevision.current = next.revision;
      setRecord(next);
      setPendingRevision(null);
      setLoadError("");
      return toStudentPolicy(next.settings, configuration.mode);
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : "Unable to load exam policy.");
      throw error;
    }
  }, [configuration.mode, readPolicy]);
  useEffect(() => {
    if (!configuration.connected) return;
    const controller = new AbortController();
    readPolicy(controller.signal).then(next => {
      if (!controller.signal.aborted) { activeRevision.current = next.revision; setRecord(next); setLoadError(""); }
    }).catch(error => {
      if (!controller.signal.aborted) setLoadError(error instanceof Error ? error.message : "Unable to load exam policy.");
    }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [configuration.connected, readPolicy]);
  const checkForUpdate = useCallback(async () => {
    if (!record) return;
    try {
      const next = await readPolicy();
      // Announce newer rules without replacing the active snapshot until Restart preview.
      setPendingRevision(next.revision > activeRevision.current ? next.revision : null);
      setLoadError("");
    } catch (error) { setLoadError(error instanceof Error ? error.message : "Unable to check for updated permissions. The active preview keeps its starting policy."); }
  }, [readPolicy, record]);
  useEffect(() => {
    if (!configuration.connected || !record) return;
    const check = () => { void checkForUpdate(); };
    window.addEventListener("focus", check);
    window.addEventListener("storage", check);
    return () => { window.removeEventListener("focus", check); window.removeEventListener("storage", check); };
  }, [configuration.connected, record, checkForUpdate]);
  const policy = useMemo(() => record ? toStudentPolicy(record.settings, configuration.mode) : demoPolicy, [record, configuration.mode, demoPolicy]);
  const retry = async () => {
    if (record) { await checkForUpdate(); return; }
    setLoading(true);
    try { await beginPreview(); } catch { /* Error is displayed below. */ }
    finally { setLoading(false); }
  };
  // A failed connected preview must show its error rather than silently use sample permissions.
  if (configuration.connected && !record) return <div className="student-settings-preview-page"><main className="student-settings-preview-content">
    <h1>Student settings preview</h1>
    {loading ? <p role="status">Loading exam policy…</p> : <><p className="student-policy-error" role="alert">{loadError}</p><button type="button" onClick={() => void retry()}>Retry policy load</button></>}
    <p><a href="/student/exams">Back to Exams</a></p>
  </main></div>;
  return <StudentPreview policy={policy} preferenceExamId={configuration.connected ? JSON.stringify([configuration.source, configuration.examId, configuration.source === "local" ? configuration.instructorId : "server"]) : EXAM_ID} onRestart={configuration.connected ? beginPreview : undefined} policyNotice={configuration.connected && <>
    <p className="student-policy-context" role="status">{configuration.source === "local" ? "Shared browser preview" : "Professor-authorized saved policy preview"} · Revision {record?.revision} · {policy.mode} · Changes apply to new attempts. Assistance allowances apply per question.</p>
    {pendingRevision !== null && <p className="student-policy-update" role="status">A newer policy is available. Restart preview to apply it.</p>}
    {loadError && <div className="student-policy-error" role="alert"><p>{loadError}</p><button type="button" onClick={() => void retry()}>Retry policy load</button></div>}
  </>} connected={configuration.connected} />;
}

function StudentPreview({ policy, preferenceExamId, onRestart, policyNotice, connected }: { policy: StudentPolicy; preferenceExamId: string; onRestart?: () => Promise<StudentPolicy>; policyNotice?: ReactNode; connected: boolean }) {
  const [store] = useState(() => {
    try { return createPreferenceStore(window.localStorage); }
    catch { return createPreferenceStore(); }
  });
  const [initial] = useState(() => store.load(preferenceExamId, STUDENT_ID, policy));
  const [preferences, setPreferences] = useState(initial.preferences);
  const [baseline, setBaseline] = useState(() => JSON.stringify(initial.preferences));
  const [status, setStatus] = useState("");
  const [error, setError] = useState(initial.error ?? "");
  const [panelOpen, setPanelOpen] = useState(false);
  const [answer, setAnswer] = useState("");
  const [attempt, setAttempt] = useState(newAttempt);
  const [restarting, setRestarting] = useState(false);
  const [browserReducedMotion, setBrowserReducedMotion] = useState(() => window.matchMedia("(prefers-reduced-motion: reduce)").matches);
  const launchButton = useRef<HTMLButtonElement>(null);
  const reducedMotion = policy.defaults.reducedMotion || browserReducedMotion || preferences.reducedMotion;
  const dirty = JSON.stringify(preferences) !== baseline;
  // Hide disallowed actions entirely; allowed actions stay visible when their uses reach zero.
  const availableActions = ACTIONS.filter(action => policy.assistance[action.id].enabled);
  useEffect(() => { setPreferences(current => reconcilePreferences(current, policy)); }, [policy]);

  useEffect(() => {
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setBrowserReducedMotion(query.matches);
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);

  const updatePreferences = (next: StudentPreferences) => {
    setPreferences(reconcilePreferences(next, policy));
    setStatus("");
    setError("");
  };
  const savePreferences = () => {
    try {
      store.save(preferenceExamId, STUDENT_ID, preferences, policy);
      setBaseline(JSON.stringify(preferences));
      setError("");
      setStatus("Preferences saved in this browser for the preview.");
    } catch {
      setError("Could not save preferences in this browser. Your changes still apply to this preview.");
    }
  };
  const resetPreferences = () => {
    setPreferences(defaultPreferences(policy));
    setError("");
    setStatus("Preferences reset. Select Save Preferences to keep them on reload.");
  };
  const closePanel = () => {
    setPanelOpen(false);
    requestAnimationFrame(() => launchButton.current?.focus());
  };
  const requestAssistance = (action: typeof ACTIONS[number]) => {
    // Check the latest count inside the updater so queued clicks cannot exceed the preview limit.
    setAttempt(current => {
      const allowance = policy.assistance[action.id];
      if (!allowance.enabled || current.counts[action.id] >= allowance.limit) return current;
      return {
        counts: { ...current.counts, [action.id]: current.counts[action.id] + 1 },
        state: "Speaking",
        response: { label: action.label, text: action.response },
      };
    });
  };
  const restart = async () => {
    setRestarting(true);
    try {
      // Refresh permissions before clearing usage; a failed load preserves the active attempt.
      const nextPolicy = onRestart ? await onRestart() : policy;
      setPreferences(current => reconcilePreferences(current, nextPolicy));
      setAttempt(newAttempt());
      setAnswer("");
      setStatus("");
    } catch { setError("Could not restart the preview. Your active preview and assistance usage have been kept."); }
    finally { setRestarting(false); }
  };

  return <div className="student-settings-preview-page">
    <header className="simple-header">
      <div className="logo"><span className="logo-icon" aria-hidden="true"><OralExamMark size={34} /></span><span>OralExam AI</span></div>
      <a href="/student/exams">Back to Exams</a>
    </header>
    <main className="student-settings-preview-content">
      <div className="student-preview-heading">
        <div><p className="eyebrow">STUDENT SETTINGS PREVIEW</p><h1>Your exam, your presentation preferences</h1><p>Try the student controls using a synthetic practice question.</p></div>
        <button className="student-preview-primary" type="button" ref={launchButton} onClick={() => setPanelOpen(true)}>Student settings</button>
      </div>

      <aside className="student-preview-notice" aria-label="Prototype information">
        <strong>Student settings · Synthetic exam preview</strong>
        <p>No exam is started and no response is submitted. Audio, avatar states, and assistance are simulated. {connected ? "This preview uses a snapshot of the selected instructor policy. Real student accounts and class rosters are not connected yet." : "This standalone page uses fixed sample permissions. Open a shared preview from Manage Exam to test instructor changes."}</p>
      </aside>
      {policyNotice}

      <div className={`student-demo-surface${reducedMotion ? " student-demo-reduced-motion" : ""}`} style={{ fontSize: `${preferences.textSize}px` }}>
        <section className="student-demo-question" aria-labelledby="student-sample-question">
          <div className="student-preview-card-heading"><span>{policy.mode === "practice" ? "Practice" : "Assessed"} sample · Question 1</span><span className="student-preview-state" role="status">{attempt.state} · simulated</span></div>
          <div className={`student-demo-stage student-demo-background-${preferences.background}${policy.defaults.animation && !reducedMotion && preferences.avatar !== "custom" && attempt.state === "Speaking" ? " student-demo-animated" : ""}`} data-avatar={preferences.avatar} data-background={preferences.background} style={preferences.background === "custom" && policy.defaults.customBackground ? { backgroundImage: `url("${policy.defaults.customBackground}")`, backgroundSize: "cover", backgroundPosition: "center" } : undefined}>
            <div className={`student-demo-avatar student-demo-avatar-${preferences.avatar}`} aria-hidden="true">
              {preferences.avatar === "custom" && policy.defaults.customAvatar ? <img src={policy.defaults.customAvatar} alt="" /> : preferences.avatar === "guide" ? <svg viewBox="0 0 100 100" focusable="false"><circle cx="50" cy="33" r="17" /><path d="M19 88v-9c0-17 14-28 31-28s31 11 31 28v9" /></svg> : <span />}
            </div>
            <div>{policy.allowAvatar && <strong>{policy.avatarChoices.find(choice => choice.id === preferences.avatar)?.label}</strong>}{policy.allowBackground && <p>{policy.backgroundChoices.find(choice => choice.id === preferences.background)?.label}</p>}{policy.allowSpeed && <p><output className="student-demo-speed">{preferences.speed.toFixed(2)}× speaking speed</output></p>}<p><output className="student-demo-volume">Volume: {preferences.volume}%</output> · {reducedMotion ? "Reduced motion on" : "Standard motion"}</p></div>
          </div>
          <h2 id="student-sample-question">{QUESTION}</h2>
          <label htmlFor="student-sample-response">Sample response</label>
          <textarea id="student-sample-response" value={answer} onChange={event => setAnswer(event.target.value)} placeholder="Try typing a sample response…" aria-describedby="student-sample-response-help" />
          <p id="student-sample-response-help" className="student-preview-help">Your sample response stays on this page. It is not saved, submitted, or evaluated.</p>
        </section>

        {availableActions.length > 0 && <section className="student-demo-assistance" aria-labelledby="student-assistance-heading">
          <h2 id="student-assistance-heading">Question assistance</h2>
          <p className="student-preview-help">Allowances apply per question. Changing or resetting presentation preferences does not restore uses.</p>
          <div className="student-demo-assistance-list">{availableActions.map(action => {
            const allowance = policy.assistance[action.id];
            const remaining = Math.max(0, allowance.limit - attempt.counts[action.id]);
            return <div className="student-demo-assistance-item" key={action.id}>
              <div>
                <div className="student-assistance-heading">
                  <strong>{action.label}</strong>
                  <span id={`student-assistance-${action.id}-help`} className={`student-assistance-remaining${remaining === 0 ? " student-assistance-exhausted" : ""}`} aria-live="polite" aria-atomic="true"><strong>{remaining} of {allowance.limit}</strong> remaining</span>
                </div>
                <p>{action.description}</p>
                {remaining === 0 && <p>Limit reached for this preview.</p>}
                {(action.id === "repeat" || action.id === "clarification") && <p>Timer policy: {allowance.timerContinues ? "continues" : "pauses"}. No timer is running in this preview.</p>}
              </div>
              <button type="button" disabled={remaining === 0} aria-describedby={`student-assistance-${action.id}-help`} onClick={() => requestAssistance(action)}>{action.label}</button>
            </div>;
          })}</div>
          <div className="student-demo-response" role="status" aria-live="polite" aria-atomic="true">{attempt.response ? <><strong>{attempt.response.label}</strong><p>{attempt.response.text}</p></> : <p>Available assistance appears here as readable sample text.</p>}</div>
        </section>}
      </div>

      <section className="student-preview-review-note" aria-label="Preview scope">
        <p>No AI score is generated here; professors control final grades.</p>
        <p>Reloading or restarting this preview begins a new synthetic attempt. Only saved personal preferences persist. Server permission enforcement is a deferred step.</p>
        <button type="button" disabled={restarting} onClick={() => void restart()}>Restart preview</button>
      </section>
    </main>
    <StudentSettingsPanel open={panelOpen} policy={policy} preferences={preferences} onChange={updatePreferences} onClose={closePanel} onSave={savePreferences} onReset={resetPreferences} dirty={dirty} status={status} error={error} browserReducedMotion={browserReducedMotion} />
  </div>;
}
