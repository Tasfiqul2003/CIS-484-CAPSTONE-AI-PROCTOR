import { useEffect, useState } from "react";
import {
  defaultExamSettings, hasCategoryChanges, loadExamSettings,
  saveExamSettingsCategory, validMaxFollowUps, validTimeLimit, validQuestionTimeLimit,
} from "./examSettings";
import type { ExamSettings, ExamSettingsCategory } from "./examSettings";
import "./category-settings.css";

export default function ExamCategorySettings({ examId, category }: {
  examId: string;
  category: ExamSettingsCategory;
}) {
  const [settings, setSettings] = useState<ExamSettings>(defaultExamSettings);
  const [savedSettings, setSavedSettings] = useState<ExamSettings>(defaultExamSettings);
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [settingsError, setSettingsError] = useState("");
  const dirty = loaded && hasCategoryChanges(category, settings, savedSettings);

  useEffect(() => {
    setLoaded(false);
    setSaved(false);
    setSettingsError("");
    const controller = new AbortController();
    async function load() {
      try {
        const draft = loadExamSettings(localStorage, examId);
        if (category === "time-scheduling") {
          const response = await fetch(`/api/exam/templates/${encodeURIComponent(examId)}/time-settings`, {
            credentials: "include", signal: controller.signal,
          });
          if (!response.ok) throw new Error("Unable to load the saved time limits from the server.");
          const data = await response.json();
          if (!data || typeof data !== "object" || Array.isArray(data)) {
            throw new Error("The server returned invalid time settings. Reload to try again.");
          }
          if ((data.time_limit_minutes !== null && !validTimeLimit(data.time_limit_minutes)) ||
              !validQuestionTimeLimit(data.question_time_limit_minutes)) {
            setSettingsError("A saved time limit is outside 1-240 minutes. Enter a valid time or disable the question limit, then save to correct it.");
          }
          draft.timeLimit = validTimeLimit(data.time_limit_minutes) ? data.time_limit_minutes : NaN;
          draft.questionTimeLimit = validQuestionTimeLimit(data.question_time_limit_minutes) ? data.question_time_limit_minutes : NaN;
        }
        if (controller.signal.aborted) return;
        setSettings(draft);
        setSavedSettings(draft);
        setLoaded(true);
      } catch (error) {
        if (!controller.signal.aborted) setSettingsError(error instanceof Error ? error.message : "Unable to load settings.");
      }
    }
    void load();
    return () => controller.abort();
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

  const saveSettings = async () => {
    if (!loaded || saving) return;
    if (category === "time-scheduling" && !validTimeLimit(settings.timeLimit)) {
      setSettingsError("Time per exam must be a whole number from 1 to 240 minutes.");
      document.getElementById("exam-time-limit")?.focus();
      return;
    }
    if (category === "time-scheduling" && !validQuestionTimeLimit(settings.questionTimeLimit)) {
      setSettingsError("Time per question must be a whole number from 1 to 240 minutes, or disabled.");
      document.getElementById("question-time-limit")?.focus();
      return;
    }
    if (category === "ai-questioning" && settings.followUpQuestions && !validMaxFollowUps(settings.maxFollowUps)) {
      setSettingsError("Maximum Follow-Ups Per Question must be a whole number from 1 to 4.");
      document.getElementById("legacy-max-followups")?.focus();
      return;
    }
    setSaving(true);
    try {
      let next = settings;
      if (category === "time-scheduling") {
        const response = await fetch(`/api/exam/templates/${encodeURIComponent(examId)}/time-settings`, {
          method: "PUT", credentials: "include", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ time_limit_minutes: settings.timeLimit, question_time_limit_minutes: settings.questionTimeLimit }),
        });
        if (!response.ok) throw new Error("Unable to save the time limits to the server. Your changes remain unsaved.");
        const data = await response.json();
        if (!data || !validTimeLimit(data.time_limit_minutes) || !validQuestionTimeLimit(data.question_time_limit_minutes)) {
          throw new Error("The server returned invalid time limits. Reload to verify the saved values.");
        }
        next = { ...settings, timeLimit: data.time_limit_minutes, questionTimeLimit: data.question_time_limit_minutes };
      } else {
        next = saveExamSettingsCategory(localStorage, examId, category, settings);
      }
      setSettings(next);
      setSavedSettings(next);
      setSettingsError("");
      setSaved(true);
    } catch (error) {
      setSettingsError(error instanceof Error ? error.message : "Unable to save settings. Your changes remain unsaved.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="exam-settings-container category-settings" aria-label="Category settings" aria-busy={saving}>
      <div className="exam-settings-header">
        <div>
          <p className="eyebrow">CONFIGURATION</p>
          <h2>Exam Settings</h2>
          <p>{category === "time-scheduling" ? "Set time per question and time per exam for new attempts." : "Save this category as a browser-local draft for this exam."}</p>
          <p role="status">{dirty ? "Unsaved changes" : loaded ? "No unsaved changes" : settingsError ? "Settings unavailable" : "Loading settings..."}</p>
        </div>
        <button type="button" disabled={!loaded || saving} className={saved ? "settings-save-button saved" : "settings-save-button"} onClick={saveSettings}>
          {saving ? "Saving..." : saved ? "✓ Settings Saved" : "Save Settings"}
        </button>
      </div>
      <p className="settings-notice">{category === "time-scheduling" ? "Saved time limits apply to new attempts. Existing attempts keep their starting limits. The exam ends when its total time runs out, even if time remains for a question." : <>These settings remain separate from Avatar &amp; Interaction drafts, shared previews, and saved exam policies. Saving this category does not change live exam behavior.</>}</p>
      {settingsError && <p id="category-settings-error" role="alert">{settingsError}</p>}
      {loaded && <>
      {category === "time-scheduling" && (
        <div className="settings-section">
          <div className="settings-section-heading">
            <div className="settings-section-icon" aria-hidden="true">
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
          <p>Choose a total exam time and, optionally, a separate limit for each question.</p>
          <div className="settings-grid">
            <label className="settings-field">
              <span>
                Time per exam
              </span>
              <div className="settings-input-with-unit">
                <input
                  id="exam-time-limit"
                  disabled={saving}
                  type="number"
                  min="1"
                  max="240"
                  step="1"
                  required
                  aria-invalid={!validTimeLimit(settings.timeLimit)}
                  aria-describedby={`exam-time-help${settingsError ? " category-settings-error" : ""}`}
                  value={Number.isNaN(settings.timeLimit) ? "" : settings.timeLimit}
                  onChange={(e) =>
                    updateSetting(
                      "timeLimit",
                      e.target.valueAsNumber
                    )
                  }
                />
                <small>
                  minutes
                </small>
              </div>
              <small id="exam-time-help">1–240 minutes for the whole exam.</small>
            </label>
            <div className="category-question-limit">
              <label className="settings-toggle">
                <div>
                  <strong>Limit time per question</strong>
                  <small>Give each question its own answering time.</small>
                </div>
                <input
                  id="question-time-limit-enabled"
                  type="checkbox"
                  disabled={saving}
                  checked={settings.questionTimeLimit !== null}
                  aria-controls={settings.questionTimeLimit !== null ? "question-time-limit-controls" : undefined}
                  onChange={(event) => updateSetting("questionTimeLimit", event.target.checked ? 2 : null)}
                />
              </label>
              {settings.questionTimeLimit !== null && (
                <label id="question-time-limit-controls" className="settings-field nested-setting">
                  <span>Time per question</span>
                  <div className="settings-input-with-unit">
                    <input
                      id="question-time-limit"
                      type="number"
                      min="1"
                      max="240"
                      step="1"
                      required
                      disabled={saving}
                      value={Number.isFinite(settings.questionTimeLimit) ? settings.questionTimeLimit : ""}
                      aria-invalid={!validTimeLimit(settings.questionTimeLimit)}
                      aria-describedby={`question-time-help${settingsError ? " category-settings-error" : ""}`}
                      onChange={(event) => updateSetting("questionTimeLimit", event.target.valueAsNumber)}
                    />
                    <small>minutes</small>
                  </div>
                  <small id="question-time-help">1–240 minutes per question. When time runs out, the question advances as unanswered. Submit before the timer reaches zero.</small>
                </label>
              )}
              {settings.questionTimeLimit === null && <p className="settings-notice">No separate question limit. The total exam time still applies.</p>}
            </div>
          </div>
          <p className="settings-notice">Approved extended time is assigned by student EID in{" "}
            <a href={`/professor/exams/${encodeURIComponent(examId)}/settings/ods-accommodations`}>ODS Accommodations</a>.
            {" "}It applies only to the total exam time for that student's new attempts. Time per question stays unchanged.
          </p>
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
