export default function StudentVerification() {
  return (
    <div className="verification-page">
      <header className="simple-header">
        <div className="logo">
          <span className="logo-icon">◉</span>
          <span>OralExam AI</span>
        </div>
      </header>

      <main className="verification-content">
        <div className="verification-card">
          <div className="verification-icon">🎓</div>

          <p className="eyebrow">STUDENT VERIFICATION</p>

          <h1>Verify your identity</h1>

          <p className="verification-description">
            Swipe your JACard to verify your identity before accessing your
            exams.
          </p>

          <div className="jacard-placeholder">
            <div className="card-icon">💳</div>
            <h2>Swipe your JACard</h2>
            <p>Waiting for card...</p>
          </div>

          <p className="verification-note">
            Your JACard is used to make sure you are taking your own exam.
          </p>

          <button
            className="back-button"
            onClick={() => (window.location.href = "/")}
          >
            ← Back to Home
          </button>
        </div>
      </main>
    </div>
  );
}
