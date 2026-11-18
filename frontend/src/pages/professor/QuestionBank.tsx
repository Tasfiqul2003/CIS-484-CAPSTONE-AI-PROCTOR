
import { useCallback, useEffect, useRef, useState } from "react";
import QuestionDrafts from "../../components/exam/QuestionDrafts";
import {useRequestScope} from "../../components/exam/useRequestScope";
import type {RequestScope} from "../../components/exam/useRequestScope";
import OralExamMark from "../../components/brand/OralExamMark";
import ExamManagementLayout from "./ExamManagementLayout";

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

export default function QuestionBank() {
  const examId = getExamId();

  const [questions, setQuestions] = useState<Question[]>([]);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [preview, setPreview] = useState<Question | null>(null);
  const [loadedExam,setLoadedExam]=useState<string|null>(null);
  const fileInput=useRef<HTMLInputElement|null>(null);
  const {capture,isCurrent,json}=useRequestScope(examId ?? '');
  const visibleQuestions=loadedExam===examId?questions:[];

  const loadQuestions = useCallback(async (expected?:RequestScope) => {
    const scope=expected??capture();
    if (!isCurrent(scope)) return;
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

      const data=await json<Question[]>(scope,`/api/exam/templates/${encodeURIComponent(scope.owner)}/questions`,{credentials:'include'});
      if (isCurrent(scope)) setQuestions(data);
    } catch (err) {
      if (isCurrent(scope)) setError(
        err instanceof Error
          ? err.message
          : "Unable to load examination questions."
      );
    } finally {
      if (isCurrent(scope)) {setLoadedExam(examId);setLoading(false);}
    }
  }, [examId,capture,isCurrent,json]);

  useEffect(() => {
    setQuestions([]);setLoadedExam(null);setLoading(true);setUploading(false);setDeletingId(null);setPreview(null);setError('');
    if(fileInput.current)fileInput.current.value='';
    void loadQuestions();
  }, [loadQuestions]);

  async function handleFileChange(
    event: React.ChangeEvent<HTMLInputElement>
  ) {
    const input = event.currentTarget;
    const file = input.files?.[0];

    if (!file || !examId || loadedExam!==examId) return;
    const scope=capture();

    const formData = new FormData();
    formData.append("file", file);

    setUploading(true);
    setError("");

    try {
      const data=await json<{questions_added?:number;filename?:string}>(scope,`/api/exam/templates/${encodeURIComponent(scope.owner)}/questions`,{
        method:'POST',credentials:'include',body:formData,
      },60000);
      if (!isCurrent(scope)) return;
      await loadQuestions(scope);
      if (!isCurrent(scope)) return;

      window.alert(
        `Upload complete. ${data.questions_added ?? 0} questions added from ${data.filename ?? file.name}.`
      );
    } catch (err) {
      if (isCurrent(scope)) setError(
        err instanceof Error
          ? err.message
          : "Unable to upload the question file."
      );
    } finally {
      if (isCurrent(scope)) {setUploading(false);input.value="";}
    }
  }

  async function deleteQuestion(question: Question) {
    if (!examId || loadedExam!==examId) return;
    const scope=capture();

    const confirmed = window.confirm(
      `Delete this question?\n\n"${question.question_text}"`
    );

    if (!confirmed || !isCurrent(scope)) return;

    setDeletingId(question.id);
    setError("");

    try {
      await json(scope,`/api/exam/templates/${encodeURIComponent(scope.owner)}/questions/${encodeURIComponent(question.id)}`,{
        method:'DELETE',credentials:'include',
      },60000);
      if (!isCurrent(scope)) return;

      setQuestions((current) =>
        current.filter((item) => item.id !== question.id)
      );

      if (preview?.id === question.id) {
        setPreview(null);
      }
    } catch (err) {
      if (isCurrent(scope)) setError(
        err instanceof Error
          ? err.message
          : "Unable to delete the question."
      );
    } finally {
      if (isCurrent(scope)) setDeletingId(null);
    }
  }

  return (
    <ExamManagementLayout examId={examId ?? ""} section="questions">{() => (
      <div className="question-bank-content in-manage-layout">



        <div className="question-bank-heading">
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
              ref={fileInput}
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

        {examId && <QuestionDrafts examId={examId} onApproved={loadQuestions} />}

        <section className="question-list">
          <div className="question-list-heading">
            <div>
              <p className="eyebrow">EXAMINATION CONTENT</p>
              <h2>Saved Questions</h2>
            </div>

            <span className="question-count">{visibleQuestions.length}</span>
          </div>

          {loading || loadedExam!==examId ? (
            <p className="question-status">Loading saved questions...</p>
          ) : visibleQuestions.length === 0 ? (
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
              {visibleQuestions.map((question, index) => (
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

        {preview && loadedExam===examId && (
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
      </div>
    )}</ExamManagementLayout>
  );
}
