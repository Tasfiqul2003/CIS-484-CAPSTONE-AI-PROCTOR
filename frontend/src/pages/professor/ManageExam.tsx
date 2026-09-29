import { useEffect, useState } from "react";

type Exam = {
  id: number;
  course: string;
  name: string;
  description: string;
  icon: string;
  questionCount: number;
  materialCount: number;
  status: string;
};

const sampleExams: Exam[] = [
  {
    id: 1,
    course: "CIS 484",
    name: "Oral Examination",
    description: "AI-powered oral examination for CIS 484.",
    icon: "🎙️",
    questionCount: 10,
    materialCount: 3,
    status: "Active",
  },
  {
    id: 2,
    course: "COB 300",
    name: "Operations Oral Examination",
    description: "Operations and supply chain oral examination.",
    icon: "📊",
    questionCount: 8,
    materialCount: 5,
    status: "Active",
  },
];

export default function ManageExam() {
  const [exam, setExam] = useState<Exam | null>(null);

  useEffect(() => {
    const pathParts = window.location.pathname.split("/");
    const examId = Number(pathParts[3]);

    const saved = localStorage.getItem("oralExamExams");

    let savedExams: Exam[] = [];

    if (saved) {
      try {
        savedExams = JSON.parse(saved);
      } catch {
        savedExams = [];
      }
    }

    const allExams = [...sampleExams, ...savedExams];

    const foundExam = allExams.find(
      (item) => item.id === examId
    );

    if (foundExam) {
      setExam(foundExam);
    }
  }, []);

  if (!exam) {
    return (
      <div className="professor-dashboard-page">

        <header className="simple-header">

          <div className="logo">
            <span className="logo-icon">◉</span>
            <span>OralExam AI</span>
          </div>

          <a
            href="/professor/dashboard"
            className="dashboard-logout"
          >
            Dashboard
          </a>

        </header>

        <main className="professor-dashboard-content">

          <div className="empty-exams">

            <div className="empty-exams-icon">
              🔍
            </div>

            <h1>
              Exam Not Found
            </h1>

            <p>
              We couldn't find this examination.
            </p>

            <a
              href="/professor/dashboard"
              className="create-exam-button"
            >
              ← Back to Dashboard
            </a>

          </div>

        </main>

      </div>
    );
  }

  return (
    <div className="professor-dashboard-page">

      <header className="simple-header">

        <div className="logo">
          <span className="logo-icon">◉</span>
          <span>OralExam AI</span>
        </div>

        <a
          href="/professor/dashboard"
          className="dashboard-logout"
        >
          Dashboard
        </a>

      </header>

      <main className="professor-dashboard-content">

        <a
          href="/professor/dashboard"
          className="manage-back-link"
        >
          ← Back to My Exams
        </a>

        <section className="manage-exam-header">

          <div className="manage-exam-icon">
            {exam.icon}
          </div>

          <div className="manage-exam-title">

            <p className="eyebrow">
              {exam.course}
            </p>

            <h1>
              {exam.name}
            </h1>

            <p>
              {exam.description}
            </p>

          </div>

          <span className="exam-status">
            {exam.status}
          </span>

        </section>

        <section className="manage-overview">

          <div className="manage-stat">

            <strong>
              {exam.questionCount}
            </strong>

            <span>
              Questions
            </span>

          </div>

          <div className="manage-stat">

            <strong>
              {exam.materialCount}
            </strong>

            <span>
              Course Materials
            </span>

          </div>

          <div className="manage-stat">

            <strong>
              0
            </strong>

            <span>
              Submissions
            </span>

          </div>

        </section>

        <div className="dashboard-section-heading">

          <div>

            <p className="eyebrow">
              EXAM MANAGEMENT
            </p>

            <h2>
              Manage This Exam
            </h2>

          </div>

        </div>

        <section className="manage-options">

          <a
            href={`/professor/exams/${exam.id}/questions`}
            className="manage-option"
          >

            <div className="manage-option-icon">
              ❓
            </div>

            <div>

              <h3>
                Question Bank
              </h3>

              <p>
                Upload and manage the questions used
                during this examination.
              </p>

            </div>

            <span>
              →
            </span>

          </a>

          <a
            href={`/professor/exams/${exam.id}/materials`}
            className="manage-option"
          >

            <div className="manage-option-icon">
              📚
            </div>

            <div>

              <h3>
                Course Materials
              </h3>

              <p>
                Upload lectures, notes, documents,
                and other course materials.
              </p>

            </div>

            <span>
              →
            </span>

          </a>

          <a
            href={`/professor/exams/${exam.id}/submissions`}
            className="manage-option"
          >

            <div className="manage-option-icon">
              📋
            </div>

            <div>

              <h3>
                Student Submissions
              </h3>

              <p>
                Review completed oral examinations
                and student responses.
              </p>

            </div>

            <span>
              →
            </span>

          </a>

          <div className="manage-option">

            <div className="manage-option-icon">
              ⚙️
            </div>

            <div>

              <h3>
                Exam Settings
              </h3>

              <p>
                Configure timing, question behavior,
                and AI examination settings.
              </p>

            </div>

            <span>
              →
            </span>

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
