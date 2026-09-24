import { useNavigate } from "react-router-dom";

export default function Home() {
  const navigate = useNavigate();

  return (
    <div className="home-page">
      <header className="home-header">
        <div className="logo">
          <span className="logo-icon">◉</span>
          <span>OralExam AI</span>
        </div>
      </header>

      <main className="home-content">
        <section className="hero-section">
          <div className="hero-text">
            <p className="eyebrow">AI-POWERED ORAL EXAMINATIONS</p>

            <h1>
              A smarter way to conduct
              <span> oral examinations.</span>
            </h1>

            <p className="hero-description">
              OralExam AI allows professors to create and manage oral exams
              while providing students with an interactive AI-powered
              examination experience.
            </p>
          </div>

          <div className="role-selection">
            <h2>How are you using OralExam AI?</h2>

            <div className="role-cards">
              <button
                className="role-card"
                onClick={() => navigate("/student/verify")}
              >
                <div className="role-icon student-icon">👤</div>

                <div className="role-card-content">
                  <h3>I'm a Student</h3>
                  <p>
                    Swipe your JACard to verify your identity and access your
                    available exams.
                  </p>
                </div>

                <span className="arrow">→</span>
              </button>

              <button
                className="role-card"
                onClick={() => navigate("/teacher/login")}
              >
                <div className="role-icon teacher-icon">▣</div>

                <div className="role-card-content">
                  <h3>I'm a Professor</h3>
                  <p>
                    Log in to create exams, manage questions and materials,
                    and review student submissions.
                  </p>
                </div>

                <span className="arrow">→</span>
              </button>
            </div>
          </div>
        </section>

        <section className="features-section">
          <div className="feature">
            <div className="feature-icon">🎙️</div>
            <div>
              <h3>Interactive Oral Exams</h3>
              <p>
                Students answer questions verbally through an AI-powered
                examination experience.
              </p>
            </div>
          </div>

          <div className="feature">
            <div className="feature-icon">🔐</div>
            <div>
              <h3>Student Verification</h3>
              <p>
                JACard and identity verification help ensure students take
                their own examinations.
              </p>
            </div>
          </div>

          <div className="feature">
            <div className="feature-icon">📚</div>
            <div>
              <h3>Professor Controls</h3>
              <p>
                Professors control their question banks, course materials,
                exams, and student submissions.
              </p>
            </div>
          </div>
        </section>
      </main>

      <footer className="home-footer">
        <p>OralExam AI</p>
        <p>AI-assisted oral examination platform</p>
      </footer>
    </div>
  );
}
