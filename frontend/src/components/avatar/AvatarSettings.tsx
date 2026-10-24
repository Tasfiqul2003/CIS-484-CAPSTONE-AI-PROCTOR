import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { AVATARS, BACKGROUNDS, VOICES, MAX_PREVIEW_IMAGE_BYTES, isValidPreviewImage, createDraftStore, defaultSettings, validateSettings } from "./settings";
import type { Action, Settings } from "./settings";
import StudentAvatarPreview from "./StudentAvatarPreview";
import { createLocalExamPolicyStore, loadExamPolicy, saveExamPolicy, type ExamPolicy } from "./examPolicy";
import "./avatar-settings.css";

const actionLabels: Record<Action, string> = {
  repeat: "Exact question repeats", clarification: "Clarification", hint: "Hints",
  explanation: "Explanations", correctness: "Correctness feedback",
};
const actionHelp: Record<Action, string> = {
  repeat: "Repeat the exact question without adding content.",
  clarification: "Reword the question without adding answer content.",
  hint: "Offer a synthetic hint only in the selected modes.",
  explanation: "Offer a synthetic explanation only in the selected modes.",
  correctness: "Tell the student whether the sample answer was correct. If enabled for assessed mode, feedback appears during the simulated exam. This prototype uses fixed example feedback and assigns no grade.",
};

function Field({ id, label, help, children }: { id: string; label: string; help: string; children: ReactNode }) {
  return <div className="avatar-field"><label htmlFor={id}>{label}</label>{children}<small id={`${id}-help`} className="avatar-help">{help}</small></div>;
}

function Check({ id, label, help, checked, disabled, onChange }: {
  id: string; label: string; help: string; checked: boolean; disabled?: boolean; onChange?: (checked: boolean) => void;
}) {
  return <div className="avatar-check"><label htmlFor={id}><input id={id} type="checkbox" checked={checked} disabled={disabled} aria-describedby={`${id}-help`} onChange={e => onChange?.(e.target.checked)} />{label}</label><small id={`${id}-help`} className="avatar-help">{help}</small></div>;
}

function PhotoUpload({ kind, photo, onChange, onBusy }: {
  kind: "avatar" | "background";
  photo: string | null;
  onChange: (photo: string | null) => void;
  onBusy: (busy: boolean) => void;
}) {
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const active = useRef(true);
  const reader = useRef<FileReader | null>(null);
  const id = `avatar-upload-${kind}`;
  useEffect(() => {
    active.current = true;
    return () => { active.current = false; reader.current?.abort(); };
  }, []);
  const readPhoto = async (file: File) => {
    setError("");
    if (!["image/png", "image/jpeg", "image/webp"].includes(file.type)) {
      setError("Choose a PNG, JPEG, or WebP image.");
      return;
    }
    if (file.size > MAX_PREVIEW_IMAGE_BYTES) {
      setError("Choose an image no larger than 1 MB (1,048,576 bytes).");
      return;
    }
    setBusy(true);
    onBusy(true);
    try {
      const data = await new Promise<string>((resolve, reject) => {
        const currentReader = new FileReader();
        reader.current = currentReader;
        currentReader.onload = () => typeof currentReader.result === "string" ? resolve(currentReader.result) : reject(new Error("Unable to read the image."));
        currentReader.onerror = () => reject(new Error("Unable to read the image."));
        currentReader.onabort = () => reject(new Error("Image selection cancelled."));
        currentReader.readAsDataURL(file);
      });
      if (!isValidPreviewImage(data)) throw new Error("Choose a valid PNG, JPEG, or WebP image no larger than 1 MB.");
      await new Promise<void>((resolve, reject) => {
        const image = new Image();
        image.onload = () => image.naturalWidth > 0 && image.naturalHeight > 0 ? resolve() : reject(new Error("The selected file is not a readable image."));
        image.onerror = () => reject(new Error("The selected file is not a readable image."));
        image.src = data;
      });
      if (active.current) onChange(data);
    } catch (failure) {
      if (active.current) setError(failure instanceof Error ? failure.message : "Unable to read the image.");
    } finally {
      if (active.current) { setBusy(false); onBusy(false); }
    }
  };
  return <div className="avatar-photo-upload">
    <label htmlFor={id}>Upload own {kind} photo</label>
    <input id={id} type="file" accept="image/png,image/jpeg,image/webp" disabled={busy} aria-describedby={`${id}-help`} onChange={event => {
      const file = event.currentTarget.files?.[0];
      event.currentTarget.value = "";
      if (file) void readPhoto(file);
    }} />
    <small id={`${id}-help`} className="avatar-help">PNG, JPEG, or WebP, up to 1 MB. Uploaded photos are static previews. Save Local Draft keeps them in this browser; Save Exam Policy sends the selected photos with the policy.</small>
    {busy && <p role="status">Loading photo…</p>}
    {error && <p role="alert" className="avatar-error">{error}</p>}
    {photo && <div className="avatar-photo-selection"><img src={photo} alt={`Uploaded ${kind} photo preview`} /><button type="button" disabled={busy} onClick={() => { setError(""); onChange(null); }}>Remove {kind} photo</button></div>}
  </div>;
}

export default function AvatarSettings({ examId, defaultOpen = false }: { examId: string; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen || window.location.hash === "#avatar-settings");
  const [identity, setIdentity] = useState<{ id: string; error: string } | null>(null);
  const [identityLoading, setIdentityLoading] = useState(true);
  // Session identity scopes browser drafts; the API separately checks exam ownership.
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    fetch("/api/auth/me", { credentials: "include", signal: controller.signal })
      .then(async response => {
        if (!response.ok) throw new Error("Instructor identity is unavailable. Local saving is disabled.");
        const user = await response.json();
        const id = user.professor_id || user.id;
        if (user.role !== "professor" || typeof id !== "string" || !id.trim()) throw new Error("Instructor identity is unavailable. Local saving is disabled.");
        if (!controller.signal.aborted) setIdentity({ id, error: "" });
      })
      .catch(error => { if (!controller.signal.aborted) setIdentity({ id: "", error: error instanceof Error ? error.message : "Unable to identify instructor. Local saving is disabled." }); })
      .finally(() => { if (!controller.signal.aborted) setIdentityLoading(false); });
    return () => controller.abort();
  }, [open]);
  return <section className="avatar-settings" id="avatar-settings" aria-label="Avatar settings prototype">
    <div className="avatar-settings-header"><div><p className="eyebrow">EXAM PERMISSIONS</p><h2>Avatar &amp; Interaction Settings</h2><p>Save permissions for this exam and review them in the connected student preview. Live exam delivery is not connected yet.</p></div>
      <button type="button" aria-expanded={open} aria-controls="avatar-settings-editor" onClick={() => { if (!open) setIdentityLoading(true); setOpen(current => !current); }}>Avatar &amp; Interaction Settings</button></div>
    {open && identityLoading && <p role="status">Loading local draft context…</p>}
    <div id="avatar-settings-editor" hidden={!open || identityLoading}>{identity && <SettingsEditor key={JSON.stringify([examId, identity.id])} examId={examId} instructorId={identity.id} identityError={identity.error} />}</div>
  </section>;
}

function SettingsEditor({ examId, instructorId, identityError }: { examId: string; instructorId: string; identityError: string }) {
  const [store] = useState(() => {
    try { return createDraftStore(window.localStorage); }
    catch { return createDraftStore(); }
  });
  const [initial] = useState(() => instructorId ? store.load(examId, instructorId) : { settings: null, error: identityError });
  const [settings, setSettings] = useState<Settings>(() => initial.settings ?? defaultSettings());
  const [baseline, setBaseline] = useState(() => JSON.stringify(initial.settings ?? defaultSettings()));
  const [hasDraft, setHasDraft] = useState(!!initial.settings);
  const [message, setMessage] = useState(initial.error ?? "");
  const [preview, setPreview] = useState(false);
  const [previewVersion, setPreviewVersion] = useState(0);
  const [photoVersion, setPhotoVersion] = useState(0);
  const [uploading, setUploading] = useState({ avatar: false, background: false });
  const [examPolicy, setExamPolicy] = useState<ExamPolicy | null>(null);
  const [serverBusy, setServerBusy] = useState(false);
  const [serverError, setServerError] = useState("");
  const [sharedRevision, setSharedRevision] = useState<number | null>(null);
  const [previewMode, setPreviewMode] = useState<"practice" | "assessed">("practice");
  // Track edits so a delayed server response cannot replace changes made while it loads.
  const edited = useRef(false);
  const editGeneration = useRef(0);
  const errorRef = useRef<HTMLDivElement>(null);
  const previewButton = useRef<HTMLButtonElement>(null);
  const errors = validateSettings(settings);
  const dirty = JSON.stringify(settings) !== baseline;
  const proposed = defaultSettings();
  const uploadingPhoto = uploading.avatar || uploading.background;
  const avatarChoices = [...AVATARS, ...(settings.presentation.customAvatar ? [{ id: "custom", label: "Uploaded avatar photo" }] : [])];
  const backgroundChoices = [...BACKGROUNDS, ...(settings.presentation.customBackground ? [{ id: "custom", label: "Uploaded background photo" }] : [])];
  const responseFactor = settings.behavior.responseUnit === "minutes" ? 60 : 1;
  const previewQuery = new URLSearchParams({ examId, instructorId, policySource: "local", mode: previewMode });
  const serverPreviewQuery = new URLSearchParams({ examId, policySource: "server", mode: previewMode });
  useEffect(() => {
    if (!instructorId) return;
    const controller = new AbortController();
    setServerBusy(true);
    loadExamPolicy(examId, controller.signal).then(record => {
      if (controller.signal.aborted) return;
      setExamPolicy(record);
      // A local draft takes priority; loading the server revision does not publish that draft.
      if (!initial.settings && !edited.current && record.revision > 0) {
        setSettings(record.settings);
        setBaseline(JSON.stringify(record.settings));
      }
    }).catch(error => {
      if (!controller.signal.aborted) setServerError(error instanceof Error ? error.message : "Unable to load saved exam policy.");
    }).finally(() => { if (!controller.signal.aborted) setServerBusy(false); });
    try { setSharedRevision(createLocalExamPolicyStore().load(examId, instructorId)?.revision ?? null); }
    catch (error) { setMessage(error instanceof Error ? error.message : "Unable to read the shared preview policy."); }
    return () => controller.abort();
  }, [examId, instructorId]);
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => { if (dirty) { event.preventDefault(); event.returnValue = ""; } };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);
  const change = (next: Settings) => { edited.current = true; editGeneration.current += 1; setSettings(next); setMessage(""); setPreview(false); };
  const presentation = <K extends keyof Settings["presentation"]>(key: K, value: Settings["presentation"][K]) => change({ ...settings, presentation: { ...settings.presentation, [key]: value } });
  const student = <K extends keyof Settings["student"]>(key: K, value: Settings["student"][K]) => change({ ...settings, student: { ...settings.student, [key]: value } });
  const behavior = <K extends keyof Settings["behavior"]>(key: K, value: Settings["behavior"][K]) => change({ ...settings, behavior: { ...settings.behavior, [key]: value } });
  const policy = (action: Action, next: Partial<Settings["assistance"][Action]>) => change({ ...settings, assistance: { ...settings.assistance, [action]: { ...settings.assistance[action], ...next } } });
  const numberProps = (id: string, value: number, min: number, max: number, onChange: (value: number) => void, step = 1) => ({ id, type: "number", value: Number.isFinite(value) ? value : "", min, max, step, "aria-describedby": `${id}-help`, onChange: (event: React.ChangeEvent<HTMLInputElement>) => onChange(event.target.valueAsNumber) });
  const setPhoto = (kind: "avatar" | "background", photo: string | null) => {
    edited.current = true;
    editGeneration.current += 1;
    setSettings(current => {
      const imageKey = kind === "avatar" ? "customAvatar" : "customBackground";
      const optionsKey = kind === "avatar" ? "avatars" : "backgrounds";
      const fallback = kind === "avatar" ? "guide" : "neutral";
      const selected = photo ? "custom" : current.presentation[kind] === "custom" ? fallback : current.presentation[kind];
      const allowed = current.student[optionsKey].filter(option => option !== "custom");
      if (photo) allowed.push("custom");
      if (!allowed.includes(selected)) allowed.push(selected);
      return { ...current, presentation: { ...current.presentation, [kind]: selected, [imageKey]: photo }, student: { ...current.student, [optionsKey]: allowed } };
    });
    setMessage("");
    setPreview(false);
  };
  const save = () => {
    if (uploadingPhoto) return;
    if (errors.length) { errorRef.current?.focus(); return; }
    try { store.save(examId, instructorId, settings); setBaseline(JSON.stringify(settings)); setHasDraft(true); setMessage("Local draft saved for this exam and instructor. Live exams are unchanged."); }
    catch (error) { setMessage(error instanceof Error ? error.message : "Unable to save local draft."); }
  };
  const reset = () => {
    change(defaultSettings()); setPreview(false);
    setPhotoVersion(version => version + 1);
    setUploading({ avatar: false, background: false });
    setMessage("Proposed defaults restored in the editor. Save Local Draft to replace the saved draft.");
  };
  const sharePreview = () => {
    if (errors.length || uploadingPhoto || !instructorId) { errorRef.current?.focus(); return; }
    try {
      // Sharing updates only this browser's preview policy, not the saved server policy.
      const record = createLocalExamPolicyStore().save(examId, instructorId, settings, sharedRevision ?? 0);
      setSharedRevision(record.revision);
      setMessage(`Preview policy revision ${record.revision} shared in this browser. Open previews keep their starting policy until restarted.`);
    } catch (error) { setMessage(error instanceof Error ? error.message : "Unable to share preview policy."); }
  };
  const saveServer = async () => {
    if (errors.length || uploadingPhoto || !instructorId || !examPolicy || serverBusy) { errorRef.current?.focus(); return; }
    setServerBusy(true);
    setServerError("");
    try {
      const record = await saveExamPolicy(examId, settings, examPolicy.revision);
      setExamPolicy(record);
      setBaseline(JSON.stringify(record.settings));
      setHasDraft(false);
      setMessage(`Exam policy revision ${record.revision} saved. Changes apply to new attempts; assistance limits apply per question.`);
    } catch (error) { setServerError(error instanceof Error ? error.message : "Unable to save exam policy."); }
    finally { setServerBusy(false); }
  };
  const reloadServer = async () => {
    if (!instructorId || serverBusy) return;
    setServerBusy(true);
    setServerError("");
    const generation = editGeneration.current;
    try {
      const record = await loadExamPolicy(examId);
      setExamPolicy(record);
      setBaseline(JSON.stringify(record.settings));
      if (editGeneration.current === generation) {
        edited.current = true;
        editGeneration.current += 1;
        setSettings(record.settings);
        setHasDraft(false);
        setPreview(false);
        setMessage(`Saved exam policy revision ${record.revision} loaded into the editor.`);
      } else setMessage(`Saved exam policy revision ${record.revision} loaded. Your newer editor changes have been kept.`);
    } catch (error) { setServerError(error instanceof Error ? error.message : "Unable to load saved exam policy."); }
    finally { setServerBusy(false); }
  };
  const loadSharedPreview = () => {
    try {
      const record = createLocalExamPolicyStore().load(examId, instructorId);
      setSharedRevision(record?.revision ?? null);
      if (!record) { setMessage("No shared preview policy was found for this exam and instructor."); return; }
      change(record.settings);
      setMessage(`Shared preview revision ${record.revision} loaded into the editor.`);
    } catch (error) { setMessage(error instanceof Error ? error.message : "Unable to load shared preview policy."); }
  };
  return <>
    <div className="avatar-notice"><strong>Policy changes apply to new attempts</strong><p>Assistance limits apply per question. Open previews retain their starting policy until restarted. Volume, text size, and reduced motion remain student comfort options. Placeholder avatars and voices do not activate audio, AI, or a live exam.</p></div>
    {identityError && <p role="alert" className="avatar-error">{identityError}</p>}
    <section className="avatar-section avatar-policy-persistence" aria-label="Exam policy storage">
      <h3>Save and share exam permissions</h3>
      <p className="avatar-help">Save Exam Policy stores permissions on the server for this professor's exam. Share Preview Policy connects the two previews in this browser using synthetic exam content; it does not grant student access.</p>
      <p className="avatar-policy-context" role="status">{serverBusy ? "Loading or saving exam policy…" : examPolicy ? `Saved exam policy revision ${examPolicy.revision}${examPolicy.revision === 0 ? " · defaults, not yet saved" : ""}` : "Saved exam policy unavailable"}{sharedRevision !== null ? ` · Shared preview revision ${sharedRevision}` : ""}</p>
      {hasDraft && examPolicy && examPolicy.revision > 0 && <p className="avatar-help">The editor uses your local draft. Load Saved Exam Policy to replace it with the server version.</p>}
      {serverError && <p className="avatar-error" role="alert">{serverError} Local drafts and shared browser previews remain separate.</p>}
      <div className="avatar-settings-actions">
        <button type="button" disabled={!instructorId || uploadingPhoto || errors.length > 0 || serverBusy || !examPolicy} onClick={() => void saveServer()}>Save Exam Policy</button>
        <button type="button" disabled={!instructorId || uploadingPhoto || serverBusy} onClick={() => void reloadServer()}>Load Saved Exam Policy</button>
        <button type="button" disabled={!instructorId || uploadingPhoto || errors.length > 0} onClick={sharePreview}>Share Preview Policy</button>
        <button type="button" disabled={!instructorId || uploadingPhoto} onClick={loadSharedPreview}>Load Shared Preview Policy</button>
      </div>
      <div className="avatar-grid"><Field id="avatar-shared-mode" label="Preview exam mode" help="Instructor simulation only. Students cannot change the actual exam mode.">
        <select id="avatar-shared-mode" value={previewMode} aria-describedby="avatar-shared-mode-help" onChange={event => setPreviewMode(event.target.value as "practice" | "assessed")}><option value="practice">Practice</option><option value="assessed">Assessed</option></select>
      </Field></div>
      {sharedRevision !== null && <p><a href={`/student/settings-preview?${previewQuery}`}>Open shared student preview</a></p>}
      {examPolicy && examPolicy.revision > 0 && <p><a href={`/student/settings-preview?${serverPreviewQuery}`}>Open saved policy preview</a> <span className="avatar-help">Professor sign-in required.</span></p>}
    </section>
    <form noValidate onSubmit={event => { event.preventDefault(); save(); }}>
      <div className="avatar-settings-actions"><span role="status" className="avatar-status">{dirty ? "Unsaved changes" : hasDraft ? "Local draft · No unsaved changes" : examPolicy && examPolicy.revision > 0 ? "Saved exam policy · No unsaved changes" : "Proposed defaults · No unsaved changes"}</span><button type="submit" disabled={!instructorId || uploadingPhoto}>Save Local Draft</button><button type="button" onClick={reset}>Reset to Defaults</button><button type="button" ref={previewButton} disabled={errors.length > 0 || uploadingPhoto} onClick={() => { setPreviewVersion(v => v + 1); setPreview(true); }}>Preview as Student</button></div>
      <p role="status">{message}</p>
      {errors.length > 0 && <div className="avatar-error" role="alert" tabIndex={-1} ref={errorRef}><strong>Correct these settings before saving or previewing:</strong><ul>{errors.map((error, index) => <li key={index}>{error}</li>)}</ul></div>}
      <section className="avatar-section" aria-labelledby="avatar-presentation-heading"><h3 id="avatar-presentation-heading">Presentation defaults</h3><p>Professor sets the starting presentation. Optional student choices are defined below.</p><div className="avatar-grid">
        {([['avatar', 'Default avatar', avatarChoices], ['background', 'Default background', backgroundChoices], ['voice', 'Default voice', VOICES]] as const).map(([key, label, choices]) => <Field key={key} id={`avatar-default-${key}`} label={label} help={`Proposed default: ${choices.find(c => c.id === proposed.presentation[key])?.label}. ${key === 'voice' ? 'Professor controlled; students cannot choose a separate voice.' : `Student change: ${settings.student[key] ? 'allowed within selected options' : 'off'}.`}`}><select id={`avatar-default-${key}`} value={settings.presentation[key]} aria-describedby={`avatar-default-${key}-help`} onChange={event => presentation(key, event.target.value)}>{choices.map(choice => <option key={choice.id} value={choice.id}>{choice.label}</option>)}</select>{key !== 'voice' && <PhotoUpload key={`${key}-${photoVersion}`} kind={key} photo={key === 'avatar' ? settings.presentation.customAvatar : settings.presentation.customBackground} onChange={photo => setPhoto(key, photo)} onBusy={busy => setUploading(current => ({ ...current, [key]: busy }))} />}</Field>)}
        <Field id="avatar-default-speed" label="Default speaking speed" help={`Speaking-speed multiplier: 1× is normal, 0.5× is half speed, and 2× is twice normal speed. Student change: ${settings.student.speed ? 'within the limits below' : 'off'}. No speech service is active.`}><output id="avatar-speed-value" htmlFor="avatar-default-speed">{settings.presentation.speed.toFixed(2)}× ({settings.presentation.speed === 1 ? 'normal speed' : settings.presentation.speed < 1 ? 'slower than normal' : 'faster than normal'})</output><input id="avatar-default-speed" type="range" min={0.5} max={2} step={0.05} value={settings.presentation.speed} aria-describedby="avatar-default-speed-help" aria-valuetext={`${settings.presentation.speed.toFixed(2)} times normal speaking speed`} onChange={event => presentation('speed', event.target.valueAsNumber)} /></Field>
        <Check id="avatar-animation" label="Enable animation preview" checked={settings.presentation.animation} onChange={value => presentation('animation', value)} help="Proposed default: on. Professor sets this; reduced motion suppresses animation." />
        <Check id="avatar-motion" label="Reduced motion by default" checked={settings.presentation.reducedMotion} onChange={value => presentation('reducedMotion', value)} help="Proposed default: off. Students may always reduce motion; browser motion preferences also apply." />
        <Check id="avatar-state-labels" label="Visible avatar state labels" checked={settings.presentation.stateLabels} disabled help="Proposed default: on. Always available for accessibility: Idle, Listening, Thinking, Speaking, Error." />
      </div></section>
      <section className="avatar-section" aria-labelledby="avatar-student-heading"><h3 id="avatar-student-heading">Student controls</h3><p>Volume (0–100%, default 70%), text size (16, 20, or 24 px, default 16), and reduced motion are always available in the preview. They do not change assessment policy.</p>
        <div className="avatar-grid">{([['avatar', 'avatars', avatarChoices], ['background', 'backgrounds', backgroundChoices]] as const).map(([key, list, choices]) => <div className="avatar-policy" key={key}><Check id={`avatar-student-${key}`} label={`Allow students to choose ${key}`} checked={settings.student[key]} onChange={value => student(key, value)} help={`Proposed default: off. Include the professor default when enabling choice. ${key === 'avatar' ? 'Guide is a person icon; Geometric is a diamond icon. ' : ''}Uploaded photos are static previews.`} /><fieldset disabled={!settings.student[key]} aria-describedby={`avatar-options-${key}-help`}><legend>Allowed {key} options</legend><div className="avatar-choice-list">{choices.map(choice => <label key={choice.id}><input type="checkbox" checked={settings.student[list].includes(choice.id)} onChange={event => student(list, event.target.checked ? [...settings.student[list], choice.id] : settings.student[list].filter(id => id !== choice.id))} />{choice.label}</label>)}</div></fieldset><small id={`avatar-options-${key}-help`} className="avatar-help">{settings.student[key] ? 'Only checked options appear in the student preview.' : 'Options are disabled because student choice is off; the professor default applies.'}</small></div>)}</div>
        <Check id="avatar-student-speed" label="Allow students to choose speaking speed" checked={settings.student.speed} onChange={value => student('speed', value)} help="Proposed default: off. Proposed limits: 0.8–1.2×. Include the default speed within the limits." />
        <fieldset disabled={!settings.student.speed}><legend>Student speaking speed limits</legend><div className="avatar-grid"><Field id="avatar-min-speed" label="Minimum speaking speed" help="Proposed default: 0.8×. Range: 0.5–2×, no greater than maximum."><input {...numberProps('avatar-min-speed', settings.student.minSpeed, .5, 2, value => student('minSpeed', value), .1)} /></Field><Field id="avatar-max-speed" label="Maximum speaking speed" help="Proposed default: 1.2×. Range: 0.5–2×, no less than minimum."><input {...numberProps('avatar-max-speed', settings.student.maxSpeed, .5, 2, value => student('maxSpeed', value), .1)} /></Field></div></fieldset><p className="avatar-help">{settings.student.speed ? 'Students can adjust only within these bounds.' : 'Speed limits are disabled because student speed choice is off.'}</p>
      </section>
      <section className="avatar-section" aria-labelledby="avatar-assistance-heading"><h3 id="avatar-assistance-heading">Assistance</h3><p>Professor controls each action and its mode availability. Student input cannot change exam mode, rules, or assistance limits. These are proposed policies for the preview.</p><div className="avatar-grid">
        {(Object.keys(actionLabels) as Action[]).map(action => { const item = settings.assistance[action]; const limited = action === 'repeat' || action === 'clarification'; return <div className="avatar-policy" key={action}><Check id={`avatar-${action}`} label={actionLabels[action]} checked={item.enabled} onChange={enabled => policy(action, { enabled })} help={`${actionHelp[action]} Proposed default: ${proposed.assistance[action].enabled ? 'on, both modes' : 'off, practice only'}. Professor only.`} /><fieldset disabled={!item.enabled}><legend>{actionLabels[action]} policy</legend><Field id={`avatar-${action}-modes`} label={`${actionLabels[action]} availability`} help="Choices: practice, assessed, or both. Professor only."><select id={`avatar-${action}-modes`} aria-describedby={`avatar-${action}-modes-help`} value={item.modes} onChange={event => policy(action, { modes: event.target.value as typeof item.modes })}><option value="practice">Practice only</option><option value="assessed">Assessed only</option><option value="both">Practice and assessed</option></select></Field>{<><Field id={`avatar-${action}-limit`} label={`${actionLabels[action]} limit per question`} help={`Proposed default: ${proposed.assistance[action].limit}. Whole number 1–10 when enabled. Student cannot change allowance.`}><input {...numberProps(`avatar-${action}-limit`, item.limit, 1, 10, limit => policy(action, { limit }))} /></Field>{limited && <Check id={`avatar-${action}-timer`} label={`Timer continues during ${action === 'repeat' ? 'repeats' : 'clarification'}`} checked={item.timerContinues} onChange={timerContinues => policy(action, { timerContinues })} help="Proposed default: on. Uncheck to simulate a paused timer during this action. No real exam timer is connected." />}</>}</fieldset>{!item.enabled && <p className="avatar-help">Dependent controls are disabled because this assistance action is off.</p>}</div>; })}
      </div></section>
      <section className="avatar-section" aria-labelledby="avatar-behavior-heading"><h3 id="avatar-behavior-heading">Exam behavior</h3><p>Professor-only draft values for the synthetic preview. The other categories linked from Manage Exam remain separate; this prototype does not synchronize or override them.</p><div className="avatar-grid">
        <Field id="avatar-followups" label="Follow-up limit per question" help="Proposed default: 1. Whole number 0–5; 0 disables follow-ups. Professor only."><input {...numberProps('avatar-followups', settings.behavior.followUps, 0, 5, value => behavior('followUps', value))} /></Field>
        <Field id="avatar-order" label="Question ordering" help="Proposed default: authored order. Choices: authored or randomized. Professor only."><select id="avatar-order" aria-describedby="avatar-order-help" value={settings.behavior.order} onChange={event => behavior('order', event.target.value as Settings['behavior']['order'])}><option value="authored">Authored order</option><option value="random">Randomized</option></select></Field>
        <Field id="avatar-timing" label="Response timing" help="Proposed default: existing exam timing. Optional fixed response window is a preview policy. Professor only."><select id="avatar-timing" aria-describedby="avatar-timing-help" value={settings.behavior.responseTiming} onChange={event => behavior('responseTiming', event.target.value as Settings['behavior']['responseTiming'])}><option value="exam">Use existing exam timing</option><option value="fixed">Fixed response window</option></select></Field>
        <div className="avatar-time-entry"><Field id="avatar-response-window" label="Response window" help={`Proposed default: 2 minutes (120 seconds). Range: 10 seconds–10 minutes, in whole-second increments. ${settings.behavior.responseTiming === 'fixed' ? 'Used for the fixed-window preview.' : 'Disabled because existing exam timing is selected.'}`}><input id="avatar-response-window" type="number" disabled={settings.behavior.responseTiming !== 'fixed'} min={10 / responseFactor} max={600 / responseFactor} step="any" value={Number.isFinite(settings.behavior.responseSeconds) ? settings.behavior.responseSeconds / responseFactor : ''} aria-describedby="avatar-response-window-help" onChange={event => behavior('responseSeconds', Number((event.target.valueAsNumber * responseFactor).toFixed(8)))} /></Field><Field id="avatar-response-unit" label="Response window unit" help="Changing units preserves the duration."><select id="avatar-response-unit" disabled={settings.behavior.responseTiming !== 'fixed'} aria-describedby="avatar-response-unit-help" value={settings.behavior.responseUnit} onChange={event => behavior('responseUnit', event.target.value as Settings['behavior']['responseUnit'])}><option value="seconds">Seconds</option><option value="minutes">Minutes</option></select></Field></div>
      </div>
        <p>Question difficulty is set by the professor in the <a href={`/professor/exams/${examId}/questions`}>existing Question Bank for topics and authored questions</a>. Use <a href={`/professor/exams/${examId}/materials`}>Course Materials for professor-provided guidance and rubrics</a>. All AI scores are provisional; professors control final grades.</p>
      </section>
      <div className="avatar-settings-actions"><button type="submit" disabled={!instructorId || uploadingPhoto}>Save Local Draft</button><button type="button" onClick={reset}>Reset to Defaults</button><span>{dirty ? 'Unsaved changes' : 'No unsaved changes'}</span></div>
    </form>
    {preview && <StudentAvatarPreview key={previewVersion} settings={settings} onClose={() => { setPreview(false); previewButton.current?.focus(); }} />}
  </>;
}
