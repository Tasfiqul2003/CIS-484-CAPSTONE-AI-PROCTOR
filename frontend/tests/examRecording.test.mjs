import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { ExamRecording } from '../src/pages/student/examRecording.ts';

const original = { fetch: globalThis.fetch, navigator: Object.getOwnPropertyDescriptor(globalThis, 'navigator') };
afterEach(() => {
  globalThis.fetch = original.fetch;
  if (original.navigator) Object.defineProperty(globalThis, 'navigator', original.navigator);
  delete globalThis.MediaRecorder;
  delete globalThis.isSecureContext;
});
const attempt = { session_id: 'synthetic-session', status: 'in_progress', record_examination: true, recording_consent_status: 'consented' };
const turn = () => new Promise(resolve => setImmediate(resolve));

function environment({ existing = 'awaiting_recording', ready = true, denied = false, uploadFailures = 0 } = {}) {
  const states = [], requests = [], recorders = [], tracks = [{ stopped: false }, { stopped: false }];
  let permissions = 0;
  for (const track of tracks) {
    track.stop = () => { track.stopped = true; };
    track.addEventListener = () => {};
  }
  const stream = { getTracks: () => tracks, getAudioTracks: () => [tracks[0]], getVideoTracks: () => [tracks[1]] };
  let expectedRecordingStream = stream;
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { mediaDevices: {
    getUserMedia: async constraints => {
      permissions++;
      assert.deepEqual(constraints, { audio: true, video: true });
      if (denied) throw new DOMException('synthetic', 'NotAllowedError');
      return stream;
    },
  } } });
  globalThis.isSecureContext = true;
  globalThis.MediaRecorder = class {
    static isTypeSupported(type) { return type.includes('webm'); }
    state = 'inactive';
    constructor(combinedStream) { assert.equal(combinedStream, expectedRecordingStream); recorders.push(this); }
    start(timeslice) { assert.equal(timeslice, 5000); this.state = 'recording'; }
    emit(data) { this.ondataavailable({ data: new Blob([data]) }); }
    stop() {
      this.state = 'inactive';
      queueMicrotask(() => { this.emit('last'); this.onstop(); });
    }
  };
  globalThis.fetch = async (url, init) => {
    requests.push({ url, init });
    if (url.includes('/chunks/') && uploadFailures-- > 0) return Response.json({}, { status: 503 });
    return Response.json(url.endsWith('/preflight') ? { ready }
      : url.endsWith('video-recording') ? { status: existing } : { accepted: true });
  };
  return { states, requests, recorders, tracks, stream, expectStream: value => { expectedRecordingStream = value; }, permissions: () => permissions,
    controller: new ExamRecording(status => states.push(status)) };
}

test('pending consent, declines, disabled snapshots, and demos never request media', async () => {
  const env = environment();
  for (const settings of [{ recording_consent_status: 'pending' }, { recording_consent_status: 'declined' },
    { record_examination: false }, { developer_demo: true }]) {
    await env.controller.start({ ...attempt, ...settings }, 'synthetic-token');
  }
  assert.equal(env.permissions(), 0);
  assert.equal(env.requests.length, 0);
  assert.ok(env.states.includes('consent_declined'));
});

test('permission denial is reported without throwing into the exam', async () => {
  const env = environment({ denied: true });
  await env.controller.start(attempt, 'synthetic-token');
  assert.equal(env.states.at(-1), 'permission_denied');
  assert.equal(JSON.parse(env.requests.at(-1).init.body).status, 'permission_denied');
  assert.equal(env.recorders.length, 0);
});

test('failed preflight allows exam continuation without requesting devices', async () => {
  const env = environment({ ready: false });
  await env.controller.start(attempt, 'synthetic-token');
  assert.equal(env.permissions(), 0);
  assert.equal(env.states.at(-1), 'unavailable');
});

test('refresh reports an existing capture interrupted instead of starting another', async () => {
  const env = environment({ existing: 'recording' });
  await env.controller.start(attempt, 'synthetic-token');
  await env.controller.start(attempt, 'synthetic-token');
  assert.equal(env.permissions(), 0);
  assert.equal(env.states.at(-1), 'interrupted');
  assert.equal(env.requests.filter(item => item.url.endsWith('/failure')).length, 1);
});

test('combined recording uploads retry at the same index and flush on completion', async () => {
  const env = environment({ uploadFailures: 1 });
  await env.controller.start(attempt, 'synthetic-token');
  await env.controller.start(attempt, 'synthetic-token');
  assert.equal(env.permissions(), 1);
  assert.equal(env.states.at(-1), 'recording');
  env.recorders[0].emit('first');
  const completion = env.controller.finish();
  assert.ok(env.tracks.every(track => track.stopped));
  await completion;
  assert.equal(env.states.at(-1), 'completed');
  const urls = env.requests.filter(item => item.url.includes('/chunks/')).map(item => item.url.split('/').at(-1));
  assert.deepEqual(urls, ['0', '0', '1']);
  assert.equal(JSON.parse(env.requests.find(item => item.url.endsWith('/complete')).init.body).expected_chunk_count, 2);
});

test('upload failure during finalization never becomes completed', async () => {
  const env = environment({ uploadFailures: 20 });
  await env.controller.start(attempt, 'synthetic-token');
  env.recorders[0].emit('first');
  await env.controller.finish();
  assert.equal(env.states.at(-1), 'upload_failed');
  assert.ok(env.tracks.every(track => track.stopped));
  assert.ok(!env.requests.some(item => item.url.endsWith('/complete')));
});

test('unmount releases devices and records an interruption', async () => {
  const env = environment();
  await env.controller.start(attempt, 'synthetic-token');
  env.controller.interrupt();
  await turn();
  assert.ok(env.tracks.every(track => track.stopped));
  assert.equal(env.states.at(-1), 'interrupted');
});

test('late permission acceptance after exam completion releases the stream', async () => {
  const env = environment();
  let accept;
  navigator.mediaDevices.getUserMedia = () => new Promise(resolve => { accept = resolve; });
  const starting = env.controller.start(attempt, 'synthetic-token');
  while (!accept) await turn();
  await env.controller.finish();
  accept({ getTracks: () => env.tracks });
  await starting;
  assert.ok(env.tracks.every(track => track.stopped));
  assert.equal(env.recorders.length, 0);
});

test('examiner audio mixing keeps the original shared stream and releases every track', async () => {
  const env = environment();
  const audio = { stopped: false, stop() { this.stopped = true; } };
  const mixed = { getTracks: () => [env.tracks[1], audio] };
  let released = 0;
  env.expectStream(mixed);
  const controller = new ExamRecording(status => env.states.push(status), {
    prepareStream: source => { assert.equal(source, env.stream); return mixed; },
    releaseStream: () => { released++; },
  });
  await controller.start(attempt, 'synthetic-token');
  assert.equal(controller.getMediaStream(), env.stream);
  await controller.finish();
  assert.ok(env.tracks.every(track => track.stopped));
  assert.ok(audio.stopped);
  assert.equal(released, 1);
  assert.equal(controller.getMediaStream(), null);
});
