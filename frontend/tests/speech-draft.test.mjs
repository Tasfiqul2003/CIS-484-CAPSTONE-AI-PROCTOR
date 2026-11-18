import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ts = require('typescript');
const source = await readFile(new URL('../src/components/exam/speechDraft.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } });
const { readSpeechDraft, confirmedTranscript } = await import(`data:text/javascript;base64,${Buffer.from(compiled.outputText).toString('base64')}`);
const draft = { request_id: 'request-a', transcript_draft_id: 'request-a', transcript_receipt: 'signed-receipt',
  interaction_id: 'interaction-a', question_revision: 'revision-a', sequence_num: 1,
  text: 'Synthetic machine transcript', source: 'machine_draft', status: 'review_required' };

test('only a correlated review-required draft can be offered for confirmation', () => {
  assert.deepEqual(readSpeechDraft(draft, 'request-a', 1), draft);
  for (const changed of [{ request_id: 'late' }, { transcript_draft_id: 'late' },
    { sequence_num: 2 }, { source: 'confirmed' }, { status: 'submitted' },
    { text: '' }, { text: 'x'.repeat(8001) }, { transcript_receipt: '' },
    { interaction_id: '' }, { question_revision: '' }]) {
    assert.throws(() => readSpeechDraft({ ...draft, ...changed }, 'request-a', 1));
  }
});

test('confirmed metadata preserves original draft and receipt for student corrections', () => {
  const metadata = confirmedTranscript(draft);
  assert.deepEqual(metadata, { input_source: 'confirmed_transcript', transcript_draft_id: 'request-a',
    machine_draft: 'Synthetic machine transcript', transcript_receipt: 'signed-receipt' });
  assert.equal('answer_transcript' in metadata, false);
  assert.equal('submitted' in metadata, false);
});

const waveSource = await readFile(new URL('../src/components/exam/speechWave.ts', import.meta.url), 'utf8');
const waveCompiled = ts.transpileModule(waveSource, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } });
const { encodeSpeechWave, prepareSpeechAudio } = await import(`data:text/javascript;base64,${Buffer.from(waveCompiled.outputText).toString('base64')}`);
test('native WAV encoder bounds samples and creates correct PCM headers', async () => {
  const blob = encodeSpeechWave(new Float32Array([-2, -1, 0, 1, 2, Number.NaN]));
  assert.equal(blob.type, 'audio/wav');
  const data = new DataView(await blob.arrayBuffer());
  assert.equal(data.getUint32(24, true), 16000);
  assert.equal(data.getUint16(22, true), 1);
  assert.equal(data.getUint16(34, true), 16);
  assert.deepEqual(Array.from({length: 6}, (_, i) => data.getInt16(44+i*2, true)), [-32768, -32768, 0, 32767, 32767, 0]);
  assert.throws(() => encodeSpeechWave(new Float32Array(0)));
  assert.throws(() => encodeSpeechWave(new Float32Array(16000*120+1)));
  assert.throws(() => encodeSpeechWave(new Float32Array(1), 44100));
  assert.equal(await prepareSpeechAudio(blob, ['audio/wav']), blob);
  await assert.rejects(prepareSpeechAudio(blob, ['audio/ogg']), /does not accept/);
});


const abortSource=await readFile(new URL('../src/components/exam/abortable.ts',import.meta.url),'utf8');
const abortCompiled=ts.transpileModule(abortSource,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}});
const {abortable}=await import(`data:text/javascript;base64,${Buffer.from(abortCompiled.outputText).toString('base64')}`);
test('abort releases a noncooperative pending preparation immediately',async()=>{
  const controller=new AbortController();
  const waiting=abortable(new Promise(()=>{}),controller.signal);
  controller.abort();
  await assert.rejects(waiting,error=>error.name==='AbortError');
});
test('already aborted work consumes a late decoder failure',async()=>{
  const controller=new AbortController();controller.abort();
  let fail;
  const work=new Promise((_resolve,reject)=>{fail=reject;});
  await assert.rejects(abortable(work,controller.signal),error=>error.name==='AbortError');
  fail(new Error('Late synthetic decoder error'));
  await new Promise(resolve=>setImmediate(resolve));
});
test('completed preparation returns its result without inventing cancellation',async()=>{
  assert.equal(await abortable(Promise.resolve('synthetic-result'),new AbortController().signal),'synthetic-result');
});
