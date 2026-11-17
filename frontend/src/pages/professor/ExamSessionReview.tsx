import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowLeft, LoaderCircle } from "lucide-react";
import OralExamMark from "../../components/brand/OralExamMark";
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
  course: string | null;
  status: string;
  video_url: string;
  recording_expires_at?: string;
  answers: AnswerReview[];
  media_events?: { event_id: string; question_sequence_num: number; kind: string;
    media_offset_seconds: number | null; continuity_boundary: boolean }[];
};

export default function ExamSessionReview() {
  const sessionId = window.location.pathname.match(/^\/professor\/exam-sessions\/([^/]+)\/review\/?$/)?.[1];
  const [review, setReview] = useState<ReviewData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
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
        const response = await fetch(
          `/api/exam/sessions/${encodeURIComponent(sessionId)}/review`,
          { credentials: "include", signal: controller.signal },
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
    return () => {
      cancelled = true; controller.abort(); playbackGeneration.current++;
      video.current?.pause(); questionAudio.current?.pause();
      questionAudio.current = null; segmentEnd.current = null;
    };
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
                Access is limited to the professor who owns this exam.
                {review.recording_expires_at ? ` Recording retention deadline: ${new Date(review.recording_expires_at).toLocaleString()}.` : ""}
              </p>
              <video
                ref={bindVideo}
                controls
                preload="metadata"
                src={review.video_url}
                aria-label={`Video and audio recording for ${review.student_name}`}
                style={{ width: "100%", maxHeight: "70vh" }}
                onError={() => setMediaError("Recording unavailable, expired, or unsupported by this browser.")}
                onPlay={() => questionAudio.current?.pause()}
                onTimeUpdate={() => {
                  if (video.current && segmentEnd.current !== null && video.current.currentTime >= segmentEnd.current) {
                    video.current.pause();
                    segmentEnd.current = null;
                  }
                }}
                onSeeking={() => {
                  if (video.current && segmentEnd.current !== null && video.current.currentTime > segmentEnd.current) segmentEnd.current = null;
                }}
              >
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
            </section>

            <section className="exam-card" aria-labelledby="transcript-heading">
              <h2 id="transcript-heading">Submitted answer transcript</h2>
              <p>Exchange seek positions are approximate times reported by the student's browser. They may include question reading and silence; they do not prove when an answer was spoken.</p>
              {review.answers.length === 0 ? (
                <p>No answer transcript was saved for this session.</p>
              ) : (
                <ol>
                  {review.answers.map(item => (
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
            <section className="exam-card">
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
          </>
        ) : null}
      </main>
    </div>
  );
}
