/** Actual localhost UI smoke. Credentials are read internally from protected P3
 * storage and never printed, traced, screenshotted, or included in reports.
 * --create-synthetic-exam explicitly permits one unpublished synthetic draft;
 * only that newly-created UUID is deleted during cleanup. No provider or devices.
 */
import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { randomUUID } from 'node:crypto';

const { values } = parseArgs({ options: {
  'create-synthetic-exam': { type: 'boolean', default: false },
  'exam-id': { type: 'string' }, plan: { type: 'boolean', default: false },
  'expect-backend-unavailable': { type: 'boolean', default: false },
} });
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const data = path.join(root, 'private-data', 'p3-local');
const origin = 'http://127.0.0.1:5173';
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
if (values['exam-id'] && !uuid.test(values['exam-id'])) throw new Error('A valid exam UUID is required.');
if (values['exam-id'] && values['create-synthetic-exam']) throw new Error('Choose an existing exam or create one synthetic draft.');
if (values['expect-backend-unavailable'] && (values['exam-id'] || values['create-synthetic-exam'])) throw new Error('Outage verification never creates or inspects an exam.');
if (values.plan) {
  console.log(JSON.stringify({ target: origin, starts_services: false, capture: false, model_calls: false,
    credential_source: values['expect-backend-unavailable'] ? 'synthetic dummy input; no credential file read' : 'protected P3 professor account', screenshots: false,
    creates_unpublished_synthetic_exam: values['create-synthetic-exam'],
    expects_backend_unavailable: values['expect-backend-unavailable'],
    cleanup_scope: 'Only this run\'s new synthetic exam UUID',
    checks: values['expect-backend-unavailable'] ? ['actual proxy login service-failure message']
      : ['service readiness', 'actual UI login', 'dashboard and exams', 'question draft panel GET', 'five shared-renderer backgrounds', '390px layout'] }, null, 2));
  process.exit(0);
}

const output = path.join(data, 'verification', `browser-smoke-${Date.now()}-${randomUUID().slice(0, 8)}`);
await mkdir(output, { recursive: true, mode: 0o700 });
const reportPath = path.join(output, 'report.json');
const report = { status: 'started', started_at: new Date().toISOString(), step: 'initialization', checks: [],
  services_started: false, capture: false, screenshots: false, provider_requests: 0,
  blocked_requests: [], api_results: [], runtime_error_count: 0,
  synthetic_exam_created: false, synthetic_exam_cleaned: false };
let browser, context, createdId = null, targetId = values['exam-id'] ?? null;
const failures = [];
function requireCheck(condition, code) { assert.ok(condition, code); }
async function check(name, callback) {
  report.step = name;
  await callback();
  report.checks.push({ name, status: 'passed' });
}
try {
  let account;
  if (!values['expect-backend-unavailable']) {
    const accountFile = JSON.parse(await readFile(path.join(data, 'local-accounts.json'), 'utf8'));
    account = accountFile.professor;
    requireCheck(typeof account?.username === 'string' && typeof account?.password === 'string', 'PROTECTED_ACCOUNT_INVALID');
  }
  const require = createRequire(process.env.AVATAR_NODE_MODULES_PATH
    ? path.join(path.resolve(process.env.AVATAR_NODE_MODULES_PATH), 'package.json') : import.meta.url);
  const { chromium } = require('playwright');
  browser = await chromium.launch({ headless: true, args: ['--mute-audio'],
    executablePath: process.env.AVATAR_CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe' });
  context = await browser.newContext({ viewport: { width: 1280, height: 900 }, reducedMotion: 'reduce' });
  let mediaCalls = 0;
  await context.exposeBinding('__blockedP3SmokeMedia', () => { mediaCalls++; });
  await context.addInitScript(() => {
    if (navigator.mediaDevices) navigator.mediaDevices.getUserMedia = () => {
      void window.__blockedP3SmokeMedia(); throw new Error('Real capture is disabled in this verification.');
    };
    if (window.speechSynthesis) window.speechSynthesis.speak = () => {
      void window.__blockedP3SmokeMedia(); throw new Error('Speech output is disabled in this verification.');
    };
  });
  if (!values['expect-backend-unavailable']) await context.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.origin !== origin) {
      report.blocked_requests.push({ kind: 'external', method: request.method() });
      return route.abort('blockedbyclient');
    }
    if (url.pathname.startsWith('/api/') && !['GET', 'HEAD'].includes(request.method()) &&
        !(url.pathname === '/api/auth/login' && request.method() === 'POST') &&
        !(values['create-synthetic-exam'] && createdId && request.method() === 'PUT' &&
          url.pathname === `/api/exam/templates/${createdId}/question-drafts/context`)) {
      report.blocked_requests.push({ kind: 'unapproved-browser-mutation', method: request.method(), path: url.pathname });
      return route.abort('blockedbyclient');
    }
    if (/\/(?:speech|question-audio|question-drafts\/generate|ollama)(?:\/|$)/.test(url.pathname)) {
      report.provider_requests++;
      return route.abort('blockedbyclient');
    }
    return route.continue();
  });
  const page = await context.newPage(); page.setDefaultTimeout(10000);
  page.on('pageerror', () => { report.runtime_error_count++; });
  page.on('dialog', dialog => dialog.type() === 'beforeunload' ? dialog.accept() : dialog.dismiss());
  page.on('response', response => {
    const url = new URL(response.url());
    if (url.origin === origin && url.pathname.startsWith('/api/')) report.api_results.push({ path: url.pathname, method: response.request().method(), status: response.status() });
  });
  if (values['expect-backend-unavailable']) {
    await check('actual_proxy_login_service_failure', async () => {
      await page.goto(`${origin}/professor/login`);
      await page.getByLabel('Username', { exact: true }).fill('__synthetic_outage_check__');
      await page.getByLabel('Password', { exact: true }).fill(`Synthetic-only-${randomUUID()}`);
      const response = page.waitForResponse(response => new URL(response.url()).pathname === '/api/auth/login');
      await page.getByRole('button', { name: 'Sign In', exact: true }).click();
      const unavailable = await response;
      requireCheck(unavailable.status() >= 500, 'BACKEND_WAS_NOT_UNAVAILABLE');
      report.expected_proxy_status = unavailable.status();
      const alert = page.getByRole('alert');
      await alert.waitFor();
      const message = await alert.innerText();
      requireCheck(/service is unavailable|Unable to connect to the server/i.test(message), 'SERVICE_OUTAGE_NOT_REPORTED');
      requireCheck(!/incorrect|invalid credentials|check your username and password/i.test(message), 'OUTAGE_MISREPORTED_AS_BAD_CREDENTIALS');
      requireCheck(new URL(page.url()).pathname === '/professor/login', 'FAILED_LOGIN_NAVIGATED_TO_DASHBOARD');
      requireCheck(report.runtime_error_count === 0, 'BROWSER_RUNTIME_ERROR');
    });
    report.status = 'passed';
  } else {
  await check('ready', async () => {
    const response = await context.request.get(`${origin}/api/health/ready`);
    requireCheck(response.ok(), 'LOCAL_SERVICES_NOT_READY');
  });
  await check('actual_ui_login', async () => {
    await page.goto(`${origin}/professor/login`);
    await page.getByLabel('Username', { exact: true }).fill(account.username);
    await page.getByLabel('Password', { exact: true }).fill(account.password);
    const response = page.waitForResponse(response => new URL(response.url()).pathname === '/api/auth/login');
    await page.getByRole('button', { name: 'Sign In', exact: true }).click();
    requireCheck((await response).ok(), 'LOCAL_LOGIN_FAILED');
    await page.getByRole('heading', { name: 'Your examinations', exact: true }).waitFor();
    const identity = await context.request.get(`${origin}/api/auth/me`);
    requireCheck(identity.ok() && (await identity.json()).role === 'professor', 'PROFESSOR_COOKIE_NOT_ESTABLISHED');
  });
  await check('owned_exams', async () => {
    await page.goto(`${origin}/professor/exams`);
    await page.getByRole('heading', { name: 'My Exams', exact: true }).waitFor();
    if (values['create-synthetic-exam']) {
      const response = await context.request.post(`${origin}/api/exam/templates`, { data: {
        title: `[P3 synthetic smoke] ${randomUUID()}`, course: 'SYNTH-SMOKE',
        description: 'Synthetic unpublished UI verification. No real student, media, provider or exam publication.', icon: 'S',
      } });
      requireCheck(response.status() === 201, 'SYNTHETIC_DRAFT_CREATE_FAILED');
      const result = await response.json();
      requireCheck(uuid.test(result.id), 'SYNTHETIC_DRAFT_ID_INVALID');
      createdId = targetId = result.id; report.synthetic_exam_created = true;
    }
    requireCheck(Boolean(targetId), 'EXAM_ID_OR_EXPLICIT_SYNTHETIC_CREATE_REQUIRED');
    const response = await context.request.get(`${origin}/api/auth/professor/exams`);
    requireCheck(response.ok(), 'OWNED_EXAM_LIST_FAILED');
    const exams = await response.json(), target = exams.find(exam => exam.id === targetId);
    requireCheck(target && target.status === 'draft', 'TARGET_IS_NOT_AN_OWNED_UNPUBLISHED_DRAFT');
  });
  await check('question_draft_panel_actual_get', async () => {
    const response = page.waitForResponse(response => new URL(response.url()).pathname === `/api/exam/templates/${targetId}/question-drafts`);
    const contextResponse = page.waitForResponse(response => new URL(response.url()).pathname === `/api/exam/templates/${targetId}/question-drafts/context`);
    await page.goto(`${origin}/professor/exams/${targetId}/questions`);
    await page.getByRole('heading', { name: 'Question Bank', exact: true }).waitFor();
    await page.getByRole('heading', { name: 'AI question drafts', exact: true }).waitFor();
    requireCheck((await response).ok(), 'QUESTION_DRAFT_GET_FAILED');
    const panel = page.getByRole('region', { name: 'AI question drafts', exact: true });
    await panel.getByRole('button', { name: 'Generate drafts', exact: true }).waitFor();
    requireCheck((await panel.innerText()).includes('explicitly approve'), 'DRAFT_APPROVAL_NOTICE_MISSING');
    requireCheck((await contextResponse).ok(), 'ASSESSMENT_CONTEXT_GET_FAILED');
    await panel.getByText('Professor topics and assessment rubric', { exact: true }).click();
    await panel.getByLabel('Exam topics, one per line', { exact: true }).waitFor();
    requireCheck(await panel.getByLabel('Exam topics, one per line', { exact: true }).isEnabled(), 'UNPUBLISHED_CONTEXT_NOT_EDITABLE');
    requireCheck(await panel.getByRole('button', { name: 'Save topics and rubric', exact: true }).isVisible(), 'ASSESSMENT_CONTEXT_SAVE_CONTROL_MISSING');
    if (values['create-synthetic-exam']) {
      requireCheck(createdId === targetId, 'CONTEXT_WRITE_REQUIRES_NEW_SCRATCH_EXAM');
      await panel.getByLabel('Exam topics, one per line', { exact: true }).fill('Computer Science');
      await panel.getByRole('button', { name: 'Add rubric criterion', exact: true }).click();
      await panel.getByLabel('Criterion 1 name', { exact: true }).fill('Accuracy');
      await panel.getByLabel('Criterion 1 maximum score', { exact: true }).fill('10');
      await panel.getByLabel('Criterion 1 description', { exact: true }).fill('Synthetic professor criterion for browser verification.');
      const saved = page.waitForResponse(response => response.request().method() === 'PUT' &&
        new URL(response.url()).pathname === `/api/exam/templates/${createdId}/question-drafts/context`);
      await panel.getByRole('button', { name: 'Save topics and rubric', exact: true }).click();
      requireCheck((await saved).ok(), 'SYNTHETIC_CONTEXT_SAVE_FAILED');
      await panel.getByText('Topics and rubric saved for this unpublished exam. Publishing remains a separate action.', { exact: true }).waitFor();
      await page.reload();
      await panel.getByText('Professor topics and assessment rubric', { exact: true }).click();
      await panel.getByLabel('Exam topics, one per line', { exact: true }).waitFor();
      requireCheck(await panel.getByLabel('Exam topics, one per line', { exact: true }).inputValue() === 'Computer Science', 'SAVED_TOPICS_NOT_RESTORED');
      requireCheck(await panel.getByLabel('Criterion 1 name', { exact: true }).inputValue() === 'Accuracy', 'SAVED_RUBRIC_NOT_RESTORED');
      requireCheck(await panel.getByLabel('Criterion 1 maximum score', { exact: true }).inputValue() === '10', 'SAVED_RUBRIC_SCORE_NOT_RESTORED');
      requireCheck(await panel.getByRole('button', { name: 'Generate drafts', exact: true }).isEnabled(), 'SAVED_TOPICS_DID_NOT_ENABLE_DRAFT_CONTROLS');
      report.synthetic_context_saved_and_reloaded = true;
      // The Generate action remains unclicked; no model/provider request occurs.
    }
  });
  await check('current_main_sidebar_and_tabs', async () => {
    await page.goto(`${origin}/professor/exams/${targetId}`);
    const nav = page.getByRole('navigation', { name: 'Exam sections', exact: true });
    await nav.waitFor();
    for (const [slug, title] of [
      ['avatar-interaction','Avatar & Interaction Settings'], ['time-scheduling','Time & Scheduling'],
      ['ods-accommodations','ODS Accommodations'], ['ai-questioning','AI Questioning'],
      ['recording-transcript','Recording & Transcript'], ['ai-results','AI Results']]) {
      const href = `/professor/exams/${targetId}/settings/${slug}`;
      requireCheck(await nav.locator(`a[href="${href}"]`).count() === 1, 'CURRENT_SIDEBAR_DESTINATION');
      await nav.locator(`a[href="${href}"]`).click();
      await page.getByRole('heading', {name:title, exact:true}).first().waitFor();
    }
    await page.goto(`${origin}/professor/exams/${targetId}/settings/avatar-interaction`);
    for (const label of ['Talking avatar','Built-in examiner','Student controls','Assistance','Exam behavior','Student preview','Saving and sharing']) {
      const tab = page.getByRole('button',{name:label,exact:true});
      await tab.click(); requireCheck(await tab.getAttribute('aria-pressed') === 'true','CURRENT_AVATAR_TAB');
    }
  });
  await check('five_shared_renderer_backgrounds', async () => {
    await page.goto(`${origin}/professor/exams/${targetId}/settings/avatar-interaction`);
    await page.getByRole('button', { name: 'Built-in examiner', exact: true }).click();
    const background = page.getByLabel('Default background', { exact: true });
    await background.waitFor();
    const expected = ['neutral', 'library', 'classroom', 'office', 'nature'];
    const options = await background.locator('option').evaluateAll(options => options.map(option => option.value));
    requireCheck(expected.every(id => options.includes(id)), 'FIVE_BACKGROUND_CATALOG_MISSING');
    const styles = new Set();
    for (const id of expected) {
      await background.selectOption(id);
      await page.getByRole('button', { name: 'Student preview', exact: true }).click();
      const preview = page.getByRole('region', { name: 'Student preview', exact: true });
      const stage = preview.locator('.exam-stage-viewport');
      requireCheck(await stage.getAttribute('data-background') === id, 'PREVIEW_BACKGROUND_MISMATCH');
      styles.add(await stage.evaluate(element => getComputedStyle(element).backgroundImage));
      await page.getByRole('button', { name: 'Built-in examiner', exact: true }).click();
    }
    requireCheck(styles.size === 5, 'PREVIEW_BACKGROUNDS_NOT_VISUALLY_DISTINCT');
    // All edits above remain in this mounted synthetic preview; never save policy/draft.
  });
  await check('narrow_viewport', async () => {
    await page.setViewportSize({ width: 390, height: 844 });
    report.narrow_metrics = await page.evaluate(() => ({width:innerWidth,scroll:document.documentElement.scrollWidth,overflow:[...document.querySelectorAll('main *')].filter(e=>e.getBoundingClientRect().right>innerWidth+1).slice(0,12).map(e=>({tag:e.tagName,cls:e.className,width:e.getBoundingClientRect().width,right:e.getBoundingClientRect().right}))}));
    requireCheck(report.narrow_metrics.scroll <= report.narrow_metrics.width, 'NARROW_LAYOUT_OVERFLOW');
    await page.getByRole('button', { name: 'Student preview', exact: true }).click();
    requireCheck(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'NARROW_PREVIEW_OVERFLOW');
    await page.getByRole('button', { name: 'Built-in examiner', exact: true }).click();
  });
  await check('no_unexpected_requests_or_capture', async () => {
    requireCheck(mediaCalls === 0 && report.provider_requests === 0, 'UNEXPECTED_MEDIA_OR_PROVIDER_REQUEST');
    requireCheck(report.blocked_requests.length === 0, 'UNEXPECTED_REQUEST_BLOCKED');
    requireCheck(report.runtime_error_count === 0, 'BROWSER_RUNTIME_ERROR');
    requireCheck(report.api_results.every(result => result.status < 400), 'UNEXPECTED_API_ERROR');
  });
  report.status = 'passed';
  }
} catch {
  // Never print raw Playwright errors: fill() diagnostics can contain credentials.
  failures.push({ step: report.step, code: 'SMOKE_STEP_FAILED' }); report.status = 'failed';
} finally {
  if (createdId && context) {
    try {
      const response = await context.request.delete(`${origin}/api/exam/templates/${createdId}`);
      const listed = await context.request.get(`${origin}/api/auth/professor/exams`);
      report.synthetic_exam_cleaned = response.ok() && listed.ok() && !(await listed.json()).some(exam => exam.id === createdId);
    } catch { report.synthetic_exam_cleaned = false; }
    if (!report.synthetic_exam_cleaned) { failures.push({ step: 'cleanup', code: 'SYNTHETIC_DRAFT_CLEANUP_FAILED' }); report.status = 'failed'; }
  }
  if (browser) { try { await browser.close(); } catch { failures.push({ step: 'browser_cleanup', code: 'BROWSER_CLOSE_FAILED' }); report.status = 'failed'; } }
  report.completed_at = new Date().toISOString(); report.failures = failures;
  await writeFile(reportPath, JSON.stringify(report, null, 2), { mode: 0o600 });
}
console.log(JSON.stringify({ status: report.status, passed: report.checks.length, failed: failures.length,
  report: reportPath, synthetic_exam_created: report.synthetic_exam_created, synthetic_exam_cleaned: report.synthetic_exam_cleaned,
  no_real_media: true, no_provider_calls: report.provider_requests === 0 }, null, 2));
process.exitCode = report.status === 'passed' ? 0 : 1;
