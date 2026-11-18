export type MediaEventKind = 'question_presented' | 'question_audio_started' | 'question_audio_ended'
  | 'question_audio_failed' | 'recording_interrupted' | 'recording_ended';
export type MediaEvent = { event_id: string; kind: MediaEventKind; question_sequence_num: number;
  media_offset_seconds?: number; asset_id?: string };

/** Serialize observations and retry the SAME event ID. Never advance the exam. */
export function createMediaTimeline(sessionId: string, token: string, offset: () => number | null) {
  let queue: Promise<void> = Promise.resolve();
  let pending = 0;
  const send = async (event: MediaEvent) => {
    for (let attempt = 0; attempt < 2; attempt++) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5000);
      try {
        const response = await fetch(`/api/exam/sessions/${encodeURIComponent(sessionId)}/media-timeline/events`, {
          method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(event), signal: controller.signal, keepalive: true,
        });
        if (response.ok) return;
        if (attempt === 0 && [502, 503, 504].includes(response.status)) continue;
        const failure = new Error('This playback observation could not be saved. The exam recording is separate.');
        failure.name = 'MediaObservationRejected';
        throw failure;
      } catch (error) {
        if (attempt === 1 || (error instanceof Error && error.name === 'MediaObservationRejected')) throw error;
      } finally { clearTimeout(timeout); }
    }
  };
  return {
    record(kind: MediaEventKind, sequence: number, assetId?: string) {
      if (pending >= 32) return Promise.reject(new Error('Playback observations are unavailable. The exam recording is separate.'));
      const seconds = offset();
      const event: MediaEvent = { event_id: crypto.randomUUID(), kind, question_sequence_num: sequence,
        ...(seconds !== null && Number.isFinite(seconds) && seconds >= 0 && seconds <= 86400
          ? { media_offset_seconds: seconds } : {}), ...(assetId ? { asset_id: assetId } : {}) };
      pending++;
      const operation = queue.catch(() => undefined).then(() => send(event));
      queue = operation.finally(() => { pending--; });
      // Keep the queue's internal rejected promise observed. The caller receives
      // the operation's failure and chooses the UI warning without losing events.
      void queue.catch(() => undefined);
      return operation;
    },
  };
}
