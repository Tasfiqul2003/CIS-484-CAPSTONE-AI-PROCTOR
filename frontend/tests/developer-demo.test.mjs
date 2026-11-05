import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const ts = require('typescript');
const source = await readFile(new URL('../src/components/developer-demo/developerDemo.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
const { loadDeveloperCapabilities, withTransientSummary, demoAnswer } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`);

test('only an explicit server capability enables developer UI; errors and old backends keep it off', async () => {
  const original = globalThis.fetch;
  try {
    for (const payload of [{}, null, { enabled: 'true' }, { enabled: false, ai_available: true }]) {
      globalThis.fetch = async () => new Response(JSON.stringify(payload));
      assert.deepEqual(await loadDeveloperCapabilities(), { enabled: false });
    }
    globalThis.fetch = async () => new Response('not found', { status: 404 });
    assert.deepEqual(await loadDeveloperCapabilities(), { enabled: false });
    globalThis.fetch = async () => { throw new Error('offline'); };
    assert.deepEqual(await loadDeveloperCapabilities(), { enabled: false });
    const controller = new AbortController();
    globalThis.fetch = async (url, options) => {
      assert.equal(url, '/api/developer/capabilities');
      assert.equal(options.cache, 'no-store');
      assert.equal(options.signal, controller.signal);
      return new Response(JSON.stringify({ enabled: true, ai_available: false, secret: 'must not copy' }));
    };
    assert.deepEqual(await loadDeveloperCapabilities(controller.signal), { enabled: true, aiAvailable: false });
  } finally { globalThis.fetch = original; }
});

test('transient demo excerpts attach to the matching preview without mutating saved content', () => {
  const preview = { id: 'synthetic-material', filename: 'sample.txt', extracted_text: 'Synthetic course material', summary: null };
  const result = { id: preview.id, summary: '[Developer demo] Synthetic excerpt', demo: true, persisted: false };
  assert.deepEqual(withTransientSummary(preview, result), { ...preview, summary: result.summary, demo: true });
  assert.equal(preview.summary, null);
  for (const wrong of [{ ...result, id: 'another-material' }, { ...result, persisted: true }, { ...result, demo: 'true' }, { ...result, summary: null }, null]) {
    assert.equal(withTransientSummary(preview, wrong), preview);
  }
  assert.match(demoAnswer, /^\[Developer demo answer/);
  assert.match(demoAnswer, /not a recording/);
});

test('minimal mode requires an explicit boolean from an enabled server capability', async () => {
  const original = globalThis.fetch;
  try {
    for (const payload of [{enabled:true,minimal:'true'}, {enabled:true,minimal:1}, {enabled:false,minimal:true}]) {
      globalThis.fetch = async () => new Response(JSON.stringify(payload));
      assert.notEqual((await loadDeveloperCapabilities()).minimal, true);
    }
    globalThis.fetch = async () => new Response(JSON.stringify({enabled:true,minimal:true,ai_available:false}));
    assert.deepEqual(await loadDeveloperCapabilities(), {enabled:true,minimal:true,aiAvailable:false});
  } finally { globalThis.fetch = original; }
});
