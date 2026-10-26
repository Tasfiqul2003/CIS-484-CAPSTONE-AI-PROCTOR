import { useEffect } from "react";
import RosterUpload from "../../components/RosterUpload";
import ExamManagementLayout from "./ExamManagementLayout";
import { examSettingsCategories, examSettingsPath } from "./examSettingsNavigation";

export default function ManageExam() {
  const examId = window.location.pathname.match(/^\/professor\/exams\/([^/]+)\/?$/)?.[1] ?? "";
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
  return <ExamManagementLayout examId={examId}>{exam => <>
    <nav className="manage-exam-options" aria-label="Exam content">
      <a href={`/professor/exams/${exam.id}/questions`} className="manage-exam-card">
        <div className="manage-exam-card-icon" aria-hidden="true">📚</div>
        <div className="manage-exam-card-content">
          <span className="manage-exam-card-label">QUESTIONS</span>
          <h2>Question Bank</h2>
          <p>View, add, edit, and organize the questions used during this exam.</p>
          <span className="manage-exam-card-link">View Question Bank →</span>
        </div>
      </a>
      <a href={`/professor/exams/${exam.id}/materials`} className="manage-exam-card">
        <div className="manage-exam-card-icon" aria-hidden="true">📁</div>
        <div className="manage-exam-card-content">
          <span className="manage-exam-card-label">MATERIALS</span>
          <h2>Course Materials</h2>
          <p>View and manage documents and study materials used by the AI.</p>
          <span className="manage-exam-card-link">View Course Materials →</span>
        </div>
      </a>
    </nav>
    <section className="manage-exam-settings" aria-labelledby="exam-settings-heading">
      <div className="manage-exam-settings-heading">
        <p className="eyebrow">CONFIGURATION</p>
        <h2 id="exam-settings-heading">Exam Settings</h2>
        <p>Choose a category to review and save its settings.</p>
      </div>
      <nav className="manage-exam-settings-grid" aria-label="Exam settings">
        {examSettingsCategories.map(category => <a key={category.slug} href={examSettingsPath(exam.id, category.slug)} className="manage-exam-card manage-exam-settings-card">
          <div className="manage-exam-card-icon" aria-hidden="true">{category.icon}</div>
          <div className="manage-exam-card-content">
            <h3>{category.title}</h3>
            <p>{category.description}</p>
            <span className="manage-exam-card-link">Manage settings →</span>
          </div>
        </a>)}
      </nav>
    </section>
    <RosterUpload examId={exam.id} />
  </>}</ExamManagementLayout>;
}
