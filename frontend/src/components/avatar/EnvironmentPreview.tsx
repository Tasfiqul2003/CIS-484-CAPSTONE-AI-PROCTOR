import { useEffect, useState } from "react";
import ExamStageAvatar from "./ExamStageAvatar";
import { environmentPresentation, type EnvironmentPresentation } from "./environmentPresentation";
import type { StudentPreferences } from "../student-settings/studentSettings";
import "./environment-preview.css";

/** Pre-attempt settings only: no devices, clocks, questions or attempt creation. */
export default function EnvironmentPreview({ onContinue }: { onContinue: (preferences: StudentPreferences) => void }) {
  const [presentation, setPresentation] = useState<EnvironmentPresentation | null>(null);
  const [preferences, setPreferences] = useState<StudentPreferences | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [reload, setReload] = useState(0);
  const [identity] = useState(() => {
    const params = new URLSearchParams(window.location.search);
    const examId = params.get("templateId") ?? "";
    const studentId = params.get("studentId") ?? "";
    const token = sessionStorage.getItem(`oralexam_exam_token:${examId}:${studentId}`) ?? "";
    const valid = !!examId && !!studentId && sessionStorage.getItem("oralexam_student_id") === studentId
      && sessionStorage.getItem("oralexam_face_check_passed") === "true";
    return { examId, token: valid ? token : "" };
  });
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true); setError(""); setPresentation(null); setPreferences(null);
    environmentPresentation(identity.examId, identity.token, controller.signal).then(value => {
      if (!controller.signal.aborted) { setPresentation(value); setPreferences(value.preferences); }
    }).catch(failure => {
      if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : "Unable to load the environment preview.");
    }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [identity, reload]);

  async function confirm() {
    if (!presentation || !preferences || saving) return;
    setSaving(true); setError("");
    try {
      const saved = await environmentPresentation(identity.examId, identity.token, undefined,
        { preferences, expected_revision: presentation.revision });
      onContinue(saved.preferences);
    } catch (failure) { setError(failure instanceof Error ? failure.message : "Unable to save preferences."); }
    finally { setSaving(false); }
  }

  return <div className="student-exam-page"><main className="student-exam-content">
    <section className="exam-question-card environment-preview" aria-labelledby="environment-preview-heading">
      <h1 id="environment-preview-heading">Choose your examiner environment</h1>
      <p>Preview the examiner's background before your exam begins. This preview does not start the timer or use your camera or microphone.</p>
      {loading && <p role="status">Loading permitted environments…</p>}
      {!loading && presentation && preferences && <>
        {presentation.notice && <p role="status">{presentation.notice}</p>}
        <ExamStageAvatar avatar={preferences.avatar} background={preferences.background}
          customAvatar={presentation.policy.defaults.customAvatar} customBackground={presentation.policy.defaults.customBackground}
          reducedMotion state="Idle" />
        {presentation.policy.allowBackground ? <fieldset disabled={saving}>
          <legend>Examiner background</legend>
          <div className="environment-preview-choices">
            {presentation.policy.backgroundChoices.map(choice => <label key={choice.id} className={choice.id === preferences.background ? "environment-selected" : ""}>
              <input type="radio" name="examiner-environment" value={choice.id} checked={preferences.background === choice.id}
                onChange={() => setPreferences({ ...preferences, background: choice.id })} />
              <span>{choice.label}</span>
            </label>)}
          </div>
        </fieldset> : <p>Your professor has fixed the examiner environment: {presentation.policy.backgroundChoices.find(choice => choice.id === preferences.background)?.label}.</p>}
        <p>You will review the recording notice next. Your exam begins only after you explicitly start it.</p>
        <button type="button" className="confirmation-submit-button" disabled={saving} onClick={() => void confirm()}>{saving ? "Saving preferences…" : "Save and continue to recording notice"}</button>
      </>}
      {error && <div role="alert"><p>{error}</p><button type="button" disabled={loading || saving} onClick={() => setReload(value => value + 1)}>Reload current policy</button></div>}
      <p><a href="/student/exams">Return to exams</a></p>
    </section>
  </main></div>;
}
