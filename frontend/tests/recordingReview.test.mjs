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
const { RecordingEvidence } = await import(generated.href);
function render(status, playable = false) {
  return renderToStaticMarkup(createElement(RecordingEvidence, { sessionId: 'synthetic-session', data: {
    status, playable, failure_reason: null, transcript_status: 'unavailable', generated_transcript: null,
  } }));
}

test('completed recordings use private authenticated playback and a separate speech transcript section', () => {
  const html = render('completed', true);
  assert.match(html, /<video/);
  assert.match(html, /src="\/api\/exam\/sessions\/synthetic-session\/video"/);
  assert.match(html, /Generated speech transcript/);
  assert.match(html, /Typed answers are shown separately/);
  assert.match(html, /transcription is unavailable/);
});

test('declines, failures, interruptions, expiry and disabled recording do not render a broken player', () => {
  for (const status of ['consent_declined', 'upload_failed', 'permission_denied', 'interrupted', 'expired', 'not_required']) {
    const html = render(status, true);
    assert.doesNotMatch(html, /<video/);
    assert.match(html, /role="status"/);
  }
});
