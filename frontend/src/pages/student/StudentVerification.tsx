import { useState } from "react";

export default function StudentVerification() {
  const [cardDetected, setCardDetected] = useState(false);

  function simulateCardSwipe() {
    setCardDetected(true);
  }

  function goHome() {
    window.location.href = "/";
  }

  function continueToFaceVerification() {
    window.location.href = "/student/face-verification";
  }

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

          <div className="verification-icon">
            💳
          </div>

          <p className="eyebrow">
            STUDENT VERIFICATION
          </p>

          <h1>
            Verify your identity
          </h1>

          {!cardDetected ? (
            <>
              <p className="verification-description">
                Swipe your JACard to verify your identity before accessing
                your exams.
              </p>

              <div
                className="jacard-placeholder"
                onClick={simulateCardSwipe}
              >
                <div className="card-icon">
                  💳
                </div>

                <h2>
                  Swipe your JACard
                </h2>

                <p>
                  Waiting for card...
                </p>

                <button
                  type="button"
                  onClick={(event) => {
                    event.stopPropagation();
                    simulateCardSwipe();
                  }}
                >
                  Simulate JACard Swipe
                </button>
              </div>

              <p className="verification-note">
                Your JACard is used to make sure you are taking your own exam.
              </p>
            </>
          ) : (
            <>
              <p className="verification-description">
                JACard detected. We found the following student account.
              </p>

              <div className="student-identity">

                <div className="student-avatar">
                  👤
                </div>

                <div className="student-details">
                  <p className="student-label">
                    STUDENT
                  </p>

                  <h2>
                    Kayleigh Moore
                  </h2>

                  <p>
                    JMU ID: 00000000
                  </p>
                </div>

                <div className="verified-badge">
                  ✓ Verified
                </div>

              </div>

              <div className="verification-warning">
                <strong>Identity verification required</strong>

                <p>
                  You will need to verify your face before accessing your
                  examinations.
                </p>
              </div>

              <button
                type="button"
                className="continue-button"
                onClick={continueToFaceVerification}
              >
                Continue to Face Verification →
              </button>
            </>
          )}

          <button
            type="button"
            className="back-button"
            onClick={goHome}
          >
            ← Back to Home
          </button>

        </div>

      </main>

    </div>
  );
}
