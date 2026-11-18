import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const ts = require('typescript');
const source = await readFile(new URL('../src/components/media/mediaTimeline.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
const { createMediaTimeline } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`);

test('observations serialize in capture order and retries reuse exact event identity', async () => {
  const original = globalThis.fetch;
  const sent = [];
  let offset = 5;
  globalThis.fetch = async (url, init) => {
    sent.push({ url, event: JSON.parse(init.body), authorization: init.headers.Authorization });
    if (sent.length === 1) throw new TypeError('Synthetic network loss');
    return new Response('{}', { status: 200 });
  };
  try {
    const timeline = createMediaTimeline('synthetic-attempt', 'synthetic-token', () => offset);
    const first = timeline.record('question_presented', 1);
    offset = 6;
    const second = timeline.record('question_audio_started', 1, 'synthetic-asset');
    await Promise.all([first, second]);
    assert.deepEqual(sent[0], sent[1]);
    assert.notEqual(sent[1].event.event_id, sent[2].event.event_id);
    assert.equal(sent[1].event.media_offset_seconds, 5);
    assert.equal(sent[2].event.media_offset_seconds, 6);
    assert.equal(sent[2].event.asset_id, 'synthetic-asset');
    assert.equal(sent[2].authorization, 'Bearer synthetic-token');
  } finally { globalThis.fetch = original; }
});

test('authorization failure is not retried and later observations can recover', async () => {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => new Response('{}', { status: ++calls === 1 ? 403 : 200 });
  try {
    const timeline = createMediaTimeline('attempt', 'token', () => null);
    await assert.rejects(timeline.record('question_presented', 1));
    assert.equal(calls, 1);
    await timeline.record('recording_interrupted', 1);
    assert.equal(calls, 2);
  } finally { globalThis.fetch = original; }
});

test('the pending observation queue is bounded and drains without dropping accepted events', async () => {
  const original = globalThis.fetch;
  let release;
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    if (calls === 1) await new Promise(resolve => { release = resolve; });
    return new Response('{}', { status: 200 });
  };
  try {
    const timeline = createMediaTimeline('attempt', 'token', () => 1);
    const pending = Array.from({ length: 32 }, () => timeline.record('question_presented', 1));
    await assert.rejects(timeline.record('question_presented', 1), /unavailable/);
    while (!release) await Promise.resolve();
    release();
    await Promise.all(pending);
    assert.equal(calls, 32);
  } finally { globalThis.fetch = original; }
});
