import { useCallback, useEffect, useRef, useState } from "react";
import { AlertTriangle, ArrowLeft, LoaderCircle, Play, RefreshCw, Sparkles } from "lucide-react";
import ProfessorHeader from "../../components/professor/ProfessorHeader";
import DownloadAllButton from '../../components/professor/DownloadAllButton';

type ReviewData = {
  student_name: string;
  student_eid: string | null;
  exam_title: string;
  exam_template_id?: string | null;
  course: string | null;
  status: string;
  video_url: string | null;
  video_recording_status?: string | null;
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

type Turn = {
  sequence_num: number;
  question_source: string | null;
  avatar_root_sequence: number | null;
  avatar_followup_index: number | null;
  question_text: string;
  student_answer_transcript: string | null;
  ai_evaluation: string | null;
  topic: string | null;
  asked_at_s: number | string | null;
};

type Report = {
  session: { started_at?: string | null; ended_at?: string | null };
  interactions: Turn[];
  grades: Grade[];
  integrity_events: IntegrityEvent[];
  assessment?: { status: "done" | "running" | "failed" | "not_started"; error?: string };
  rubric?: { default: boolean; criteria: Array<{ name: string; max_score: number }> };
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

function when(value?: string | null) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return `${date.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })} at ${
    date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}`;
}

/** Bank questions with their follow-ups, in exam order. */
function groupTurns(turns: Turn[]) {
  const groups = new Map<number, Turn[]>();
  for (const turn of turns) {
    const root = turn.avatar_root_sequence ?? turn.sequence_num;
    groups.set(root, [...(groups.get(root) ?? []), turn]);
  }
  return [...groups.values()];
}

export default function ExamSessionReview() {
  // The page lives at /professor/exam-sessions/<session id>/review, so the ID is the segment before "review".
  const match = window.location.pathname.match(/^\/professor\/exam-sessions\/([^/]+)\/review\/?$/);
  const sessionId = match ? decodeURIComponent(match[1]) : "";
  const [review, setReview] = useState<ReviewData | null>(null);
  const [report, setReport] = useState<Report | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [retrying, setRetrying] = useState(false);
  const [gradeError, setGradeError] = useState("");
  const video = useRef<HTMLVideoElement>(null);

  const loadReport = useCallback(async () => {
    try {
      const response = await fetch(`/api/exam/${encodeURIComponent(sessionId)}/report`, { credentials: "include" });
      if (response.ok) setReport(await response.json() as Report);
    } catch {
      // The recording still shows without the report.
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
        const response = await fetch(`/api/exam/sessions/${encodeURIComponent(sessionId)}/review`, { credentials: "include" });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) {
          throw new Error(typeof data.detail === "string" ? data.detail : "Unable to load the exam review.");
        }
        if (!cancelled) setReview(data as ReviewData);
        if (!cancelled) await loadReport();
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : "Unable to load the exam review.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void loadReview();
    return () => { cancelled = true; };
  }, [sessionId, loadReport]);

  // The assessment runs on the server when the exam finishes; check back until it is ready.
  const assessing = report?.assessment?.status === "running";
  useEffect(() => {
    if (!assessing) return;
    const timer = window.setInterval(() => void loadReport(), 3000);
    return () => window.clearInterval(timer);
  }, [assessing, loadReport]);

  async function retryAssessment() {
    setRetrying(true);
    setGradeError("");
    try {
      const response = await fetch("/api/exam/grade", {
        method: "POST", credentials: "include", headers: { "Content-Type": "application/json" },
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
      setRetrying(false);
    }
  }

  const seek = (seconds: number) => {
    if (!video.current) return;
    video.current.currentTime = seconds;
    void video.current.play().catch(() => undefined);
  };

  const grades = report?.grades ?? [];
  const suggestedTotal = grades.reduce((sum, grade) => sum + (numberOrNull(grade.model_suggested_score) ?? 0), 0);
  const maxTotal = grades.reduce((sum, grade) => sum + (numberOrNull(grade.max_score) ?? 0), 0);
  const events = report?.integrity_events ?? [];
  const groups = groupTurns(report?.interactions ?? []);
  const progressLink = review?.exam_template_id
    ? `/professor/exams/${encodeURIComponent(review.exam_template_id)}/submissions` : "/professor/exams";
  const rubricLink = review?.exam_template_id
    ? `/professor/exams/${encodeURIComponent(review.exam_template_id)}/settings/ai-results` : "";
  const status = report?.assessment?.status;

  return (
    <div className="professor-dashboard-page professor-review-page">
      <ProfessorHeader title="Professor review" />
      <main className="professor-review-content">
        <div className="professor-review-heading">
          <a href={progressLink} className="professor-back-button">
            <ArrowLeft size={16} aria-hidden="true" />Back to Student Progress
          </a>
          {review && <div className="professor-review-title">
            <h1>{review.student_name} <span>· {review.exam_title}</span></h1>
            <p>{review.student_eid ? `EID ${review.student_eid}` : ""}{report?.session.started_at ? ` · ${when(report.session.started_at)}` : ""}</p>
          </div>}
          {review?.course && <span className="professor-review-course">{review.course}</span>}
          <DownloadAllButton sessionId={sessionId} disabled={loading || !!error || !review} />
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
            <section className="professor-review-qa" aria-labelledby="qa-heading">
              <h2 id="qa-heading">Questions and answers</h2>
              {groups.length === 0 ? <p>No answers were saved for this session.</p> : groups.map((turns, index) => {
                const root = turns[0];
                return <article className="review-question" key={root.sequence_num}>
                  <p className="review-question-label">Question {index + 1}{root.topic ? ` · ${root.topic}` : ""}</p>
                  <p className="review-question-essential"><span>Essential question</span>{root.question_text}</p>
                  <ol className="review-turns">
                    {turns.map(turn => {
                      const at = numberOrNull(turn.asked_at_s);
                      const followUp = (turn.avatar_followup_index ?? 0) > 0;
                      return <li key={turn.sequence_num} className={followUp ? "is-follow-up" : ""}>
                        <div className="review-turn-asked">
                          <span className="review-turn-kind">{followUp ? "Follow-up asked" : "Student answer"}</span>
                          {followUp && <span className="review-turn-question">{turn.question_text}</span>}
                          {at !== null && <button type="button" className="review-timestamp" onClick={() => seek(at)}
                            aria-label={`Play the recording from ${clock(at)}`}><Play size={12} aria-hidden="true" />{clock(at)}</button>}
                        </div>
                        <div className="review-answer">{turn.student_answer_transcript || <em>No answer submitted.</em>}</div>
                        {turn.ai_evaluation && <p className="review-evaluation"><span>AI evaluation</span>{turn.ai_evaluation}</p>}
                      </li>;
                    })}
                  </ol>
                </article>;
              })}
            </section>

            <div className="professor-review-side">
              <section className="professor-review-panel professor-review-video" aria-labelledby="recording-heading">
                <h2 id="recording-heading">Recording</h2>
                {review.video_url ? <video ref={video} controls preload="metadata" src={review.video_url}
                  aria-label={`Video and audio recording for ${review.student_name}`}>
                  Your browser cannot play this exam recording.
                </video> : <p role="status">Recording {review.video_recording_status?.replaceAll('_', ' ') || 'unavailable'}. Submitted answers remain available.</p>}
                <p className="professor-review-note">Recording access follows the administrator-configured retention deadline and exam ownership.</p>
              </section>

              <section className="professor-review-panel" aria-labelledby="assessment-heading">
                <h2 id="assessment-heading">AI assessment</h2>
                {grades.length > 0 ? <>
                  <p className="professor-review-total">Suggested total <strong>{suggestedTotal} / {maxTotal}</strong></p>
                  <ul className="professor-review-grades">
                    {grades.map(grade => <li key={grade.rubric_criterion}>
                      <div><strong>{grade.rubric_criterion}</strong>
                        <span>{numberOrNull(grade.model_suggested_score) ?? "—"} / {numberOrNull(grade.max_score) ?? "—"}</span></div>
                      {grade.professor_notes && <p>{grade.professor_notes.replace(/^\[AI rationale\]\s*/, "")}</p>}
                    </li>)}
                  </ul>
                </> : status === "failed" ? <>
                  <p role="alert" className="exam-error">The AI assessment did not finish: {report?.assessment?.error}</p>
                  <button type="button" className="professor-review-assess" onClick={() => void retryAssessment()} disabled={retrying}>
                    {retrying ? <LoaderCircle size={16} className="progress-spin" aria-hidden="true" /> : <RefreshCw size={16} aria-hidden="true" />}
                    {retrying ? "Assessing…" : "Try again"}
                  </button>
                </> : <p className="professor-review-assessing" role="status">
                  <Sparkles size={16} aria-hidden="true" />Preparing the AI assessment… this usually takes under a minute.
                </p>}
                {gradeError && <p role="alert" className="exam-error">{gradeError}</p>}
                <p className="professor-review-note">
                  {report?.rubric?.default === false ? "Your rubric for this exam" : "Default rubric"}
                  {rubricLink && <> · <a href={rubricLink}>Change rubric</a></>} · Suggestions only; you confirm each score.
                </p>
              </section>

              <section className="professor-review-panel professor-review-flags" aria-labelledby="flags-heading">
                <h2 id="flags-heading"><AlertTriangle size={16} aria-hidden="true" />Camera presence</h2>
                {events.length === 0 ? <p>No presence flags were recorded.</p> : <ul>
                  {events.map((event, index) => {
                    const at = numberOrNull(event.event_timestamp);
                    return <li key={`${event.event_type}-${index}`}>
                      {at !== null ? <button type="button" onClick={() => seek(at)}>{clock(at)}</button> : <span>—</span>}
                      <span>{EVENT_LABELS[event.event_type] ?? event.notes ?? event.event_type}</span>
                    </li>;
                  })}
                </ul>}
              </section>
            </div>
          </div>
        ) : null}
      </main>
    </div>
  );
}
