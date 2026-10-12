import { useEffect, useState } from "react";

type Professor = {
  username: string;
  role: string;
};

type Exam = {
  id: string;
  title: string;
  created_at: string | null;
  question_count: number;
  submission_count: number;
};

export default function ProfessorDashboard() {
  const [professor, setProfessor] = useState<Professor | null>(null);
  const [exams, setExams] = useState<Exam[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    async function loadDashboard() {
      try {
        const userResponse = await fetch("/api/auth/me", {
          credentials: "include",
        });

        if (!userResponse.ok) {
          window.location.href = "/professor/login";
          return;
        }

        const userData = await userResponse.json();

        if (userData.role !== "professor") {
          setError("This account does not have professor access.");
          return;
        }

        setProfessor(userData);

        const examsResponse = await fetch("/api/auth/professor/exams", {
          credentials: "include",
        });

        if (!examsResponse.ok) {
          throw new Error("Unable to load your examinations.");
        }

        const examsData: Exam[] = await examsResponse.json();
        setExams(examsData);
      } catch (err) {
        setError(
          err instanceof Error
            ? err.message
            : "Unable to connect to the server."
        );
      } finally {
        setLoading(false);
      }
    }

    loadDashboard();
  }, []);

  async function handleLogout() {
    try {
      await fetch("/api/auth/logout", {
        method: "POST",
        credentials: "include",
      });
    } finally {
      window.location.href = "/professor/login";
    }
  }

  if (loading) {
    return (
      <main className="professor-dashboard-content">
        <p>Loading your dashboard...</p>
      </main>
    );
  }

  if (error || !professor) {
    return (
      <main className="professor-dashboard-content">
        <p role="alert">{error || "Please sign in again."}</p>
        <a href="/professor/login">Return to login</a>
      </main>
    );
  }

  const professorName =
    professor.username
      .split(".")
      .pop()
      ?.replace(/^./, (letter) => letter.toUpperCase()) || "Professor";

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
          onClick={handleLogout}
        >
          Log Out
        </button>
      </header>

      <main className="professor-dashboard-content">
        <section className="dashboard-welcome">
          <p className="eyebrow">PROFESSOR PORTAL</p>
          <h1>Welcome, Professor {professorName}</h1>
          <p>
            Create and manage your oral examinations and review student
            submissions.
          </p>
        </section>

        <section className="dashboard-actions">
          <a
            href="/professor/exams/new"
            className="dashboard-action primary"
          >
            <span className="dashboard-action-icon">+</span>
            <div>
              <strong>Create New Exam</strong>
              <p>
                Create an examination and add its questions and course
                materials.
              </p>
            </div>
            <span className="dashboard-action-arrow">→</span>
          </a>
        </section>

        <div className="dashboard-section-heading">
          <div>
            <p className="eyebrow">YOUR EXAMINATIONS</p>
            <h2>My Exams</h2>
          </div>
        </div>

        <section className="dashboard-exam-list">
          {exams.length === 0 && (
            <p>You haven't created any examinations yet.</p>
          )}

          {exams.map((exam) => (
            <div className="professor-exam-card" key={exam.id}>
              <div className="professor-exam-header">
                <div className="professor-exam-title">
                  <div className="professor-exam-icon">🎙️</div>
                  <div>
                    <div className="exam-course">ORAL EXAM</div>
                    <h3>{exam.title}</h3>
                    <p>
                      Manage questions and review student examinations.
                    </p>
                  </div>
                </div>
                <span className="exam-status">Exam</span>
              </div>

              <div className="professor-exam-stats">
                <div>
                  <strong>{exam.question_count}</strong>
                  <span>Questions</span>
                </div>
                <div>
                  <strong>{exam.submission_count}</strong>
                  <span>Submissions</span>
                </div>
              </div>

              <div className="professor-exam-options">
                <a
                  href={`/professor/exams/${exam.id}`}
                  className="exam-option"
                >
                  <span>⚙️</span>
                  <div>
                    <strong>Manage Exam</strong>
                    <small>Questions, materials, and settings</small>
                  </div>
                  <span>→</span>
                </a>

                <a
                  href={`/professor/exams/${exam.id}/submissions`}
                  className="exam-option"
                >
                  <span>📋</span>
                  <div>
                    <strong>View Submissions</strong>
                    <small>Review student examinations</small>
                  </div>
                  <span>→</span>
                </a>
              </div>
            </div>
          ))}
        </section>
      </main>

      <footer className="home-footer">
        <p>OralExam AI</p>
        <p>AI-assisted oral examination platform</p>
      </footer>
    </div>
  );
}
