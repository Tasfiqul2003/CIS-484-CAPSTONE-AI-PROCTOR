import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const require = createRequire(process.env.AVATAR_NODE_MODULES_PATH
  ? path.join(path.resolve(process.env.AVATAR_NODE_MODULES_PATH), 'package.json') : import.meta.url);
const { chromium } = require('playwright');
const baseUrl = process.env.COMBINED_EXAM_TEST_URL || 'http://localhost:5173';
const output = path.resolve(process.env.COMBINED_EXAM_OUTPUT_DIR || 'tests/results/combined-exam-pages');
const EXAM = '20000000-0000-4000-8000-000000000001';
const STUDENT = '30000000-0000-4000-8000-000000000001';
const base = `/professor/exams/${EXAM}`;
const api = `/api/exam/templates/${EXAM}`;
const exam = { id: EXAM, title: 'Synthetic combined exam', course: 'SYNTH 101', status: 'draft', question_count: 1, roster_count: 1 };
const syntheticStudent = { student_id: STUDENT, name: 'Synthetic Student', email: 'student@example.invalid', eid: 'synthetic-student', has_photo: false };
let roster = [syntheticStudent], questions = [], materials = [], ownsExam = true;
let time = { time_limit_minutes: 30, question_time_limit_minutes: 2 };
let multiplier = 1.5;
const requests = [], unexpected = [], errors = [], checks = [];
const ods = () => ({ ...time, assignments: [{ ...syntheticStudent, extended_time_multiplier: multiplier,
  effective_time_limit_minutes: time.time_limit_minutes * multiplier }] });
const browser = await chromium.launch({ headless: true, executablePath: process.env.AVATAR_CHROME_PATH
  || (process.platform === 'win32' ? 'C:/Program Files/Google/Chrome/Application/chrome.exe' : undefined) });
const context = await browser.newContext({ viewport: { width: 1365, height: 950 }, reducedMotion: 'reduce' });
const page = await context.newPage();
page.on('pageerror', error => errors.push(error.message));
page.on('dialog', dialog => dialog.accept());
page.setDefaultTimeout(10000);
async function check(name, action) { await action(); checks.push(name); }
async function visit(suffix) {
  await page.goto(baseUrl + base + suffix);
  await page.locator('h1').waitFor();
}
async function noOverflow() {
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'Page should fit the viewport');
}

try {
  await mkdir(output, { recursive: true });
  await context.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url()), p = url.pathname;
    if (url.origin !== new URL(baseUrl).origin) { unexpected.push(url.origin); return route.abort(); }
    if (!p.startsWith('/api/')) return route.continue();
    requests.push({ method: request.method(), path: p });
    const respond = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    if (p === '/api/developer/capabilities') return respond({ enabled: false });
    if (p === '/api/auth/me') return respond({ role: 'professor', professor_id: 'synthetic-professor', username: 'Synthetic Professor' });
    if (p === '/api/auth/professor/recording-notifications') return respond([]);
    if (p === '/api/auth/professor/exams') return respond(ownsExam ? [exam] : []);
    if (p === api + '/roster') {
      if (request.method() === 'POST') {
        roster = [{ ...syntheticStudent, name: 'Synthetic Uploaded Student' }];
        return respond({ rows_processed: 1, students_added: 1, students_updated: 0 });
      }
      return respond(roster);
    }
    if (p === api + '/materials') {
      if (request.method() === 'POST') {
        materials = [{ id: 'synthetic-material', filename: 'synthetic-notes.txt', characters_extracted: 25,
          content_type: 'text/plain', created_at: '2026-11-19T12:00:00Z', has_summary: false }];
        return respond(materials[0]);
      }
      return respond(materials);
    }
    if (p === api + '/materials/synthetic-material') return respond({ ...materials[0], extracted_text: 'Synthetic course notes.' });
    if (p === api + '/questions') {
      if (request.method() === 'POST') {
        questions = [{ id: 'synthetic-question', question_text: 'Explain a synthetic topic.', topic: 'Synthetic', difficulty: 2,
          created_at: '2026-11-19T12:00:00Z' }];
        return respond({ questions_added: 1, filename: 'synthetic-questions.txt' });
      }
      return respond(questions);
    }
    if (p === api + '/question-drafts') return respond({ drafts: [], topics: ['Synthetic'], can_edit: false });
    if (p === api + '/question-drafts/context') return respond({ topic_coverage_required: ['Synthetic'], rubric: { criteria: [] }, context_hash: 'synthetic', can_edit: false });
    if (p === api + '/time-settings') {
      if (request.method() === 'PUT') time = request.postDataJSON();
      return respond(time);
    }
    if (p === api + '/ods-accommodations') {
      if (request.method() === 'PUT') {
        const body = request.postDataJSON();
        assert.equal(body.eid, 'synthetic-student'); multiplier = body.extended_time_multiplier;
      }
      return respond(ods());
    }
    unexpected.push(`${request.method()} ${p}`); return respond({ detail: 'Unexpected synthetic request' }, 500);
  });

  await check('one sidebar destination contains all three upload editors', async () => {
    await visit('/uploads');
    const nav = page.getByRole('navigation', { name: 'Exam sections', exact: true });
    await nav.getByRole('link', { name: 'Exam uploads', exact: true }).waitFor();
    assert.equal(await nav.locator('[aria-current="page"]').textContent(), 'Exam uploads');
    for (const name of ['Questions', 'Course materials', 'Student roster', 'Time & Scheduling', 'ODS Accommodations']) {
      assert.equal(await nav.getByRole('link', { name, exact: true }).count(), 0);
    }
    assert.equal(await nav.getByRole('link', { name: 'Time and ODS', exact: true }).count(), 1);
    for (const id of ['roster', 'materials', 'questions']) assert.equal(await page.locator(`#${id} input[type=file]`).count(), 1);
    assert.equal(await page.locator('main').count(), 1);
    await noOverflow();
    await page.screenshot({ path: path.join(output, 'uploads-light.png') });
  });
  await check('student roster upload and saved preview remain functional', async () => {
    const section = page.locator('#roster');
    await section.locator('input[type=file]').setInputFiles({ name: 'synthetic-roster.csv', mimeType: 'text/csv',
      buffer: Buffer.from('name,email,eid\nSynthetic Uploaded Student,student@example.invalid,synthetic-student\n') });
    await section.getByRole('button', { name: 'Upload Student Roster', exact: true }).click();
    await section.getByRole('button', { name: 'Review uploaded roster' }).click();
    await page.getByRole('dialog').getByRole('cell', { name: 'Synthetic Uploaded Student', exact: true }).waitFor();
    await page.getByRole('button', { name: 'Close Preview', exact: true }).click();
  });
  await check('course material upload and preview remain functional', async () => {
    const section = page.locator('#materials');
    await section.locator('input[type=file]').setInputFiles({ name: 'synthetic-notes.txt', mimeType: 'text/plain', buffer: Buffer.from('Synthetic course notes.') });
    await section.getByRole('heading', { name: 'synthetic-notes.txt', exact: true }).waitFor();
    await section.getByRole('button', { name: 'Preview', exact: true }).click();
    await page.getByRole('dialog').getByText('Synthetic course notes.', { exact: true }).waitFor();
    await page.getByRole('button', { name: 'Close Preview', exact: true }).click();
  });
  await check('question upload and preview remain functional', async () => {
    const section = page.locator('#questions');
    await section.locator('input[type=file]').setInputFiles({ name: 'synthetic-questions.txt', mimeType: 'text/plain', buffer: Buffer.from('Explain a synthetic topic.') });
    await section.getByRole('heading', { name: 'Explain a synthetic topic.', exact: true }).waitFor();
    const headings = await section.locator('h2').allTextContents();
    assert.ok(headings.indexOf('Import Question Bank') < headings.indexOf('Saved Questions'));
    assert.ok(headings.indexOf('Saved Questions') < headings.indexOf('AI question drafts'));
    await section.getByRole('button', { name: 'Preview', exact: true }).click();
    await page.getByRole('dialog').getByText('Explain a synthetic topic.', { exact: true }).waitFor();
    await page.getByRole('button', { name: 'Close Preview', exact: true }).click();
    const posts = requests.filter(item => item.method === 'POST').map(item => item.path);
    assert.deepEqual(posts.sort(), [api + '/roster', api + '/materials', api + '/questions'].sort());
  });
  await check('old upload bookmarks redirect to the appropriate section', async () => {
    for (const section of ['roster', 'materials', 'questions']) {
      await page.goto(baseUrl + base + '/' + section + '?source=synthetic');
      await page.waitForURL(baseUrl + base + '/uploads?source=synthetic#' + section);
      await page.getByRole('heading', { name: 'Exam uploads', exact: true }).waitFor();
    }
  });
  await check('time limits and ODS assignments share one page', async () => {
    await visit('/settings/time-ods');
    await page.locator('#exam-time-limit').waitFor();
    await page.locator('.ods-saved-assignments').getByRole('cell', { name: '45 minutes', exact: true }).waitFor();
    assert.equal(await page.locator('#exam-time-limit').inputValue(), '30');
    assert.equal(await page.locator('#question-time-limit').inputValue(), '2');
  });
  await check('saving time refreshes ODS totals and preserves an unfinished EID entry', async () => {
    await page.locator('#ods-student-eid').fill('unfinished-synthetic-eid');
    await page.locator('#exam-time-limit').fill('45');
    await page.getByRole('button', { name: 'Save time limits', exact: true }).click();
    await page.locator('.ods-saved-assignments').getByRole('cell', { name: '67.5 minutes', exact: true }).waitFor();
    assert.equal(await page.locator('#ods-student-eid').inputValue(), 'unfinished-synthetic-eid');
    assert.equal(await page.locator('#question-time-limit').inputValue(), '2');
    assert.deepEqual(time, { time_limit_minutes: 45, question_time_limit_minutes: 2 });
  });
  await check('ODS changes retain standard time and the question limit', async () => {
    await page.locator('#ods-student-eid').fill('synthetic-student');
    await page.getByRole('combobox', { name: /^Extended time multiplier/ }).selectOption('2');
    await page.getByRole('button', { name: 'Save student accommodation', exact: true }).click();
    await page.locator('.ods-saved-assignments').getByRole('cell', { name: '90 minutes', exact: true }).waitFor();
    assert.equal(await page.locator('#exam-time-limit').inputValue(), '45');
    assert.equal(await page.locator('#question-time-limit').inputValue(), '2');
    await page.reload();
    await page.locator('.ods-saved-assignments').getByRole('cell', { name: '90 minutes', exact: true }).waitFor();
    assert.equal(await page.locator('#exam-time-limit').inputValue(), '45');
    await page.screenshot({ path: path.join(output, 'time-and-ods-light.png'), fullPage: true });
  });
  await check('old timing bookmarks open the combined page', async () => {
    for (const [old, target] of [['time-scheduling', 'time-limits'], ['ods-accommodations', 'ods-accommodations']]) {
      await page.goto(baseUrl + base + '/settings/' + old);
      await page.waitForURL(baseUrl + base + '/settings/time-ods#' + target);
      await page.getByRole('heading', { name: 'Time and ODS', exact: true }).waitFor();
    }
  });
  await check('combined pages fit desktop and mobile in dark mode', async () => {
    await page.getByRole('switch', { name: 'Dark mode', exact: true }).click();
    for (const width of [1365, 390, 320]) {
      await page.setViewportSize({ width, height: 950 });
      for (const suffix of ['/uploads', '/settings/time-ods']) {
        await visit(suffix);
        assert.equal(await page.locator('html').getAttribute('data-theme'), 'dark');
        await noOverflow();
        if (width === 390) await page.screenshot({ path: path.join(output, suffix.includes('uploads') ? 'uploads-dark-mobile.png' : 'time-and-ods-dark-mobile.png') });
      }
    }
    const options = await page.getByRole('combobox', { name: /^Go to/ }).locator('option').allTextContents();
    assert.ok(options.includes('Exam uploads') && options.includes('Time and ODS'));
    assert.ok(!options.includes('Time & Scheduling') && !options.includes('ODS Accommodations'));
  });
  await check('exam ownership gate remains ahead of the combined forms', async () => {
    ownsExam = false;
    const before = requests.filter(item => item.path.startsWith(api)).length;
    for (const suffix of ['/uploads', '/settings/time-ods']) {
      await page.goto(baseUrl + base + suffix);
      await page.getByRole('alert').waitFor();
      assert.match(await page.getByRole('alert').textContent(), /Exam not found, or you do not have permission to access it/);
      assert.equal(await page.locator('input[type=file]').count(), 0);
    }
    assert.equal(requests.filter(item => item.path.startsWith(api)).length, before);
  });
  assert.deepEqual(errors, []); assert.deepEqual(unexpected, []);
  const results = { passed: true, checks, jsErrors: errors, unexpectedRequests: unexpected,
    limits: 'Synthetic records and intercepted API requests only. No live database writes, media access, or AI calls.' };
  await writeFile(path.join(output, 'actual-results.json'), JSON.stringify(results, null, 2));
  console.log(JSON.stringify(results));
} finally { await context.close(); await browser.close(); }
