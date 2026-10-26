import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

// All API traffic is intercepted with synthetic owned exams. No real backend writes occur.
const require = createRequire(process.env.AVATAR_NODE_MODULES_PATH
  ? path.join(path.resolve(process.env.AVATAR_NODE_MODULES_PATH), 'package.json') : import.meta.url);
const { chromium } = require('playwright');
const baseUrl = process.env.EXAM_POLICY_TEST_URL || process.env.AVATAR_TEST_URL || 'http://127.0.0.1:5173';
const outputDir = process.env.EXAM_POLICY_TEST_OUTPUT_DIR || path.join(process.cwd(), 'test-results', 'exam-policy');
const executablePath = process.env.AVATAR_CHROME_PATH || (process.platform === 'win32'
  ? 'C:/Program Files/Google/Chrome/Application/chrome.exe'
  : process.platform === 'darwin' ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : undefined);
const keepOpen = process.argv.includes('--keep-open');
const browser = await chromium.launch({ executablePath, headless: !keepOpen });
const context = await browser.newContext({ viewport: { width: 1365, height: 900 } });
const page = await context.newPage();
const student = await context.newPage();
const EXAM_A = 'synthetic-policy-exam-a';
const EXAM_B = 'synthetic-policy-exam-b';
const INSTRUCTOR_A = 'synthetic-policy-instructor-a';
const INSTRUCTOR_B = 'synthetic-policy-instructor-b';
const SHARED_PREFIX = 'oral-exam-policy-preview:v1:';
const DRAFT_PREFIX = 'oral-exam-avatar:v1:';
const startedAt = new Date().toISOString();
const results = [];
const requests = [];
const unexpectedApi = [];
const externalRequests = [];
const pageErrors = [];
const mediaCalls = [];
let instructor = INSTRUCTOR_A;
let failPolicyGet = false;
let failPolicyPut = false;
let policyReadGate = null;
const clone = (value) => JSON.parse(JSON.stringify(value));
const defaultSettings = () => ({
  presentation: {
    avatar: 'guide', background: 'neutral', customAvatar: null, customBackground: null,
    voice: 'calm', speed: 1, animation: true, reducedMotion: false, stateLabels: true,
  },
  student: { avatar: false, background: false, speed: false, avatars: ['guide', 'geometric'], backgrounds: ['neutral', 'library'], minSpeed: 0.8, maxSpeed: 1.2 },
  assistance: {
    repeat: { enabled: true, modes: 'both', limit: 2, timerContinues: true },
    clarification: { enabled: true, modes: 'both', limit: 1, timerContinues: true },
    hint: { enabled: false, modes: 'practice', limit: 1, timerContinues: true },
    explanation: { enabled: false, modes: 'practice', limit: 1, timerContinues: true },
    correctness: { enabled: false, modes: 'practice', limit: 1, timerContinues: true },
  },
  behavior: { followUps: 1, order: 'authored', responseTiming: 'exam', responseSeconds: 120, responseUnit: 'seconds' },
});
const envelope = (examId, revision = 0, settings = defaultSettings()) => ({
  exam_id: examId, revision, settings: clone(settings), effective_for: 'new_attempts',
  assistance_scope: 'per_question', updated_at: revision ? '2026-10-15T12:00:00Z' : null,
});
const serverPolicies = new Map([[EXAM_A, envelope(EXAM_A)], [EXAM_B, envelope(EXAM_B)]]);
const owner = new Map([[EXAM_A, INSTRUCTOR_A], [EXAM_B, INSTRUCTOR_B]]);
const exams = [EXAM_A, EXAM_B].map((id) => ({
  id, title: `Synthetic Policy Exam ${id === EXAM_A ? 'A' : 'B'}`, course: 'SYNTH 101',
  description: 'Synthetic policy integration fixture.', icon: null, status: 'draft',
  created_at: '2026-10-15T12:00:00Z', question_count: 1, submission_count: 0,
  in_progress_count: 0, awaiting_grading_count: 0, completed_count: 0, flagged_count: 0,
}));

for (const target of [page, student]) {
  target.setDefaultTimeout(7000);
  target.on('pageerror', (error) => pageErrors.push(error.message));
  target.on('dialog', (dialog) => dialog.type() === 'beforeunload' ? dialog.accept() : dialog.dismiss());
}
await context.exposeBinding('__recordPolicyMediaCall', (_source, name) => mediaCalls.push(String(name)));
await context.addInitScript(() => {
  if (navigator.mediaDevices) navigator.mediaDevices.getUserMedia = () => {
    void window.__recordPolicyMediaCall('getUserMedia');
    return Promise.reject(new Error('Synthetic preview blocks device capture.'));
  };
  if (window.speechSynthesis) window.speechSynthesis.speak = () => {
    void window.__recordPolicyMediaCall('speechSynthesis.speak');
    throw new Error('Synthetic preview blocks speech services.');
  };
});
await context.route('**/*', async (route) => {
  const request = route.request();
  const url = new URL(request.url());
  if (url.origin !== new URL(baseUrl).origin) {
    externalRequests.push(url.origin + url.pathname);
    return route.abort('blockedbyclient');
  }
  const api = url.pathname.startsWith('/api/');
  if (!api && ['GET', 'HEAD'].includes(request.method()) && !['fetch', 'xhr'].includes(request.resourceType())) return route.continue();
  const details = { method: request.method(), path: url.pathname, instructor, body: request.postData() };
  requests.push(details);
  const respond = (json, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(json) });
  if (request.method() === 'GET' && url.pathname === '/api/auth/me') {
    return respond({ id: 'synthetic-policy-account', professor_id: instructor, username: 'Synthetic Instructor', role: 'professor' });
  }
  if (request.method() === 'GET' && url.pathname === '/api/auth/professor/exams') {
    return respond(exams.filter(({ id }) => owner.get(id) === instructor));
  }
  const policyMatch = url.pathname.match(/^\/api\/exam\/templates\/([^/]+)\/avatar-policy$/);
  if (policyMatch) {
    const examId = decodeURIComponent(policyMatch[1]);
    if (owner.get(examId) !== instructor) return respond({ detail: 'Synthetic exam access denied.' }, 403);
    if (request.method() === 'GET') {
      const gate = policyReadGate?.examId === examId ? policyReadGate : null;
      if (gate) { gate.arrive(); await gate.pending; }
      if (failPolicyGet) return respond({ detail: 'Synthetic policy read failure.' }, 503);
      return respond(serverPolicies.get(examId));
    }
    if (request.method() === 'PUT') {
      if (failPolicyPut) return respond({ detail: 'Synthetic policy write failure.' }, 503);
      const body = request.postDataJSON();
      assert.deepEqual(Object.keys(body).sort(), ['expected_revision', 'settings']);
      const current = serverPolicies.get(examId);
      if (body.expected_revision !== current.revision) return respond({ detail: 'Synthetic stale revision.' }, 409);
      const next = envelope(examId, current.revision + 1, body.settings);
      serverPolicies.set(examId, next);
      return respond(next);
    }
  }
  if (request.method() === 'GET' && /^\/api\/exam\/templates\/[^/]+\/questions$/.test(url.pathname)) {
    return respond([{ id: 'synthetic-policy-question', question_text: 'Synthetic topic?', topic: 'Synthetic', difficulty: 2, created_at: '2026-10-15T12:00:00Z' }]);
  }
  if (request.method() === 'GET' && /^\/api\/exam\/templates\/[^/]+\/materials$/.test(url.pathname)) return respond([]);
  if (request.method() === 'GET' && /^\/api\/exam\/templates\/[^/]+\/roster$/.test(url.pathname)) return respond([]);
  unexpectedApi.push(details);
  return respond({ detail: 'The synthetic policy integration test blocks this endpoint.' }, 403);
});

const field = (name) => page.getByLabel(name, { exact: true });
const button = (name, target = page) => target.getByRole('button', { name, exact: true }).first();
const modal = () => student.getByRole('dialog', { name: 'Student settings', exact: true });
const studentField = (name) => modal().getByLabel(name, { exact: true });
const localUrl = (examId = EXAM_A, instructorId = INSTRUCTOR_A, mode = 'practice') =>
  `${baseUrl}/student/settings-preview?${new URLSearchParams({ examId, instructorId, policySource: 'local', mode })}`;
const serverUrl = (examId = EXAM_A, mode = 'practice') =>
  `${baseUrl}/student/settings-preview?${new URLSearchParams({ examId, policySource: 'server', mode })}`;
async function check(name, run) {
  const begin = Date.now();
  try {
    const details = await run();
    results.push({ name, status: 'passed', durationMs: Date.now() - begin, details: details ?? null });
    console.log(`PASS ${name}`);
  } catch (error) {
    results.push({ name, status: 'failed', durationMs: Date.now() - begin, error: error.stack || String(error) });
    console.log(`FAIL ${name}: ${error.message}`);
  }
}
async function openInstructor(examId = EXAM_A) {
  await page.goto(`${baseUrl}/professor/exams/${examId}#avatar-settings`, { waitUntil: 'domcontentloaded' });
  await field('Default avatar').waitFor({ timeout: 30000 });
  await button('Save Exam Policy').waitFor();
  await button('Save Exam Policy').waitFor({ state: 'visible' });
  await page.waitForFunction(() => ![...document.querySelectorAll('button')].find((item) => item.textContent?.trim() === 'Save Exam Policy')?.disabled);
}
async function visitStudent(url = localUrl()) {
  await student.goto(url, { waitUntil: 'domcontentloaded' });
  await student.locator('.student-demo-surface').waitFor({ timeout: 30000 });
  await student.locator('.student-policy-context').waitFor();
}
async function openStudentSettings() {
  if (!await modal().isVisible()) await button('Student settings', student).click();
  await modal().waitFor();
}
async function closeStudentSettings() {
  if (await modal().isVisible()) await modal().getByRole('button', { name: 'Close Settings', exact: true }).click();
  await modal().waitFor({ state: 'hidden' });
}
async function values(prefix) {
  return page.evaluate((prefix) => Object.fromEntries(Object.entries(localStorage).filter(([key]) => key.startsWith(prefix))), prefix);
}
async function shared(examId = EXAM_A, instructorId = INSTRUCTOR_A) {
  const all = await values(SHARED_PREFIX);
  const raw = all[`${SHARED_PREFIX}${JSON.stringify([examId, instructorId])}`];
  return raw ? JSON.parse(raw).policy : null;
}
async function refreshAvailablePolicy() {
  await student.evaluate(() => window.dispatchEvent(new Event('focus')));
}
function holdPolicyReads(examId) {
  let release;
  let arrive;
  const pending = new Promise((resolve) => { release = resolve; });
  const entered = new Promise((resolve) => { arrive = resolve; });
  const gate = { examId, pending, arrive, entered, release: () => {
    if (policyReadGate === gate) policyReadGate = null;
    release();
  } };
  policyReadGate = gate;
  return gate;
}
async function screenshot(name, target = student) {
  await mkdir(outputDir, { recursive: true });
  const file = path.join(outputDir, name);
  await target.screenshot({ path: file, fullPage: true });
  return file;
}

await check('Exam policy loading is read only and local drafts do not publish rules', async () => {
  await openInstructor();
  const before = clone(serverPolicies.get(EXAM_A));
  const beforeShared = await values(SHARED_PREFIX);
  await field('Allow students to choose avatar').check();
  await field('Allow students to choose background').check();
  await field('Allow students to choose speaking speed').check();
  await field('Hints').check();
  await field('Hints limit per question').fill('2');
  await field('Default speaking speed').fill('1.1');
  await field('Exact question repeats limit per question').fill('3');
  await button('Save Local Draft').click();
  assert(Object.keys(await values(DRAFT_PREFIX)).some((key) => key.includes(EXAM_A) && key.includes(INSTRUCTOR_A)));
  assert.deepEqual(await values(SHARED_PREFIX), beforeShared);
  assert.deepEqual(serverPolicies.get(EXAM_A), before);
  assert.equal(requests.filter(({ method }) => method === 'PUT').length, 0);
  return { localDraftSeparateFromSharedAndServer: true };
});

await check('Explicit sharing connects instructor choices to the scoped student preview', async () => {
  await button('Share Preview Policy').click();
  const saved = await shared();
  assert(saved);
  assert.equal(saved.revision, 1);
  assert.equal(saved.effective_for, 'new_attempts');
  assert.equal(saved.assistance_scope, 'per_question');
  const link = page.getByRole('link', { name: 'Open shared student preview', exact: true });
  const url = new URL(await link.getAttribute('href'), baseUrl);
  assert.equal(url.searchParams.get('examId'), EXAM_A);
  assert.equal(url.searchParams.get('instructorId'), INSTRUCTOR_A);
  assert.equal(url.searchParams.get('policySource'), 'local');
  await visitStudent(url.href);
  await openStudentSettings();
  assert.equal(await studentField('Avatar').count(), 1);
  assert.equal(await studentField('Background').count(), 1);
  assert.equal(Number(await modal().getByLabel(/^Speaking speed(?:\s|:|$)/).inputValue()), 1.1);
  await studentField('Avatar').selectOption('geometric');
  await studentField('Background').selectOption('library');
  await modal().getByRole('button', { name: 'Save Preferences', exact: true }).click();
  await closeStudentSettings();
  assert.equal(await button('Request hint', student).count(), 1);
  assert.match(await student.locator('#student-assistance-hint-help').innerText(), /2 of 2 remaining/);
  assert.equal(await button('Request explanation', student).count(), 0);
  assert.equal(await button('Request correctness feedback', student).count(), 0);
  assert.match(await student.locator('#student-assistance-repeat-help').innerText(), /3 of 3 remaining/);
  assert.deepEqual(serverPolicies.get(EXAM_A).revision, 0);
  return { revision: saved.revision, screenshot: await screenshot('shared-policy-student-desktop.png') };
});

await check('Unsaved edits and saved local drafts cannot change the shared policy', async () => {
  const current = await shared();
  await field('Default speaking speed').fill('0.9');
  assert.deepEqual(await shared(), current);
  await button('Save Local Draft').click();
  assert.deepEqual(await shared(), current);
  await refreshAvailablePolicy();
  assert.match(await student.locator('.student-demo-speed').innerText(), /1\.10/);
  assert.equal(await student.locator('.student-policy-update').count(), 0);
});

await check('An active preview pins its revision and new starts reconcile newly restricted preferences', async () => {
  await button('Repeat exact question', student).click();
  await field('Allow students to choose avatar').uncheck();
  await field('Allow students to choose background').uncheck();
  await field('Allow students to choose speaking speed').uncheck();
  await field('Hints').uncheck();
  await field('Exact question repeats limit per question').fill('1');
  await button('Share Preview Policy').click();
  assert.equal((await shared()).revision, 2);
  await refreshAvailablePolicy();
  await student.locator('.student-policy-update').waitFor();
  assert.match(await student.locator('.student-policy-context').innerText(), /revision\s*1/i);
  assert.equal(await student.locator('.student-demo-stage').getAttribute('data-avatar'), 'geometric');
  assert.match(await student.locator('#student-assistance-repeat-help').innerText(), /2 of 3 remaining/);
  assert.equal(await button('Request hint', student).count(), 1);
  await button('Restart preview', student).click();
  await student.waitForFunction(() => /revision\s*2/i.test(document.querySelector('.student-policy-context')?.textContent ?? ''));
  assert.equal(await student.locator('.student-demo-stage').getAttribute('data-avatar'), 'guide');
  assert.equal(await student.locator('.student-demo-stage').getAttribute('data-background'), 'neutral');
  assert.equal(await button('Request hint', student).count(), 0);
  await openStudentSettings();
  for (const label of ['Avatar', 'Background']) assert.equal(await studentField(label).count(), 0);
  assert.equal(await modal().getByLabel(/^Speaking speed(?:\s|:|$)/).count(), 0);
  await closeStudentSettings();
  assert.match(await student.locator('#student-assistance-repeat-help').innerText(), /1 of 1 remaining/);
  await button('Repeat exact question', student).click();
  assert(await button('Repeat exact question', student).isDisabled());
  assert.match(await student.locator('#student-assistance-repeat-help').innerText(), /0 of 1 remaining/);
  return { pinnedUntilExplicitRestart: true, exhaustedAllowedActionRemainsVisible: true };
});

await check('Local preview namespaces isolate exams and instructors without fixed-policy fallback', async () => {
  for (const url of [localUrl(EXAM_B), localUrl(EXAM_A, INSTRUCTOR_B)]) {
    await student.goto(url, { waitUntil: 'domcontentloaded' });
    await student.locator('.student-policy-error').waitFor();
    assert.equal(await student.locator('.student-demo-surface').count(), 0);
    assert.equal(await button('Student settings', student).count(), 0);
  }
  instructor = INSTRUCTOR_B;
  await openInstructor(EXAM_B);
  assert.equal(await field('Default speaking speed').inputValue(), '1');
  await button('Share Preview Policy').click();
  assert.equal((await shared(EXAM_B, INSTRUCTOR_B)).revision, 1);
  assert.equal((await shared()).revision, 2);
  assert.equal(await shared(EXAM_A, INSTRUCTOR_B), null);
  instructor = INSTRUCTOR_A;
});

await check('Practice and assessed availability follow the professor preview mode', async () => {
  await openInstructor();
  await field('Allow students to choose avatar').uncheck();
  await field('Allow students to choose background').uncheck();
  await field('Allow students to choose speaking speed').uncheck();
  await field('Hints').check();
  await field('Hints availability').selectOption('practice');
  await button('Share Preview Policy').click();
  const saved = await shared();
  for (const key of ['avatar', 'background', 'speed']) assert.equal(saved.settings.student[key], false, `The synthetic ${key} choice must be restricted for the accessibility exercise`);
  await field('Preview exam mode').selectOption('assessed');
  const assessed = new URL(await page.getByRole('link', { name: 'Open shared student preview', exact: true }).getAttribute('href'), baseUrl);
  assert.equal(assessed.searchParams.get('mode'), 'assessed');
  await visitStudent(assessed.href);
  assert.equal(await button('Request hint', student).count(), 0);
  assert.equal(await button('Repeat exact question', student).count(), 1);
  await visitStudent(localUrl());
  assert.equal(await button('Request hint', student).count(), 1);
  await openStudentSettings();
  for (const name of ['Exam mode', 'Preview exam mode', 'Voice', 'Default voice']) assert.equal(await studentField(name).count(), 0);
  await closeStudentSettings();
});

await check('Explicit server policy saves round trip revisions separately from drafts and browser sharing', async () => {
  await openInstructor();
  const localBefore = await values(SHARED_PREFIX);
  await field('Default speaking speed').fill('1.2');
  await button('Save Exam Policy').click();
  await page.waitForFunction(() => /revision\s*1/i.test(document.querySelector('.avatar-settings')?.textContent ?? ''));
  assert.equal(serverPolicies.get(EXAM_A).revision, 1);
  assert.equal(serverPolicies.get(EXAM_A).settings.presentation.speed, 1.2);
  assert.deepEqual(await values(SHARED_PREFIX), localBefore);
  assert.equal(serverPolicies.get(EXAM_B).revision, 0);
  const savedLink = new URL(await page.getByRole('link', { name: 'Open saved policy preview', exact: true }).getAttribute('href'), baseUrl);
  assert.equal(savedLink.searchParams.get('policySource'), 'server');
  assert.equal(savedLink.searchParams.get('instructorId'), null);
  await visitStudent(savedLink.href);
  assert.match(await student.locator('.student-policy-context').innerText(), /revision\s*1/i);
  await field('Default speaking speed').fill('0.8');
  await button('Save Exam Policy').click();
  await page.waitForFunction(() => /revision\s*2/i.test(document.querySelector('.avatar-settings')?.textContent ?? ''));
  assert.equal(serverPolicies.get(EXAM_A).revision, 2);
  const puts = requests.filter(({ method }) => method === 'PUT').map(({ body }) => JSON.parse(body));
  assert.deepEqual(puts.slice(-2).map(({ expected_revision }) => expected_revision), [0, 1]);
  assert.equal(serverPolicies.get(EXAM_A).settings.presentation.speed, 0.8);
  return { mockedPolicyWrites: puts.length, noRealBackendWrites: true };
});

await check('Conflicts and failed writes preserve the saved policy and do not silently fall back locally', async () => {
  const current = serverPolicies.get(EXAM_A);
  serverPolicies.set(EXAM_A, envelope(EXAM_A, current.revision + 1, current.settings));
  const savedBefore = clone(serverPolicies.get(EXAM_A));
  const sharedBefore = await values(SHARED_PREFIX);
  await field('Default speaking speed').fill('1.1');
  await button('Save Exam Policy').click();
  await page.getByText(/changed in another view|reload.*before saving/i).first().waitFor();
  assert.deepEqual(serverPolicies.get(EXAM_A), savedBefore);
  assert.deepEqual(await values(SHARED_PREFIX), sharedBefore);
  await button('Load Saved Exam Policy').click();
  await page.waitForFunction(() => document.querySelector('#avatar-default-speed')?.value === '0.8');
  failPolicyPut = true;
  await field('Default speaking speed').fill('1');
  await button('Save Exam Policy').click();
  await page.getByText(/HTTP 503|unable to.*policy/i).first().waitFor();
  assert.deepEqual(serverPolicies.get(EXAM_A), savedBefore);
  assert.deepEqual(await values(SHARED_PREFIX), sharedBefore);
  failPolicyPut = false;
});

await check('Unavailable or unauthorized server previews do not reveal a fixed or local policy', async () => {
  failPolicyGet = true;
  await student.goto(serverUrl(), { waitUntil: 'domcontentloaded' });
  await student.locator('.student-policy-error').waitFor();
  assert.equal(await student.locator('.student-demo-surface').count(), 0);
  assert.match(await student.locator('.student-policy-error').innerText(), /503|unable/i);
  failPolicyGet = false;
  await button('Retry policy load', student).click();
  await student.locator('.student-demo-surface').waitFor();
  instructor = INSTRUCTOR_B;
  await student.goto(serverUrl(), { waitUntil: 'domcontentloaded' });
  await student.locator('.student-policy-error').waitFor();
  assert.equal(await student.locator('.student-demo-surface').count(), 0);
  assert.match(await student.locator('.student-policy-error').innerText(), /403|unable/i);
  instructor = INSTRUCTOR_A;
});

await check('Essential accessibility controls remain available under restricted presentation permissions', async () => {
  await visitStudent(localUrl());
  await student.setViewportSize({ width: 360, height: 844 });
  await openStudentSettings();
  for (const label of ['Avatar', 'Background']) assert.equal(await studentField(label).count(), 0);
  assert.equal(await modal().getByLabel(/^Speaking speed(?:\s|:|$)/).count(), 0);
  assert.equal(await modal().getByLabel(/^Volume(?:\s|:|$)/).count(), 1);
  assert.equal(await studentField('Text size').count(), 1);
  assert.equal(await studentField('Reduce motion').count(), 1);
  await studentField('Text size').selectOption('24');
  await studentField('Reduce motion').check();
  const metrics = await student.evaluate(() => ({ screen: innerWidth, document: document.documentElement.scrollWidth, client: document.querySelector('dialog').clientWidth, scroll: document.querySelector('dialog').scrollWidth }));
  assert(metrics.document <= metrics.screen);
  assert(metrics.scroll <= metrics.client);
  await student.keyboard.press('Escape');
  await modal().waitFor({ state: 'hidden' });
  await student.waitForFunction(() => document.activeElement?.textContent?.trim() === 'Student settings');
  await button('Repeat exact question', student).click();
  assert.equal(await student.locator('.student-demo-avatar').evaluate((element) => getComputedStyle(element).animationName), 'none');
  return { textSizePx: 24, viewportWidth: 360, screenshot: await screenshot('shared-policy-student-mobile.png') };
});

await check('Late initial policy loads preserve edits typed while the server is loading', async () => {
  instructor = INSTRUCTOR_B;
  const savedSettings = defaultSettings();
  savedSettings.presentation.speed = 0.85;
  serverPolicies.set(EXAM_B, envelope(EXAM_B, 1, savedSettings));
  // This exam has no local draft, so an untouched editor would adopt the saved policy.
  assert.equal(Object.keys(await values(DRAFT_PREFIX)).some((key) => key.includes(EXAM_B)), false);
  const gate = holdPolicyReads(EXAM_B);
  try {
    await page.goto(`${baseUrl}/professor/exams/${EXAM_B}#avatar-settings`, { waitUntil: 'domcontentloaded' });
    await field('Default speaking speed').waitFor({ timeout: 30000 });
    await gate.entered;
    assert(await button('Save Exam Policy').isDisabled());
    await field('Default speaking speed').fill('1.15');
    gate.release();
    await page.waitForFunction(() => ![...document.querySelectorAll('button')].find((item) => item.textContent?.trim() === 'Save Exam Policy')?.disabled);
    assert.equal(await field('Default speaking speed').inputValue(), '1.15');
    assert.match(await page.locator('.avatar-policy-context').innerText(), /revision\s*1/i);
    assert.equal(serverPolicies.get(EXAM_B).settings.presentation.speed, 0.85);
    assert.match(await page.locator('.avatar-status').innerText(), /unsaved changes/i);
  } finally { gate.release(); instructor = INSTRUCTOR_A; }
  return { delayedSavedSpeed: 0.85, preservedTypedSpeed: 1.15 };
});

await check('Load Saved Exam Policy preserves newer edits made during its pending request', async () => {
  instructor = INSTRUCTOR_B;
  const gate = holdPolicyReads(EXAM_B);
  try {
    await button('Load Saved Exam Policy').click();
    await gate.entered;
    await field('Default speaking speed').fill('1.05');
    gate.release();
    await page.waitForFunction(() => ![...document.querySelectorAll('button')].find((item) => item.textContent?.trim() === 'Load Saved Exam Policy')?.disabled);
    assert.equal(await field('Default speaking speed').inputValue(), '1.05');
    await page.getByText(/newer editor changes have been kept/i).first().waitFor();
    assert.equal(serverPolicies.get(EXAM_B).settings.presentation.speed, 0.85);
    assert.match(await page.locator('.avatar-status').innerText(), /unsaved changes/i);
  } finally { gate.release(); instructor = INSTRUCTOR_A; }
  return { delayedSavedSpeed: 0.85, preservedTypedSpeed: 1.05 };
});

await check('Stale shared-preview saves preserve newer rules and explicit reloading recovers', async () => {
  await openInstructor();
  const starting = await shared();
  await field('Default speaking speed').fill('1.1');
  const other = await context.newPage();
  other.on('pageerror', (error) => pageErrors.push(error.message));
  other.on('dialog', (dialog) => dialog.type() === 'beforeunload' ? dialog.accept() : dialog.dismiss());
  try {
    await other.goto(`${baseUrl}/professor/exams/${EXAM_A}#avatar-settings`, { waitUntil: 'domcontentloaded' });
    await other.getByLabel('Default speaking speed', { exact: true }).waitFor({ timeout: 30000 });
    await other.waitForFunction(() => ![...document.querySelectorAll('button')].find((item) => item.textContent?.trim() === 'Save Exam Policy')?.disabled);
    await other.getByLabel('Default speaking speed', { exact: true }).fill('1.05');
    await other.getByRole('button', { name: 'Share Preview Policy', exact: true }).click();
    const newer = await shared();
    assert.equal(newer.revision, starting.revision + 1);
    assert.equal(newer.settings.presentation.speed, 1.05);
    await button('Share Preview Policy').click();
    await page.getByText(/changed in another view|reload.*before saving/i).first().waitFor();
    assert.deepEqual(await shared(), newer);
    assert.equal(await field('Default speaking speed').inputValue(), '1.1');
    await button('Load Shared Preview Policy').click();
    assert.equal(await field('Default speaking speed').inputValue(), '1.05');
    await field('Default speaking speed').fill('1.15');
    await button('Share Preview Policy').click();
    const recovered = await shared();
    assert.equal(recovered.revision, newer.revision + 1);
    assert.equal(recovered.settings.presentation.speed, 1.15);
    assert.equal(serverPolicies.get(EXAM_A).revision, 3, 'Browser sharing must not write the server policy');
    return { staleRevision: starting.revision, preservedRevision: newer.revision, recoveredRevision: recovered.revision };
  } finally { await other.close(); }
});

await check('Integration exercise made only mocked policy requests and never started a live exam', async () => {
  assert.deepEqual(unexpectedApi, []);
  assert.deepEqual(externalRequests, []);
  assert.deepEqual(mediaCalls, []);
  assert.deepEqual(pageErrors, []);
  assert.equal(requests.some(({ path }) => /\/exam\/(start|answer)/.test(path)), false);
  assert(requests.some(({ method, path }) => method === 'PUT' && path.endsWith('/avatar-policy')));
});

await mkdir(outputDir, { recursive: true });
const report = {
  startedAt, completedAt: new Date().toISOString(), baseUrl, syntheticDataOnly: true, allApiRequestsMocked: true,
  summary: { passed: results.filter(({ status }) => status === 'passed').length, failed: results.filter(({ status }) => status === 'failed').length },
  results, requests, unexpectedApi, externalRequests, mediaCalls, pageErrors,
  limitations: [
    'Server responses and ownership are mocked. These browser checks cannot prove backend authorization or persistence.',
    'Browser preview IDs and local storage are synthetic convenience data, not authenticated student access.',
    'Real attempt snapshots, server assistance counters, roster integration, and student authorization remain separate integration tasks.',
    'Focused keyboard, labels, reduced-motion, and narrow-layout checks are not full accessibility conformance testing.',
  ],
};
const reportPath = path.join(outputDir, 'exam-policy-browser-test-results.json');
await writeFile(reportPath, JSON.stringify(report, null, 2));
console.log(JSON.stringify({ reportPath, summary: report.summary, keepOpen }));
process.exitCode = report.summary.failed ? 1 : 0;
if (keepOpen) {
  await student.setViewportSize({ width: 1365, height: 900 });
  await visitStudent(localUrl());
  await openStudentSettings();
  console.log('Synthetic connected student policy preview is open for manual review. Press Ctrl+C to close.');
  await new Promise((resolve) => { process.once('SIGINT', resolve); process.once('SIGTERM', resolve); });
}
await browser.close();
