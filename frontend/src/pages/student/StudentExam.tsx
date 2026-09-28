import { useState } from "react";

const questions = [
  "Tell me about the role of information systems in a business.",
  "How can information systems improve business decision-making?",
  "What are some challenges businesses face when implementing new technology?",
  "How can businesses use data to gain a competitive advantage?",
  "What is the importance of cybersecurity in a business environment?",
  "How can technology improve communication within an organization?",
  "What factors should a business consider when selecting a new information system?",
  "How can information systems support supply chain operations?",
  "What are some risks associated with implementing new technology?",
  "How do information systems contribute to organizational strategy?",
];

export default function StudentExam() {
  const [questionIndex, setQuestionIndex] = useState(0);
  const [answering, setAnswering] = useState(false);

  const question = questions[questionIndex];
  const isLastQuestion = questionIndex === questions.length - 1;

  return (
    <div className="exam-page">
      <h1>CIS 484 — Oral Examination</h1>

      <p>
        Question {questionIndex + 1} of {questions.length}
      </p>

      <h2>{question}</h2>

      <p>
        When you are ready, answer the question verbally.
      </p>

      <div>
        AI Avatar
      </div>

      <div className="answer-status">
        {!answering ? (
          <>
            <p>Waiting for your answer...</p>

            <button
              type="button"
              onClick={() => setAnswering(true)}
            >
              Start Answer
            </button>
          </>
        ) : (
          <>
            <p>● Answering...</p>

            <button
              type="button"
              onClick={() => setAnswering(false)}
            >
              Stop Answer
            </button>
          </>
        )}
      </div>

      {!answering && (
        <button
          type="button"
          onClick={() => {
            if (!isLastQuestion) {
              setQuestionIndex(questionIndex + 1);
            }
          }}
        >
          {isLastQuestion ? "Finish Exam" : "Next Question"}
        </button>
      )}
    </div>
  );
}
