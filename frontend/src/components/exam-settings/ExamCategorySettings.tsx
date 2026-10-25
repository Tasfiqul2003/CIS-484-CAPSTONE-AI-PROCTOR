import { useEffect, useState } from "react";
import {
  defaultExamSettings, hasCategoryChanges, loadExamSettings,
  saveExamSettingsCategory, validMaxFollowUps,
} from "./examSettings";
import type { ExamSettings, ExamSettingsCategory } from "./examSettings";

export default function ExamCategorySettings({ examId, category }: {
  examId: string;
  category: ExamSettingsCategory;
}) {
  const [settings, setSettings] = useState<ExamSettings>(defaultExamSettings);
  const [savedSettings, setSavedSettings] = useState<ExamSettings>(defaultExamSettings);
  const [loaded, setLoaded] = useState(false);
  const [saved, setSaved] = useState(false);
  const [settingsError, setSettingsError] = useState("");
  const dirty = loaded && hasCategoryChanges(category, settings, savedSettings);

  useEffect(() => {
    setLoaded(false);
    setSaved(false);
    setSettingsError("");
    try {
      const draft = loadExamSettings(localStorage, examId);
      setSettings(draft);
      setSavedSettings(draft);
      setLoaded(true);
    } catch {
      setSettingsError("Unable to load these settings from browser storage. Existing saved data has not been changed.");
    }
  }, [examId, category]);

  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  useEffect(() => {
    if (!saved) return;
    const timer = window.setTimeout(() => setSaved(false), 2500);
    return () => window.clearTimeout(timer);
  }, [saved]);

  const updateSetting = <K extends keyof ExamSettings>(key: K, value: ExamSettings[K]) => {
    setSettings(current => ({ ...current, [key]: value }));
    setSaved(false);
    setSettingsError("");
  };

  const saveSettings = () => {
    if (!loaded) return;
    if (category === "ai-questioning" && settings.followUpQuestions && !validMaxFollowUps(settings.maxFollowUps)) {
      setSettingsError("Maximum Follow-Ups Per Question must be a whole number from 1 to 4.");
      document.getElementById("legacy-max-followups")?.focus();
      return;
    }
    try {
      const next = saveExamSettingsCategory(localStorage, examId, category, settings);
      setSettings(next);
      setSavedSettings(next);
      setSettingsError("");
      setSaved(true);
    } catch {
      setSettingsError("Unable to save these settings in browser storage. Your changes remain unsaved.");
    }
  };

  return (
    <section className="exam-settings-container" aria-label="Category settings">
      <div className="exam-settings-header">
        <div>
          <p className="eyebrow">CONFIGURATION</p>
          <h2>Exam Settings</h2>
          <p>Save this category as a browser-local draft for this exam.</p>
          <p role="status">{dirty ? "Unsaved changes" : loaded ? "No unsaved changes" : "Settings unavailable"}</p>
        </div>
        <button type="button" disabled={!loaded} className={saved ? "settings-save-button saved" : "settings-save-button"} onClick={saveSettings}>
          {saved ? "✓ Settings Saved" : "Save Settings"}
        </button>
      </div>
      <p className="settings-notice">These settings remain separate from Avatar &amp; Interaction drafts, shared previews, and saved exam policies. Saving this category does not change live exam behavior.</p>
      {settingsError && <p id="category-settings-error" role="alert">{settingsError}</p>}
      {loaded && <>
      {category === "time-scheduling" && (
        <div className="settings-section">
          <div className="settings-section-heading">
            <div className="settings-section-icon">
              ⏱
            </div>
            <div>
              <h3>
                Time & Scheduling
              </h3>
              <p>
                Control how long students have to complete
                the oral examination.
              </p>
            </div>
          </div>
          <div className="settings-grid">
            <label className="settings-field">
              <span>
                Standard Time Limit
              </span>
              <div className="settings-input-with-unit">
                <input
                  type="number"
                  min="1"
                  max="240"
                  value={settings.timeLimit}
                  onChange={(e) =>
                    updateSetting(
                      "timeLimit",
                      Number(e.target.value)
                    )
                  }
                />
                <small>
                  minutes
                </small>
              </div>
            </label>
          </div>
        </div>
      )}

      {category === "ods-accommodations" && (
        <div className="settings-section">
          <div className="settings-section-heading">
            <div className="settings-section-icon">
              ♿
            </div>
            <div>
              <h3>
                ODS Accommodations
              </h3>
              <p>
                Configure exam features that can support
                approved testing accommodations.
              </p>
            </div>
          </div>
          <div className="settings-notice">
            <strong>
              Accommodation reminder
            </strong>
            <span>
              These settings provide exam capabilities.
              They do not determine a student's approved
              accommodations.
            </span>
          </div>
          <div className="settings-toggle-list">
            <label className="settings-toggle">
              <div>
                <strong>
                  Extended Time
                </strong>
                <small>
                  Allow the student's approved extended
                  testing time to be applied.
                </small>
              </div>
              <input
                type="checkbox"
                checked={settings.extendedTime}
                onChange={(e) =>
                  updateSetting(
                    "extendedTime",
                    e.target.checked
                  )
                }
              />
            </label>
            {settings.extendedTime && (
              <label className="settings-field nested-setting">
                <span>
                  Extended Time Multiplier
                </span>
                <select
                  value={settings.extendedTimeMultiplier}
                  onChange={(e) =>
                    updateSetting(
                      "extendedTimeMultiplier",
                      Number(e.target.value)
                    )
                  }
                >
                  <option value={1.25}>
                    1.25×
                  </option>
                  <option value={1.5}>
                    1.5×
                  </option>
                  <option value={2}>
                    2×
                  </option>
                  <option value={3}>
                    3×
                  </option>
                </select>
              </label>
            )}
            <label className="settings-toggle">
              <div>
                <strong>
                  Breaks
                </strong>
                <small>
                  Allow approved testing breaks without
                  treating them as answering time.
                </small>
              </div>
              <input
                type="checkbox"
                checked={settings.breaksAllowed}
                onChange={(e) =>
                  updateSetting(
                    "breaksAllowed",
                    e.target.checked
                  )
                }
              />
            </label>
            <label className="settings-toggle">
              <div>
                <strong>
                  Reduced-Distraction Mode
                </strong>
                <small>
                  Minimize unnecessary visual and audio
                  distractions during the examination.
                </small>
              </div>
              <input
                type="checkbox"
                checked={settings.reducedDistraction}
                onChange={(e) =>
                  updateSetting(
                    "reducedDistraction",
                    e.target.checked
                  )
                }
              />
            </label>
            <label className="settings-toggle">
              <div>
                <strong>
                  Assistive Technology
                </strong>
                <small>
                  Allow compatible accessibility and
                  assistive technology features.
                </small>
              </div>
              <input
                type="checkbox"
                checked={settings.assistiveTechnology}
                onChange={(e) =>
                  updateSetting(
                    "assistiveTechnology",
                    e.target.checked
                  )
                }
              />
            </label>
          </div>
        </div>
      )}

      {category === "ai-questioning" && (
        <div className="settings-section">
          <div className="settings-section-heading">
            <div className="settings-section-icon">
              🤖
            </div>
            <div>
              <h3>
                AI Questioning
              </h3>
              <p>
                Control how OralExam AI interacts with
                the student.
              </p>
            </div>
          </div>
          <div className="settings-grid">
            <label className="settings-field">
              <span>
                Number of Questions
              </span>
              <input
                type="number"
                min="1"
                max="100"
                value={settings.questionCount}
                onChange={(e) =>
                  updateSetting(
                    "questionCount",
                    Number(e.target.value)
                  )
                }
              />
            </label>
          </div>
          <p className="settings-notice avatar-question-bank-note">
            Question difficulty is set by the professor in the{" "}
            <a href={`/professor/exams/${examId}/questions`}>Question Bank</a>.
          </p>
          <div className="settings-toggle-list">
            <label className="settings-toggle">
              <div>
                <strong>
                  Follow-Up Questions
                </strong>
                <small>
                  Allow the AI to probe vague or incomplete
                  answers.
                </small>
              </div>
              <input
                type="checkbox"
                checked={settings.followUpQuestions}
                onChange={(e) =>
                  updateSetting(
                    "followUpQuestions",
                    e.target.checked
                  )
                }
              />
            </label>
            {settings.followUpQuestions && (
              <label className="settings-field nested-setting">
                <span id="legacy-followup-label">
                  Maximum Follow-Ups Per Question
                </span>
                <input
                  id="legacy-max-followups"
                  type="number"
                  min="1"
                  max="4"
                  step="1"
                  value={Number.isFinite(settings.maxFollowUps) ? settings.maxFollowUps : ""}
                  aria-labelledby="legacy-followup-label"
                  aria-describedby="legacy-followup-help"
                  aria-invalid={settings.followUpQuestions && (!Number.isInteger(settings.maxFollowUps) || settings.maxFollowUps < 1 || settings.maxFollowUps > 4)}
                  onChange={(e) =>
                    updateSetting(
                      "maxFollowUps",
                      e.target.valueAsNumber
                    )
                  }
                />
                <small id="legacy-followup-help">Enter a whole number from 1 to 4.</small>
              </label>
            )}
            <label className="settings-toggle">
              <div>
                <strong>
                  Allow Rephrasing
                </strong>
                <small>
                  Allow the AI to rephrase a question when
                  the student does not understand it.
                </small>
              </div>
              <input
                type="checkbox"
                checked={settings.allowRephrase}
                onChange={(e) =>
                  updateSetting(
                    "allowRephrase",
                    e.target.checked
                  )
                }
              />
            </label>
            <label className="settings-toggle">
              <div>
                <strong>
                  Allow Hints
                </strong>
                <small>
                  Allow the AI to provide hints when a
                  student is struggling.
                </small>
              </div>
              <input
                type="checkbox"
                checked={settings.allowHints}
                onChange={(e) =>
                  updateSetting(
                    "allowHints",
                    e.target.checked
                  )
                }
              />
            </label>
          </div>
        </div>
      )}

      {category === "recording-transcript" && (
        <div className="settings-section">
          <div className="settings-section-heading">
            <div className="settings-section-icon">
              🎥
            </div>
            <div>
              <h3>
                Recording & Transcript
              </h3>
              <p>
                Choose what information is captured during
                the examination.
              </p>
            </div>
          </div>
          <div className="settings-toggle-list">
            <label className="settings-toggle">
              <div>
                <strong>
                  Record Video
                </strong>
                <small>
                  Save the student's examination video.
                </small>
              </div>
              <input
                type="checkbox"
                checked={settings.recordVideo}
                onChange={(e) =>
                  updateSetting(
                    "recordVideo",
                    e.target.checked
                  )
                }
              />
            </label>
            <label className="settings-toggle">
              <div>
                <strong>
                  Record Audio
                </strong>
                <small>
                  Save the student's spoken responses.
                </small>
              </div>
              <input
                type="checkbox"
                checked={settings.recordAudio}
                onChange={(e) =>
                  updateSetting(
                    "recordAudio",
                    e.target.checked
                  )
                }
              />
            </label>
            <label className="settings-toggle">
              <div>
                <strong>
                  Generate Transcript
                </strong>
                <small>
                  Generate a searchable transcript of
                  the examination.
                </small>
              </div>
              <input
                type="checkbox"
                checked={settings.generateTranscript}
                onChange={(e) =>
                  updateSetting(
                    "generateTranscript",
                    e.target.checked
                  )
                }
              />
            </label>
          </div>
        </div>
      )}

      {category === "ai-results" && (
        <div className="settings-section">
          <div className="settings-section-heading">
            <div className="settings-section-icon">
              📊
            </div>
            <div>
              <h3>
                AI Results
              </h3>
              <p>
                Configure the information generated for
                professor review after the exam.
              </p>
            </div>
          </div>
          <div className="settings-toggle-list">
            <label className="settings-toggle">
              <div>
                <strong>
                  Recommended Grade
                </strong>
                <small>
                  Generate an AI-recommended grade based on
                  the student's responses.
                </small>
              </div>
              <input
                type="checkbox"
                checked={settings.recommendedGrade}
                onChange={(e) =>
                  updateSetting(
                    "recommendedGrade",
                    e.target.checked
                  )
                }
              />
            </label>
            <label className="settings-toggle">
              <div>
                <strong>
                  Generate Feedback
                </strong>
                <small>
                  Provide a summary of strengths, weaknesses,
                  and areas for review.
                </small>
              </div>
              <input
                type="checkbox"
                checked={settings.generateFeedback}
                onChange={(e) =>
                  updateSetting(
                    "generateFeedback",
                    e.target.checked
                  )
                }
              />
            </label>
            <label className="settings-toggle">
              <div>
                <strong>
                  Professor Review Required
                </strong>
                <small>
                  AI results remain recommendations until
                  reviewed by the professor.
                </small>
              </div>
              <input
                type="checkbox"
                checked={settings.professorReview}
                onChange={(e) =>
                  updateSetting(
                    "professorReview",
                    e.target.checked
                  )
                }
              />
            </label>
          </div>
        </div>
      )}

      </>}
    </section>
  );
}
