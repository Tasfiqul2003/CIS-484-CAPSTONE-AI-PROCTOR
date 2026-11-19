import { useEffect, useState } from "react";
import { FolderUp, Trash2 } from "lucide-react";
import ExamManagementLayout, { type ManagedExam } from "./ExamManagementLayout";
import { examSettingsCategories, examSettingsPath, examUploadsPath } from "./examSettingsNavigation";

function errorText(data: unknown, fallback: string) {
  const detail = (data as { detail?: unknown } | null)?.detail;
  return typeof detail === "string" ? detail : fallback;
}

/** The exam's front page: where it stands, what to set up, publishing, and deleting it. */
function Overview({ exam, reload }: { exam: ManagedExam; reload: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const published = exam.status === "published";
  const roster = exam.roster_count ?? 0;

  async function togglePublication() {
    const action = published ? "unpublish" : "publish";
    setBusy(true); setError("");
    try {
      const response = await fetch(`/api/exam/templates/${encodeURIComponent(exam.id)}/${action}`, { method: "POST", credentials: "include" });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(errorText(data, `Unable to ${action} this exam.`));
      await reload();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Unable to update the exam.");
    } finally {
      setBusy(false);
    }
  }

  async function deleteExam() {
    if (!window.confirm(`Delete "${exam.title}"? This cannot be undone. Exams that students have taken cannot be deleted.`)) return;
    setBusy(true); setError("");
    try {
      const response = await fetch(`/api/exam/templates/${encodeURIComponent(exam.id)}`, { method: "DELETE", credentials: "include" });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(errorText(data, "Unable to delete this exam."));
      window.location.href = "/professor/exams";
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Unable to delete this exam.");
      setBusy(false);
    }
  }

  return <div className="manage-exam-overview">
    <header className="manage-exam-overview-head">
      <div>
        <p className="manage-exam-overview-course">{exam.course}</p>
        <h1>{exam.title}</h1>
        {exam.description && <p>{exam.description}</p>}
      </div>
      <div className="manage-exam-overview-publish">
        <span className={`exam-row-status ${published ? "published" : "draft"}`}>{published ? "Published" : "Draft"}</span>
        <button type="button" className={published ? "" : "is-primary"} disabled={busy} onClick={() => void togglePublication()}>
          {published ? "Unpublish" : "Publish"}
        </button>
      </div>
    </header>
    {error && <p role="alert" className="exam-error">{error}</p>}

    <dl className="manage-exam-stats">
      <div><dt>Questions</dt><dd>{exam.question_count ?? 0}</dd></div>
      <div><dt>Submitted</dt><dd>{exam.submitted_student_count ?? 0}{roster > 0 ? ` / ${roster}` : ""}</dd></div>
      <div><dt>In progress</dt><dd>{exam.in_progress_count ?? 0}</dd></div>
      <div><dt>Flagged</dt><dd>{exam.flagged_count ?? 0}</dd></div>
    </dl>
    <p><a href={`/professor/exams/${encodeURIComponent(exam.id)}/submissions`}>View student progress and submissions →</a></p>

    <h2 className="manage-exam-section-title">Set up</h2>
    <ul className="manage-exam-shortcuts">
      <li><a href={examUploadsPath(exam.id)}><FolderUp size={18} aria-hidden="true" /><strong>Exam uploads</strong><span>Student roster, course materials, and questions</span></a></li>
      {examSettingsCategories.map(category => <li key={category.slug}>
        <a href={examSettingsPath(exam.id, category.slug)}><span className="manage-exam-nav-glyph" aria-hidden="true">{category.icon}</span>
          <strong>{category.title.replace(" Settings", "")}</strong><span>{category.description}</span></a>
      </li>)}
    </ul>

    <section className="manage-exam-danger" aria-labelledby="danger-heading">
      <div>
        <h2 id="danger-heading">Delete this exam</h2>
        <p>Removes the exam, its questions and its settings. Exams that students have taken cannot be deleted.</p>
      </div>
      <button type="button" disabled={busy} onClick={() => void deleteExam()}><Trash2 size={16} aria-hidden="true" />Delete exam</button>
    </section>
  </div>;
}

export default function ManageExam() {
  const match = window.location.pathname.match(/^\/professor\/exams\/([^/]+)\/?$/);
  const examId = match?.[1] ?? "";
  useEffect(() => {
    // An old fragment link can be followed while the overview is already open.
    // Hash-only navigation does not remount this pathname-based application.
    const openLegacyAvatar = () => {
      if (examId && window.location.hash === "#avatar-settings") {
        window.location.replace(examSettingsPath(examId, "avatar-interaction") + window.location.search);
      }
    };
    openLegacyAvatar();
    window.addEventListener("hashchange", openLegacyAvatar);
    return () => window.removeEventListener("hashchange", openLegacyAvatar);
  }, [examId]);
  return <ExamManagementLayout examId={examId} section="overview">{(exam, reload) =>
    <Overview exam={exam} reload={reload} />
  }</ExamManagementLayout>;
}
