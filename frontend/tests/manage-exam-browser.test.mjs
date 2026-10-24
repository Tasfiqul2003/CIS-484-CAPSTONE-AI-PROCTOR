import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

// Local synthetic browser checks. Every API request is intercepted; no real records are read or written.
const require = createRequire(process.env.AVATAR_NODE_MODULES_PATH
  ? path.join(path.resolve(process.env.AVATAR_NODE_MODULES_PATH), 'package.json') : import.meta.url);
const { chromium } = require('playwright');
const baseUrl = process.env.MANAGE_EXAM_TEST_URL || process.env.AVATAR_TEST_URL || 'http://127.0.0.1:5173';
const outputDir = process.env.MANAGE_EXAM_TEST_OUTPUT_DIR || path.join(process.cwd(), 'test-results', 'manage-exam');
const executablePath = process.env.AVATAR_CHROME_PATH || (process.platform === 'win32'
  ? 'C:/Program Files/Google/Chrome/Application/chrome.exe'
  : process.platform === 'darwin' ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : undefined);
const browser = await chromium.launch({ executablePath, headless: true });
const context = await browser.newContext({ viewport: { width: 1365, height: 900 } });
const page = await context.newPage();
const EXAM = 'synthetic-navigation-exam';
const INSTRUCTOR = 'synthetic-navigation-instructor';
const rootPath = `/professor/exams/${EXAM}`;
const settingsKey = `oralExamSettings-${rootPath}`;
const categories = [
  { slug: 'avatar-interaction', title: 'Avatar & Interaction Settings', field: 'Default avatar' },
  { slug: 'time-scheduling', title: 'Time & Scheduling', field: 'Standard Time Limit' },
  { slug: 'ods-accommodations', title: 'ODS Accommodations', field: 'Extended Time' },
  { slug: 'ai-questioning', title: 'AI Questioning', field: 'Number of Questions' },
  { slug: 'recording-transcript', title: 'Recording & Transcript', field: 'Record Video' },
  { slug: 'ai-results', title: 'AI Results', field: 'Recommended Grade' },
];
const startedAt = new Date().toISOString();
const results = [];
const requests = [];
const unexpectedApi = [];
const externalRequests = [];
const pageErrors = [];
const dialogs = [];
let nextDialog = 'accept';
let denyExams = false;
const exam = {
  id: EXAM, title: 'Synthetic Navigation Exam', course: 'SYNTH 101',
  description: 'Synthetic settings navigation exercise.', icon: null, status: 'draft',
  created_at: '2026-10-24T12:00:00Z', question_count: 1, submission_count: 0,
  in_progress_count: 0, awaiting_grading_count: 0, completed_count: 0, flagged_count: 0,
};
const legacySettings = {
  timeLimit: 37, extendedTime: false, extendedTimeMultiplier: 1.5,
  breaksAllowed: true, reducedDistraction: false, assistiveTechnology: false,
  questionCount: 17, followUpQuestions: true, maxFollowUps: 3, allowRephrase: true, allowHints: false,
  recordVideo: false, recordAudio: true, generateTranscript: true,
  recommendedGrade: false, generateFeedback: true, professorReview: true,
  futureTeamSetting: { marker: 'preserve-synthetic-extension' }, difficulty: 'removed-legacy-field',
};
function observe(target) {
  target.setDefaultTimeout(10000);
  target.on('pageerror', error => pageErrors.push(error.message));
  target.on('dialog', async dialog => {
    const action = nextDialog;
    nextDialog = 'accept';
    dialogs.push({ type: dialog.type(), action });
    if (action === 'dismiss') await dialog.dismiss(); else await dialog.accept();
  });
}
observe(page);
await context.route('**/*', async route => {
  const request = route.request();
  const url = new URL(request.url());
  if (url.origin !== new URL(baseUrl).origin) {
    externalRequests.push(url.origin + url.pathname);
    return route.abort('blockedbyclient');
  }
  if (!url.pathname.startsWith('/api/')) return route.continue();
  const details = { method: request.method(), path: url.pathname };
  requests.push(details);
  const respond = (json, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(json) });
  if (request.method() === 'GET') {
    if (url.pathname === '/api/auth/professor/exams') return respond(denyExams ? [] : [exam]);
    if (url.pathname === '/api/auth/me') return respond({ id: 'synthetic-account', professor_id: INSTRUCTOR, username: 'Synthetic Instructor', role: 'professor' });
    if (url.pathname === `/api/exam/templates/${EXAM}/avatar-policy`) return respond({ detail: 'Synthetic fixture has no saved server policy.' }, 503);
    if (url.pathname === `/api/exam/templates/${EXAM}/questions`) return respond([{ id: 'synthetic-question', question_text: 'Explain a synthetic topic.', topic: 'Synthetic', difficulty: 2, created_at: '2026-10-24T12:00:00Z' }]);
    if ([`/api/exam/templates/${EXAM}/materials`, `/api/exam/templates/${EXAM}/roster`].includes(url.pathname)) return respond([]);
  }
  unexpectedApi.push(details);
  return respond({ detail: 'Synthetic navigation test blocks this API request.' }, 403);
});
const categoryPath = slug => `${rootPath}/settings/${slug}`;
const field = (label, target = page) => target.getByLabel(new RegExp(label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))).first();
const save = (target = page) => target.getByRole('button', { name: 'Save Settings', exact: true });
const back = (target = page) => target.getByRole('link', { name: /Back to Manage Exam/ });
const snapshot = () => page.evaluate(key => JSON.parse(localStorage.getItem(key)), settingsKey);
async function check(name, run) {
  const start = Date.now();
  try {
    const details = await run();
    results.push({ name, status: 'passed', durationMs: Date.now() - start, details: details ?? null });
    console.log(`PASS ${name}`);
  } catch (error) {
    results.push({ name, status: 'failed', durationMs: Date.now() - start, error: error.stack || String(error) });
    console.log(`FAIL ${name}: ${error.message}`);
  }
}
async function visitHub(target = page) {
  await target.goto(baseUrl + rootPath);
  await target.getByRole('heading', { name: exam.title, exact: true }).waitFor();
}
async function visitCategory(slug, target = page) {
  await target.goto(baseUrl + categoryPath(slug));
  await field(categories.find(category => category.slug === slug).field, target).waitFor();
}
async function screenshot(filename) {
  await mkdir(outputDir, { recursive: true });
  const file = path.join(outputDir, filename);
  await page.screenshot({ path: file, fullPage: true });
  return file;
}

await check('Manage Exam keeps exam details and eight navigation destinations', async () => {
  await visitHub();
  assert.match(await page.locator('main').innerText(), /SYNTH 101/);
  for (const category of categories) {
    const link = page.getByRole('link', { name: new RegExp(category.title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')) });
    assert.equal(await link.count(), 1, `Expected one ${category.title} card`);
    assert.equal(await link.getAttribute('href'), categoryPath(category.slug));
    assert.equal(await field(category.field).count(), 0, `${category.title} form must be on its own page`);
  }
  assert.equal(await page.getByRole('link', { name: /View Question Bank/ }).getAttribute('href'), `${rootPath}/questions`);
  assert.equal(await page.getByRole('link', { name: /View Course Materials/ }).getAttribute('href'), `${rootPath}/materials`);
  return { screenshot: await screenshot('manage-exam-overview-desktop.png') };
});

await check('Every settings card opens its category; direct links, refresh, back and forward work', async () => {
  for (const category of categories) {
    await visitHub();
    await page.getByRole('link', { name: new RegExp(category.title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')) }).click();
    await field(category.field).waitFor();
    assert.equal(new URL(page.url()).pathname, categoryPath(category.slug));
    assert.match(await page.locator('main').innerText(), new RegExp(exam.title));
    assert(await page.getByRole('heading', { name: category.title, exact: true }).first().isVisible());
    assert.equal(await back().getAttribute('href'), rootPath);
    for (const other of categories.filter(item => item.slug !== category.slug)) assert.equal(await field(other.field).count(), 0);
    await page.reload();
    await field(category.field).waitFor();
    await page.goBack();
    await page.getByRole('link', { name: /View Question Bank/ }).waitFor();
    await page.goForward();
    await field(category.field).waitFor();
    await back().click();
    await page.getByRole('link', { name: /View Question Bank/ }).waitFor();
    await visitCategory(category.slug);
  }
  return { categories: categories.map(({ title }) => title), directReloadBackForward: true };
});

await check('Question Bank and Course Materials keep their existing navigation', async () => {
  await visitHub();
  await page.getByRole('link', { name: /View Question Bank/ }).click();
  await page.getByRole('heading', { name: 'Question Bank', exact: true }).waitFor();
  await page.getByRole('button', { name: /Back to Exam/ }).click();
  await page.getByRole('link', { name: /View Course Materials/ }).click();
  await page.getByRole('heading', { name: 'Course Materials', exact: true }).waitFor();
  await page.getByRole('button', { name: /Back to Exam/ }).click();
  await page.getByRole('link', { name: /View Question Bank/ }).waitFor();
});

await check('Legacy exam-key data loads without rewriting and category saves preserve other data', async () => {
  await visitHub();
  await page.evaluate(({ key, settings }) => localStorage.setItem(key, JSON.stringify(settings)), { key: settingsKey, settings: legacySettings });
  await visitCategory('time-scheduling');
  assert.equal(await field('Standard Time Limit').inputValue(), '37');
  assert.deepEqual(await snapshot(), legacySettings, 'Loading a new URL must not rewrite the old saved draft');
  await field('Standard Time Limit').fill('47');
  await save().click();
  assert.deepEqual(await snapshot(), { ...legacySettings, timeLimit: 47 });
  await back().click();
  await page.getByRole('link', { name: /ODS Accommodations/ }).click();
  await field('Extended Time').check();
  await field('Extended Time Multiplier').selectOption('2');
  await field('Breaks').uncheck();
  await save().click();
  await visitCategory('ai-questioning');
  assert.equal(await field('Number of Questions').inputValue(), '17');
  await field('Number of Questions').fill('19');
  await field('Maximum Follow-Ups Per Question').fill('4');
  await field('Allow Hints').check();
  await save().click();
  await visitCategory('recording-transcript');
  assert.equal(await field('Record Video').isChecked(), false);
  await field('Record Audio').uncheck();
  await field('Generate Transcript').uncheck();
  await save().click();
  await visitCategory('ai-results');
  assert.equal(await field('Recommended Grade').isChecked(), false);
  await field('Generate Feedback').uncheck();
  await field('Professor Review Required').uncheck();
  await save().click();
  const expected = { ...legacySettings, timeLimit: 47, extendedTime: true, extendedTimeMultiplier: 2, breaksAllowed: false, questionCount: 19, maxFollowUps: 4, allowHints: true, recordAudio: false, generateTranscript: false, generateFeedback: false, professorReview: false };
  delete expected.difficulty;
  assert.deepEqual(await snapshot(), expected);
  await page.reload();
  await field('Recommended Grade').waitFor();
  assert.equal(await field('Generate Feedback').isChecked(), false);
  assert.deepEqual(await snapshot(), expected);
  const keys = await page.evaluate(() => Object.keys(localStorage).filter(key => key.startsWith('oralExamSettings-')));
  assert.deepEqual(keys, [settingsKey], 'New category URLs must reuse the existing exam key');
  return { canonicalStorageKey: settingsKey, unknownFieldsPreserved: true };
});

await check('Concurrent category pages merge into the latest stored exam draft', async () => {
  const other = await context.newPage();
  observe(other);
  try {
    await visitCategory('time-scheduling');
    await visitCategory('recording-transcript', other);
    await field('Standard Time Limit').fill('61');
    await field('Record Video', other).check();
    await save().click();
    await save(other).click();
    assert.equal((await snapshot()).timeLimit, 61);
    assert.equal((await snapshot()).recordVideo, true);
    await page.reload();
    await field('Standard Time Limit').waitFor();
    assert.equal(await field('Standard Time Limit').inputValue(), '61');
    await other.reload();
    await field('Record Video', other).waitFor();
    assert(await field('Record Video', other).isChecked());
  } finally { await other.close(); }
});

await check('Unsaved category changes guard links, reload, and browser back', async () => {
  await visitHub();
  await page.getByRole('link', { name: /Time & Scheduling/ }).click();
  await field('Standard Time Limit').fill('73');
  const saved = await snapshot();
  for (const navigate of [
    () => back().click({ noWaitAfter: true }),
    () => page.reload().catch(() => null),
    () => page.goBack().catch(() => null),
  ]) {
    nextDialog = 'dismiss';
    const notice = page.waitForEvent('dialog');
    const navigation = navigate();
    assert.equal((await notice).type(), 'beforeunload');
    await navigation;
    assert.equal(new URL(page.url()).pathname, categoryPath('time-scheduling'));
    assert.equal(await field('Standard Time Limit').inputValue(), '73');
    assert.deepEqual(await snapshot(), saved);
  }
  nextDialog = 'accept';
  await back().click();
  await page.getByRole('link', { name: /Time & Scheduling/ }).click();
  assert.equal(await field('Standard Time Limit').inputValue(), String(saved.timeLimit));
  await field('Standard Time Limit').fill('67');
  await save().click();
  const dialogCount = dialogs.length;
  await back().click();
  await page.getByRole('link', { name: /View Question Bank/ }).waitFor();
  assert.equal(dialogs.length, dialogCount, 'Saving should clear the unsaved navigation guard');
  return { canceled: ['link', 'reload', 'browser back'], acceptedDiscard: true, savedNavigationNoPrompt: true };
});

await check('Legacy avatar fragment and avatar-settings URL open the dedicated page', async () => {
  for (const legacyPath of [`${rootPath}#avatar-settings`, `${rootPath}/avatar-settings`]) {
    // Include a same-document fragment change while the overview is already open.
    await visitHub();
    await page.goto(baseUrl + legacyPath);
    await field('Default avatar').waitFor();
    assert.equal(new URL(page.url()).pathname, categoryPath('avatar-interaction'));
  }
});

await check('Avatar draft and student previews retain separate storage and unsaved handling', async () => {
  await visitCategory('avatar-interaction');
  const legacyBefore = await snapshot();
  await field('Default speaking speed').fill('1.15');
  const draftKey = `oral-exam-avatar:v1:${JSON.stringify([EXAM, INSTRUCTOR])}`;
  await page.getByRole('button', { name: 'Save Local Draft', exact: true }).first().click();
  const draft = await page.evaluate(key => localStorage.getItem(key), draftKey);
  assert.equal(JSON.parse(draft).settings.presentation.speed, 1.15);
  await page.getByRole('button', { name: 'Preview as Student', exact: true }).click();
  await page.getByRole('region', { name: 'Preview as Student', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Close Student Preview', exact: true }).click();
  await page.getByRole('button', { name: 'Share Preview Policy', exact: true }).click();
  const sharedLink = page.getByRole('link', { name: 'Open shared student preview', exact: true });
  await sharedLink.waitFor();
  const student = await context.newPage();
  observe(student);
  try {
    await student.goto(new URL(await sharedLink.getAttribute('href'), baseUrl).href);
    await student.locator('.student-demo-surface').waitFor();
    await student.getByRole('button', { name: 'Student settings', exact: true }).click();
    const modal = student.getByRole('dialog', { name: 'Student settings', exact: true });
    await modal.getByLabel('Volume', { exact: true }).fill('35');
    await modal.getByRole('button', { name: 'Save Preferences', exact: true }).click();
    await modal.getByRole('button', { name: 'Close Settings', exact: true }).click();
    await student.reload();
    await student.locator('.student-demo-surface').waitFor();
    await student.getByRole('button', { name: 'Student settings', exact: true }).click();
    assert.equal(await modal.getByLabel('Volume', { exact: true }).inputValue(), '35');
    assert.equal(await page.evaluate(key => localStorage.getItem(key), draftKey), draft);
    assert.deepEqual(await snapshot(), legacyBefore);
    const keys = await page.evaluate(() => Object.keys(localStorage));
    assert(keys.some(key => key.startsWith('oral-exam-policy-preview:v1:')));
    assert(keys.some(key => key.startsWith('oral-exam-student-preview:v1:')));
  } finally { await student.close(); }
  await field('Default speaking speed').fill('1.2');
  nextDialog = 'dismiss';
  const notice = page.waitForEvent('dialog');
  const navigation = back().click({ noWaitAfter: true });
  assert.equal((await notice).type(), 'beforeunload');
  await navigation;
  assert.equal(await field('Default speaking speed').inputValue(), '1.2');
  nextDialog = 'accept';
  await back().click();
  await visitCategory('avatar-interaction');
  assert.equal(await field('Default speaking speed').inputValue(), '1.15');
  assert.deepEqual(await snapshot(), legacyBefore);
});

await check('Every direct settings page preserves the existing owned-exam check', async () => {
  denyExams = true;
  try {
    for (const category of categories) {
      const beforeRequests = requests.length;
      await page.goto(baseUrl + categoryPath(category.slug));
      await page.getByRole('alert').waitFor();
      assert.match(await page.getByRole('alert').innerText(), /not found|permission/i);
      assert.equal(await field(category.field).count(), 0);
      assert.deepEqual(requests.slice(beforeRequests).filter(request => request.path.includes('avatar-policy')), []);
    }
  } finally { denyExams = false; }
});

await check('Overview and all six settings pages fit a 360px screen', async () => {
  await page.setViewportSize({ width: 360, height: 844 });
  const screenshots = [];
  await visitHub();
  screenshots.push(await screenshot('manage-exam-overview-360px.png'));
  for (const category of categories) {
    await visitCategory(category.slug);
    const metrics = await page.evaluate(() => ({ width: innerWidth, scrollWidth: document.documentElement.scrollWidth }));
    assert(metrics.scrollWidth <= metrics.width, `${category.title}: ${JSON.stringify(metrics)}`);
    screenshots.push(await screenshot(`manage-exam-${category.slug}-360px.png`));
  }
  return { width: 360, screenshots };
});

await check('Only synthetic configured API reads occurred and there were no runtime errors', async () => {
  assert.deepEqual(unexpectedApi, []);
  assert.deepEqual(externalRequests, []);
  assert.deepEqual(pageErrors, []);
  assert(requests.every(request => request.method === 'GET'));
});

await mkdir(outputDir, { recursive: true });
const report = {
  startedAt, completedAt: new Date().toISOString(), baseUrl, syntheticDataOnly: true, apiIntercepted: true,
  results, summary: { passed: results.filter(result => result.status === 'passed').length, failed: results.filter(result => result.status === 'failed').length },
  requests, unexpectedApi, externalRequests, pageErrors, dialogs,
  limitations: ['Frontend ownership denial uses a mocked owned-exam list, not real backend authorization.', 'Saved server policies are unavailable in this fixture; exam-policy-browser.test.mjs covers mocked server reads/writes.', 'No real accounts, roster records, device recordings, live exam enforcement, grading, or model behavior are tested.', 'Automated viewport checks do not establish full accessibility conformance.'],
};
const reportPath = path.join(outputDir, 'manage-exam-browser-test-results.json');
await writeFile(reportPath, JSON.stringify(report, null, 2));
console.log(JSON.stringify({ reportPath, summary: report.summary }));
process.exitCode = report.summary.failed ? 1 : 0;
await browser.close();
