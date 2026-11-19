import { useEffect } from "react";
import RosterUpload from "../../components/RosterUpload";
import ExamManagementLayout from "./ExamManagementLayout";
import { MaterialUploadContent } from "./MaterialUpload";
import { QuestionBankContent } from "./QuestionBank";

function UploadsContent({ examId }: { examId: string }) {
  useEffect(() => {
    // The ownership check mounts these sections after the initial page load.
    const target = window.location.hash.slice(1);
    if (["roster", "materials", "questions"].includes(target)) {
      document.getElementById(target)?.scrollIntoView();
    }
  }, []);

  return <div className="exam-combined-page exam-uploads-page">
    <header className="exam-combined-heading">
      <h1>Exam uploads</h1>
      <p>Upload and manage this exam's student roster, course materials, and questions in one place.</p>
    </header>
    <nav className="exam-section-jump" aria-label="Upload sections">
      <a href="#roster">Student roster</a>
      <a href="#materials">Course materials</a>
      <a href="#questions">Questions</a>
    </nav>
    <section id="roster" className="exam-upload-section" aria-label="Student roster">
      <RosterUpload examId={examId} />
    </section>
    <section id="materials" className="exam-upload-section" aria-label="Course materials">
      <MaterialUploadContent examId={examId} />
    </section>
    <section id="questions" className="exam-upload-section" aria-label="Questions">
      <QuestionBankContent examId={examId} />
    </section>
  </div>;
}

export default function ExamUploads({ examId }: { examId: string }) {
  return <ExamManagementLayout examId={examId} section="uploads">{exam =>
    <UploadsContent key={exam.id} examId={exam.id} />
  }</ExamManagementLayout>;
}
