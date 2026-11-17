import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ts = require('typescript');
const source = await readFile(new URL('../src/components/avatar/voiceCommands.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } });
const { isRepeatRequest } = await import(`data:text/javascript,${encodeURIComponent(compiled.outputText)}`);

test('short requests to hear the question again are recognised', () => {
  for (const said of ['Can you repeat the question?', 'Sorry, say that again.', 'Repeat that please',
    "I didn't hear that", 'Could you ask the question again?', 'Pardon?', 'One more time']) {
    assert.equal(isRepeatRequest(said), true, said);
  }
});

test('answers are never mistaken for a repeat request', () => {
  for (const said of ['', 'A primary key uniquely identifies each row in the table.',
    'You repeat the key in the child table as a foreign key so the rows stay linked together.',
    'Normalization reduces duplicate data.']) {
    assert.equal(isRepeatRequest(said), false, said);
  }
});

test('requests to clarify are recognised, answers are not', async () => {
  const { isClarifyRequest } = await import(`data:text/javascript,${encodeURIComponent(compiled.outputText)}`);
  for (const said of ['Can you clarify?', 'What do you mean?', "I don't understand the question", 'Could you rephrase that?'])
    assert.equal(isClarifyRequest(said), true, said);
  for (const said of ['A primary key uniquely identifies each row.', 'Can you repeat the question?',
    'To clarify my answer, normalization removes duplicate data from related tables in the schema.'])
    assert.equal(isClarifyRequest(said), false, said);
});
