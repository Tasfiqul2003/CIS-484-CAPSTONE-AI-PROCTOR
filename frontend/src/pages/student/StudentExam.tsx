import { useState } from "react";

const questions = [
  "Explain the primary concept covered in this question.",
  "How would you apply this concept in a real-world situation?",
  "What are the main challenges associated with this topic?",
  "Compare two approaches related to this concept.",
  "Why is this concept important to the course?",
];

export default function StudentExam() {
  const [currentQuestion, setCurrentQuestion] = useState(0);
  const [answer, setAnswer] = useState("");
  const [showConfirmation, setShowConfirmation] = useState(false);

  const isLastQuestion =
    currentQuestion === questions.length - 1;

  const handleNext = () => {
    if (isLastQuestion) {
      setShowConfirmation(true);
      return;
    }

    setAnswer("");
    setCurrentQuestion((current) => current + 1);
  };

  const submitExam = () => {
    window.location.href = "/student/exam/submitted";
  };

  if (showConfirmation) {
    return (
      <div className="student-exam-page">

        <header className="student-exam-header">

          <div className="student-exam-logo">
            <span>◉</span>
            <strong>OralExam AI</strong>
          </div>

          <div className="student-exam-progress">
            Exam Complete
          </div>

        </header>

        <main className="student-confirmation-content">

          <div className="student-confirmation-card">

            <div className="confirmation-icon">
              !
            </div>

            <p className="confirmation-eyebrow">
              FINAL CONFIRMATION
            </p>

            <h1>
              Are you ready to submit?
            </h1>

            <p className="confirmation-message">
              You have reached the end of your oral examination.
              Please make sure you have completed all of your
              responses before submitting.
            </p>

            <div className="confirmation-summary">

              <div className="confirmation-row">
                <span>Questions completed</span>
                <strong>
                  {questions.length} / {questions.length}
                </strong>
              </div>

              <div className="confirmation-row">
                <span>Current response</span>
                <strong>
                  Recorded
                </strong>
              </div>

              <div className="confirmation-row">
                <span>Submission</span>
                <strong>
                  Final
                </strong>
              </div>

            </div>

            <div className="confirmation-warning">
              <strong>
                Once submitted, you cannot return to this exam.
              </strong>

              <span>
                Your responses will be saved for your professor
                to review.
              </span>
            </div>

            <div className="confirmation-actions">

              <button
                type="button"
                className="confirmation-back-button"
                onClick={() => setShowConfirmation(false)}
              >
                ← Go Back
              </button>

              <button
                type="button"
                className="confirmation-submit-button"
                onClick={submitExam}
              >
                Confirm & Submit
              </button>

            </div>

          </div>

        </main>

      </div>
    );
  }

  return (
    <div className="student-exam-page">

      <header className="student-exam-header">

        <div className="student-exam-logo">
          <span>◉</span>
          <strong>OralExam AI</strong>
        </div>

        <div className="student-exam-progress">
          Question {currentQuestion + 1} of {questions.length}
        </div>

      </header>

      <main className="student-exam-content">

        <div className="exam-question-card">

          <div className="exam-question-number">
            QUESTION {currentQuestion + 1}
          </div>

          <h1>
            {questions[currentQuestion]}
          </h1>

          <div className="ai-avatar-container">

            <div className="ai-avatar">
              AI
            </div>

            <div>
              <strong>OralExam AI</strong>

              <p>
                Take your time and explain your answer clearly.
              </p>
            </div>

          </div>

          <textarea
            className="student-answer-input"
            value={answer}
            onChange={(e) => setAnswer(e.target.value)}
            placeholder="Speak your answer or type your response..."
          />

          <div className="exam-question-footer">

            <span>
              {answer.length > 0
                ? "Response recorded"
                : "Waiting for response..."}
            </span>

            <button
              type="button"
              className="exam-next-button"
              onClick={handleNext}
            >
              {isLastQuestion
                ? "Finish Exam"
                : "Next Question →"}
            </button>

          </div>

        </div>

      </main>

    </div>
  );
}
