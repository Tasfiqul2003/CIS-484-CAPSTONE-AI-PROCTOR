export type RetainedAsset = { asset_id: string; interaction_id: string; audio_url: string;
  content_sha256: string; duration_seconds: number; status: string; expires_at?: string;
  byte_count?: number; media_type?: 'audio/wav' | 'video/mp4'; segment_index?: number };

export function validateRetainedAsset(value: RetainedAsset, sessionId: string): RetainedAsset {
  const prefix = `/api/exam/sessions/${encodeURIComponent(sessionId)}/question-audio/`;
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (value.status !== 'ready' || !uuid.test(value.asset_id) || !uuid.test(value.interaction_id)
      || value.audio_url !== prefix + value.asset_id || !/^[0-9a-f]{64}$/.test(value.content_sha256)
      || !(value.duration_seconds > 0 && value.duration_seconds <= 120)
      || (value.media_type !== undefined && !['audio/wav', 'video/mp4'].includes(value.media_type))
      || (value.expires_at !== undefined && !(Date.parse(value.expires_at) > Date.now())))
    throw new Error('The retained examiner media response is invalid or expired.');
  return value;
}

export async function requestQuestionAudio(sessionId: string, token: string, sequence: number,
  requestId: string, signal: AbortSignal): Promise<RetainedAsset> {
  const response = await fetch(`/api/exam/sessions/${encodeURIComponent(sessionId)}/question-audio`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ sequence_num: sequence, request_id: requestId }), signal,
  });
  const value = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(typeof value.detail === 'string' ? value.detail : 'Retained examiner audio is unavailable.');
  return validateRetainedAsset(value, sessionId);
}

/** Caller owns and revokes the returned URL. Both examiner players verify the same bytes. */
export async function loadRetainedAudio(asset: RetainedAsset, sessionId: string, token: string,
  signal: AbortSignal): Promise<string> {
  validateRetainedAsset(asset, sessionId);
  const response = await fetch(asset.audio_url, { headers: { Authorization: `Bearer ${token}` }, cache: 'no-store', signal });
  if (!response.ok) throw new Error('Retained examiner media could not be retrieved.');
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Retained examiner media has no body.');
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read(); if (done) break;
      size += value.byteLength;
      if (size > 10 * 1024 * 1024) throw new Error('Retained examiner media exceeds its limit.');
      chunks.push(value);
    }
  } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
  if (signal.aborted) throw new DOMException('Cancelled', 'AbortError');
  if (size < 12 || (asset.byte_count !== undefined && asset.byte_count !== size))
    throw new Error('Retained examiner media has an invalid size.');
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)))
    .map(value => value.toString(16).padStart(2, '0')).join('');
  if (signal.aborted) throw new DOMException('Cancelled', 'AbortError');
  if (hash !== asset.content_sha256) throw new Error('Retained examiner media failed its integrity check.');
  return URL.createObjectURL(new Blob([bytes], { type: asset.media_type ?? 'audio/wav' }));
}
