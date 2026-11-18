// Offline synthetic browser checks: bundled in memory, all network requests mocked,
// no test server, services, camera/microphone, real provider, or persistent DB.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const require = createRequire(process.env.AVATAR_NODE_MODULES_PATH
  ? path.join(path.resolve(process.env.AVATAR_NODE_MODULES_PATH), 'package.json') : import.meta.url);
const { chromium } = require('playwright');
const frontend = fileURLToPath(new URL('..', import.meta.url));
const bundle = await build({
  stdin: { contents: `import React from 'react'; import {createRoot} from 'react-dom/client';
    import EnvironmentPreview from './src/components/avatar/EnvironmentPreview';
    import StudentExam from './src/pages/student/StudentExam';
    createRoot(document.getElementById('root')).render(location.hash === '#attempt' ? <StudentExam/> :
      <EnvironmentPreview onContinue={preferences=>window.confirmedPreferences=preferences}/>);`,
    resolveDir: frontend, loader: 'tsx' },
  bundle: true, write: false, outdir: 'environment-browser-memory', jsx: 'automatic',
  define: { 'process.env.NODE_ENV': '"test"' }, logLevel: 'silent',
});
const js = bundle.outputFiles.find(file => file.path.endsWith('.js')).text;
const css = bundle.outputFiles.find(file => file.path.endsWith('.css'))?.text ?? '';
const browser = await chromium.launch({ headless: true,
  executablePath: process.env.AVATAR_CHROME_PATH || (process.platform === 'win32' ? 'C:/Program Files/Google/Chrome/Application/chrome.exe' : undefined) });
const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, reducedMotion: 'reduce' });
const page = await context.newPage();
page.setDefaultTimeout(6000);
const errors = [];
page.on('pageerror', error => errors.push(error.message));
const exam = '20000000-0000-4000-8000-000000000001';
const student = '10000000-0000-4000-8000-000000000001';
const session = '30000000-0000-4000-8000-000000000001';
const builtIns = ['neutral', 'library', 'classroom', 'office', 'nature'];
let locked = false, failImage = false, savedBackground = 'neutral';
let calls = [], answers = [], dropAnswer = true, sequence = 1;
function preview() {
  const backgrounds = failImage ? ['custom', 'neutral'] : locked ? ['neutral'] : builtIns;
  return { exam_id: exam, revision: 1, voice_profile: 'clear', notice: null,
    policy: { defaults: { avatar: 'guide', background: failImage ? 'custom' : 'neutral', customAvatar: null,
      customBackground: failImage ? 'data:image/png;base64,iVBORw0KGgpzeW50aGV0aWM=' : null,
      voiceLabel: 'Clear voice', speed: 1, reducedMotion: false, animation: false },
      allowAvatar: false, allowBackground: !locked, allowSpeed: false,
      avatarChoices: [{ id: 'guide', label: 'Guide examiner' }], backgroundChoices: backgrounds.map(id=>({ id, label: `${id} background` })), minSpeed: 1, maxSpeed: 1 },
    preferences: { avatar: 'guide', background: failImage ? 'custom' : locked ? 'neutral' : savedBackground,
      volume: 0, textSize: 16, reducedMotion: false, speed: 1 } };
}
const timing = () => ({ server_now: new Date().toISOString(), deadline: new Date(Date.now()+600000).toISOString(), question_deadline: null });
const state = () => ({ session_id: session, session_token: 'synthetic-session-token', status: 'in_progress',
  sequence_num: sequence, question: `Synthetic approved question ${sequence}`, developer_demo: true, ...timing() });
await context.addInitScript(({ exam, student }) => {
  sessionStorage.setItem('oralexam_student_id', student);
  sessionStorage.setItem('oralexam_face_check_passed', 'true');
  sessionStorage.setItem(`oralexam_exam_token:${exam}:${student}`, 'synthetic-exam-token');
  window.mediaCalls = [];
  Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: {
    getUserMedia() { window.mediaCalls.push('getUserMedia'); throw new Error('Real capture forbidden in synthetic test.'); },
  } });
  if (window.speechSynthesis) window.speechSynthesis.speak = () => {
    window.mediaCalls.push('speak'); throw new Error('Real speech forbidden in synthetic test.');
  };
}, { exam, student });
await page.route('**/*', async route => {
  const request = route.request(); const url = new URL(request.url());
  const json = body => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
  if (url.pathname.endsWith('/bundle.js')) return route.fulfill({ contentType: 'application/javascript', body: js });
  if (url.pathname.endsWith('/bundle.css')) return route.fulfill({ contentType: 'text/css', body: css });
  if (!url.pathname.startsWith('/api/')) return route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/bundle.css"></head><body style="margin:0"><div id="root"></div><script src="/bundle.js"></script></body></html>' });
  calls.push({ path: url.pathname, method: request.method() });
  if (url.pathname === '/api/avatar/status') return json({enabled:false,ready:false});
  if (url.pathname.endsWith('/student-presentation')) {
    if (request.method() === 'PUT') savedBackground = request.postDataJSON().preferences.background;
    return json(preview());
  }
  if (url.pathname.endsWith('/video-recording/preflight')) return json({ ready: true, recording_required: false });
  if (url.pathname === '/api/exam/start') return json(state());
  if (url.pathname === '/api/exam/answer') {
    answers.push(request.postDataJSON());
    if (dropAnswer) { dropAnswer = false; return route.abort('failed'); }
    sequence++; return json({ done: false, ...state() });
  }
  if (url.pathname === `/api/exam/sessions/${session}`) return json(state());
  if (url.pathname.endsWith('/presentation')) return json({ ...preview(), session_id: session });
  if (url.pathname.endsWith('/assistance')) return json({ session_id: session, question_sequence_num: sequence, mode: 'assessed', actions: {}, ...timing() });
  if (url.pathname.includes('/speech/')) return json({ transcription: { available: false }, synthesis: { available: false } });
  throw new Error(`Unexpected synthetic API ${request.method()} ${url.pathname}`);
});
let visits = 0;
const visit = (hash = '') => page.goto(`http://127.0.0.1:52391/student/exam?templateId=${exam}&studentId=${student}&fixture=${++visits}${hash}`);
try {
  await visit();
  await page.getByRole('radio', { name: 'nature background', exact: true }).waitFor();
  assert.equal(await page.getByRole('radio').count(), 5);
  const images = new Set();
  for (const id of builtIns) {
    await page.getByRole('radio', { name: `${id} background`, exact: true }).check();
    const stage = page.locator('.exam-stage-viewport');
    assert.equal(await stage.getAttribute('data-background'), id);
    images.add(await stage.evaluate(element => getComputedStyle(element).backgroundImage));
  }
  assert.equal(images.size, 5);
  assert.ok(calls.every(call => call.method === 'GET' && call.path.endsWith('/student-presentation')));
  assert.deepEqual(await page.evaluate(() => window.mediaCalls), []);
  await page.getByRole('radio', { name: 'neutral background', exact: true }).focus();
  await page.keyboard.press('ArrowRight');
  assert.equal(await page.getByRole('radio', { name: 'library background', exact: true }).isChecked(), true);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => document.documentElement.style.zoom = '1.5');
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
  await page.evaluate(() => document.documentElement.style.zoom = '1');
  await page.getByRole('radio', { name: 'office background', exact: true }).check();
  await page.getByRole('button', { name: 'Save and continue to recording notice' }).click();
  await page.waitForFunction(() => window.confirmedPreferences?.background === 'office');
  await visit();
  assert.equal(await page.getByRole('radio', { name: 'office background', exact: true }).isChecked(), true);
  console.log('PASS five environments, shared renderer, keyboard, narrow/zoom, scoped refresh and no preview capture/attempt');
  locked = true; await visit();
  await page.getByText('Your professor has fixed the examiner environment:', { exact: false }).waitFor();
  assert.equal(await page.getByRole('radio').count(), 0);
  locked = false; failImage = true; await visit();
  await page.getByText('Background unavailable. Showing the neutral environment.', { exact: true }).waitFor();
  failImage = false;
  console.log('PASS locked policy and failed custom asset fallback');
  calls = []; await visit('#attempt');
  await page.getByRole('button', { name: 'Save and continue to recording notice' }).click();
  await page.getByRole('button', { name: 'I understand — start recording and exam' }).click();
  await page.getByText('Accessibility and recovery', {exact:true}).click();
  await page.getByRole('button', { name: 'Use keyboard controls', exact: true }).click();
  await page.getByLabel('Test answer', { exact: true }).fill('Synthetic first answer');
  await page.getByRole('button', { name: 'Submit test answer →', exact: true }).click();
  await page.locator('.exam-error').filter({ hasText: /fetch/i }).waitFor();
  await page.getByRole('button', { name: 'Submit test answer →', exact: true }).click();
  await page.getByRole('heading', { name: 'Synthetic approved question 2', exact: true }).waitFor();
  assert.equal(answers.length, 2);
  assert.deepEqual(answers[0], answers[1]);
  assert.equal(answers[0].question_sequence_num, 1);
  assert.match(answers[0].request_id, /^[0-9a-f-]{36}$/);
  await page.getByLabel('Test answer', { exact: true }).fill('Synthetic second answer');
  await page.getByRole('button', { name: 'Submit test answer →', exact: true }).click();
  await page.getByRole('heading', { name: 'Synthetic approved question 3', exact: true }).waitFor();
  assert.notEqual(answers[2].request_id, answers[1].request_id);
  assert.equal(answers[2].question_sequence_num, 2);
  assert.deepEqual(await page.evaluate(() => window.mediaCalls), []);
  assert.deepEqual(errors, []);
  console.log('PASS actual StudentExam lost-response retry identity/payload and new-question isolation (mocked demo only)');
} finally { await context.close(); await browser.close(); }
