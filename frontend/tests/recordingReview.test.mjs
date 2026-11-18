import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, unlink } from 'node:fs/promises';
import ts from 'typescript';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const generated = new URL('./recording-evidence.generated.mjs', import.meta.url);
const source = await readFile(new URL('../src/pages/professor/RecordingReview.tsx', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { jsx: ts.JsxEmit.ReactJSX,
  target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText
  .replaceAll('../student/examRecording', '../src/pages/student/examRecording.ts');
await writeFile(generated, compiled);
after(async () => { await unlink(generated); });
const { RecordingEvidence, shouldPollRecording, recordingPollDelay } = await import(generated.href);
function render(status, playable = false, transcriptStatus = 'unavailable', transcript = null) {
  return renderToStaticMarkup(createElement(RecordingEvidence, { sessionId: 'synthetic-session', data: {
    status, playable, failure_reason: null, transcript_status: transcriptStatus, generated_transcript: transcript,
  } }));
}

test('completed recordings use private authenticated playback and a separate speech transcript section', () => {
  const html = render('completed', true);
  assert.match(html, /<video/);
  assert.match(html, /src="\/api\/exam\/sessions\/synthetic-session\/video"/);
  assert.match(html, /Download recording \(.webm\)/);
  assert.match(html, /Generated speech transcript/);
  assert.match(html, /Typed answers are shown separately/);
  assert.match(html, /waiting for a configured local worker/);
});

test('saved speech text is displayed separately and downloaded through the private session route', () => {
  const html = render('completed', true, 'completed', '[00:00:01] Synthetic speech.');
  assert.match(html, /Synthetic speech/);
  assert.match(html, /href="\/api\/exam\/sessions\/synthetic-session\/speech-transcript"/);
  assert.match(html, /Download speech transcript/);
  assert.match(html, /machine-generated/);
  assert.match(html, /Typed answers are shown separately/);
});

test('empty speech output shows no speech detected without inventing transcript text', () => {
  const html = render('completed', true, 'completed', '');
  assert.match(html, /No speech was detected/);
});

test('review continues polling after media completes while the speech job is pending', () => {
  const data = { status: 'completed', transcript_status: 'queued', transcript_attempts: 0 };
  for (const status of ['queued', 'processing', 'unavailable']) {
    assert.equal(shouldPollRecording({ ...data, transcript_status: status }), true);
  }
  assert.equal(shouldPollRecording({ ...data, transcript_status: 'failed', transcript_attempts: 1 }), true);
  assert.equal(shouldPollRecording({ ...data, transcript_status: 'failed', transcript_attempts: 3 }), false);
  assert.equal(shouldPollRecording({ ...data, transcript_status: 'completed' }), false);
  assert.equal(shouldPollRecording({ ...data, status: 'expired', transcript_status: 'expired' }), false);
});

test('declines, failures, interruptions, expiry and disabled recording do not render a broken player', () => {
  for (const status of ['consent_declined', 'upload_failed', 'permission_denied', 'interrupted', 'expired', 'not_required']) {
    const html = render(status, true);
    assert.doesNotMatch(html, /<video/);
    assert.doesNotMatch(html, /Download recording/);
    assert.match(html, /role="status"/);
    assert.equal(shouldPollRecording({ status, transcript_status: 'unavailable' }), false);
  }
});

test('pending review polling backs off to at most one request every thirty seconds', () => {
  assert.deepEqual([0, 1, 2, 3, 100].map(recordingPollDelay), [5000, 10000, 20000, 30000, 30000]);
});
