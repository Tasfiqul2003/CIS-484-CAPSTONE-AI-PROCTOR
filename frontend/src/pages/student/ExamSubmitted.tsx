import { useEffect, useState } from "react";

export default function ExamSubmitted() {
  const [countdown, setCountdown] = useState(5);

  useEffect(() => {
    const timer = setInterval(() => {
      setCountdown((current) => {
        if (current <= 1) {
          clearInterval(timer);
          window.location.href = "/";
          return 0;
        }

        return current - 1;
      });
    }, 1000);

    return () => clearInterval(timer);
  }, []);

  return (
    <div className="student-submission-page">

      <div className="submission-card">

        <div className="submission-success-icon">
          ✓
        </div>

        <p className="submission-eyebrow">
          EXAM COMPLETE
        </p>

        <h1>
          Your exam has been submitted
        </h1>

        <p className="submission-message">
          Your responses have been successfully recorded.
          You may now leave the examination area.
        </p>

        <div className="submission-divider" />

        <div className="submission-status">

          <div className="submission-status-row">
            <span>Exam status</span>
            <strong>Submitted ✓</strong>
          </div>

          <div className="submission-status-row">
            <span>Responses</span>
            <strong>Recorded ✓</strong>
          </div>

          <div className="submission-status-row">
            <span>Transcript</span>
            <strong>Processing</strong>
          </div>

        </div>

        <div className="submission-countdown">

          <div className="countdown-number">
            {countdown}
          </div>

          <div>
            <strong>
              Returning to home
            </strong>

            <small>
              You will be returned to the main screen
              automatically.
            </small>
          </div>

        </div>

        <button
          className="submission-exit-button"
          onClick={() => {
            window.location.href = "/";
          }}
        >
          Return to Home Now
        </button>

      </div>

    </div>
  );
}
