
import { useCallback, useEffect, useState } from "react";

type Question = {
  id: string;
  question_text: string;
  topic: string | null;
  difficulty: number | null;
  created_at: string;
};

function getExamId(): string | null {
  const match = window.location.pathname.match(
    /^\/professor\/exams\/([^/]+)\/questions\/?$/
  );

  return match?.[1] ?? null;
}

async function readResponse(response: Response) {
  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    const detail = data?.detail;
    const message =
      typeof detail === "string"
        ? detail
        : detail
          ? JSON.stringify(detail)
          : "The request failed.";

    throw new Error(message);
  }

  return data;
}

export default function QuestionBank() {
  const examId = getExamId();

  const [questions, setQuestions] = useState<Question[]>([]);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [preview, setPreview] = useState<Question | null>(null);

  const loadQuestions = useCallback(async () => {
    if (!examId) {
      setError(
        "Invalid exam ID. Open Questions from a specific exam's Manage Exam page."
      );
      setQuestions([]);
      setLoading(false);
      return;
    }

    try {
      setError("");

      const response = await fetch(
        `/api/exam/templates/${examId}/questions`,
        { credentials: "include" }
      );

      const data = await readResponse(response);
      setQuestions(data);
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : "Unable to load examination questions."
      );
    } finally {
      setLoading(false);
    }
  }, [examId]);

  useEffect(() => {
    void loadQuestions();
  }, [loadQuestions]);

  async function handleFileChange(
    event: React.ChangeEvent<HTMLInputElement>
  ) {
    const input = event.currentTarget;
    const file = input.files?.[0];

    if (!file || !examId) return;

    const formData = new FormData();
    formData.append("file", file);

    setUploading(true);
    setError("");

    try {
      const response = await fetch(
        `/api/exam/templates/${examId}/questions`,
        {
          method: "POST",
          credentials: "include",
          body: formData,
        }
      );

      const data = await readResponse(response);
      await loadQuestions();

      window.alert(
        `Upload complete. ${data.questions_added ?? 0} questions added from ${data.filename ?? file.name}.`
      );
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : "Unable to upload the question file."
      );
    } finally {
      setUploading(false);
      input.value = "";
    }
  }

  async function deleteQuestion(question: Question) {
    if (!examId) return;

    const confirmed = window.confirm(
      `Delete this question?\n\n"${question.question_text}"`
    );

    if (!confirmed) return;

    setDeletingId(question.id);
    setError("");

    try {
      const response = await fetch(
        `/api/exam/templates/${examId}/questions/${question.id}`,
        {
          method: "DELETE",
          credentials: "include",
        }
      );

      await readResponse(response);

      setQuestions((current) =>
        current.filter((item) => item.id !== question.id)
      );

      if (preview?.id === question.id) {
        setPreview(null);
      }
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : "Unable to delete the question."
      );
    } finally {
      setDeletingId(null);
    }
  }

  return (
    <div className="question-bank-page">
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

      <main className="question-bank-content">
      <button
        type="button"
        className="back-to-exam-button"
        onClick={() => {
          window.location.href = examId
            ? `/professor/exams/${examId}`
            : "/professor/exams";
        }}
      >
        ← Back to Exam
      </button>


        <div className="question-bank-heading">
          <p className="eyebrow">PROFESSOR PORTAL</p>
          <h1>Question Bank</h1>
          <p>
            Import questions for this examination, review them, and manage
            the questions your oral exam can use.
          </p>
        </div>

        {error && (
          <div className="question-error" role="alert">
            <span>{error}</span>
            <button type="button" onClick={() => void loadQuestions()}>
              Retry
            </button>
          </div>
        )}

        <section className="question-builder">
          <div className="section-heading">
            <p className="eyebrow">UPLOAD QUESTIONS</p>
            <h2>Import Question Bank</h2>
          </div>

          <label className="question-upload-zone">
            <input
              type="file"
              accept=".csv,.txt,.docx,.pdf,.pptx"
              disabled={uploading || !examId}
              onChange={handleFileChange}
            />

            <div className="question-upload-icon">↑</div>

            <strong>
              {uploading ? "Uploading questions..." : "Upload your questions"}
            </strong>

            <p>CSV, TXT, DOCX, PDF, or PPTX</p>

            <span className="choose-file-button">
              {uploading ? "Please wait..." : "Choose Question File"}
            </span>
          </label>

          <div className="question-upload-help">
            <strong>Recommended format</strong>
            <p>
              Use one question per CSV row or TXT line. For documents and
              slides, clearly separate each question.
            </p>
          </div>
        </section>

        <section className="question-list">
          <div className="question-list-heading">
            <div>
              <p className="eyebrow">EXAMINATION CONTENT</p>
              <h2>Saved Questions</h2>
            </div>

            <span className="question-count">{questions.length}</span>
          </div>

          {loading ? (
            <p className="question-status">Loading saved questions...</p>
          ) : questions.length === 0 ? (
            <div className="empty-question-list">
              <div className="empty-icon">?</div>
              <h3>No questions yet</h3>
              <p>
                Upload a question file above. Questions saved to this exam
                will appear here.
              </p>
            </div>
          ) : (
            <div className="question-items">
              {questions.map((question, index) => (
                <article className="question-item" key={question.id}>
                  <div className="question-number">{index + 1}</div>

                  <div className="question-item-content">
                    <span>
                      {question.topic?.trim() || "EXAM QUESTION"}
                    </span>

                    <h3>{question.question_text}</h3>

                    <p>
                      {question.difficulty != null
                        ? `Difficulty: ${question.difficulty}/5`
                        : "Difficulty not assigned"}
                      {" · "}
                      Added{" "}
                      {new Date(question.created_at).toLocaleDateString()}
                    </p>
                  </div>

                  <div className="question-actions">
                    <button
                      type="button"
                      className="preview-question"
                      onClick={() => setPreview(question)}
                    >
                      Preview
                    </button>

                    <button
                      type="button"
                      className="delete-question"
                      disabled={deletingId === question.id}
                      onClick={() => void deleteQuestion(question)}
                    >
                      {deletingId === question.id ? "Deleting..." : "Delete"}
                    </button>
                  </div>
                </article>
              ))}
            </div>
          )}
        </section>

        {preview && (
          <div
            className="question-preview-overlay"
            onClick={(event) => {
              if (event.target === event.currentTarget) {
                setPreview(null);
              }
            }}
          >
            <section
              className="question-preview-modal"
              role="dialog"
              aria-modal="true"
              aria-labelledby="question-preview-title"
            >
              <div className="question-preview-header">
                <div>
                  <p className="eyebrow">QUESTION PREVIEW</p>
                  <h2 id="question-preview-title">Examination Question</h2>
                </div>

                <button
                  type="button"
                  className="question-preview-close"
                  aria-label="Close preview"
                  onClick={() => setPreview(null)}
                >
                  ×
                </button>
              </div>

              <div className="question-preview-body">
                <p className="question-preview-label">
                  {preview.topic?.trim() || "GENERAL QUESTION"}
                </p>

                <p className="question-preview-text">
                  {preview.question_text}
                </p>

                <div className="question-preview-meta">
                  <span>
                    Difficulty:{" "}
                    {preview.difficulty != null
                      ? `${preview.difficulty}/5`
                      : "Not assigned"}
                  </span>

                  <span>
                    Added{" "}
                    {new Date(preview.created_at).toLocaleDateString()}
                  </span>
                </div>
              </div>

              <div className="question-preview-footer">
                <button
                  type="button"
                  onClick={() => setPreview(null)}
                >
                  Close Preview
                </button>
              </div>
            </section>
          </div>
        )}
      </main>
    </div>
  );
}
