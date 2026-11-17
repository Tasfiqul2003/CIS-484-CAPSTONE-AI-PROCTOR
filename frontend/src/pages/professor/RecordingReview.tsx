import { useEffect, useState } from 'react';
import { recordingLabels } from '../student/examRecording';
import type { RecordingStatus } from '../student/examRecording';

export type RecordingReviewData = {
  status: RecordingStatus;
  failure_reason: string | null;
  playable: boolean;
  transcript_status: string;
  generated_transcript: string | null;
};

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
    <h3>Generated speech transcript</h3>
    {data.transcript_status === 'completed' && data.generated_transcript
      ? <p style={{ whiteSpace: 'pre-wrap' }}>{data.generated_transcript}</p>
      : <p>{data.transcript_status === 'unavailable'
        ? 'Speech transcription is unavailable: a local transcription engine and model must be configured.'
        : `Speech transcript: ${data.transcript_status.replaceAll('_', ' ')}.`}</p>}
    <p>Typed answers are shown separately below and remain the source for assessment.</p>
  </section>;
}

export default function RecordingReview({ sessionId }: { sessionId: string }) {
  const [data, setData] = useState<RecordingReviewData | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    const abort = new AbortController();
    async function load() {
      try {
        const response = await fetch(`/api/exam/sessions/${encodeURIComponent(sessionId)}/recording-review`,
          { credentials: 'include', cache: 'no-store', signal: abort.signal });
        if (!response.ok) throw new Error('Unable to load recording status. Typed answers remain available.');
        const result = await response.json() as RecordingReviewData;
        if (!active) return;
        setData(result);
        setError('');
        if (['recording', 'awaiting_recording'].includes(result.status)) timer = setTimeout(() => void load(), 5000);
      } catch (failure) {
        if (active) setError(failure instanceof Error ? failure.message : 'Recording status unavailable.');
      }
    }
    void load();
    return () => { active = false; clearTimeout(timer); abort.abort(); };
  }, [sessionId]);
  if (error) return <section className="student-review-section"><h2>Examination recording</h2><p role="status">{error}</p></section>;
  return data ? <RecordingEvidence sessionId={sessionId} data={data} />
    : <p role="status">Loading recording status...</p>;
}
