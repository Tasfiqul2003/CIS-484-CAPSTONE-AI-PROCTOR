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
  for (const [specifier, url] of Object.entries(imports)) {
    compiled = compiled.replaceAll(`'${specifier}'`, JSON.stringify(url)).replaceAll(`"${specifier}"`, JSON.stringify(url));
  }
  return `data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`;
}
const settingsUrl = await moduleUrl('../src/components/avatar/settings.ts');
const preferencesUrl = await moduleUrl('../src/components/student-settings/studentSettings.ts');
const { readSessionPresentation, loadSessionPresentation, saveSessionPresentation } = await import(await moduleUrl(
  '../src/components/avatar/sessionPresentation.ts', { './settings': settingsUrl, '../student-settings/studentSettings': preferencesUrl },
));
const { selectEnglishVoice, standardVoiceDelivery, createExamSpeaker } = await import(await moduleUrl('../src/components/avatar/examSpeech.ts'));
const { readAssistanceState, readAssistanceResult, requestAssistance, completeAssistance, pendingAssistanceRequest } = await import(await moduleUrl('../src/components/avatar/sessionAssistance.ts'));
const session = 'synthetic-session';
const token = 'synthetic-token';
const presentation = () => ({
  session_id: session, revision: 3, voice_profile: 'clear',
  policy: {
    defaults: { avatar: 'guide', background: 'neutral', customAvatar: null, customBackground: null,
      voiceLabel: 'Clear English voice', speed: 1, reducedMotion: false, animation: true },
    allowAvatar: false, allowBackground: false, allowSpeed: false,
    avatarChoices: [{ id: 'guide', label: 'Guide examiner' }], backgroundChoices: [{ id: 'neutral', label: 'Neutral' }],
    minSpeed: 1, maxSpeed: 1,
  },
  preferences: { volume: 70, textSize: 16, reducedMotion: false, avatar: 'guide', background: 'neutral', speed: 1 },
});
const assistance = () => ({ session_id: session, question_sequence_num: 2, mode: 'assessed',
  server_now: '2026-11-04T12:00:00Z', deadline: '2026-11-04T12:20:00Z', question_deadline: '2026-11-04T12:01:00Z', pause_until: null,
  actions: { repeat: { limit: 2, used: 1, remaining: 1, timerContinues: true } },
});

test('live presentation preserves saved restrictions and copies only student-facing fields', () => {
  const source = presentation();
  source.professor_evaluation = 'must not be copied';
  const parsed = readSessionPresentation(source, session);
  assert.equal(parsed.policy.allowAvatar, false);
  assert.equal(parsed.preferences.speed, 1);
  assert.equal(parsed.professor_evaluation, undefined);
  source.preferences.volume = 0;
  assert.equal(parsed.preferences.volume, 70);
  const locked = presentation();
  locked.policy.defaults.speed = locked.preferences.speed = 1.8;
  locked.policy.minSpeed = .8; locked.policy.maxSpeed = 1.2;
  assert.equal(readSessionPresentation(locked, session).policy.minSpeed, 1.8);
});

test('invalid snapshots or forbidden saved preferences cannot enable student controls', () => {
  for (const edit of [value => value.session_id = 'another-session', value => value.revision = -1,
    value => value.voice_profile = 'cloned', value => value.policy.allowAvatar = 'yes',
    value => value.policy.defaults.customAvatar = 'https://example.invalid/image.png',
    value => value.preferences.avatar = 'geometric', value => value.preferences.speed = 1.5,
    value => value.preferences.textSize = 100, value => value.preferences.volume = Infinity,
    value => value.policy.avatarChoices.push({ id: 'guide', label: 'Duplicate' }),
  ]) {
    const value = presentation(); edit(value);
    assert.throws(() => readSessionPresentation(value, session), /invalid exam presentation/);
  }
});

test('presentation transport uses a bearer token and whitelists preferences without browser storage', async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  try {
    globalThis.fetch = async (url, options) => { calls.push({ url, options }); return new Response(JSON.stringify(presentation())); };
    await loadSessionPresentation(session, token);
    const prefs = { ...presentation().preferences, exam_mode: 'practice', assistance: { hint: true } };
    await saveSessionPresentation(session, token, prefs);
    assert.equal(calls[0].url, `/api/exam/sessions/${session}/presentation`);
    assert.equal(calls[0].options.headers.Authorization, `Bearer ${token}`);
    assert.deepEqual(JSON.parse(calls[1].options.body), presentation().preferences);
    globalThis.fetch = async () => new Response('{}', { status: 403 });
    await assert.rejects(loadSessionPresentation(session, token), /403/);
    await assert.rejects(loadSessionPresentation(session, ''), /authorization/);
  } finally { globalThis.fetch = originalFetch; }
});

test('standard English speech selects installed voices and applies professor cadence and comfort preferences', () => {
  const french = { lang: 'fr-FR', localService: true, default: true };
  const englishRemote = { lang: 'en-GB', localService: false, default: false };
  const englishLocal = { lang: 'en-US', localService: true, default: false };
  assert.equal(selectEnglishVoice([french, englishRemote, englishLocal]), englishLocal);
  assert.equal(selectEnglishVoice([french]), undefined);
  assert.deepEqual(standardVoiceDelivery('clear', 1.5, 25), { lang: 'en-US', rate: 1.5, pitch: 1, volume: .25 });
  assert(standardVoiceDelivery('calm', 1, 70).rate < standardVoiceDelivery('clear', 1, 70).rate);
  for (const args of [['clear', 3, 70], ['cloned', 1, 70], ['calm', 1, -1]]) assert.throws(() => standardVoiceDelivery(...args));
});

test('cancelled speech cannot change a newer question avatar state or trigger its completion', () => {
  const spoken = [], states = [], errors = [];
  const engine = { cancel() {}, getVoices: () => [], speak: utterance => spoken.push(utterance) };
  const speaker = createExamSpeaker(engine, text => ({ text }));
  speaker.speak('First synthetic question', 'clear', 1, 70, state => states.push(state), message => errors.push(message));
  const first = spoken[0];
  first.onstart();
  speaker.stop(); first.onend(); first.onerror();
  speaker.speak('Second synthetic question', 'clear', 1, 70, state => states.push(state), message => errors.push(message));
  spoken[1].onstart(); first.onend(); spoken[1].onend();
  assert.deepEqual(states, ['Speaking', 'Speaking', 'Idle']);
  assert.deepEqual(errors, []);
});

test('assistance exposes only server-permitted actions and validates counts, sequence and timing', () => {
  const parsed = readAssistanceState(assistance(), session, 2);
  assert.deepEqual(Object.keys(parsed.actions), ['repeat']);
  for (const edit of [value => value.question_sequence_num = 1, value => value.actions.repeat.remaining = 9,
    value => value.actions.repeat.used = -1, value => value.actions.hint = { limit: 0, used: 0, remaining: 0, timerContinues: true },
    value => value.server_now = 'invalid', value => value.pause_until = 'invalid',
  ]) { const value = assistance(); edit(value); assert.throws(() => readAssistanceState(value, session, 2)); }
  const source = assistance();
  const response = { ...source, usage: { question_sequence_num: 2, actions: source.actions },
    request_id: 'synthetic-request', action: 'repeat', status: 'succeeded', text: 'Synthetic question' };
  assert.equal(readAssistanceResult(response, session, 2, 'synthetic-request').text, 'Synthetic question');
  assert.throws(() => readAssistanceResult({ ...response, request_id: 'other' }, session, 2, 'synthetic-request'));
});

test('assistance retry transport retains request identity and sends answer text only for correctness', async () => {
  const originalFetch = globalThis.fetch, calls = [];
  try {
    globalThis.fetch = async (url, options) => {
      calls.push({ url, options }); const source = assistance();
      return new Response(JSON.stringify({ ...source, request_id: 'synthetic-request', action: 'repeat', status: 'succeeded', text: 'Synthetic question',
        usage: { question_sequence_num: 2, actions: source.actions } }));
    };
    await requestAssistance(session, token, 2, 'repeat', 'synthetic-request', 'private synthetic answer');
    await requestAssistance(session, token, 2, 'repeat', 'synthetic-request');
    assert.deepEqual(JSON.parse(calls[0].options.body), JSON.parse(calls[1].options.body));
    assert.equal(JSON.parse(calls[0].options.body).answer_transcript, undefined);
    await completeAssistance(session, token, 2, 'synthetic-request');
    assert.match(calls[2].url, /assistance\/synthetic-request\/complete$/);
    await assert.rejects(requestAssistance(session, token, 2, 'correctness', 'synthetic-request', ''), /Enter a response/);
  } finally { globalThis.fetch = originalFetch; }
});

test('lost correctness responses replay their original answer and request ID even after draft edits or quota exhaustion', () => {
  const original = pendingAssistanceRequest(null, 2, 'correctness', ' Original synthetic answer ', () => 'original-request');
  const retry = pendingAssistanceRequest(original, 2, 'correctness', 'Edited answer', () => { throw new Error('Retry must not allocate another ID'); });
  assert.equal(retry, original);
  assert.equal(retry.answer, 'Original synthetic answer');
  const nextQuestion = pendingAssistanceRequest(original, 3, 'correctness', 'New answer', () => 'new-question-request');
  assert.equal(nextQuestion.id, 'new-question-request');
  assert.equal(nextQuestion.answer, 'New answer');
  const exhausted = assistance(); exhausted.actions.repeat = { limit: 1, used: 1, remaining: 0, timerContinues: false };
  exhausted.active_request_id = 'original-request';
  assert.equal(readAssistanceState(exhausted, session, 2).active_request_id, 'original-request');
  const reserved = { ...exhausted, usage: { question_sequence_num: 2, actions: exhausted.actions },
    request_id: 'original-request', action: 'repeat', status: 'reserved', text: null };
  assert.equal(readAssistanceResult(reserved, session, 2, 'original-request').status, 'reserved');
});
