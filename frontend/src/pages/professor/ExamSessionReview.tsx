import { useEffect, useState } from "react";
import { ArrowLeft, LoaderCircle } from "lucide-react";
import OralExamMark from "../../components/brand/OralExamMark";

type AnswerReview = {
  sequence_num: number;
  question: string;
  answer: string | null;
};

type ReviewData = {
  student_name: string;
  student_eid: string | null;
  exam_title: string;
  course: string | null;
  status: string;
  video_url: string;
  answers: AnswerReview[];
};

export default function ExamSessionReview() {
  const sessionId = window.location.pathname.split("/").filter(Boolean).at(-1);
  const [review, setReview] = useState<ReviewData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    async function loadReview() {
      if (!sessionId) {
        setError("The exam session ID is missing.");
        setLoading(false);
        return;
      }
      try {
        const response = await fetch(
          `/api/exam/sessions/${encodeURIComponent(sessionId)}/review`,
          { credentials: "include" },
        );
        const data = await response.json().catch(() => ({}));
        if (!response.ok) {
          throw new Error(
            typeof data.detail === "string"
              ? data.detail
              : "Unable to load the exam review.",
          );
        }
        if (!cancelled) setReview(data as ReviewData);
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Unable to load the exam review.");
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void loadReview();
    return () => { cancelled = true; };
  }, [sessionId]);

  return (
    <div className="professor-dashboard">
      <header className="dashboard-header">
        <a href="/professor/dashboard" className="dashboard-brand">
          <OralExamMark />
          <span>OralExam AI</span>
        </a>
        <a href="/professor/exams" className="progress-back-link">
          <ArrowLeft size={16} aria-hidden="true" />
          Exams
        </a>
      </header>
      <main className="dashboard-main">
        <section className="dashboard-welcome">
          <div>
            <p className="eyebrow">PROFESSOR REVIEW</p>
            <h1>Exam recording and transcript</h1>
            {review && (
              <p>
                {review.student_name} · {review.student_eid || "EID unavailable"} ·{" "}
                {review.exam_title}
                {review.course ? ` · ${review.course}` : ""}
              </p>
            )}
          </div>
        </section>

        {loading ? (
          <section className="progress-empty-state" role="status">
            <LoaderCircle size={24} className="progress-spin" />
            <p>Loading the submitted exam review…</p>
          </section>
        ) : error ? (
          <section className="progress-error" role="alert">
            <strong>Review unavailable</strong>
            <p>{error}</p>
          </section>
        ) : review ? (
          <>
            <section className="exam-card">
              <h2>Recorded exam</h2>
              <p>
                Video and audio are retained until the configured semester-end
                deadline. Access is limited to the professor who owns this exam.
              </p>
              <video
                controls
                preload="metadata"
                src={review.video_url}
                aria-label={`Video and audio recording for ${review.student_name}`}
                style={{ width: "100%", maxHeight: "70vh" }}
              >
                Your browser cannot play this exam recording.
              </video>
            </section>

            <section className="exam-card" aria-labelledby="transcript-heading">
              <h2 id="transcript-heading">Submitted answer transcript</h2>
              {review.answers.length === 0 ? (
                <p>No answer transcript was saved for this session.</p>
              ) : (
                <ol>
                  {review.answers.map(item => (
                    <li key={item.sequence_num}>
                      <h3>{item.question}</h3>
                      <p>{item.answer || "No answer submitted."}</p>
                    </li>
                  ))}
                </ol>
              )}
            </section>
          </>
        ) : null}
      </main>
    </div>
  );
}
