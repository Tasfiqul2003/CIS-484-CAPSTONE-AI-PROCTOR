import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const ts = require('typescript');
async function moduleUrl(path, imports = {}) {
  const source = await readFile(new URL(path, import.meta.url), 'utf8');
  const result = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext }, reportDiagnostics: true });
  assert.deepEqual(result.diagnostics.filter(item => item.category === ts.DiagnosticCategory.Error), []);
  let compiled = result.outputText;
  for (const [specifier, url] of Object.entries(imports)) compiled = compiled.replaceAll(`"${specifier}"`, JSON.stringify(url)).replaceAll(`'${specifier}'`, JSON.stringify(url));
  return `data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`;
}
const settingsUrl = await moduleUrl('../src/components/avatar/settings.ts');
const preferencesUrl = await moduleUrl('../src/components/student-settings/studentSettings.ts');
const sessionUrl = await moduleUrl('../src/components/avatar/sessionPresentation.ts', { './settings': settingsUrl, '../student-settings/studentSettings': preferencesUrl });
const { BACKGROUNDS, defaultSettings, validateSettings } = await import(settingsUrl);
const { readEnvironmentPresentation, environmentPresentation } = await import(await moduleUrl('../src/components/avatar/environmentPresentation.ts', { './sessionPresentation': sessionUrl }));
const { pendingAnswer } = await import(await moduleUrl('../src/pages/student/answerSubmission.ts'));

test('five offline backgrounds validate in professor policy and student preferences', () => {
  assert.deepEqual(BACKGROUNDS.map(item => item.id), ['neutral', 'library', 'classroom', 'office', 'nature']);
  for (const { id } of BACKGROUNDS) {
    const settings = defaultSettings(); settings.presentation.background = id; settings.student.background = true;
    assert.deepEqual(validateSettings(settings), []);
  }
});

function fixture() {
  return { exam_id: 'synthetic-exam', revision: 2, voice_profile: 'clear', notice: null,
    policy: { defaults: { avatar: 'guide', background: 'neutral', customAvatar: null, customBackground: null, voiceLabel: 'Clear', speed: 1, reducedMotion: false, animation: true },
      allowAvatar: false, allowBackground: true, allowSpeed: false,
      avatarChoices: [{ id: 'guide', label: 'Guide' }], backgroundChoices: BACKGROUNDS, minSpeed: 1, maxSpeed: 1 },
    preferences: { volume: 70, textSize: 16, reducedMotion: false, avatar: 'guide', background: 'nature', speed: 1 } };
}
test('preview API validates scope, allowed catalog and private output omission', () => {
  const value = { ...fixture(), rubric: 'private' };
  assert.equal(readEnvironmentPresentation(value, 'synthetic-exam').preferences.background, 'nature');
  assert.equal(readEnvironmentPresentation(value, 'synthetic-exam').rubric, undefined);
  assert.throws(() => readEnvironmentPresentation(value, 'another-exam'));
  value.policy.allowBackground = false;
  assert.throws(() => readEnvironmentPresentation(value, 'synthetic-exam'));
});
test('preflight fetch and save use only authenticated presentation routes', async () => {
  const original = globalThis.fetch; const requests = [];
  globalThis.fetch = async (url, options) => { requests.push({ url, options }); return { ok: true, json: async () => fixture() }; };
  try {
    await environmentPresentation('synthetic-exam', 'synthetic-token');
    await environmentPresentation('synthetic-exam', 'synthetic-token', undefined, { preferences: fixture().preferences, expected_revision: 2 });
    assert.equal(requests[0].options.method, 'GET');
    assert.equal(requests[1].options.method, 'PUT');
    assert.ok(requests.every(item => item.url.endsWith('/student-presentation')));
    assert.ok(requests.every(item => item.options.headers.Authorization === 'Bearer synthetic-token'));
  } finally { globalThis.fetch = original; }
});
test('answer retries retain operation and payload across timeout, edits and new questions isolate them', () => {
  let nextId = 0; const newId = () => `synthetic-request-${++nextId}`;
  const first = pendingAnswer(null, 'attempt-one', 1, ' Sample answer ', false, newId);
  assert.equal(pendingAnswer(first, 'attempt-one', 1, ' Sample answer ', true, newId), first);
  assert.equal(first.answer_transcript, 'Sample answer');
  assert.notEqual(pendingAnswer(first, 'attempt-one', 1, 'Corrected answer', false, newId).request_id, first.request_id);
  assert.notEqual(pendingAnswer(first, 'attempt-one', 2, ' Sample answer ', false, newId).request_id, first.request_id);
  assert.notEqual(pendingAnswer(first, 'attempt-two', 1, ' Sample answer ', false, newId).request_id, first.request_id);
});
test('lost-response retries preserve confirmed draft provenance and approximate exchange bounds', () => {
  const metadata = { input_source: 'confirmed_transcript', transcript_draft_id: 'synthetic-draft',
    transcript_receipt: 'synthetic-signed-receipt', machine_draft: 'Machine draft', answer_timestamp_start: 12.5, answer_timestamp_end: 24.25 };
  const first = pendingAnswer(null, 'attempt-one', 2, 'Student correction', false, () => 'synthetic-request', metadata);
  const retried = pendingAnswer(first, 'attempt-one', 2, 'Student correction', true, () => { throw new Error('must retain id'); },
    { answer_timestamp_start: 12.5, answer_timestamp_end: 30 });
  assert.deepEqual(retried, first);
  assert.equal(retried.answer_timestamp_end, 24.25);
  assert.equal(retried.transcript_receipt, metadata.transcript_receipt);
  assert.equal(retried.machine_draft, 'Machine draft');
});
test('provider metadata cannot override the attempt, question or operation identifier', () => {
  const request = pendingAnswer(null, 'authorized-attempt', 2, 'Confirmed text', false, () => 'new-operation',
    { session_id: 'another-attempt', question_sequence_num: 9, request_id: 'stale-operation', answer_transcript: 'overridden', rubric: 'private' });
  assert.equal(request.session_id, 'authorized-attempt');
  assert.equal(request.question_sequence_num, 2);
  assert.equal(request.request_id, 'new-operation');
  assert.equal(request.answer_transcript, 'Confirmed text');
  assert.equal(request.rubric, undefined);
});
