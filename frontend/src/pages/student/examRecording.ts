// Optional media capture is deliberately independent of exam answer requests.
export type RecordingStatus = 'not_required' | 'awaiting_consent' | 'awaiting_recording'
  | 'initializing' | 'recording' | 'finishing' | 'completed' | 'permission_denied'
  | 'unavailable' | 'upload_failed' | 'interrupted' | 'expired' | 'consent_declined';

export const recordingLabels: Record<RecordingStatus, string> = {
  not_required: 'Recording not required', awaiting_consent: 'Awaiting recording consent',
  awaiting_recording: 'Recording has not started', initializing: 'Preparing camera and microphone',
  recording: 'Recording camera and microphone', finishing: 'Answers saved. Finishing recording upload',
  completed: 'Recording completed', permission_denied: 'Camera or microphone permission denied',
  unavailable: 'Recording unavailable', upload_failed: 'Recording upload incomplete',
  interrupted: 'Recording interrupted', expired: 'Recording expired', consent_declined: 'Recording declined',
};

type Failure = 'permission_denied' | 'unavailable' | 'upload_failed' | 'interrupted';
type Attempt = { session_id: string; status: string; developer_demo?: boolean;
  record_examination?: boolean; recording_consent_status?: string };
const MAX_CHUNK = 5 * 1024 * 1024;
const MAX_BUFFER = 64 * 1024 * 1024;

export class ExamRecording {
  private sid = '';
  private token = '';
  private generation = 0;
  private initialized = false;
  private recorder: MediaRecorder | null = null;
  private stream: MediaStream | null = null;
  private captureStream: MediaStream | null = null;
  private queue: Promise<void> = Promise.resolve();
  private index = 0;
  private buffered = 0;
  private failed = false;
  private stopping = false;
  private finishTask: Promise<void> | null = null;
  private stopped: (() => void) | null = null;
  private requests = new Set<AbortController>();

  private onStatus: (status: RecordingStatus) => void;
  private options: { prepareStream?: (stream: MediaStream) => MediaStream; releaseStream?: () => void };
  constructor(onStatus: (status: RecordingStatus) => void,
      options: { prepareStream?: (stream: MediaStream) => MediaStream; releaseStream?: () => void } = {}) {
    this.onStatus = onStatus;
    this.options = options;
  }
  getMediaStream(): MediaStream | null { return this.stream; }

  private async request(path: string, init: RequestInit = {}, attempts = 3): Promise<any> {
    let last: unknown;
    for (let attempt = 0; attempt < attempts; attempt++) {
      const abort = new AbortController();
      this.requests.add(abort);
      const timer = setTimeout(() => abort.abort(), 10000);
      try {
        const response = await fetch(`/api/exam/sessions/${encodeURIComponent(this.sid)}/video-recording${path}`, {
          ...init, signal: abort.signal,
          headers: { Authorization: `Bearer ${this.token}`, ...init.headers },
        });
        if (response.ok) return await response.json();
        if (response.status < 500 && ![408, 429].includes(response.status)) {
          throw Object.assign(new Error('Recording request rejected'), { permanent: true });
        }
        throw new Error('Recording request failed');
      } catch (error) {
        last = error;
        if ((error as { permanent?: boolean }).permanent) throw error;
      } finally {
        clearTimeout(timer);
        this.requests.delete(abort);
      }
      if (attempt + 1 < attempts) await new Promise(resolve => setTimeout(resolve, 250 * (attempt + 1)));
    }
    throw last;
  }

  private post(path: string, body: object = {}) {
    return this.request(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  }

  private release() {
    if (this.recorder && this.recorder.state !== 'inactive') {
      try { this.recorder.stop(); } catch { /* tracks still release below */ }
    }
    const tracks = new Set([...(this.stream?.getTracks() ?? []), ...(this.captureStream?.getTracks() ?? [])]);
    tracks.forEach(track => track.stop());
    this.options.releaseStream?.();
    this.stream = null;
    this.captureStream = null;
  }

  async fail(status: Failure) {
    if (this.failed) return;
    this.failed = true;
    this.generation++;
    this.release();
    this.onStatus(status);
    // Never include browser exception text, devices, tokens, or local paths.
    if (this.sid) await this.post('/failure', { status }).catch(() => {});
  }

  async start(attempt: Attempt, token: string) {
    if (attempt.developer_demo || !attempt.record_examination) {
      this.onStatus('not_required'); return;
    }
    if (attempt.recording_consent_status !== 'consented') {
      this.onStatus(attempt.recording_consent_status === 'declined' ? 'consent_declined' : 'awaiting_consent'); return;
    }
    if (this.initialized) return;
    if (attempt.status !== 'in_progress') {
      this.sid = attempt.session_id;
      this.token = token;
      try { this.onStatus((await this.request('')).status); } catch { this.onStatus('unavailable'); }
      return;
    }
    this.initialized = true;
    this.sid = attempt.session_id;
    this.token = token;
    const generation = ++this.generation;
    this.onStatus('initializing');
    try {
      const existing = await this.request('');
      if (generation !== this.generation) return;
      if (existing.status !== 'awaiting_recording') {
        if (existing.status === 'recording') await this.fail('interrupted');
        else this.onStatus(existing.status);
        return;
      }
      const ready = await this.post('/preflight');
      if (generation !== this.generation) return;
      if (!ready.ready || !globalThis.isSecureContext || !navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
        await this.fail('unavailable'); return;
      }
      const mimeType = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm']
        .find(value => MediaRecorder.isTypeSupported(value));
      if (!mimeType) { await this.fail('unavailable'); return; }
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: true });
      if (generation !== this.generation) { stream.getTracks().forEach(track => track.stop()); return; }
      this.stream = stream;
      if (!stream.getAudioTracks().length || !stream.getVideoTracks().length) {
        await this.fail('unavailable'); return;
      }
      this.captureStream = this.options.prepareStream?.(stream) ?? stream;
      const recorder = new MediaRecorder(this.captureStream, { mimeType, videoBitsPerSecond: 750000, audioBitsPerSecond: 64000 });
      this.recorder = recorder;
      recorder.ondataavailable = event => {
        if (!event.data.size || this.failed) return;
        this.buffered += event.data.size;
        if (this.buffered > MAX_BUFFER) { void this.fail('upload_failed'); return; }
        for (let offset = 0; offset < event.data.size; offset += MAX_CHUNK) {
          const blob = event.data.slice(offset, offset + MAX_CHUNK);
          this.queue = this.queue.then(async () => {
            if (this.failed) return;
            await this.request(`/chunks/${this.index}`, { method: 'PUT', headers: { 'Content-Type': 'application/octet-stream' }, body: blob });
            this.index++;
            this.buffered -= blob.size;
          }).catch(() => { void this.fail('upload_failed'); });
        }
      };
      recorder.onerror = () => { void this.fail('interrupted'); };
      recorder.onstop = () => {
        this.stopped?.();
        if (!this.stopping && !this.failed) void this.fail('interrupted');
      };
      stream.getTracks().forEach(track => track.addEventListener('ended', () => {
        if (!this.stopping && !this.failed) void this.fail('interrupted');
      }));
      await this.post('/start', { content_type: mimeType });
      if (generation !== this.generation) { this.release(); return; }
      recorder.start(5000);
      this.onStatus('recording');
    } catch (error) {
      if (generation !== this.generation) return;
      const denied = error instanceof DOMException && ['NotAllowedError', 'SecurityError'].includes(error.name);
      await this.fail(denied ? 'permission_denied' : 'unavailable');
    }
  }

  finish(): Promise<void> {
    if (this.finishTask) return this.finishTask;
    this.finishTask = this.finishRecording();
    return this.finishTask;
  }

  private async finishRecording() {
    this.generation++; // cancel a pending permission prompt/start request
    if (!this.recorder || this.failed || this.recorder.state === 'inactive') {
      this.release();
      if (this.initialized && !this.failed) {
        this.failed = true;
        this.onStatus('interrupted');
        await this.post('/failure', { status: 'interrupted' }).catch(() => {});
      }
      return;
    }
    this.stopping = true;
    this.onStatus('finishing');
    const stopped = new Promise<void>(resolve => { this.stopped = resolve; });
    this.release(); // stop camera/microphone immediately, regardless of uploads
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        (async () => {
          await stopped;
          await this.queue;
          if (this.failed || this.index === 0) throw new Error('incomplete');
          await this.post('/complete', { expected_chunk_count: this.index });
        })(),
        new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error('upload timeout')), 12000); }),
      ]);
      this.onStatus('completed');
    } catch {
      this.failed = true;
      this.requests.forEach(request => request.abort());
      this.onStatus('upload_failed');
      await this.request('/failure', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'upload_failed' }) }, 1).catch(() => {});
    } finally {
      clearTimeout(timeout);
    }
  }

  interrupt() {
    this.generation++;
    if (this.initialized && !this.stopping) void this.fail('interrupted');
    else this.release();
  }
}
