import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

// Local synthetic browser exercise. All API requests are intercepted; no backend is used.
const require = createRequire(process.env.AVATAR_NODE_MODULES_PATH
  ? path.join(path.resolve(process.env.AVATAR_NODE_MODULES_PATH), 'package.json')
  : import.meta.url);
const { chromium } = require('playwright');
const baseUrl = process.env.AVATAR_TEST_URL || 'http://127.0.0.1:5173';
const outputDir = process.env.AVATAR_TEST_OUTPUT_DIR || path.join(process.cwd(), 'test-results', 'avatar');
const keepOpen = process.argv.includes('--keep-open');
const executablePath = process.env.AVATAR_CHROME_PATH || (process.platform === 'win32'
  ? 'C:/Program Files/Google/Chrome/Application/chrome.exe'
  : process.platform === 'darwin'
    ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
    : undefined);
const browser = await chromium.launch({
  executablePath,
  headless: !keepOpen,
});
const context = await browser.newContext({ viewport: { width: 1365, height: 900 } });
const page = await context.newPage();
page.setDefaultTimeout(7000);
let instructor = 'synthetic-instructor-a';
let identityFailure = false;
let identityGate = null;
const results = [];
const requests = [];
const consoleErrors = [];
const pageErrors = [];
const blockedMutations = [];
const unknownApi = [];
const testStart = new Date().toISOString();
const exams = ['a', 'b'].map((suffix) => ({
  id: `synthetic-exam-${suffix}`,
  title: `Synthetic Avatar Exam ${suffix.toUpperCase()}`,
  course: 'SYNTH 101',
  description: 'Synthetic browser exercise only.',
  icon: null,
  created_at: '2026-10-15T12:00:00Z',
  status: 'draft',
  question_count: 1,
  submission_count: 0,
  in_progress_count: 0,
  awaiting_grading_count: 0,
  completed_count: 0,
  flagged_count: 0,
}));

page.on('console', (message) => { if (message.type() === 'error') consoleErrors.push(message.text()); });
page.on('pageerror', (error) => pageErrors.push(error.message));
page.on('dialog', (dialog) => dialog.type() === 'beforeunload' ? dialog.accept() : dialog.dismiss());
await context.route('**/*', async (route) => {
  const request = route.request();
  const url = new URL(request.url());
  if (url.origin !== new URL(baseUrl).origin) return route.abort('blockedbyclient');
  if (!url.pathname.startsWith('/api/')) return route.continue();
  requests.push({ method: request.method(), path: url.pathname });
  const respond = (json, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(json) });
  if (request.method() !== 'GET') {
    blockedMutations.push({ method: request.method(), path: url.pathname });
    return respond({ detail: 'Synthetic test blocks backend mutations.' }, 405);
  }
  if (url.pathname === '/api/auth/me') {
    if (identityGate) await identityGate;
    if (identityFailure) return respond({ detail: 'Synthetic identity failure.' }, 401);
    return respond({ id: 'synthetic-account', professor_id: instructor, username: 'Synthetic Instructor', role: 'professor' });
  }
  if (url.pathname === '/api/auth/professor/exams') return respond(exams);
  if (/^\/api\/exam\/templates\/synthetic-exam-[ab]\/avatar-policy$/.test(url.pathname)) {
    // This regression suite exercises local drafts only; the saved-policy API is
    // covered by exam-policy-browser.test.mjs. No real backend is contacted.
    return respond({ detail: 'Saved policy unavailable in this local-draft fixture.' }, 503);
  }
  if (/^\/api\/exam\/templates\/synthetic-exam-[ab]\/questions$/.test(url.pathname)) {
    return respond([{ id: 'synthetic-question', question_text: 'Describe a synthetic topic.', topic: 'Synthetic topic', difficulty: 2, created_at: '2026-10-15T12:00:00Z' }]);
  }
  if (/^\/api\/exam\/templates\/synthetic-exam-[ab]\/materials$/.test(url.pathname)) return respond([]);
  if (/^\/api\/exam\/templates\/synthetic-exam-[ab]\/roster$/.test(url.pathname)) return respond([]);
  unknownApi.push(url.pathname);
  return respond({ detail: 'Unconfigured synthetic read fixture.' }, 404);
});

async function check(name, run) {
  const started = Date.now();
  try {
    const details = await run();
    results.push({ name, status: 'passed', durationMs: Date.now() - started, details: details ?? null });
    console.log(`PASS ${name}`);
  } catch (error) {
    results.push({ name, status: 'failed', durationMs: Date.now() - started, error: error.stack || String(error) });
    console.log(`FAIL ${name}: ${error.message}`);
  }
}

const field = (name) => page.getByLabel(name, { exact: true });
const button = (name) => page.getByRole('button', { name, exact: true }).first();
async function ensureAvatarEditor() {
  const toggle = button('Avatar & Interaction Settings');
  await toggle.waitFor();
  if (await toggle.getAttribute('aria-expanded') === 'false') await toggle.click();
  await field('Default avatar').waitFor();
}
async function openSettings(exam = 'a') {
  await page.goto(`${baseUrl}/professor/exams/synthetic-exam-${exam}`);
  await page.getByRole('heading', { name: `Synthetic Avatar Exam ${exam.toUpperCase()}`, exact: true }).waitFor();
  await page.getByRole('link', { name: /Avatar & Interaction Settings/ }).click();
  await ensureAvatarEditor();
}
async function settingsStorage() {
  return page.evaluate(() => Object.fromEntries(Object.entries(localStorage).filter(([key]) => /avatar/i.test(key))));
}
async function currentDraft(exam = 'a', instructorId = instructor) {
  return page.evaluate(({ examId, instructorId }) => {
    const raw = localStorage.getItem(`oral-exam-avatar:v1:${JSON.stringify([examId, instructorId])}`);
    return raw ? JSON.parse(raw) : null;
  }, { examId: `synthetic-exam-${exam}`, instructorId });
}
async function saveAndReload() {
  await button('Save Local Draft').click();
  await page.reload();
  await ensureAvatarEditor();
}
async function syntheticPhoto() {
  const dataUrl = await page.evaluate(() => {
    const canvas = document.createElement('canvas');
    canvas.width = 2;
    canvas.height = 2;
    const graphics = canvas.getContext('2d');
    graphics.fillStyle = '#6d28d9';
    graphics.fillRect(0, 0, 2, 2);
    return canvas.toDataURL('image/png');
  });
  return { name: 'synthetic-avatar-preview.png', mimeType: 'image/png', buffer: Buffer.from(dataUrl.split(',')[1], 'base64') };
}
async function uploadPhotos() {
  const photo = await syntheticPhoto();
  await field('Upload own avatar photo').setInputFiles(photo);
  await page.waitForFunction(() => document.querySelector('#avatar-default-avatar')?.value === 'custom');
  await field('Upload own background photo').setInputFiles({ ...photo, name: 'synthetic-background-preview.png' });
  await page.waitForFunction(() => document.querySelector('#avatar-default-background')?.value === 'custom');
}
async function screenshot(name) {
  await mkdir(outputDir, { recursive: true });
  const file = path.join(outputDir, name);
  await page.screenshot({ path: file, fullPage: true });
  return file;
}
async function openPreview() {
  await button('Preview as Student').click();
  const preview = page.getByRole('region', { name: 'Preview as Student', exact: true });
  await preview.waitFor();
  return preview;
}

await check('Open settings through dashboard and exam management', async () => {
  await page.goto(`${baseUrl}/professor/dashboard`);
  const card = page.locator('article').filter({ has: page.getByRole('heading', { name: 'Synthetic Avatar Exam A', exact: true }) });
  await card.getByRole('link', { name: 'Manage Exam', exact: true }).click();
  await page.getByRole('link', { name: /Avatar & Interaction Settings/ }).click();
  await ensureAvatarEditor();
  assert.match(await page.locator('.avatar-settings').innerText(), /exam permissions/i);
  assert.match(await page.locator('.avatar-settings').innerText(), /live exam delivery is not connected yet/i);
  return { screenshot: await screenshot('avatar-settings-desktop.png') };
});

await check('Presentation controls, unsaved indicator, and dependent controls', async () => {
  await openSettings();
  const avatarOptions = await field('Default avatar').locator('option').evaluateAll((options) => options.map((option) => ({ value: option.value, text: option.textContent })));
  assert(avatarOptions.length > 1, 'Expected multiple preview avatars');
  await field('Default avatar').selectOption(avatarOptions[1].value);
  assert.match(await page.locator('main').innerText(), /unsaved changes/i);
  await field('Allow students to choose speaking speed').uncheck();
  assert(await field('Minimum speaking speed').isDisabled());
  assert(await field('Maximum speaking speed').isDisabled());
  await field('Allow students to choose speaking speed').check();
  assert(await field('Minimum speaking speed').isEnabled());
  assert(await field('Maximum speaking speed').isEnabled());
  const allowedAvatars = page.getByRole('group', { name: 'Allowed avatar options', exact: true });
  assert(await allowedAvatars.getByRole('checkbox').first().isDisabled());
  await field('Allow students to choose avatar').check();
  assert(await allowedAvatars.getByRole('checkbox').first().isEnabled());
  await field('Hints').check();
  assert(await field('Hints availability').isEnabled());
  await field('Hints').uncheck();
  assert(await field('Hints availability').isDisabled());
  await field('Exact question repeats').uncheck();
  assert(await field('Exact question repeats limit per question').isDisabled());
  await field('Exact question repeats').check();
  await field('Response timing').selectOption('fixed');
  assert(await field('Response window').isEnabled());
  assert(await field('Response window unit').isEnabled());
  await field('Response timing').selectOption('exam');
  assert(await field('Response window').isDisabled());
  assert(await field('Response window unit').isDisabled());
  assert.equal(await field('Allow students to choose voice').count(), 0);
  assert.equal(await page.getByRole('group', { name: 'Allowed voice options', exact: true }).count(), 0);
  for (const label of ['Difficulty', 'Difficulty behavior', 'Minimum difficulty level', 'Maximum difficulty level']) {
    assert.equal(await field(label).count(), 0);
  }
  return { selectedAvatar: avatarOptions[1] };
});

await check('Invalid ranges and limits do not save', async () => {
  await openSettings();
  const before = await settingsStorage();
  await field('Allow students to choose speaking speed').check();
  await field('Minimum speaking speed').fill('1.5');
  await field('Maximum speaking speed').fill('1');
  await button('Save Local Draft').click();
  assert.deepEqual(await settingsStorage(), before);
  assert(await page.locator('[role="alert"]').count() > 0, 'Expected announced validation error');
  await field('Minimum speaking speed').fill('0.75');
  await field('Maximum speaking speed').fill('1.5');
  // The native number validity and adapter validator must reject fractional assistance limits.
  const repeatLimit = field('Exact question repeats limit per question');
  await repeatLimit.fill('-1');
  await button('Save Local Draft').click();
  assert.deepEqual(await settingsStorage(), before);
  await repeatLimit.fill('2');
  await field('Clarification limit per question').fill('1.5');
  await button('Save Local Draft').click();
  assert.deepEqual(await settingsStorage(), before);
  await field('Clarification limit per question').fill('1');
  await field('Follow-up limit per question').fill('6');
  await button('Save Local Draft').click();
  assert.deepEqual(await settingsStorage(), before);
});

await check('Save/reload and scoped exam and instructor drafts', async () => {
  await openSettings();
  await field('Default speaking speed').fill('1.2');
  await button('Save Local Draft').click();
  await page.reload();
  await ensureAvatarEditor();
  assert.equal(await field('Default speaking speed').inputValue(), '1.2');
  await openSettings('b');
  assert.equal(await field('Default speaking speed').inputValue(), '1');
  await field('Default speaking speed').fill('0.9');
  await button('Save Local Draft').click();
  instructor = 'synthetic-instructor-b';
  await openSettings('a');
  assert.equal(await field('Default speaking speed').inputValue(), '1');
  await field('Default speaking speed').fill('1.1');
  await button('Save Local Draft').click();
  instructor = 'synthetic-instructor-a';
  await openSettings('a');
  assert.equal(await field('Default speaking speed').inputValue(), '1.2');
  return { storageKeys: Object.keys(await settingsStorage()) };
});

await check('Reset to defaults and reload', async () => {
  await openSettings();
  await button('Reset to Defaults').click();
  assert.equal(await field('Default speaking speed').inputValue(), '1');
  await button('Save Local Draft').click();
  await page.reload();
  await ensureAvatarEditor();
  assert.equal(await field('Default speaking speed').inputValue(), '1');
});

await check('Speaking-speed slider exposes normal speed and keyboard bounds', async () => {
  await openSettings();
  await button('Reset to Defaults').click();
  const speed = field('Default speaking speed');
  assert.equal(await speed.getAttribute('type'), 'range');
  assert.equal(Number(await speed.getAttribute('min')), 0.5);
  assert.equal(Number(await speed.getAttribute('max')), 2);
  assert.equal(Number(await speed.getAttribute('step')), 0.05);
  assert.match(await page.locator('#avatar-speed-value').innerText(), /1\.00×.*normal speed/i);
  await speed.focus();
  await speed.press('ArrowRight');
  assert.equal(Number(await speed.inputValue()), 1.05);
  assert.match(await page.locator('#avatar-speed-value').innerText(), /1\.05×/);
  await speed.press('Home');
  assert.equal(Number(await speed.inputValue()), 0.5);
  await speed.press('End');
  assert.equal(Number(await speed.inputValue()), 2);
  return { min: 0.5, normal: 1, max: 2, keyboardStep: 0.05 };
});

await check('Response window units preserve canonical seconds through save and reload', async () => {
  await openSettings();
  await button('Reset to Defaults').click();
  await field('Response timing').selectOption('fixed');
  await field('Response window unit').selectOption('seconds');
  await field('Response window').fill('45');
  await field('Response window unit').selectOption('minutes');
  assert.equal(Number(await field('Response window').inputValue()), 0.75);
  await field('Response window unit').selectOption('seconds');
  assert.equal(Number(await field('Response window').inputValue()), 45);
  await field('Response window unit').selectOption('minutes');
  await field('Response window').fill('2');
  await saveAndReload();
  assert.equal(await field('Response window unit').inputValue(), 'minutes');
  assert.equal(Number(await field('Response window').inputValue()), 2);
  const draft = await currentDraft();
  assert.equal(draft.version, 2);
  assert.equal(draft.settings.behavior.responseSeconds, 120);
  assert.equal(draft.settings.behavior.responseUnit, 'minutes');
  const preview = await openPreview();
  assert.match(await preview.innerText(), /2 minutes per response/);
  await button('Close Student Preview').click();
  const before = await settingsStorage();
  for (const invalidMinutes of ['', '-1', '10.5']) {
    await field('Response window').fill(invalidMinutes);
    await button('Save Local Draft').click();
    assert.deepEqual(await settingsStorage(), before);
    assert(await page.locator('#avatar-settings-editor [role="alert"]').count() > 0);
  }
  return { convertedSeconds: 45, convertedMinutes: 0.75, persistedSeconds: 120, persistedUnit: 'minutes' };
});

await check('Local photos save, reload, scope, preview, remove, and reset', async () => {
  await openSettings();
  await button('Reset to Defaults').click();
  await uploadPhotos();
  assert.equal(await field('Default avatar').inputValue(), 'custom');
  assert.equal(await field('Default background').inputValue(), 'custom');
  await field('Allow students to choose avatar').check();
  await field('Allow students to choose background').check();
  await page.getByRole('group', { name: 'Allowed avatar options', exact: true }).getByLabel('Uploaded avatar photo', { exact: true }).check();
  await page.getByRole('group', { name: 'Allowed background options', exact: true }).getByLabel('Uploaded background photo', { exact: true }).check();
  await saveAndReload();
  const draft = await currentDraft();
  assert.equal(draft.version, 2);
  assert.match(draft.settings.presentation.customAvatar, /^data:image\/png;base64,/);
  assert.match(draft.settings.presentation.customBackground, /^data:image\/png;base64,/);
  const preview = await openPreview();
  const image = preview.getByAltText('Uploaded avatar photo', { exact: true });
  assert.equal(await image.getAttribute('src'), draft.settings.presentation.customAvatar);
  assert(await image.evaluate(async (element) => { await element.decode(); return element.complete && element.naturalWidth > 0; }));
  assert((await preview.locator('.avatar-stage').evaluate((element) => getComputedStyle(element).backgroundImage)).includes(draft.settings.presentation.customBackground));
  assert.equal(await preview.getByLabel('Avatar', { exact: true }).inputValue(), 'custom');
  assert.equal(await preview.getByLabel('Background', { exact: true }).inputValue(), 'custom');
  await button('Close Student Preview').click();
  await openSettings('b');
  assert.equal(await field('Default avatar').locator('option[value="custom"]').count(), 0);
  assert.equal(await field('Default background').locator('option[value="custom"]').count(), 0);
  instructor = 'synthetic-instructor-photo-isolation';
  try {
    await openSettings('a');
    assert.equal(await field('Default avatar').locator('option[value="custom"]').count(), 0);
  } finally {
    instructor = 'synthetic-instructor-a';
  }
  await openSettings('a');
  await button('Remove avatar photo').click();
  await button('Remove background photo').click();
  assert.equal(await field('Default avatar').locator('option[value="custom"]').count(), 0);
  assert.equal(await field('Default background').locator('option[value="custom"]').count(), 0);
  await saveAndReload();
  assert.equal((await currentDraft()).settings.presentation.customAvatar, null);
  assert.equal((await currentDraft()).settings.presentation.customBackground, null);
  await uploadPhotos();
  await button('Reset to Defaults').click();
  await saveAndReload();
  assert.equal((await currentDraft()).settings.presentation.customAvatar, null);
  assert.equal((await currentDraft()).settings.presentation.customBackground, null);
  assert.equal(await field('Default avatar').inputValue(), 'guide');
  assert.equal(await field('Default background').inputValue(), 'neutral');
  return { syntheticPngOnly: true, photosPersistedInBrowserDraft: true, separateExamsAndInstructors: true };
});

await check('Invalid, oversized, and undecodable local photos are rejected', async () => {
  await openSettings();
  const before = await settingsStorage();
  const payloads = [
    { file: { name: 'synthetic-unsupported.svg', mimeType: 'image/svg+xml', buffer: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>') }, expectedError: /Choose a PNG, JPEG, or WebP image/ },
    { file: { name: 'synthetic-too-large.png', mimeType: 'image/png', buffer: Buffer.alloc(1_048_577) }, expectedError: /no larger than 1 MB/ },
    { file: { name: 'synthetic-corrupt.png', mimeType: 'image/png', buffer: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]) }, expectedError: /not a readable image/ },
  ];
  for (const label of ['Upload own avatar photo', 'Upload own background photo']) {
    for (const payload of payloads) {
      await field(label).setInputFiles(payload.file);
      const error = field(label).locator('..').getByRole('alert');
      await error.filter({ hasText: payload.expectedError }).waitFor();
      assert.equal(await field('Default avatar').inputValue(), 'guide');
      assert.equal(await field('Default background').inputValue(), 'neutral');
      assert.deepEqual(await settingsStorage(), before);
      await field(label).setInputFiles([]);
    }
  }
  return { rejectedCasesPerUpload: ['unsupported MIME type', 'over 1 MiB', 'undecodable image'] };
});

await check('Legacy follow-up number input preserves integer limits', async () => {
  await page.goto(`${baseUrl}/professor/exams/synthetic-exam-a/settings/ai-questioning`);
  const limit = field('Maximum Follow-Ups Per Question');
  assert.equal(await limit.getAttribute('type'), 'number');
  assert.equal(await limit.getAttribute('min'), '1');
  assert.equal(await limit.getAttribute('max'), '4');
  await limit.fill('3');
  await button('Save Settings').click();
  const saved = await page.evaluate(() => localStorage.getItem('oralExamSettings-/professor/exams/synthetic-exam-a'));
  assert.equal(JSON.parse(saved).maxFollowUps, 3);
  for (const invalid of ['', '-1', '0', '1.5', '5']) {
    await limit.fill(invalid);
    await button('Save Settings').click();
    assert.equal(await page.evaluate(() => localStorage.getItem('oralExamSettings-/professor/exams/synthetic-exam-a')), saved);
    assert(await page.locator('#category-settings-error').isVisible());
  }
  await limit.fill('2');
  await button('Save Settings').click();
  return { acceptedInteger: 3, rejectedValues: ['', -1, 0, 1.5, 5] };
});

await check('Version-one local draft migrates without discarding instructor settings', async () => {
  await openSettings();
  const legacy = structuredClone((await currentDraft()).settings);
  legacy.presentation.speed = 1.15;
  legacy.presentation.voice = 'clear';
  delete legacy.presentation.customAvatar;
  delete legacy.presentation.customBackground;
  legacy.student.voice = true;
  legacy.student.voices = ['calm', 'clear'];
  legacy.behavior.responseSeconds = 90;
  delete legacy.behavior.responseUnit;
  legacy.behavior.difficulty = 'bounded';
  legacy.behavior.minDifficulty = 2;
  legacy.behavior.maxDifficulty = 4;
  legacy.assistance.repeat.limit = 3;
  const migrationInstructor = 'synthetic-instructor-migration';
  const key = `oral-exam-avatar:v1:${JSON.stringify(['synthetic-exam-b', migrationInstructor])}`;
  await page.evaluate(({ key, legacy }) => localStorage.setItem(key, JSON.stringify({ version: 1, settings: legacy })), { key, legacy });
  instructor = migrationInstructor;
  try {
    await openSettings('b');
    assert.equal(Number(await field('Default speaking speed').inputValue()), 1.15);
    assert.equal(await field('Default voice').inputValue(), 'clear');
    assert.equal(Number(await field('Exact question repeats limit per question').inputValue()), 3);
    assert.equal(await field('Response window unit').inputValue(), 'seconds');
    assert.equal(Number(await field('Response window').inputValue()), 90);
    assert.equal((await currentDraft('b', migrationInstructor)).version, 1, 'Loading should not rewrite existing draft');
    await button('Save Local Draft').click();
    const migrated = await currentDraft('b', migrationInstructor);
    assert.equal(migrated.version, 2);
    assert.equal(migrated.settings.presentation.speed, 1.15);
    assert.equal(migrated.settings.behavior.responseSeconds, 90);
    assert.equal('voice' in migrated.settings.student, false);
    assert.equal('difficulty' in migrated.settings.behavior, false);
  } finally {
    instructor = 'synthetic-instructor-a';
  }
  return { originalVersion: 1, savedVersion: 2, loadingDoesNotRewriteStorage: true };
});

await check('Collapsing and reopening settings retains unsaved edits', async () => {
  await openSettings();
  const before = await settingsStorage();
  await field('Default speaking speed').fill('1.1');
  await button('Avatar & Interaction Settings').click();
  assert.equal(await field('Default speaking speed').isVisible(), false);
  await button('Avatar & Interaction Settings').click();
  await field('Default speaking speed').waitFor();
  assert.equal(await field('Default speaking speed').inputValue(), '1.1');
  assert.match(await page.locator('#avatar-settings-editor').innerText(), /Unsaved changes/);
  assert.deepEqual(await settingsStorage(), before);
});

await check('Failed identity lookup disables local saving', async () => {
  const before = await settingsStorage();
  identityFailure = true;
  try {
    await openSettings();
    assert(await button('Save Local Draft').isDisabled());
    assert.match(await page.locator('#avatar-settings-editor [role="alert"]').first().innerText(), /identity is unavailable/i);
    await field('Default speaking speed').fill('1.1');
    assert(await button('Save Local Draft').isDisabled());
    assert.deepEqual(await settingsStorage(), before);
  } finally {
    identityFailure = false;
  }
});

await check('Delayed identity refresh hides the previous instructor controls', async () => {
  instructor = 'synthetic-instructor-a';
  await openSettings();
  await field('Default speaking speed').fill('1.2');
  await button('Avatar & Interaction Settings').click();
  instructor = 'synthetic-instructor-delayed';
  let releaseIdentity;
  identityGate = new Promise((resolve) => { releaseIdentity = resolve; });
  try {
    await button('Avatar & Interaction Settings').click();
    await page.getByText('Loading local draft context…', { exact: true }).waitFor();
    assert.equal(await field('Default speaking speed').isVisible(), false);
    assert.equal(await button('Save Local Draft').isVisible(), false);
  } finally {
    identityGate = null;
    releaseIdentity();
  }
  await field('Default speaking speed').waitFor();
  assert.equal(await field('Default speaking speed').inputValue(), '1');
  instructor = 'synthetic-instructor-a';
});

await check('Student preview reflects approved choices, limits, and exam behavior', async () => {
  await openSettings();
  await field('Allow students to choose avatar').check();
  await page.getByRole('group', { name: 'Allowed avatar options', exact: true }).getByLabel('Geometric avatar (preview)', { exact: true }).uncheck();
  await field('Default background').selectOption('library');
  await field('Allow students to choose background').check();
  await page.getByRole('group', { name: 'Allowed background options', exact: true }).getByLabel('Neutral background (preview)', { exact: true }).uncheck();
  await field('Default voice').selectOption('clear');
  await field('Allow students to choose speaking speed').check();
  await field('Minimum speaking speed').fill('0.9');
  await field('Maximum speaking speed').fill('1.3');
  await field('Default speaking speed').fill('1.1');
  await field('Follow-up limit per question').fill('2');
  await field('Question ordering').selectOption('random');
  await field('Response timing').selectOption('fixed');
  await field('Response window').fill('45');
  const preview = await openPreview();
  assert.equal(await preview.getByLabel('Avatar', { exact: true }).locator('option').count(), 1);
  assert.equal(await preview.getByLabel('Background', { exact: true }).inputValue(), 'library');
  assert.equal(await preview.getByLabel('Background', { exact: true }).locator('option').count(), 1);
  assert.equal(await preview.getByLabel('Voice', { exact: true }).count(), 0);
  assert.match(await preview.locator('.avatar-stage').innerText(), /Clear voice \(preview\)/);
  const speed = preview.getByLabel(/^Speaking speed:/);
  assert.equal(await speed.getAttribute('min'), '0.9');
  assert.equal(await speed.getAttribute('max'), '1.3');
  assert.equal(await speed.inputValue(), '1.1');
  assert.match(await preview.innerText(), /Up to 2 follow-up/);
  assert.match(await preview.innerText(), /Question order: randomized/);
  assert.match(await preview.innerText(), /45 seconds per response/);
  await preview.getByLabel(/^Volume:/).fill('25');
  await preview.getByLabel('Text size', { exact: true }).selectOption('24');
  await preview.getByLabel('Reduce motion', { exact: true }).check();
  assert.equal(await preview.locator('.avatar-student-surface').evaluate((element) => getComputedStyle(element).fontSize), '24px');
  assert(await preview.locator('.avatar-student-surface').evaluate((element) => element.classList.contains('avatar-motion-reduced')));
  const file = path.join(outputDir, 'avatar-student-preview-desktop.png');
  await preview.screenshot({ path: file });
  await button('Close Student Preview').click();
  assert(await button('Preview as Student').evaluate((element) => element === document.activeElement));
  return { screenshot: file, optionCounts: { avatars: 1, backgrounds: 1 }, professorVoice: 'clear', speedRange: [0.9, 1.3], textSizePx: 24 };
});

await check('Synthetic assistance policies, counters, states, and focus', async () => {
  await openSettings();
  await field('Hints').check();
  await field('Hints availability').selectOption('practice');
  await field('Explanations').check();
  await field('Explanations availability').selectOption('assessed');
  await field('Correctness feedback').check();
  await field('Correctness feedback availability').selectOption('both');
  await field('Timer continues during repeats').uncheck();
  const preview = await openPreview();
  const heading = preview.getByRole('heading', { name: 'Preview as Student', exact: true });
  assert(await heading.evaluate((element) => element === document.activeElement));
  await page.keyboard.press('Tab');
  assert(await button('Close Student Preview').evaluate((element) => element === document.activeElement));
  assert.equal(await preview.getByLabel('Avatar', { exact: true }).count(), 0);
  assert.equal(await preview.getByLabel('Background', { exact: true }).count(), 0);
  assert.equal(await preview.getByLabel('Voice', { exact: true }).count(), 0);
  assert.equal(await preview.getByLabel(/^Speaking speed:/).count(), 0);
  assert(await preview.getByLabel(/^Volume:/).isEnabled());
  assert(await preview.getByLabel('Text size', { exact: true }).isEnabled());
  assert(await preview.getByLabel('Reduce motion', { exact: true }).isEnabled());
  assert(await preview.getByRole('button', { name: 'Request hint', exact: true }).isEnabled());
  assert(await preview.getByRole('button', { name: 'Request explanation', exact: true }).isDisabled());
  assert(await preview.getByRole('button', { name: 'Request correctness feedback', exact: true }).isEnabled());
  const repeat = preview.getByRole('button', { name: 'Repeat exact question', exact: true });
  const clarify = preview.getByRole('button', { name: 'Clarify question wording', exact: true });
  assert.match(await preview.locator('#avatar-assistance-repeat-policy').innerText(), /2 remaining of 2/);
  assert.match(await preview.locator('.avatar-assistance-item').first().innerText(), /Timer policy: pauses/);
  await repeat.click();
  assert.equal(await preview.locator('.avatar-response p').innerText(), 'What is one benefit of separating data from presentation?');
  await repeat.click();
  assert(await repeat.isDisabled());
  await clarify.click();
  assert(await clarify.isDisabled());
  await preview.getByLabel('Text size', { exact: true }).selectOption('20');
  await preview.getByLabel(/^Volume:/).fill('40');
  assert(await repeat.isDisabled());
  await preview.getByLabel('Instructor simulation mode', { exact: true }).selectOption('assessed');
  assert(await repeat.isDisabled());
  assert(await preview.getByRole('button', { name: 'Request hint', exact: true }).isDisabled());
  assert(await preview.getByRole('button', { name: 'Request explanation', exact: true }).isEnabled());
  assert(await preview.getByRole('button', { name: 'Request correctness feedback', exact: true }).isEnabled());
  await preview.getByRole('button', { name: 'Start new synthetic attempt', exact: true }).click();
  assert(await repeat.isEnabled());
  assert(await clarify.isEnabled());
  const observedStates = [];
  for (const state of ['Idle', 'Listening', 'Thinking', 'Speaking', 'Error']) {
    const control = preview.getByRole('button', { name: state, exact: true });
    await control.click();
    assert.equal(await control.getAttribute('aria-pressed'), 'true');
    assert.equal(await preview.locator('.avatar-state-badge').innerText(), `${state} · simulated`);
    observedStates.push(state);
  }
  assert.match(await preview.getByRole('alert').innerText(), /question and assistance remain available as readable text/);
  assert.equal(await preview.locator('.avatar-question').innerText(), 'What is one benefit of separating data from presentation?');
  await preview.getByRole('button', { name: 'Thinking', exact: true }).click();
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.waitForFunction(() => document.querySelector('#avatar-preview-reduced-motion')?.disabled === true);
  assert(await preview.getByLabel('Reduce motion', { exact: true }).isChecked());
  assert(await preview.getByLabel('Reduce motion', { exact: true }).isDisabled());
  assert.equal(await preview.locator('.avatar-figure').evaluate((element) => getComputedStyle(element).animationName), 'none');
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await button('Close Student Preview').click();
  assert(await button('Preview as Student').evaluate((element) => element === document.activeElement));
  return { observedStates, repeatLimit: 2, clarificationLimit: 1, exhaustedCountsPreservedAcrossModeAndPreferences: true };
});

await check('Existing question, material, and dashboard navigation', async () => {
  await openSettings();
  await page.getByRole('link', { name: /Back to Manage Exam/ }).click();
  await page.getByRole('link', { name: /View Question Bank/ }).click();
  await page.getByRole('heading', { name: 'Question Bank', exact: true }).waitFor();
  await page.getByRole('button', { name: /Back to Exam/ }).click();
  await page.getByRole('link', { name: /View Course Materials/ }).click();
  await page.getByRole('heading', { name: 'Course Materials', exact: true }).waitFor();
  await page.getByRole('button', { name: /Back to Exam/ }).click();
  await page.getByRole('link', { name: /Back to Dashboard/ }).click();
  await page.getByRole('heading', { name: 'My Exams', exact: true }).waitFor();
});

await check('Form labels and keyboard focus', async () => {
  await openSettings();
  const controls = page.locator('#avatar-settings-editor input, #avatar-settings-editor select');
  assert(await controls.count() > 0, 'Label audit must inspect controls');
  const unlabeled = await controls.evaluateAll((elements) => elements.filter((element) => !element.labels?.length && !element.getAttribute('aria-label') && !element.getAttribute('aria-labelledby')).map((element) => element.outerHTML));
  assert.deepEqual(unlabeled, [], 'Every settings control should have an accessible label');
  const save = button('Save Local Draft');
  await save.focus();
  assert(await save.evaluate((element) => element === document.activeElement));
  await page.keyboard.press('Tab');
  const active = await page.evaluate(() => ({ tag: document.activeElement?.tagName, text: document.activeElement?.textContent, outlineStyle: getComputedStyle(document.activeElement).outlineStyle }));
  assert.notEqual(active.tag, 'BODY');
  assert.notEqual(active.outlineStyle, 'none', 'Keyboard target should have visible focus outline');
  return { labelAuditControls: await controls.count(), active };
});

await check('390px narrow-screen layout', async () => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openSettings();
  const metrics = await page.evaluate(() => ({ width: window.innerWidth, scrollWidth: document.documentElement.scrollWidth }));
  assert(metrics.scrollWidth <= metrics.width, `Horizontal overflow: ${JSON.stringify(metrics)}`);
  const settingsScreenshot = await screenshot('avatar-settings-mobile.png');
  const preview = await openPreview();
  const previewMetrics = await page.evaluate(() => ({ width: window.innerWidth, scrollWidth: document.documentElement.scrollWidth }));
  assert(previewMetrics.scrollWidth <= previewMetrics.width, `Preview horizontal overflow: ${JSON.stringify(previewMetrics)}`);
  const previewScreenshot = path.join(outputDir, 'avatar-student-preview-mobile.png');
  await preview.screenshot({ path: previewScreenshot });
  return { ...metrics, previewMetrics, settingsScreenshot, previewScreenshot };
});

await check('No backend writes, unknown API fixtures, or runtime exceptions', async () => {
  assert.deepEqual(blockedMutations, []);
  assert.deepEqual(unknownApi, []);
  assert.deepEqual(pageErrors, []);
});

await page.setViewportSize({ width: 1365, height: 900 });
await openSettings();
await page.locator('.avatar-settings > .avatar-settings-header').scrollIntoViewIfNeeded();
await mkdir(outputDir, { recursive: true });
const report = {
  testStart,
  testEnd: new Date().toISOString(),
  baseUrl,
  syntheticDataOnly: true,
  apiIntercepted: true,
  results,
  summary: { passed: results.filter((result) => result.status === 'passed').length, failed: results.filter((result) => result.status === 'failed').length },
  blockedMutations,
  unknownApi,
  requests,
  consoleErrors,
  pageErrors,
  limitations: ['Browser prototype tests use synthetic identity and exam responses; they do not test server authorization or live execution.', 'Automated label and focus checks are not a full accessibility conformance audit.'],
};
const reportPath = path.join(outputDir, 'avatar-browser-test-results.json');
await writeFile(reportPath, JSON.stringify(report, null, 2));
console.log(JSON.stringify({ reportPath, summary: report.summary, keepOpen }));
process.exitCode = report.summary.failed ? 1 : 0;
if (keepOpen) {
  console.log('Browser remains open with intercepted synthetic fixtures. Press Ctrl+C in this runner to close it.');
  await new Promise((resolve) => { process.once('SIGINT', resolve); process.once('SIGTERM', resolve); });
}
await browser.close();
