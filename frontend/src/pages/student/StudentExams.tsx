export default function StudentExams() {
  return (
    <div className="student-exams-page">
      <header className="simple-header">
        <div className="logo">
          <span className="logo-icon">◉</span>
          <span>OralExam AI</span>
        </div>
      </header>

      <main className="student-exams-content">
        <div className="student-exams-heading">
          <p className="eyebrow">STUDENT PORTAL</p>

          <h1>Your Exams</h1>

          <p>
            Select an examination below to begin your AI-powered oral exam.
          </p>
        </div>

        <div className="exam-list">
          <div className="exam-card">
            <div className="exam-card-top">
              <div className="exam-icon">🎓</div>

              <div>
                <span className="exam-status">AVAILABLE</span>
                <h2>CIS 484 — Oral Examination</h2>
              </div>
            </div>

            <div className="exam-details">
              <span>10 Questions</span>
              <span>•</span>
              <span>Oral Examination</span>
            </div>

            <a className="exam-start-button" href="/student/exam">
              Start Exam
              <span>→</span>
            </a>
          </div>

          <div className="exam-card">
            <div className="exam-card-top">
              <div className="exam-icon">📊</div>

              <div>
                <span className="exam-status">AVAILABLE</span>
                <h2>COB 300 — Operations</h2>
              </div>
            </div>

            <div className="exam-details">
              <span>8 Questions</span>
              <span>•</span>
              <span>Oral Examination</span>
            </div>

            <a className="exam-start-button" href="/student/exam">
              Start Exam
              <span>→</span>
            </a>
          </div>
        </div>
      </main>

      <footer className="home-footer">
        <p>OralExam AI</p>
        <p>AI-assisted oral examination platform</p>
      </footer>
    </div>
  );
}
