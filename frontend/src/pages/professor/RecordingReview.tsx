import { useEffect, useState } from 'react';
import { recordingLabels } from '../student/examRecording';
import type { RecordingStatus } from '../student/examRecording';

export type RecordingReviewData = {
  status: RecordingStatus;
  failure_reason: string | null;
  playable: boolean;
  transcript_status: string;
  generated_transcript: string | null;
  transcript_error?: string | null;
  transcript_attempts?: number;
  expires_at?: string | null;
};

export function shouldPollRecording(data: RecordingReviewData) {
  if (['recording', 'awaiting_recording'].includes(data.status)) return true;
  return data.status === 'completed' && (
    ['queued', 'processing', 'unavailable'].includes(data.transcript_status)
    || (data.transcript_status === 'failed' && (data.transcript_attempts ?? 3) < 3));
}

export function recordingPollDelay(attempt: number) {
  return Math.min(30000, 5000 * 2 ** Math.min(3, Math.max(0, attempt)));
}

export function RecordingEvidence({ sessionId, data }: { sessionId: string; data: RecordingReviewData }) {
  return <section className="student-review-section">
    <div className="student-review-section-heading"><h2>Examination recording</h2></div>
    <p role="status">{recordingLabels[data.status] || 'Recording status unavailable'}</p>
    {data.failure_reason && <p>{data.failure_reason}</p>}
    {data.playable && data.status === 'completed' && <video controls preload="metadata"
      style={{ width: '100%', maxHeight: 480 }}
      src={`/api/exam/sessions/${encodeURIComponent(sessionId)}/video`}>
      Your browser cannot play this WebM recording.
    </video>}
    {data.playable && data.status === 'completed' && <p>
      <a href={`/api/exam/sessions/${encodeURIComponent(sessionId)}/video`} download={`exam-${sessionId}.webm`}>Download recording (.webm)</a>
    </p>}
    {data.expires_at && data.status !== 'expired' && <p>
      Recording and speech transcript expiry: <time dateTime={data.expires_at}>{data.expires_at}</time>
    </p>}
    <h3>Generated speech transcript</h3>
    {data.transcript_status === 'completed' && data.generated_transcript !== null
      ? <>
        <p><a href={`/api/exam/sessions/${encodeURIComponent(sessionId)}/speech-transcript`} download>Download speech transcript (.txt)</a></p>
        <p style={{ whiteSpace: 'pre-wrap' }}>{data.generated_transcript || 'No speech was detected in this recording.'}</p>
      </>
      : <p>{data.transcript_status === 'unavailable'
        ? 'Speech transcription is waiting for a configured local worker.'
        : data.transcript_status === 'queued' ? 'Speech transcript queued. It will be saved when the local worker processes this recording.'
        : data.transcript_status === 'processing' ? 'Generating and saving the speech transcript...'
        : `Speech transcript: ${data.transcript_status.replaceAll('_', ' ')}.`}</p>}
    {data.transcript_status === 'failed' && data.transcript_error && <p role="status">{data.transcript_error}</p>}
    <p>The speech transcript is machine-generated from the recording and may include both the examiner and student. Check it against the recording before relying on it.</p>
    <p>Typed answers are shown separately below and remain the source for assessment.</p>
  </section>;
}

export default function RecordingReview({ sessionId }: { sessionId: string }) {
  const [loaded, setLoaded] = useState<{ sessionId: string; data: RecordingReviewData } | null>(null);
  const [error, setError] = useState('');
  const [refresh, setRefresh] = useState(0);
  const data = loaded?.sessionId === sessionId ? loaded.data : null;
  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let requestTimer: ReturnType<typeof setTimeout> | undefined;
    let abort: AbortController | null = null;
    let polls = 0;
    let failures = 0;
    let keepPolling = true;
    setError('');
    function schedule() {
      if (active && keepPolling) timer = setTimeout(() => void load(), recordingPollDelay(polls++));
    }
    async function load() {
      if (!active || !keepPolling || abort) return;
      if (document.hidden) return; // Resume when this tab becomes visible.
      abort = new AbortController();
      requestTimer = setTimeout(() => abort?.abort(), 10000);
      try {
        const response = await fetch(`/api/exam/sessions/${encodeURIComponent(sessionId)}/recording-review`,
          { credentials: 'include', cache: 'no-store', signal: abort.signal });
        if (!active) return;
        if (!response.ok) {
          // Authentication or access failures must not leave private evidence on screen.
          if ([401, 403, 404].includes(response.status)) {
            keepPolling = false;
            setLoaded(null);
          }
          throw new Error('Unable to load recording status. Typed answers remain available.');
        }
        const result = await response.json() as RecordingReviewData;
        if (!active) return;
        setLoaded({ sessionId, data: result });
        setError('');
        failures = 0;
        keepPolling = shouldPollRecording(result);
      } catch (failure) {
        if (active) {
          failures++;
          if (failures >= 3) keepPolling = false;
          setError(failure instanceof Error && failure.name !== 'AbortError'
            ? failure.message : 'Recording status could not be refreshed. Typed answers remain available.');
        }
      } finally {
        clearTimeout(requestTimer);
        abort = null;
        schedule();
      }
    }
    function visible() {
      if (!document.hidden) {
        clearTimeout(timer);
        void load();
      }
    }
    document.addEventListener('visibilitychange', visible);
    void load();
    return () => {
      active = false;
      clearTimeout(timer);
      clearTimeout(requestTimer);
      abort?.abort();
      document.removeEventListener('visibilitychange', visible);
    };
  }, [sessionId, refresh]);
  return <>
    {error && <section className="student-review-section"><h2>Recording status</h2>
      <p role="status">{error}</p>
      <button type="button" onClick={() => setRefresh(value => value + 1)}>Refresh recording status</button>
    </section>}
    {data ? <RecordingEvidence sessionId={sessionId} data={data} />
      : !error && <p role="status">Loading recording status...</p>}
  </>;
}
