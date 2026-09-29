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

export default function ProfessorDashboard() {
  const [exams, setExams] = useState<Exam[]>([]);

  useEffect(() => {
    const saved = localStorage.getItem("oralExamExams");

    if (!saved) {
      setExams(sampleExams);
      return;
    }

    try {
      const savedExams = JSON.parse(saved);
      setExams([...sampleExams, ...savedExams]);
    } catch {
      setExams(sampleExams);
    }
  }, []);

  return (
    <div className="professor-dashboard-page">

      <header className="simple-header">

        <div className="logo">
          <span className="logo-icon">◉</span>
          <span>OralExam AI</span>
        </div>

        <a href="/" className="dashboard-logout">
          Log Out
        </a>

      </header>

      <main className="professor-dashboard-content">

        {/* WELCOME */}

        <section className="dashboard-welcome">

          <p className="eyebrow">
            PROFESSOR PORTAL
          </p>

          <h1>
            Welcome, Professor
          </h1>

          <p>
            Create and manage your oral examinations,
            question banks, course materials, and student
            submissions.
          </p>

        </section>

        {/* QUICK ACTIONS */}

        <section className="dashboard-actions">

          <a
            href="/professor/exams/new"
            className="dashboard-action primary"
          >

            <span className="dashboard-action-icon">
              +
            </span>

            <div>
              <strong>
                Create New Exam
              </strong>

              <p>
                Create an examination and add questions
                and course materials.
              </p>
            </div>

            <span className="dashboard-action-arrow">
              →
            </span>

          </a>

          <a
            href="/professor/submissions"
            className="dashboard-action"
          >

            <span className="dashboard-action-icon">
              📋
            </span>

            <div>
              <strong>
                Student Submissions
              </strong>

              <p>
                Review completed oral examinations.
              </p>
            </div>

            <span className="dashboard-action-arrow">
              →
            </span>

          </a>

        </section>

        {/* EXAMS */}

        <div className="dashboard-section-heading">

          <div>
            <p className="eyebrow">
              YOUR EXAMINATIONS
            </p>

            <h2>
              My Exams
            </h2>
          </div>

        </div>

        <section className="dashboard-exam-list">

          {exams.map((exam) => (

            <div
              className="professor-exam-card"
              key={exam.id}
            >

              {/* EXAM HEADER */}

              <div className="professor-exam-header">

                <div className="professor-exam-title">

                  <div className="professor-exam-icon">
                    {exam.icon}
                  </div>

                  <div>

                    <div className="exam-course">
                      {exam.course}
                    </div>

                    <h3>
                      {exam.name}
                    </h3>

                    <p>
                      {exam.description}
                    </p>

                  </div>

                </div>

                <span className="exam-status">
                  {exam.status}
                </span>

              </div>

              {/* STATS */}

              <div className="professor-exam-stats">

                <div>
                  <strong>
                    {exam.questionCount}
                  </strong>

                  <span>
                    Questions
                  </span>
                </div>

                <div>
                  <strong>
                    {exam.materialCount}
                  </strong>

                  <span>
                    Materials
                  </span>
                </div>

                <div>
                  <strong>
                    0
                  </strong>

                  <span>
                    Submissions
                  </span>
                </div>

              </div>

              {/* EXAM OPTIONS */}

              <div className="professor-exam-options">

                <a
                  href={`/professor/exams/${exam.id}`}
                  className="exam-option primary"
                >

                  <span>⚙️</span>

                  <div>
                    <strong>
                      Manage Exam
                    </strong>

                    <small>
                      Exam settings and overview
                    </small>
                  </div>

                  <span>→</span>

                </a>

                <a
                  href={`/professor/exams/${exam.id}/questions`}
                  className="exam-option"
                >

                  <span>❓</span>

                  <div>
                    <strong>
                      Questions
                    </strong>

                    <small>
                      View and manage question bank
                    </small>
                  </div>

                  <span>→</span>

                </a>

                <a
                  href={`/professor/exams/${exam.id}/materials`}
                  className="exam-option"
                >

                  <span>📚</span>

                  <div>
                    <strong>
                      Course Materials
                    </strong>

                    <small>
                      Upload and manage materials
                    </small>
                  </div>

                  <span>→</span>

                </a>

                <a
                  href={`/professor/exams/${exam.id}/submissions`}
                  className="exam-option"
                >

                  <span>📋</span>

                  <div>
                    <strong>
                      Submissions
                    </strong>

                    <small>
                      Review student examinations
                    </small>
                  </div>

                  <span>→</span>

                </a>

              </div>

            </div>

          ))}

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
