const examTemplateId = "37031160-d701-4284-b3de-5a00ea8fa8cb";

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
          <p>Select an examination below to begin your AI-powered oral exam.</p>
        </div>

        <p className="student-settings-preview-entry"><a href="/student/settings-preview">Student Settings Preview</a> · Try presentation preferences with synthetic content. No exam is started.</p>

        <div className="exam-list">
          <div className="exam-card">
            <div className="exam-card-top">
              <div className="exam-icon">🎓</div>
              <div>
                <span className="exam-status">AVAILABLE</span>
                <h2>Databases OralExam (test)</h2>
              </div>
            </div>

            <div className="exam-details">
              <span>Adaptive questions</span>
              <span>•</span>
              <span>Database Systems</span>
            </div>

            <a
              className="exam-start-button"
              href={`/student/exam?templateId=${examTemplateId}`}
            >
              Start Exam <span>→</span>
            </a>
          </div>

          <div className="exam-card">
            <div className="exam-card-top">
              <div className="exam-icon">📊</div>
              <div>
                <span className="exam-status">NOT AVAILABLE</span>
                <h2>COB 300 — Operations</h2>
              </div>
            </div>

            <div className="exam-details">
              <span>Not yet connected</span>
              <span>•</span>
              <span>Operations</span>
            </div>
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
