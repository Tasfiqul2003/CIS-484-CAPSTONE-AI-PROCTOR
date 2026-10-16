import { useEffect, useState } from "react";
import AvatarSettings from "../../components/avatar/AvatarSettings";

type Exam = {
  id: string;
  title: string;
  course: string;
  description?: string;
  icon?: string;
};

type ExamSettings = {
  timeLimit: number;
  extendedTime: boolean;
  extendedTimeMultiplier: number;
  breaksAllowed: boolean;
  reducedDistraction: boolean;
  assistiveTechnology: boolean;

  questionCount: number;
  followUpQuestions: boolean;
  maxFollowUps: number;
  allowRephrase: boolean;
  allowHints: boolean;

  recordVideo: boolean;
  recordAudio: boolean;
  generateTranscript: boolean;

  recommendedGrade: boolean;
  generateFeedback: boolean;
  professorReview: boolean;
};

const defaultSettings: ExamSettings = {
  timeLimit: 30,

  extendedTime: false,
  extendedTimeMultiplier: 1.5,
  breaksAllowed: true,
  reducedDistraction: false,
  assistiveTechnology: false,

  questionCount: 10,
  followUpQuestions: true,
  maxFollowUps: 2,
  allowRephrase: true,
  allowHints: false,

  recordVideo: true,
  recordAudio: true,
  generateTranscript: true,

  recommendedGrade: true,
  generateFeedback: true,
  professorReview: true,
};


export default function ManageExam() {
  const [exam, setExam] = useState<Exam | null>(null);

  const [settings, setSettings] =
    useState<ExamSettings>(defaultSettings);

  const [saved, setSaved] = useState(false);
  const [settingsError, setSettingsError] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    async function loadExam() {
      try {
        const match = window.location.pathname.match(
          /^\/professor\/exams\/([^/]+)$/
        );

        if (!match) {
          throw new Error("Invalid exam URL.");
        }

        const examId = match[1];

        const response = await fetch(
          "/api/auth/professor/exams",
          { credentials: "include" }
        );

        if (!response.ok) {
          throw new Error("Unable to load your examinations.");
        }

        const exams: Exam[] = await response.json();

        const selectedExam = exams.find(
          (item) => item.id === examId
        );

        if (!selectedExam) {
          throw new Error(
            "Exam not found, or you do not have permission to access it."
          );
        }

        setExam(selectedExam);

        const savedSettings = localStorage.getItem(
          `oralExamSettings-${window.location.pathname}`
        );

        if (savedSettings) {
          setSettings({
            ...defaultSettings,
            ...JSON.parse(savedSettings),
          });
        }
      } catch (err) {
        setError(
          err instanceof Error
            ? err.message
            : "Unable to load the examination."
        );
      } finally {
        setLoading(false);
      }
    }

    loadExam();
  }, []);


  if (loading) {
  return (
    <main className="professor-dashboard-content">
      <p>Loading examination...</p>
    </main>
  );
}

if (error || !exam) {
  return (
    <main className="professor-dashboard-content">
      <p role="alert">
        {error || "Examination not found."}
      </p>
      <a href="/professor/dashboard">Return to Dashboard</a>
    </main>
  );
}


  const updateSetting = <K extends keyof ExamSettings>(
    key: K,
    value: ExamSettings[K]
  ) => {
    setSettings((current) => ({
      ...current,
      [key]: value,
    }));

    setSaved(false);
    setSettingsError("");
  };

  const saveSettings = () => {
    if (settings.followUpQuestions && (!Number.isInteger(settings.maxFollowUps) || settings.maxFollowUps < 1 || settings.maxFollowUps > 4)) {
      setSettingsError("Maximum Follow-Ups Per Question must be a whole number from 1 to 4.");
      document.getElementById("legacy-max-followups")?.focus();
      return;
    }
    // Older local drafts may contain the removed page-level difficulty field.
    // Keep the stored draft untouched on load, and omit that field on the next save.
    const { difficulty: _removedDifficulty, ...retainedSettings } = settings as ExamSettings & { difficulty?: unknown };
    const nextSettings = {
      ...retainedSettings,
      maxFollowUps: Number.isInteger(settings.maxFollowUps) && settings.maxFollowUps >= 1 && settings.maxFollowUps <= 4 ? settings.maxFollowUps : defaultSettings.maxFollowUps,
    };
    try {
      localStorage.setItem(
        `oralExamSettings-${window.location.pathname}`,
        JSON.stringify(nextSettings)
      );
    } catch {
      setSettingsError("Unable to save these settings in browser storage.");
      return;
    }
    setSettings(nextSettings);
    setSettingsError("");

    setSaved(true);

    setTimeout(() => {
      setSaved(false);
    }, 2500);
  };

  return (
    <div className="professor-dashboard-page">

      <header className="simple-header">

        <div className="logo">
          <span className="logo-icon">◉</span>
          <span>OralExam AI</span>
        </div>

        <button
          type="button"
          className="dashboard-logout"
          onClick={async () => {
            try {
              await fetch("/api/auth/logout", {
                method: "POST",
                credentials: "include",
              });
            } finally {
              window.location.href = "/professor/login";
            }
          }}
        >
          Log Out
        </button>

      </header>

      <main className="professor-dashboard-content">

        <a
          href="/professor/dashboard"
          className="back-to-exam-button"
        >
          ← Back to Dashboard
        </a>

        {/* EXAM HEADER */}

        <section className="manage-exam-header">

          <div className="manage-exam-title">

            <div className="manage-exam-icon">
              {exam.icon || "🎓"}
            </div>

            <div>

              <p className="eyebrow">
                EXAM MANAGEMENT
              </p>

              <h1>
               {exam.title}
              </h1>

              <p>
                {exam.course}
                {exam.description
                  ? ` • ${exam.description}`
                  : ""}
              </p>

            </div>

          </div>

          <span className="exam-status-badge">
            Active
          </span>

        </section>

        {/* MANAGEMENT NAVIGATION */}

        <section className="manage-exam-options">

          <a
            href={`/professor/exams/${exam.id}/questions`}
            className="manage-exam-card"
          >

            <div className="manage-exam-card-icon">
              📚
            </div>

            <div className="manage-exam-card-content">

              <span className="manage-exam-card-label">
                QUESTIONS
              </span>

              <h2>
                Question Bank
              </h2>

              <p>
                View, add, edit, and organize the
                questions used during this exam.
              </p>

              <span className="manage-exam-card-link">
                View Question Bank →
              </span>

            </div>

          </a>

          <a
            href={`/professor/exams/${exam.id}/materials`}
            className="manage-exam-card"
          >

            <div className="manage-exam-card-icon">
              📁
            </div>

            <div className="manage-exam-card-content">

              <span className="manage-exam-card-label">
                MATERIALS
              </span>

              <h2>
                Course Materials
              </h2>

              <p>
                View and manage documents and study
                materials used by the AI.
              </p>

              <span className="manage-exam-card-link">
                View Course Materials →
              </span>

            </div>

          </a>

        </section>

        <AvatarSettings examId={exam.id} />

        {/* SETTINGS */}

        <section className="exam-settings-container">

          <div className="exam-settings-header">

            <div>

              <p className="eyebrow">
                CONFIGURATION
              </p>

              <h2>
                Exam Settings
              </h2>

              <p>
                Configure how the AI conducts and records
                this examination.
              </p>

            </div>

            <button
              type="button"
              className={
                saved
                  ? "settings-save-button saved"
                  : "settings-save-button"
              }
              onClick={saveSettings}
            >
              {saved ? "✓ Settings Saved" : "Save Settings"}
            </button>

          </div>

          {/* TIME */}

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

          {/* ODS */}

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

          {/* AI QUESTIONING */}

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
              <a href={`/professor/exams/${exam.id}/questions`}>Question Bank</a>.
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

              {settingsError && <p id="legacy-followup-error" role="alert">{settingsError}</p>}

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

          {/* RECORDING */}

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

          {/* AI RESULTS */}

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

        </section>

      </main>

      <footer className="home-footer">

        <p>
          OralExam AI
        </p>

        <p>
          AI-assisted oral examination platform
        </p>

      </footer>

    </div>
  );
}
