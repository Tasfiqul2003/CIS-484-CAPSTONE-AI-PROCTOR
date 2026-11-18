// In-memory mocked browser checks; no server, devices, provider or real recording.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
const require = createRequire(process.env.AVATAR_NODE_MODULES_PATH
  ? path.join(path.resolve(process.env.AVATAR_NODE_MODULES_PATH), 'package.json') : import.meta.url);
const { chromium } = require('playwright');
const bundle = await build({ stdin: { contents: `import React from 'react'; import {createRoot} from 'react-dom/client';
  import Review from './src/pages/professor/ExamSessionReview'; import Login from './src/pages/professor/ProfessorLogin';
  createRoot(document.getElementById('root')).render(location.pathname.endsWith('/review') ? <Review/> : <Login/>);`,
  resolveDir: fileURLToPath(new URL('..', import.meta.url)), loader: 'tsx' },
  bundle: true, write: false, jsx: 'automatic', define: { 'process.env.NODE_ENV': '"test"' }, logLevel: 'silent' });
const browser = await chromium.launch({ headless: true,
  executablePath: process.env.AVATAR_CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe' });
try {
  const page = await browser.newPage();
  const session = '30000000-0000-4000-8000-000000000001';
  const reviewPath = `/api/exam/sessions/${session}/review`;
  const requested = [];
  const unexpectedApi = [];
  await page.route('**/*', async route => {
    const url = new URL(route.request().url());
    requested.push(url.pathname);
    if (route.request().method() === 'GET' && url.pathname === '/api/auth/me') return route.fulfill({ json: {
      role: 'professor', professor_id: '50000000-0000-4000-8000-000000000001',
    } });
    if (route.request().method() === 'GET' && url.pathname === `/api/exam/${session}/report`) return route.fulfill({ json: {
      session: { status: 'graded', developer_demo: false, recording_status: 'completed', recording_expires_at: '2027-11-16T04:59:59Z' },
      grades: [], rubric_criteria: [{ name: 'Synthetic Accuracy', description: 'Private synthetic professor criterion.', max_score: 10 }], rubric_error: null,
    } });
    if (url.pathname === reviewPath) return route.fulfill({ json: {
      student_name: 'Synthetic Student', student_eid: 'synthetic', exam_title: 'Synthetic Exam', status: 'graded',
      video_url: '/synthetic-recording.webm', recording_expires_at: '2027-11-16T04:59:59Z',
      answers: [{ sequence_num: 1, question: 'Synthetic approved question one', answer: 'Synthetic typed answer',
        transcript_source: 'typed', response_media_status: 'available', answer_timestamp_start: 2, answer_timestamp_end: 4 },
        { sequence_num: 2, question: 'Synthetic approved question two', answer: 'Student-corrected transcript',
          machine_transcript_draft: 'Original machine draft', transcript_source: 'confirmed_transcript',
          response_media_status: 'available', answer_timestamp_start: 10, answer_timestamp_end: 12 }],
    } });
    if (url.pathname === '/api/auth/login') return route.fulfill({ status: 503, json: { detail: 'incorrect password' } });
    if (url.pathname.startsWith('/api/')) unexpectedApi.push({ path: url.pathname, method: route.request().method() });
    if (url.pathname.endsWith('.webm')) return route.fulfill({ status: 404, body: '' });
    if (route.request().resourceType() === 'document') return route.fulfill({ contentType: 'text/html',
      body: '<!doctype html><div id="root"></div>' });
    return route.fulfill({ status: 404, body: '' });
  });
  await page.addInitScript(() => {
    window.syntheticPlayback = { time: 0, played: 0, paused: 0 };
    Object.defineProperty(HTMLMediaElement.prototype, 'duration', { get: () => 60, configurable: true });
    Object.defineProperty(HTMLMediaElement.prototype, 'currentTime', {
      get: () => window.syntheticPlayback.time, set: value => { window.syntheticPlayback.time = value; }, configurable: true });
    HTMLMediaElement.prototype.play = async () => { window.syntheticPlayback.played++; };
    HTMLMediaElement.prototype.pause = () => { window.syntheticPlayback.paused++; };
  });
  await page.goto(`http://cybros-synthetic.invalid/professor/exam-sessions/${session}/review`);
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  await page.getByRole('heading', { name: 'Recording', exact: true }).waitFor();
  assert(requested.includes(reviewPath));
  assert(!requested.some(value => value.includes('/sessions/review/')));
  assert.equal(await page.getByText('Original delivered-question audio unavailable.', { exact: false }).count(), 2);
  await page.getByRole('button', { name: 'Play exchange 2', exact: true }).click();
  assert.equal(await page.evaluate(() => window.syntheticPlayback.time), 10);
  assert.equal(await page.evaluate(() => window.syntheticPlayback.played), 1);
  await page.getByRole('combobox', { name: 'Playback speed' }).selectOption('0.5');
  assert.equal(await page.locator('video').evaluate(video => video.playbackRate), 0.5);
  await page.locator('video').evaluate(video => { video.currentTime = 12; video.dispatchEvent(new Event('timeupdate', { bubbles: true })); });
  assert.equal(await page.evaluate(() => window.syntheticPlayback.paused), 1);
  await page.getByText('Original speech draft', { exact: true }).click();
  assert(await page.getByText('Original machine draft', { exact: true }).isVisible());
  assert(await page.getByText('Exchange seek positions are approximate', { exact: false }).isVisible());
  await page.getByRole('heading', { name: 'Professor assessment', exact: true }).waitFor();
  await page.getByLabel('Your score for Synthetic Accuracy', { exact: true }).waitFor();
  assert(requested.includes('/api/auth/me'));
  assert(requested.includes(`/api/exam/${session}/report`));
  assert.deepEqual(unexpectedApi, []);
  console.log('PASS mocked review route, ordered exchanges, seek/stop/speed, transcript provenance and unavailable audio');
  await page.goto('http://cybros-synthetic.invalid/professor/login');
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  await page.getByLabel('Username', { exact: true }).fill('synthetic');
  await page.getByLabel('Password', { exact: true }).fill('synthetic-test-only');
  await page.getByRole('button', { name: 'Sign In', exact: true }).click();
  await page.getByRole('alert').waitFor();
  assert.match(await page.getByRole('alert').innerText(), /service is unavailable/i);
  assert.doesNotMatch(await page.getByRole('alert').innerText(), /incorrect password/i);
  assert.deepEqual(unexpectedApi, []);
  console.log('PASS login service failure is distinct from incorrect credentials');
} finally { await browser.close(); }
