import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, unlink } from 'node:fs/promises';
import ts from 'typescript';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const generated = new URL('./download-all.generated.mjs', import.meta.url);
const source = await readFile(new URL('../src/components/professor/DownloadAllButton.tsx', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { jsx: ts.JsxEmit.ReactJSX,
  target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText
  .replace("import './exam-downloads.css';", '');
await writeFile(generated, compiled);
after(async () => { await unlink(generated); });
const { default: DownloadAllButton } = await import(generated.href);
const render = props => renderToStaticMarkup(createElement(DownloadAllButton, props));

test('student download uses one private native ZIP link without buffering a browser blob', () => {
  const html = render({ sessionId: 'synthetic-attempt' });
  assert.match(html, /href="\/api\/exam\/sessions\/synthetic-attempt\/download-all"/);
  assert.match(html, /download=""/);
  assert.match(html, /Download all/);
  assert.match(html, /aria-label="Download all available files for this student/);
  assert.doesNotMatch(source, /fetch\(|new Blob|createObjectURL/);
});

test('exam download addresses all submitted attempts and encodes route identifiers', () => {
  const html = render({ examId: 'synthetic/exam' });
  assert.match(html, /templates\/synthetic%2Fexam\/download-all/);
  assert.match(html, /all submitted attempts/);
});

test('no-data and loading controls are disabled and cannot initiate a download', () => {
  for (const props of [{}, { sessionId: 'synthetic', disabled: true }]) {
    const html = render(props);
    assert.match(html, /<button/);
    assert.match(html, /disabled=""/);
    assert.doesNotMatch(html, /href=/);
  }
});
