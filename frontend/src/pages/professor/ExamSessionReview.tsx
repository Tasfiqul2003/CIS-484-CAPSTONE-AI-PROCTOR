import { useCallback, useEffect, useRef, useState } from "react";
import { AlertTriangle, ArrowLeft, LoaderCircle, Play, RefreshCw, Sparkles, Headphones, FileText } from "lucide-react";
import ProfessorHeader from "../../components/professor/ProfessorHeader";
import OralExamMark from "../../components/brand/OralExamMark";
import "../../styles/exam-ui-tokens.css";
import "./exam-review.css";
import ProvisionalAssessment from '../../components/exam/ProvisionalAssessment';

type AnswerReview = {
  sequence_num: number;
  question: string;
  answer: string | null;
  interaction_id?: string;
  answer_timestamp_start?: number | string | null;
  answer_timestamp_end?: number | string | null;
  transcript_source?: string;
  response_media_status?: string;
  machine_transcript_draft?: string | null;
  question_audio_assets?: { asset_id: string; audio_url?: string; status: string; playback_status: string }[];
};

type ReviewData = {
  student_name: string;
  student_eid: string | null;
  exam_title: string;
  exam_template_id?: string | null;
  course: string | null;
  status: string;
  identity_check_completed?: boolean;
  identity_review_required?: boolean;
  video_url: string;
  recording_expires_at?: string;
  answers: AnswerReview[];
  media_events?: { event_id: string; question_sequence_num: number; kind: string;
    media_offset_seconds: number | null; continuity_boundary: boolean }[];
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
  const [mediaError, setMediaError] = useState("");
  const video = useRef<HTMLVideoElement>(null);
  const segmentEnd = useRef<number | null>(null);
  const questionAudio = useRef<HTMLAudioElement | null>(null);
  const playbackGeneration = useRef(0);
  const bindVideo = useCallback((element: HTMLVideoElement | null) => {
    if (video.current !== element) {
      playbackGeneration.current++;
      video.current?.pause();
      segmentEnd.current = null;
      video.current = element;
    }
  }, []);

  async function playResponse(item: AnswerReview) {
    const player = video.current;
    const generation = ++playbackGeneration.current;
    const start = Number(item.answer_timestamp_start);
    const end = Number(item.answer_timestamp_end);
    if (!player || item.response_media_status !== "available") return;
    setMediaError("");
    questionAudio.current?.pause();
    if (item.answer_timestamp_start == null || item.answer_timestamp_end == null || !Number.isFinite(start)
        || !Number.isFinite(end) || start < 0 || end <= start || !Number.isFinite(player.duration)
        || start > player.duration || end > player.duration) {
      player.pause();
      setMediaError("This exchange cannot be located in the available recording. Use the full recording controls.");
      segmentEnd.current = null;
      return;
    }
    segmentEnd.current = end;
    try { player.currentTime = start; await player.play(); }
    catch {
      if (generation === playbackGeneration.current && video.current === player) {
        segmentEnd.current = null;
        setMediaError("Playback could not start. Use the recording controls or try a supported browser.");
      }
    }
  }



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
    const controller = new AbortController();
    setLoading(true); setReview(null); setError(""); setMediaError("");
    async function loadReview() {
      if (!sessionId) {
        setError("The exam session ID is missing.");
        setLoading(false);
        return;
      }
      try {
        const response = await fetch(`/api/exam/sessions/${encodeURIComponent(sessionId)}/review`, { credentials: "include", signal: controller.signal });
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
    return () => { cancelled = true; controller.abort(); playbackGeneration.current++; video.current?.pause(); questionAudio.current?.pause(); questionAudio.current = null; segmentEnd.current = null; };
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
    playbackGeneration.current++; segmentEnd.current = null; questionAudio.current?.pause();
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
    <div className="professor-dashboard-page professor-review-page review-settings-style">
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
            {review.identity_review_required && review.identity_check_completed === false && <p role="status">Identity was not verified by a photo check. This attempt requires professor identity review.</p>}
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

            <section className="exam-card review-transcript" aria-labelledby="transcript-heading">
              <h2 id="transcript-heading"><FileText size={20} aria-hidden="true" />Submitted answer transcript</h2>
              <p>Exchange seek positions are approximate times reported by the student's browser. They may include question reading and silence; they do not prove when an answer was spoken.</p>
              {(review.answers ?? []).length === 0 ? (
                <p>No answer transcript was saved for this session.</p>
              ) : (
                <ol>
                  {(review.answers ?? []).map(item => (
                    <li key={item.interaction_id || item.sequence_num}>
                      <h3>{item.question}</h3>
                      {item.question_audio_assets?.length ? <section aria-label={`Question audio for exchange ${item.sequence_num}`}>
                        {item.question_audio_assets.map(asset => <div key={asset.asset_id}>
                          <p>{asset.playback_status === 'ended_reported' ? 'Saved question audio; browser reported playback ended.'
                            : asset.playback_status === 'started_reported' ? 'Saved question audio; browser reported playback started, without a completed-playback report.'
                            : 'Generated question audio; browser playback was not reported.'}</p>
                          {asset.status === 'ready' && asset.audio_url ? <audio controls preload="metadata" src={asset.audio_url}
                            aria-label={`Saved question audio for exchange ${item.sequence_num}`}
                            onPlay={event => { playbackGeneration.current++; segmentEnd.current = null; video.current?.pause();
                              if (questionAudio.current !== event.currentTarget) questionAudio.current?.pause();
                              questionAudio.current = event.currentTarget;
                              event.currentTarget.playbackRate = video.current?.playbackRate ?? 1;
                            }} onError={() => setMediaError('Saved question audio is missing, expired, or unsupported. The delivered question text remains available.')} />
                            : <p>Saved question audio has expired or is unavailable.</p>}
                        </div>)}
                        <p>These browser reports do not prove what the student heard.</p>
                      </section> : <p>Original delivered-question audio unavailable. The saved question text is shown above.</p>}
                      <p>{item.answer || "No answer submitted."}</p>
                      {item.machine_transcript_draft && <details><summary>Original speech draft</summary><p>{item.machine_transcript_draft}</p></details>}
                      <p>Transcript source: {item.transcript_source === "confirmed_transcript" ? "Student-confirmed speech transcript"
                        : item.transcript_source === "automatic_transcript" ? "Automatic speech transcript (not student reviewed)"
                        : item.transcript_source === "unanswered_voice" ? "No intelligible spoken response"
                        : item.transcript_source === "typed" ? "Typed answer" : item.transcript_source === "timeout" ? "Question timed out" : "Legacy source unknown"}.</p>
                      {item.response_media_status === "available"
? <button type="button" onClick={() => void playResponse(item)}>Play exchange {item.sequence_num}</button>
                        : <p>Response segment offsets unavailable; use the full recording controls.</p>}
                    </li>
                  ))}
                </ol>
              )}
            </section>
            {sessionId && <ProvisionalAssessment sessionId={sessionId}
              onConfirmed={status => setReview(current => current ? { ...current, status } : current)} />}
            <section className="exam-card review-timeline">
              <details><summary>Delivery and interruption timeline</summary>
                <p>Times are approximate recording offsets reported by the browser. An interruption marks a continuity boundary; missing observations are not filled in.</p>
                {review.media_events?.length ? <ol>{review.media_events.map(event => <li key={event.event_id}>
                  Question {event.question_sequence_num}: {{question_presented:'Question shown', question_audio_started:'Question audio started (browser reported)',
                    question_audio_ended:'Question audio ended (browser reported)', question_audio_failed:'Question audio stopped or failed',
                    student_response_submitted:'Answer submitted', recording_interrupted:'Recording interrupted — continuity boundary',
                    recording_ended:'Recording ended — continuity boundary'}[event.kind] || 'Media observation'}
                  {event.media_offset_seconds === null ? ' · offset unavailable' : ` · approximately ${Number(event.media_offset_seconds).toFixed(1)} seconds`}
                </li>)}</ol> : <p>No delivery or interruption observations were saved for this recording.</p>}
              </details>
            </section>
            <div className="professor-review-side">
              <section className="professor-review-panel professor-review-video" aria-labelledby="recording-heading">
                <h2 id="recording-heading"><Headphones size={20} aria-hidden="true" />Recording</h2>
                <video ref={bindVideo} controls preload="metadata" src={review.video_url}
                  onError={() => setMediaError("Recording unavailable, expired, or unsupported by this browser.")}
                  onPlay={() => questionAudio.current?.pause()}
                  onTimeUpdate={() => { if (video.current && segmentEnd.current !== null && video.current.currentTime >= segmentEnd.current) { video.current.pause(); segmentEnd.current = null; } }}
                  onSeeking={() => { if (video.current && segmentEnd.current !== null && video.current.currentTime > segmentEnd.current) segmentEnd.current = null; }}
                  aria-label={`Video and audio recording for ${review.student_name}`}>
                  Your browser cannot play this exam recording.
                </video>
              <label>Playback speed{" "}
                <select defaultValue="1" onChange={event => {
                  if (video.current) video.current.playbackRate = Number(event.target.value);
                  if (questionAudio.current) questionAudio.current.playbackRate = Number(event.target.value);
                }}>
                  <option value="0.5">0.5×</option><option value="1">1×</option>
                  <option value="1.5">1.5×</option><option value="2">2×</option>
                </select>
              </label>
              {mediaError && <p role="alert">{mediaError}</p>}
                <p className="professor-review-note">Recording retention deadline: {review.recording_expires_at ? new Date(review.recording_expires_at).toLocaleString() : 'unavailable'}.</p>
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
