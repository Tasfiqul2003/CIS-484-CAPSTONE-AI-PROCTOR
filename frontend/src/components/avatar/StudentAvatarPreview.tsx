import { useEffect, useMemo, useRef, useState } from "react";
import {
  AVATARS,
  BACKGROUNDS,
  VOICES,
  isAvailable,
  isValidPreviewImage,
  type Action,
  type Settings,
} from "./settings";

type Mode = "practice" | "assessed";
type AvatarState = "Idle" | "Listening" | "Thinking" | "Speaking" | "Error";

const QUESTION = "What is one benefit of separating data from presentation?";
const STATES: AvatarState[] = ["Idle", "Listening", "Thinking", "Speaking", "Error"];
const ACTIONS: { id: Action; label: string; description: string }[] = [
  { id: "repeat", label: "Repeat exact question", description: "Repeats the original wording without adding information." },
  { id: "clarification", label: "Clarify question wording", description: "Rephrases the question without providing an answer." },
  { id: "hint", label: "Request hint", description: "Shows a fixed synthetic hint when permitted." },
  { id: "explanation", label: "Request explanation", description: "Shows a fixed synthetic explanation when permitted." },
  { id: "correctness", label: "Request correctness feedback", description: "Shows fixed feedback about the sample response when permitted." },
];
const RESPONSES: Record<Action, string> = {
  repeat: QUESTION,
  clarification: "Name one advantage of keeping the information in an application separate from the way it is shown.",
  hint: "Synthetic hint: Think about updating one part of a simple application.",
  explanation: "Synthetic explanation: The same stored information can be shown in a table or a card, so changing the display does not require changing the data.",
  correctness: "Synthetic feedback: The sample response names a benefit. This fixed example does not evaluate an answer or assign a grade.",
};
const EMPTY_COUNTS: Record<Action, number> = { repeat: 0, clarification: 0, hint: 0, explanation: 0, correctness: 0 };

function choiceLabel(options: readonly { id: string; label: string }[], id: string) {
  return options.find((option) => option.id === id)?.label ?? id;
}

function useBrowserReducedMotion() {
  const [reduced, setReduced] = useState(() =>
    typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches,
  );
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setReduced(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  return reduced;
}

export default function StudentAvatarPreview({ settings, onClose }: { settings: Settings; onClose: () => void }) {
  const heading = useRef<HTMLHeadingElement>(null);
  const [mode, setMode] = useState<Mode>("practice");
  const [state, setState] = useState<AvatarState>("Idle");
  const [volume, setVolume] = useState(70);
  const [textSize, setTextSize] = useState(16);
  const [studentReducedMotion, setStudentReducedMotion] = useState(false);
  const [avatar, setAvatar] = useState(settings.presentation.avatar);
  const [background, setBackground] = useState(settings.presentation.background);
  const [speed, setSpeed] = useState(settings.presentation.speed);
  const [counts, setCounts] = useState<Record<Action, number>>({ ...EMPTY_COUNTS });
  const [response, setResponse] = useState<{ label: string; text: string } | null>(null);
  const browserReducedMotion = useBrowserReducedMotion();
  const forcedReducedMotion = settings.presentation.reducedMotion || browserReducedMotion;
  const reducedMotion = forcedReducedMotion || studentReducedMotion;
  const customAvatar = useMemo(() => isValidPreviewImage(settings.presentation.customAvatar) ? settings.presentation.customAvatar : null, [settings.presentation.customAvatar]);
  const customBackground = useMemo(() => isValidPreviewImage(settings.presentation.customBackground) ? settings.presentation.customBackground : null, [settings.presentation.customBackground]);
  const avatarChoices = [...AVATARS, ...(customAvatar ? [{ id: "custom", label: "Uploaded avatar photo" }] : [])];
  const backgroundChoices = [...BACKGROUNDS, ...(customBackground ? [{ id: "custom", label: "Uploaded background photo" }] : [])];

  useEffect(() => { heading.current?.focus(); }, []);

  // Preferences are local to this mounted preview. They never change the instructor's draft.
  const shownAvatar = settings.student.avatar && settings.student.avatars.includes(avatar) ? avatar : settings.presentation.avatar;
  const shownBackground = settings.student.background && settings.student.backgrounds.includes(background) ? background : settings.presentation.background;
  const shownSpeed = settings.student.speed ? Math.min(settings.student.maxSpeed, Math.max(settings.student.minSpeed, speed)) : settings.presentation.speed;
  const selectableAvatars = avatarChoices.filter((option) => settings.student.avatars.includes(option.id));
  const selectableBackgrounds = backgroundChoices.filter((option) => settings.student.backgrounds.includes(option.id));
  const responseAmount = settings.behavior.responseUnit === "minutes" ? settings.behavior.responseSeconds / 60 : settings.behavior.responseSeconds;
  const displayedResponseAmount = Number(responseAmount.toFixed(3));
  const responseUnit = displayedResponseAmount === 1 ? settings.behavior.responseUnit.slice(0, -1) : settings.behavior.responseUnit;
  const responseTiming = `${displayedResponseAmount !== responseAmount ? "about " : ""}${displayedResponseAmount} ${responseUnit} per response`;
  const lockedPreferences = [
    !settings.student.avatar && "Avatar",
    !settings.student.background && "background",
    !settings.student.speed && "speaking speed",
  ].filter(Boolean);

  function requestAssistance(action: Action) {
    const policy = settings.assistance[action];
    if (!isAvailable(policy, mode) || counts[action] >= policy.limit) return;
    setCounts((current) => ({ ...current, [action]: current[action] + 1 }));
    setResponse({ label: ACTIONS.find((item) => item.id === action)!.label, text: RESPONSES[action] });
    setState("Speaking");
  }

  function restartAttempt() {
    setCounts({ ...EMPTY_COUNTS });
    setResponse(null);
    setState("Idle");
  }

  return (
    <section className="avatar-preview" aria-labelledby="avatar-student-preview-heading">
      <div className="avatar-settings-header">
        <div>
          <p className="avatar-kicker">Synthetic preview</p>
          <h3 id="avatar-student-preview-heading" tabIndex={-1} ref={heading}>Preview as Student</h3>
          <p className="avatar-help">Uses the current valid draft. All content and state changes are simulated.</p>
        </div>
        <button type="button" onClick={onClose}>Close Student Preview</button>
      </div>

      <fieldset className="avatar-simulation">
        <legend>Instructor simulation controls</legend>
        <p className="avatar-help">These controls are for this instructor preview. Students cannot change the real exam mode.</p>
        <div className="avatar-field">
          <label htmlFor="avatar-preview-mode">Instructor simulation mode</label>
          <select id="avatar-preview-mode" value={mode} onChange={(event) => { setMode(event.target.value as Mode); setResponse(null); }}>
            <option value="practice">Practice</option>
            <option value="assessed">Assessed</option>
          </select>
        </div>
        <div className="avatar-state-controls" role="group" aria-label="Simulate avatar state">
          {STATES.map((item) => (
            <button type="button" key={item} aria-pressed={state === item} onClick={() => setState(item)}>{item}</button>
          ))}
        </div>
        <p className="avatar-help">No microphone, camera, model, or voice service is activated. The professor-set voice, speed, and volume settings do not produce audio.</p>
        <button type="button" onClick={restartAttempt}>Start new synthetic attempt</button>
        <p className="avatar-help">Only a new synthetic attempt resets assistance counts. Changing preferences or simulation mode keeps the counts.</p>
      </fieldset>

      <div className={`avatar-student-surface${reducedMotion ? " avatar-motion-reduced" : ""}`} style={{ fontSize: `${textSize}px` }}>
        <div
          className={`avatar-stage avatar-background-${shownBackground}${shownBackground === "custom" && customBackground ? " avatar-stage-custom-background" : ""}${settings.presentation.animation && !reducedMotion && shownAvatar !== "custom" ? " avatar-stage-animated" : ""}`}
          data-state={state.toLowerCase()}
          style={shownBackground === "custom" && customBackground ? { backgroundImage: `url("${customBackground}")` } : undefined}
        >
          <div className={`avatar-figure avatar-figure-${shownAvatar}`} aria-hidden={shownAvatar !== "custom"}>
            {shownAvatar === "custom" && customAvatar ? <img className="avatar-photo" src={customAvatar} alt="Uploaded avatar photo" /> : shownAvatar === "guide" ? (
              <svg viewBox="0 0 100 100" focusable="false"><circle cx="50" cy="33" r="17" /><path d="M19 88v-9c0-17 14-28 31-28s31 11 31 28v9" /></svg>
            ) : <span className="avatar-geometric-mark" />}
          </div>
          <div>
            <strong>{choiceLabel(avatarChoices, shownAvatar)}{shownAvatar === "custom" ? " · static photo" : " · placeholder"}</strong>
            <p>{choiceLabel(backgroundChoices, shownBackground)}</p>
            <p>{choiceLabel(VOICES, settings.presentation.voice)} · {shownSpeed.toFixed(2)}× speed</p>
            {shownAvatar === "custom" && <p>The uploaded photo stays still. Avatar states are simulated; this photo is not an animated avatar integration.</p>}
          </div>
          <span className={`avatar-state-badge avatar-state-${state.toLowerCase()}`} role="status">{state} · simulated</span>
        </div>

        {state === "Error" && (
          <p className="avatar-error" role="alert">The avatar is unavailable in this simulated error state. The question and assistance remain available as readable text below.</p>
        )}

        <section className="avatar-student-section" aria-labelledby="avatar-preferences-heading">
          <h4 id="avatar-preferences-heading">Your presentation preferences</h4>
          <p className="avatar-help">These changes apply only to this preview. Accessibility preferences remain available.</p>
          <div className="avatar-grid">
            <div className="avatar-field">
              <label htmlFor="avatar-preview-volume">Volume: <output>{volume}%</output></label>
              <input id="avatar-preview-volume" type="range" min="0" max="100" value={volume} onChange={(event) => setVolume(Number(event.target.value))} />
              <p className="avatar-help">Default: 70%. Range: 0–100%. Audio is simulated.</p>
            </div>
            <div className="avatar-field">
              <label htmlFor="avatar-preview-text-size">Text size</label>
              <select id="avatar-preview-text-size" value={textSize} onChange={(event) => setTextSize(Number(event.target.value))}>
                <option value="16">Standard (16 px)</option><option value="20">Large (20 px)</option><option value="24">Extra large (24 px)</option>
              </select>
              <p className="avatar-help">Default: standard. Available in every exam mode.</p>
            </div>
            <div className="avatar-field">
              <label className="avatar-check" htmlFor="avatar-preview-reduced-motion">
                <input id="avatar-preview-reduced-motion" type="checkbox" checked={reducedMotion} disabled={forcedReducedMotion} onChange={(event) => setStudentReducedMotion(event.target.checked)} />
                Reduce motion
              </label>
              <p className="avatar-help">{forcedReducedMotion ? "Reduced motion is already required by the instructor or your browser. It remains on." : "Default: follows instructor and browser preferences. You can enable reduced motion at any time."}</p>
              {!settings.presentation.animation && <p className="avatar-help">Animation is disabled by the instructor; the avatar remains still.</p>}
            </div>
            {settings.student.avatar && <div className="avatar-field">
              <label htmlFor="avatar-preview-avatar">Avatar</label>
              <select id="avatar-preview-avatar" value={shownAvatar} onChange={(event) => setAvatar(event.target.value)}>{selectableAvatars.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}</select>
              <p className="avatar-help">Default: {choiceLabel(avatarChoices, settings.presentation.avatar)}. Only instructor-approved choices are listed.</p>
            </div>}
            {settings.student.background && <div className="avatar-field">
              <label htmlFor="avatar-preview-background">Background</label>
              <select id="avatar-preview-background" value={shownBackground} onChange={(event) => setBackground(event.target.value)}>{selectableBackgrounds.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}</select>
              <p className="avatar-help">Default: {choiceLabel(backgroundChoices, settings.presentation.background)}. Only instructor-approved choices are listed.</p>
            </div>}
            {settings.student.speed && <div className="avatar-field">
              <label htmlFor="avatar-preview-speed">Speaking speed: <output>{shownSpeed.toFixed(2)}×</output></label>
              <input id="avatar-preview-speed" type="range" min={settings.student.minSpeed} max={settings.student.maxSpeed} step="0.05" value={shownSpeed} onChange={(event) => setSpeed(Number(event.target.value))} />
              <p className="avatar-help">Default: {settings.presentation.speed.toFixed(2)}×. Allowed: {settings.student.minSpeed.toFixed(2)}–{settings.student.maxSpeed.toFixed(2)}×.</p>
            </div>}
          </div>
          {lockedPreferences.length > 0 && <p className="avatar-policy">Instructor-set preferences: {lockedPreferences.join(", ")}. These choices are unavailable for student changes.</p>}
          <p className="avatar-help">Voice is set by the professor: {choiceLabel(VOICES, settings.presentation.voice)}. Students cannot choose a different voice.</p>
          <p className="avatar-help">State labels remain visible in every state.</p>
        </section>

        <section className="avatar-student-section" aria-labelledby="avatar-synthetic-question-heading">
          <h4 id="avatar-synthetic-question-heading">Synthetic question</h4>
          <p className="avatar-question">{QUESTION}</p>
          <p className="avatar-sample-answer">Synthetic sample response: “It can make changes easier.”</p>
        </section>

        <section className="avatar-student-section" aria-labelledby="avatar-preview-assistance-heading">
          <h4 id="avatar-preview-assistance-heading">Question assistance</h4>
          <p className="avatar-help">Availability follows the instructor’s {mode} policy. Limits apply to this synthetic attempt.</p>
          <div className="avatar-assistance-list">
            {ACTIONS.map((action) => {
              const policy = settings.assistance[action.id];
              const allowed = isAvailable(policy, mode);
              const remaining = Math.max(0, policy.limit - counts[action.id]);
              const reason = !policy.enabled ? "Unavailable: disabled by the instructor." : !allowed ? `Unavailable in ${mode} mode.` : remaining === 0 ? "0 remaining — limit reached for this synthetic attempt." : `${remaining} remaining of ${policy.limit} for this synthetic attempt.`;
              return <div className="avatar-assistance-item" key={action.id}>
                <div>
                  <strong>{action.label}</strong>
                  <p className="avatar-help">{action.description}</p>
                  <p id={`avatar-assistance-${action.id}-policy`} className="avatar-help">{reason}</p>
                  {(action.id === "repeat" || action.id === "clarification") && <p className="avatar-help">Timer policy: {policy.timerContinues ? "continues" : "pauses"} during this action. No live timer runs in this preview.</p>}
                </div>
                <button type="button" disabled={!allowed || remaining === 0} aria-describedby={`avatar-assistance-${action.id}-policy`} onClick={() => requestAssistance(action.id)}>{action.label}</button>
              </div>;
            })}
          </div>
          <div className="avatar-response" role="status" aria-live="polite" aria-atomic="true">
            {response ? <><strong>{response.label}</strong><p>{response.text}</p></> : <p>Available assistance will appear here as text.</p>}
          </div>
        </section>

        <section className="avatar-student-section" aria-labelledby="avatar-behavior-summary-heading">
          <h4 id="avatar-behavior-summary-heading">Professor-set exam behavior</h4>
          <ul className="avatar-summary-list">
            <li>Up to {settings.behavior.followUps} follow-up questions per question.</li>
            <li>Question order: {settings.behavior.order === "authored" ? "as authored by the professor" : "randomized"}.</li>
            <li>Response timing: {settings.behavior.responseTiming === "exam" ? "follows the existing exam timing" : responseTiming}.</li>
            <li>Question difficulty is set by the professor in Question Bank.</li>
          </ul>
          <p className="avatar-help">Students cannot change these rules. This prototype does not change live question delivery, timing, difficulty, or grades.</p>
        </section>
      </div>
    </section>
  );
}
