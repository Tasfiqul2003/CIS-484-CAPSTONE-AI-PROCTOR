import { useCallback, useEffect, useRef, useState } from "react";
import { AlertTriangle, ArrowLeft, LoaderCircle, Sparkles } from "lucide-react";
import ProfessorHeader from "../../components/professor/ProfessorHeader";

type AnswerReview = {
  sequence_num: number;
  question: string;
  answer: string | null;
};

type ReviewData = {
  student_name: string;
  student_eid: string | null;
  exam_title: string;
  exam_template_id?: string | null;
  course: string | null;
  status: string;
  video_url: string;
  answers: AnswerReview[];
};

type Grade = {
  rubric_criterion: string;
  max_score: number | string;
  model_suggested_score: number | string | null;
  score: number | string | null;
  professor_notes: string | null;
};

type IntegrityEvent = {
  event_type: string;
  event_timestamp: number | string | null;
  severity: number | null;
  notes: string | null;
};

type Report = {
  interactions: Array<{ sequence_num: number; question_source: string | null; avatar_followup_index?: number | null }>;
  grades: Grade[];
  integrity_events: IntegrityEvent[];
};

const EVENT_LABELS: Record<string, string> = {
  face_not_visible: "No face visible",
  multiple_faces: "More than one face visible",
};

function clock(seconds: number) {
  const whole = Math.max(0, Math.floor(seconds));
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
}

function numberOrNull(value: number | string | null | undefined) {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export default function ExamSessionReview() {
  // The page lives at /professor/exam-sessions/<session id>/review, so the ID is the segment before "review".
  const match = window.location.pathname.match(/^\/professor\/exam-sessions\/([^/]+)\/review\/?$/);
  const sessionId = match ? decodeURIComponent(match[1]) : "";
  const [review, setReview] = useState<ReviewData | null>(null);
  const [report, setReport] = useState<Report | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [grading, setGrading] = useState(false);
  const [gradeError, setGradeError] = useState("");
  const video = useRef<HTMLVideoElement>(null);

  const loadReport = useCallback(async () => {
    try {
      const response = await fetch(`/api/exam/${encodeURIComponent(sessionId)}/report`, { credentials: "include" });
      if (response.ok) setReport(await response.json() as Report);
    } catch {
      // The recording and transcript still show without the report.
    }
  }, [sessionId]);

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
        if (!cancelled) await loadReport();
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
  }, [sessionId, loadReport]);

  async function runAssessment() {
    setGrading(true);
    setGradeError("");
    try {
      const response = await fetch("/api/exam/grade", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ session_id: sessionId }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(typeof data.detail === "string" ? data.detail : `AI assessment failed (${response.status}).`);
      }
      await loadReport();
    } catch (err) {
      setGradeError(err instanceof Error ? err.message : "AI assessment failed.");
    } finally {
      setGrading(false);
    }
  }

  const seek = (seconds: number) => {
    if (!video.current) return;
    video.current.currentTime = seconds;
    void video.current.play().catch(() => undefined);
  };

  const followUps = new Set((report?.interactions ?? [])
    .filter(item => (item.avatar_followup_index ?? 0) > 0).map(item => item.sequence_num));
  const grades = report?.grades ?? [];
  const suggestedTotal = grades.reduce((sum, grade) => sum + (numberOrNull(grade.model_suggested_score) ?? 0), 0);
  const maxTotal = grades.reduce((sum, grade) => sum + (numberOrNull(grade.max_score) ?? 0), 0);
  const events = report?.integrity_events ?? [];
  const progressLink = review?.exam_template_id
    ? `/professor/exams/${encodeURIComponent(review.exam_template_id)}/submissions` : "/professor/exams";

  return (
    <div className="professor-dashboard-page professor-review-page">
      <ProfessorHeader title="Professor review" />
      <main className="professor-review-content">
        <div className="professor-review-heading">
          <a href={progressLink} className="back-to-exam-button">
            <ArrowLeft size={16} aria-hidden="true" />Back to Student Progress
          </a>
          {review && (
            <p className="professor-review-subject">
              <strong>{review.student_name}</strong> · {review.student_eid || "EID unavailable"} ·{" "}
              {review.exam_title}{review.course ? ` · ${review.course}` : ""}
            </p>
          )}
        </div>

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
          <div className="professor-review-grid">
            <section className="professor-review-panel professor-review-video" aria-labelledby="recording-heading">
              <h2 id="recording-heading">Recorded exam</h2>
              <video
                ref={video}
                controls
                preload="metadata"
                src={review.video_url}
                aria-label={`Video and audio recording for ${review.student_name}`}
              >
                Your browser cannot play this exam recording.
              </video>
              <p className="professor-review-note">
                Retained until the configured semester-end deadline. Only the professor who owns this exam can see it.
              </p>
              <div className="professor-review-flags" aria-labelledby="flags-heading">
                <h3 id="flags-heading"><AlertTriangle size={16} aria-hidden="true" />Camera presence</h3>
                {events.length === 0 ? (
                  <p>No presence flags were recorded.</p>
                ) : (
                  <ul>
                    {events.map((event, index) => {
                      const at = numberOrNull(event.event_timestamp);
                      return <li key={`${event.event_type}-${index}`}>
                        {at !== null
                          ? <button type="button" onClick={() => seek(at)}>{clock(at)}</button>
                          : <span>—</span>}
                        <span>{EVENT_LABELS[event.event_type] ?? event.notes ?? event.event_type}</span>
                      </li>;
                    })}
                  </ul>
                )}
              </div>
            </section>

            <div className="professor-review-side">
              <section className="professor-review-panel" aria-labelledby="assessment-heading">
                <div className="professor-review-panel-heading">
                  <h2 id="assessment-heading">AI assessment</h2>
                  {grades.length === 0 && (
                    <button type="button" className="professor-review-assess" onClick={() => void runAssessment()} disabled={grading}>
                      {grading ? <LoaderCircle size={16} className="progress-spin" aria-hidden="true" /> : <Sparkles size={16} aria-hidden="true" />}
                      {grading ? "Assessing…" : "Assess with AI"}
                    </button>
                  )}
                </div>
                {gradeError && <p role="alert" className="exam-error">{gradeError}</p>}
                {grades.length === 0 ? (
                  <p className="professor-review-note">Suggested scores from the exam's AI model. You confirm or change every score.</p>
                ) : (
                  <>
                    <p className="professor-review-total">Suggested total <strong>{suggestedTotal} / {maxTotal}</strong></p>
                    <ul className="professor-review-grades">
                      {grades.map(grade => <li key={grade.rubric_criterion}>
                        <div><strong>{grade.rubric_criterion}</strong>
                          <span>{numberOrNull(grade.model_suggested_score) ?? "—"} / {numberOrNull(grade.max_score) ?? "—"}</span></div>
                        {grade.professor_notes && <p>{grade.professor_notes.replace(/^\[AI rationale\]\s*/, "")}</p>}
                      </li>)}
                    </ul>
                    <p className="professor-review-note">Suggestions only. A professor must confirm each score.</p>
                  </>
                )}
              </section>

              <section className="professor-review-panel professor-review-transcript" aria-labelledby="transcript-heading">
                <h2 id="transcript-heading">Questions and answers</h2>
                {review.answers.length === 0 ? (
                  <p>No answer transcript was saved for this session.</p>
                ) : (
                  <ol>
                    {review.answers.map(item => (
                      <li key={item.sequence_num}>
                        <h3>{followUps.has(item.sequence_num) && <span className="professor-review-followup">Follow-up</span>}{item.question}</h3>
                        <p>{item.answer || "No answer submitted."}</p>
                      </li>
                    ))}
                  </ol>
                )}
              </section>
            </div>
          </div>
        ) : null}
      </main>
    </div>
  );
}
