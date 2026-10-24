import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

// Step 1 only: isolated student presentation preview, synthetic data, no backend.
const require = createRequire(process.env.AVATAR_NODE_MODULES_PATH
  ? path.join(path.resolve(process.env.AVATAR_NODE_MODULES_PATH), 'package.json')
  : import.meta.url);
const { chromium } = require('playwright');
const baseUrl = process.env.STUDENT_SETTINGS_TEST_URL || process.env.AVATAR_TEST_URL || 'http://127.0.0.1:5173';
const outputDir = process.env.STUDENT_SETTINGS_TEST_OUTPUT_DIR || process.env.AVATAR_TEST_OUTPUT_DIR || path.join(process.cwd(), 'test-results', 'student-settings');
const executablePath = process.env.AVATAR_CHROME_PATH || (process.platform === 'win32'
  ? 'C:/Program Files/Google/Chrome/Application/chrome.exe'
  : process.platform === 'darwin'
    ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
    : undefined);
const keepOpen = process.argv.includes('--keep-open');
const browser = await chromium.launch({ executablePath, headless: !keepOpen });
const context = await browser.newContext({ viewport: { width: 1365, height: 900 } });
const page = await context.newPage();
page.setDefaultTimeout(7000);
const results = [];
const apiRequests = [];
const externalRequests = [];
const mediaCalls = [];
const pageErrors = [];
const consoleErrors = [];
const storageReads = [];
const servedModuleUrls = new Map();
const startedAt = new Date().toISOString();
const QUESTION = 'What is one benefit of separating data from presentation?';
const STUDENT_KEY_PREFIX = 'oral-exam-student-preview:v1:';
const instructorKey = 'oral-exam-avatar:v1:["synthetic-unrelated-exam","synthetic-unrelated-instructor"]';
const instructorValue = JSON.stringify({ syntheticSentinel: true, marker: 'instructor-draft-must-stay-unchanged' });

await context.exposeBinding('__recordStudentSettingsStorageRead', (_source, key) => { storageReads.push(String(key)); });
await context.exposeBinding('__recordStudentSettingsMediaCall', (_source, name) => { mediaCalls.push(String(name)); });
await context.addInitScript(({ instructorKey, instructorValue }) => {
  const getItem = Storage.prototype.getItem;
  // Seed once per isolated browser session, independently of any test succeeding.
  // Never re-seed after an app deletion: the later isolation assertion must detect it.
  const fixtureMarker = 'student-settings-test:instructor-fixture-seeded';
  if (getItem.call(sessionStorage, fixtureMarker) !== 'yes') {
    localStorage.setItem(instructorKey, instructorValue);
    sessionStorage.setItem(fixtureMarker, 'yes');
  }
  Storage.prototype.getItem = function (key) {
    void window.__recordStudentSettingsStorageRead(String(key));
    return getItem.call(this, key);
  };
  if (navigator.mediaDevices) {
    navigator.mediaDevices.getUserMedia = (..._args) => {
      void window.__recordStudentSettingsMediaCall('getUserMedia');
      return Promise.reject(new Error('The synthetic student settings test blocks media capture.'));
    };
  }
  if (window.speechSynthesis) {
    window.speechSynthesis.speak = (..._args) => {
      void window.__recordStudentSettingsMediaCall('speechSynthesis.speak');
      throw new Error('The synthetic student settings test blocks speech services.');
    };
  }
}, { instructorKey, instructorValue });
page.on('pageerror', (error) => pageErrors.push(error.message));
page.on('console', (message) => { if (message.type() === 'error') consoleErrors.push(message.text()); });
page.on('dialog', (dialog) => dialog.dismiss());
await context.route('**/*', async (route) => {
  const request = route.request();
  const url = new URL(request.url());
  const details = { method: request.method(), path: url.pathname, type: request.resourceType() };
  if (url.origin !== new URL(baseUrl).origin) {
    externalRequests.push({ ...details, origin: url.origin });
    return route.abort('blockedbyclient');
  }
  if (url.pathname.startsWith('/api/') || /\/(?:exam\/start|exam\/answer|auth)(?:\/|$)/.test(url.pathname) || ['fetch', 'xhr'].includes(request.resourceType()) || !['GET', 'HEAD'].includes(request.method())) {
    apiRequests.push(details);
    return route.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify({ detail: 'Step 1 student preview test blocks all API access.' }) });
  }
  if (request.resourceType() === 'script') servedModuleUrls.set(url.pathname, url.href);
  return route.continue();
});

const button = (name) => page.getByRole('button', { name, exact: true });
const dialog = () => page.getByRole('dialog', { name: 'Student settings', exact: true });
const dialogField = (name) => dialog().getByLabel(name, { exact: true });
const volume = () => dialog().getByLabel(/^Volume(?:\s|:|$)/);
const speed = () => dialog().getByLabel(/^Speaking speed(?:\s|:|$)/);
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
async function visitPreview() {
  await page.goto(`${baseUrl}/student/settings-preview`, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.locator('.student-settings-preview-page').waitFor({ timeout: 30000 });
  await page.locator('.student-demo-question').getByRole('heading', { name: QUESTION, exact: true }).waitFor({ timeout: 30000 });
}
async function openSettings() {
  if (!await dialog().isVisible()) await button('Student settings').click();
  await dialog().waitFor();
  assert(await dialog().evaluate((element) => element instanceof HTMLDialogElement && element.open && element.matches(':modal')));
}
async function closeSettings() {
  if (await dialog().isVisible()) await dialog().getByRole('button', { name: 'Close Settings', exact: true }).click();
  await dialog().waitFor({ state: 'hidden' });
}
async function storageSnapshot() {
  return page.evaluate(() => Object.fromEntries(Object.entries(localStorage)));
}
async function preferencesSnapshot() {
  return Object.fromEntries(Object.entries(await storageSnapshot()).filter(([key]) => key.startsWith(STUDENT_KEY_PREFIX)));
}
async function screenshot(name, target = page) {
  await mkdir(outputDir, { recursive: true });
  const file = path.join(outputDir, name);
  await target.screenshot({ path: file, ...(target === page ? { fullPage: true } : {}) });
  return file;
}
async function assertInstructorDraftUntouched() {
  assert.equal((await storageSnapshot())[instructorKey], instructorValue);
  assert.deepEqual(storageReads.filter((key) => key.startsWith('oral-exam-avatar:') || key.startsWith('oralExamSettings-')), [], 'Student preview must not read instructor drafts');
}
async function activeFocusDetails() {
  return page.evaluate(() => {
    const active = document.activeElement;
    return {
      tag: active?.tagName,
      id: active?.id,
      text: active?.textContent?.trim().slice(0, 160),
      tabIndex: active instanceof HTMLElement ? active.tabIndex : null,
      containedByDialog: !!active?.closest('dialog'),
    };
  });
}

await check('Direct student preview entry opens without starting an exam', async () => {
  // The roster/verification integration now protects /student/exams and removed
  // its former public preview link. The standalone synthetic route remains public.
  await visitPreview();
  assert.equal(new URL(page.url()).pathname, '/student/settings-preview');
  assert.match(await page.locator('main').innerText(), /preview/i);
  assert.equal(await page.locator('.student-demo-question h2').innerText(), QUESTION);
  assert.deepEqual(apiRequests, []);
  return { screenshot: await screenshot('student-settings-preview-desktop.png'), route: '/student/settings-preview' };
});

await check('Student settings update presentation immediately and keep policy controls absent', async () => {
  await visitPreview();
  await openSettings();
  assert.equal(await dialogField('Avatar').inputValue(), 'guide');
  assert.equal(await dialogField('Background').inputValue(), 'neutral');
  assert.match(await dialogField('Avatar').innerText(), /person/i);
  assert.match(await dialogField('Avatar').innerText(), /diamond/i);
  await volume().fill('35');
  await dialogField('Text size').selectOption('24');
  await dialogField('Reduce motion').check();
  await dialogField('Avatar').selectOption('geometric');
  await dialogField('Background').selectOption('library');
  await speed().fill('1.2');
  assert.equal(await page.locator('.student-demo-stage').getAttribute('data-avatar'), 'geometric');
  assert.equal(await page.locator('.student-demo-stage').getAttribute('data-background'), 'library');
  assert.equal(await page.locator('.student-demo-surface').evaluate((element) => getComputedStyle(element).fontSize), '24px');
  assert.match(await page.locator('.student-demo-speed').innerText(), /1\.20/);
  assert.match(await page.locator('.student-demo-volume').innerText(), /35/);
  assert.equal(await page.locator('.student-demo-avatar').evaluate((element) => getComputedStyle(element).animationName), 'none');
  for (const label of ['Voice', 'Default voice', 'Exam mode', 'Instructor simulation mode', 'Response timing', 'Response window', 'Follow-up limit per question', 'Exact question repeats limit per question', 'Clarification limit per question', 'Rubric']) {
    assert.equal(await page.getByLabel(label, { exact: true }).count(), 0, `${label} must not be an editable student control`);
  }
  assert.equal(await page.locator('.student-demo-question h2').innerText(), QUESTION);
  const file = await screenshot('student-settings-dialog-desktop.png', dialog());
  await closeSettings();
  await assertInstructorDraftUntouched();
  return { screenshot: file, avatar: 'geometric', background: 'library', speed: 1.2, volume: 35, textSizePx: 24 };
});

await check('Preferences save and reload without persisting an answer or instructor policy', async () => {
  await visitPreview();
  await openSettings();
  await volume().fill('35');
  await dialogField('Text size').selectOption('20');
  await dialogField('Reduce motion').check();
  await dialogField('Avatar').selectOption('geometric');
  await dialogField('Background').selectOption('library');
  await speed().fill('1.2');
  await dialog().getByRole('button', { name: 'Save Preferences', exact: true }).click();
  await closeSettings();
  const responseMarker = 'Synthetic optional response that must never be persisted.';
  await page.getByLabel('Sample response', { exact: true }).fill(responseMarker);
  const saved = await preferencesSnapshot();
  assert.equal(Object.keys(saved).length, 1, 'Expected one isolated preview preference key');
  assert(Object.keys(saved)[0].includes('synthetic-settings-exam'));
  assert(Object.keys(saved)[0].includes('synthetic-settings-student'));
  const envelope = JSON.parse(Object.values(saved)[0]);
  assert.equal(envelope.version, 1);
  assert.deepEqual(Object.keys(envelope.preferences).sort(), ['avatar', 'background', 'reducedMotion', 'speed', 'textSize', 'volume']);
  assert(!JSON.stringify(await storageSnapshot()).includes(responseMarker));
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.locator('.student-settings-preview-page').waitFor({ timeout: 30000 });
  await openSettings();
  assert.equal(await volume().inputValue(), '35');
  assert.equal(await dialogField('Text size').inputValue(), '20');
  assert(await dialogField('Reduce motion').isChecked());
  assert.equal(await dialogField('Avatar').inputValue(), 'geometric');
  assert.equal(await dialogField('Background').inputValue(), 'library');
  assert.equal(Number(await speed().inputValue()), 1.2);
  await closeSettings();
  assert.equal(await page.getByLabel('Sample response', { exact: true }).inputValue(), '');
  assert.deepEqual(await preferencesSnapshot(), saved);
  await assertInstructorDraftUntouched();
  return { preferenceKeys: Object.keys(saved), answerPersisted: false };
});

await check('Assistance limits survive preference edits, reset, and dialog reopening', async () => {
  await visitPreview();
  const repeat = button('Repeat exact question');
  const clarify = button('Clarify question wording');
  const hint = button('Request hint');
  const assistance = page.getByRole('region', { name: 'Question assistance', exact: true });
  for (const name of ['Request explanation', 'Request correctness feedback']) {
    assert.equal(await button(name).count(), 0, `${name} must be absent when disallowed`);
    assert.equal(await assistance.locator('.student-demo-assistance-item').filter({ hasText: name }).count(), 0, `${name} must not leave a placeholder assistance row`);
  }
  assert.equal(await assistance.locator('.student-demo-assistance-item').count(), 3);
  const assertRemaining = async (action, remaining, total, control) => {
    const badge = page.locator(`#student-assistance-${action}-help.student-assistance-remaining`);
    assert(await badge.isVisible(), `${action} allowance must be visibly displayed`);
    assert.equal((await badge.innerText()).trim(), `${remaining} of ${total} remaining`);
    assert.equal(await control.getAttribute('aria-describedby'), `student-assistance-${action}-help`, `${action} must describe its remaining allowance to assistive technology`);
  };
  await assertRemaining('repeat', 2, 2, repeat);
  await assertRemaining('clarification', 1, 1, clarify);
  await assertRemaining('hint', 1, 1, hint);
  await repeat.click();
  assert.match(await page.locator('.student-demo-response').innerText(), new RegExp(QUESTION.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert(await repeat.isEnabled());
  await assertRemaining('repeat', 1, 2, repeat);
  await repeat.click();
  assert(await repeat.isDisabled());
  await assertRemaining('repeat', 0, 2, repeat);
  await clarify.click();
  assert(await clarify.isDisabled());
  await assertRemaining('clarification', 0, 1, clarify);
  await hint.click();
  assert(await hint.isDisabled());
  await assertRemaining('hint', 0, 1, hint);
  await openSettings();
  await dialogField('Avatar').selectOption('guide');
  await dialogField('Text size').selectOption('24');
  await dialog().getByRole('button', { name: 'Reset Preferences', exact: true }).click();
  assert.equal(await dialogField('Avatar').inputValue(), 'guide');
  assert.equal(await dialogField('Background').inputValue(), 'neutral');
  assert.equal(Number(await speed().inputValue()), 1);
  assert.equal(await dialogField('Text size').inputValue(), '16');
  await closeSettings();
  assert(await repeat.isDisabled());
  assert(await clarify.isDisabled());
  assert(await hint.isDisabled());
  for (const action of [repeat, clarify, hint]) {
    assert.match(await action.locator('..').innerText(), /0 of \d+ remaining/i, 'An allowed action remains visible after its allowance is exhausted');
  }
  await assertRemaining('repeat', 0, 2, repeat);
  await assertRemaining('clarification', 0, 1, clarify);
  await assertRemaining('hint', 0, 1, hint);
  await openSettings();
  await closeSettings();
  assert(await repeat.isDisabled());
  assert(await clarify.isDisabled());
  assert(await hint.isDisabled());
  await page.getByLabel('Sample response', { exact: true }).fill('Synthetic response before restarting the preview.');
  await button('Restart preview').click();
  assert(await repeat.isEnabled());
  assert(await clarify.isEnabled());
  assert(await hint.isEnabled());
  await assertRemaining('repeat', 2, 2, repeat);
  await assertRemaining('clarification', 1, 1, clarify);
  await assertRemaining('hint', 1, 1, hint);
  assert.equal(await page.getByLabel('Sample response', { exact: true }).inputValue(), '');
  assert.equal(await page.locator('.student-demo-question h2').innerText(), QUESTION);
  return { repeatLimit: 2, clarificationLimit: 1, hintLimit: 1, countersResetOnlyByRestartWithinMountedPreview: true };
});

await check('Locked presentation and forced motion choices leave no fields or unavailable placeholders', async () => {
  await visitPreview();
  // Mount the actual component with isolated synthetic policies in this test page.
  // Reuse Vite's served module URLs so React and ReactDOM use the app's runtime.
  // This harness does not add an application route, change the real demo policy,
  // read instructor state, or save any preferences.
  const moduleUrls = Object.fromEntries(['react.js', 'react-dom_client.js', 'StudentSettingsPanel.tsx', 'studentSettings.ts'].map((name) => {
    const url = [...servedModuleUrls].find(([pathname]) => pathname.endsWith(`/${name}`))?.[1];
    assert(url, `Expected the preview to load ${name}`);
    return [name, url];
  }));
  await page.evaluate(async (urls) => {
    const [reactModule, reactDomModule, { default: Panel }, settings] = await Promise.all([
      import(urls['react.js']), import(urls['react-dom_client.js']),
      import(urls['StudentSettingsPanel.tsx']), import(urls['studentSettings.ts']),
    ]);
    // Vite may expose optimized CommonJS packages through their default export.
    const React = reactModule.default ?? reactModule;
    const ReactDOM = reactDomModule.default ?? reactDomModule;
    const host = document.createElement('div');
    host.id = 'synthetic-student-settings-test-harness';
    document.body.appendChild(host);
    const root = ReactDOM.createRoot(host);
    window.__studentSettingsPolicyHarness = {
      render(overrides) {
        const base = settings.getDemoPolicy();
        const policy = { ...base, ...overrides, defaults: { ...base.defaults, ...overrides.defaults } };
        root.render(React.createElement(Panel, {
          open: true, policy, preferences: settings.defaultPreferences(policy),
          onChange() {}, onClose() {}, onSave() {}, onReset() {},
          dirty: false, status: '', error: '', browserReducedMotion: false,
        }));
      },
      dispose() { root.unmount(); host.remove(); },
    };
    window.__studentSettingsPolicyHarness.render({ allowAvatar: false, allowBackground: false, allowSpeed: false, defaults: { reducedMotion: true } });
  }, moduleUrls);
  try {
    await dialog().waitFor();
    for (const label of ['Avatar', 'Background', 'Speaking speed', 'Reduce motion']) {
      assert.equal(await dialogField(label).count(), 0, `${label} must not exist when changes are forbidden`);
    }
    assert.equal(await dialog().getByRole('heading', { name: 'Presentation', exact: true }).count(), 0);
    assert.doesNotMatch(await dialog().innerText(), /avatar|background|speaking speed|voice|instructor|unavailable|reduced motion/i, 'Locked settings must not leave explanatory placeholders');
    assert(await volume().isVisible());
    assert(await dialogField('Text size').isVisible());
    await page.evaluate(() => window.__studentSettingsPolicyHarness.render({ allowAvatar: true, allowBackground: false, allowSpeed: false }));
    await dialogField('Avatar').waitFor();
    assert(await dialog().getByRole('heading', { name: 'Presentation', exact: true }).isVisible());
    assert(await dialogField('Reduce motion').isVisible());
    assert.equal(await dialogField('Background').count(), 0);
    assert.equal(await speed().count(), 0);
    assert.doesNotMatch(await dialog().innerText(), /background|speaking speed|voice|unavailable/i);
    return { allOptionalLocked: 'No Presentation section', partiallyAllowed: 'Only allowed Avatar choice shown', forcedMotionChoiceAbsent: true };
  } finally {
    await page.evaluate(() => { window.__studentSettingsPolicyHarness.dispose(); delete window.__studentSettingsPolicyHarness; });
  }
});

await check('Reset preferences can be saved and does not erase unrelated drafts', async () => {
  await visitPreview();
  await openSettings();
  await dialog().getByRole('button', { name: 'Reset Preferences', exact: true }).click();
  await dialog().getByRole('button', { name: 'Save Preferences', exact: true }).click();
  await closeSettings();
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.locator('.student-settings-preview-page').waitFor({ timeout: 30000 });
  await openSettings();
  assert.equal(Number(await volume().inputValue()), 70);
  assert.equal(await dialogField('Text size').inputValue(), '16');
  assert.equal(await dialogField('Avatar').inputValue(), 'guide');
  assert.equal(await dialogField('Background').inputValue(), 'neutral');
  assert.equal(Number(await speed().inputValue()), 1);
  await closeSettings();
  await assertInstructorDraftUntouched();
});

await check('Native dialog supports labels, focus cycling, Escape, and focus return', async () => {
  await visitPreview();
  const launcher = button('Student settings');
  await launcher.focus();
  await launcher.press('Enter');
  await dialog().waitFor();
  assert(await dialog().evaluate((element) => element instanceof HTMLDialogElement && element.matches(':modal')));
  assert(await dialog().evaluate((element) => element.contains(document.activeElement)));
  const controls = dialog().locator('input, select');
  const labeledControls = await controls.count();
  assert.equal(labeledControls, 6);
  const unlabeled = await controls.evaluateAll((elements) => elements.filter((element) => !element.labels?.length && !element.getAttribute('aria-label') && !element.getAttribute('aria-labelledby')).map((element) => element.outerHTML));
  assert.deepEqual(unlabeled, []);
  const focusable = dialog().locator('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href], [tabindex]:not([tabindex="-1"])');
  const first = focusable.first();
  const last = focusable.last();
  await last.focus();
  await page.keyboard.press('Tab');
  assert(await dialog().evaluate((element) => element.contains(document.activeElement)), `Tab escaped modal: ${JSON.stringify(await activeFocusDetails())}`);
  assert(await first.evaluate((element) => element === document.activeElement), `Tab did not wrap to first control: ${JSON.stringify(await activeFocusDetails())}`);
  await first.focus();
  await page.keyboard.press('Shift+Tab');
  assert(await dialog().evaluate((element) => element.contains(document.activeElement)), `Shift+Tab escaped modal: ${JSON.stringify(await activeFocusDetails())}`);
  assert(await last.evaluate((element) => element === document.activeElement), `Shift+Tab did not wrap to last control: ${JSON.stringify(await activeFocusDetails())}`);
  const focusStyle = await last.evaluate((element) => getComputedStyle(element).outlineStyle);
  assert.notEqual(focusStyle, 'none');
  await page.keyboard.press('Escape');
  await dialog().waitFor({ state: 'hidden' });
  await page.waitForFunction(() => document.activeElement?.textContent?.trim() === 'Student settings');
  await openSettings();
  await closeSettings();
  await page.waitForFunction(() => document.activeElement?.textContent?.trim() === 'Student settings');
  return { labeledControls, nativeModal: true, escapeAndCloseReturnFocus: true };
});

await check('Browser reduced motion is respected without enabling media services', async () => {
  await visitPreview();
  await button('Repeat exact question').click();
  assert.notEqual(await page.locator('.student-demo-avatar').evaluate((element) => getComputedStyle(element).animationName), 'none');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await openSettings();
  await dialogField('Reduce motion').waitFor({ state: 'detached' });
  assert.equal(await dialogField('Reduce motion').count(), 0);
  assert.doesNotMatch(await dialog().innerText(), /browser requests|reduced motion stays on/i);
  assert.equal(await page.locator('.student-demo-avatar').evaluate((element) => getComputedStyle(element).animationName), 'none');
  await closeSettings();
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  assert.deepEqual(mediaCalls, []);
});

await check('390px and 360px layouts remain within the screen with 24px text', async () => {
  const screenshots = [];
  for (const width of [390, 360]) {
    await page.setViewportSize({ width, height: 844 });
    await visitPreview();
    await openSettings();
    await dialogField('Text size').selectOption('24');
    const modalMetrics = await page.evaluate(() => ({ screen: innerWidth, document: document.documentElement.scrollWidth, client: document.querySelector('dialog').clientWidth, scroll: document.querySelector('dialog').scrollWidth }));
    assert(modalMetrics.document <= modalMetrics.screen, `Page overflow with open dialog: ${JSON.stringify(modalMetrics)}`);
    assert(modalMetrics.scroll <= modalMetrics.client, `Dialog overflow: ${JSON.stringify(modalMetrics)}`);
    screenshots.push(await screenshot(`student-settings-dialog-${width}px.png`, dialog()));
    await closeSettings();
    assert.equal(await page.locator('.student-demo-surface').evaluate((element) => getComputedStyle(element).fontSize), '24px');
    const pageMetrics = await page.evaluate(() => ({ screen: innerWidth, document: document.documentElement.scrollWidth }));
    assert(pageMetrics.document <= pageMetrics.screen, `Preview overflow: ${JSON.stringify(pageMetrics)}`);
    screenshots.push(await screenshot(`student-settings-preview-${width}px.png`));
  }
  return { widths: [390, 360], studentTextSizePx: 24, screenshots };
});

await check('No API, live exam, media, external request, or instructor draft access occurred', async () => {
  assert.deepEqual(apiRequests, []);
  assert.deepEqual(externalRequests, []);
  assert.deepEqual(mediaCalls, []);
  assert.deepEqual(pageErrors, []);
  await assertInstructorDraftUntouched();
});

await page.setViewportSize({ width: 1365, height: 900 });
await visitPreview();
await openSettings();
await mkdir(outputDir, { recursive: true });
const report = {
  startedAt, completedAt: new Date().toISOString(), baseUrl,
  syntheticDataOnly: true, allApiRequestsBlocked: true,
  results,
  summary: { passed: results.filter((result) => result.status === 'passed').length, failed: results.filter((result) => result.status === 'failed').length },
  apiRequests, externalRequests, mediaCalls, pageErrors, consoleErrors, storageReads,
  limitations: [
    'Step 1 only. Fixed synthetic policy; no connection to instructor drafts, roster, authentication, backend policy, or live exams.',
    'Assistance counters belong to a mounted synthetic preview and restart on page reload. They are not server-enforced limits.',
    'Automated label, focus, and layout checks are not full accessibility conformance testing.',
    'User manual review is still required before any later step. This script never initiates step 2.',
  ],
};
const reportPath = path.join(outputDir, 'student-settings-browser-test-results.json');
await writeFile(reportPath, JSON.stringify(report, null, 2));
console.log(JSON.stringify({ reportPath, summary: report.summary, keepOpen }));
process.exitCode = report.summary.failed ? 1 : 0;
if (keepOpen) {
  console.log('Step 1 student settings dialog remains open for manual review. Press Ctrl+C to close this synthetic browser.');
  await new Promise((resolve) => { process.once('SIGINT', resolve); process.once('SIGTERM', resolve); });
}
await browser.close();
