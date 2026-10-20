import { useEffect, useId, useRef, type KeyboardEvent } from "react";
import type { StudentPolicy, StudentPreferences } from "./studentSettings";
import "./student-settings-panel.css";

type StudentSettingsPanelProps = {
  open: boolean;
  policy: StudentPolicy;
  preferences: StudentPreferences;
  onChange: (preferences: StudentPreferences) => void;
  onClose: () => void;
  onSave: () => void;
  onReset: () => void;
  dirty: boolean;
  status: string;
  error: string;
  browserReducedMotion: boolean;
};

export default function StudentSettingsPanel({
  open, policy, preferences, onChange, onClose, onSave, onReset,
  dirty, status, error, browserReducedMotion,
}: StudentSettingsPanelProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const ignoreCloseEvent = useRef(false);
  const id = useId();
  // Required reduced motion stays on; its optional switch is omitted below.
  const forcedReducedMotion = policy.defaults.reducedMotion || browserReducedMotion;
  const reducedMotion = forcedReducedMotion || preferences.reducedMotion;

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      dialog.showModal();
      headingRef.current?.focus();
    } else if (!open && dialog.open) {
      // Closing from a prop change must not request another parent close.
      ignoreCloseEvent.current = true;
      dialog.close();
    }
  }, [open]);

  function change<K extends keyof StudentPreferences>(key: K, value: StudentPreferences[K]) {
    onChange({ ...preferences, [key]: value });
  }

  function keepTabFocusInPanel(event: KeyboardEvent<HTMLDialogElement>) {
    if (event.key !== "Tab" || event.altKey || event.ctrlKey || event.metaKey) return;
    const dialog = event.currentTarget;
    // Only visible, enabled controls participate in the dialog's keyboard focus loop.
    const controls = Array.from(dialog.querySelectorAll<HTMLElement>("button, input, select, textarea, a[href], [tabindex]"))
      .filter((element) => element.tabIndex >= 0 && !element.matches(":disabled") && element.getClientRects().length > 0 && window.getComputedStyle(element).visibility !== "hidden");
    const first = controls[0];
    const last = controls[controls.length - 1];
    if (!first || !last) {
      event.preventDefault();
      headingRef.current?.focus();
      return;
    }
    const active = dialog.ownerDocument.activeElement;
    if (event.shiftKey && (active === first || active === headingRef.current || active === dialog || !dialog.contains(active))) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && active === last) {
      event.preventDefault();
      first.focus();
    }
  }

  return (
    <dialog ref={dialogRef} className="student-settings-panel" role="dialog" aria-modal="true" aria-labelledby={`${id}-heading`} aria-describedby={`${id}-description`} style={{ fontSize: `${preferences.textSize}px` }}
      onKeyDown={keepTabFocusInPanel}
      onCancel={(event) => { event.preventDefault(); onClose(); }}
      onClose={() => {
        if (ignoreCloseEvent.current) { ignoreCloseEvent.current = false; return; }
        if (open) onClose();
      }}>
      <header className="student-settings-panel-header">
        <h2 id={`${id}-heading`} tabIndex={-1} ref={headingRef}>Student settings</h2>
        <button type="button" className="student-settings-close" onClick={onClose}>Close Settings</button>
      </header>
      <form onSubmit={(event) => { event.preventDefault(); onSave(); }}>
        <div className="student-settings-panel-content">
          <p id={`${id}-description`} className="student-settings-description">Presentation preferences take effect immediately. Save keeps your preferences in this browser.</p>
          <section className="student-settings-group" aria-labelledby={`${id}-accessibility-heading`}>
            <h3 id={`${id}-accessibility-heading`}>Comfort and accessibility</h3>
            <div className="student-settings-field">
              <label htmlFor={`${id}-volume`}>Volume</label>
              <div className="student-settings-slider-row">
                <input id={`${id}-volume`} type="range" min="0" max="100" step="1" value={preferences.volume} aria-valuetext={`${preferences.volume}%`} aria-describedby={`${id}-volume-help`} onChange={(event) => change("volume", Number(event.currentTarget.value))} />
                <output htmlFor={`${id}-volume`}>{preferences.volume}%</output>
              </div>
              <p id={`${id}-volume-help`} className="student-settings-help">0% represents mute. Audio is simulated in this preview.</p>
            </div>
            <div className="student-settings-field">
              <label htmlFor={`${id}-text-size`}>Text size</label>
              <select id={`${id}-text-size`} value={preferences.textSize} aria-describedby={`${id}-text-size-help`} onChange={(event) => change("textSize", Number(event.currentTarget.value) as StudentPreferences["textSize"])}>
                <option value="16">Standard (16 px)</option><option value="20">Large (20 px)</option><option value="24">Extra large (24 px)</option>
              </select>
              <p id={`${id}-text-size-help`} className="student-settings-help">Adjusts question, assistance, and settings text.</p>
            </div>
            {!forcedReducedMotion && <div className="student-settings-field">
              <label className="student-settings-check" htmlFor={`${id}-reduced-motion`}>
                <input id={`${id}-reduced-motion`} type="checkbox" checked={reducedMotion} aria-describedby={`${id}-reduced-motion-help`} onChange={(event) => change("reducedMotion", event.currentTarget.checked)} /><span>Reduce motion</span>
              </label>
              <p id={`${id}-reduced-motion-help`} className="student-settings-help">You can turn reduced motion on at any time.</p>
            </div>}
          </section>
          {(policy.allowAvatar || policy.allowBackground || policy.allowSpeed) && <section className="student-settings-group" aria-labelledby={`${id}-presentation-heading`}>
            <h3 id={`${id}-presentation-heading`}>Presentation</h3>
            {policy.allowAvatar && <div className="student-settings-field">
              <label htmlFor={`${id}-avatar`}>Avatar</label>
              <select id={`${id}-avatar`} value={preferences.avatar} aria-describedby={`${id}-avatar-help`} onChange={(event) => change("avatar", event.currentTarget.value)}>{policy.avatarChoices.map((choice) => <option key={choice.id} value={choice.id}>{choice.label}</option>)}</select>
              <p id={`${id}-avatar-help`} className="student-settings-help">Choose from the avatars your instructor has made available.</p>
            </div>}
            {policy.allowBackground && <div className="student-settings-field">
              <label htmlFor={`${id}-background`}>Background</label>
              <select id={`${id}-background`} value={preferences.background} aria-describedby={`${id}-background-help`} onChange={(event) => change("background", event.currentTarget.value)}>{policy.backgroundChoices.map((choice) => <option key={choice.id} value={choice.id}>{choice.label}</option>)}</select>
              <p id={`${id}-background-help`} className="student-settings-help">Choose from the backgrounds your instructor has made available.</p>
            </div>}
            {policy.allowSpeed && <div className="student-settings-field">
              <label htmlFor={`${id}-speed`}>Speaking speed</label>
              <div className="student-settings-slider-row">
                <input id={`${id}-speed`} type="range" min={policy.minSpeed} max={policy.maxSpeed} step="0.05" value={preferences.speed} aria-valuetext={`${preferences.speed.toFixed(2)}× normal speed`} aria-describedby={`${id}-speed-help`} onChange={(event) => change("speed", Number(event.currentTarget.value))} />
                <output htmlFor={`${id}-speed`}>{preferences.speed.toFixed(2)}×</output>
              </div>
              <p id={`${id}-speed-help`} className="student-settings-help">Available range: {policy.minSpeed.toFixed(2)}–{policy.maxSpeed.toFixed(2)}× normal speed.</p>
            </div>}
          </section>}
          <p className="student-settings-status" role="status" aria-live="polite" aria-atomic="true">{dirty ? "Unsaved preferences." : "No unsaved changes."}{status ? ` ${status}` : ""}</p>
          {error && <p className="student-settings-error" role="alert">{error}</p>}
        </div>
        <footer className="student-settings-panel-footer">
          <button type="submit" className="student-settings-save">Save Preferences</button>
          <button type="button" className="student-settings-reset" onClick={onReset}>Reset Preferences</button>
          <p className="student-settings-help">Reset restores personal preferences. Question assistance usage is unchanged.</p>
        </footer>
      </form>
    </dialog>
  );
}
