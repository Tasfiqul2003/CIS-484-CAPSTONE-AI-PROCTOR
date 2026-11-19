import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const require = createRequire(process.env.AVATAR_NODE_MODULES_PATH
  ? path.join(path.resolve(process.env.AVATAR_NODE_MODULES_PATH), 'package.json') : import.meta.url);
const { chromium } = require('playwright');
const baseUrl = process.env.ROSTER_PREVIEW_TEST_URL || 'http://localhost:5173';
const output = path.resolve(process.env.ROSTER_PREVIEW_OUTPUT_DIR || 'tests/results/roster-photo-preview');
const EXAM = '20000000-0000-4000-8000-000000000001';
const PHOTO = '30000000-0000-4000-8000-000000000001';
const MISSING = '30000000-0000-4000-8000-000000000002';
const BROKEN = '30000000-0000-4000-8000-000000000003';
const exam = { id: EXAM, title: 'Synthetic roster exam', course: 'SYNTH 101', status: 'draft' };
let roster = [
  { student_id: PHOTO, name: 'Synthetic Photo Student', email: 'photo@example.invalid', eid: 'synthetic-photo', has_photo: true },
  { student_id: MISSING, name: 'Synthetic CSV Student', email: 'csv@example.invalid', eid: 'synthetic-csv', has_photo: false },
  { student_id: BROKEN, name: 'Synthetic Unavailable Student', email: 'unavailable@example.invalid', eid: 'synthetic-unavailable', has_photo: true },
];
const browser = await chromium.launch({ headless: true, executablePath: process.env.AVATAR_CHROME_PATH
  || (process.platform === 'win32' ? 'C:/Program Files/Google/Chrome/Application/chrome.exe' : undefined) });
const context = await browser.newContext({ viewport: { width: 1365, height: 950 } });
const page = await context.newPage();
const errors = [], unexpected = [], photoRequests = [];
page.on('pageerror', error => errors.push(error.message));
// A generated geometric portrait stands in for a photo; no real student/media is used.
const jpeg = Buffer.from(await page.evaluate(() => {
  const canvas = document.createElement('canvas'); canvas.width = 96; canvas.height = 128;
  const ctx = canvas.getContext('2d'); ctx.fillStyle = '#e8e2f4'; ctx.fillRect(0, 0, 96, 128);
  ctx.fillStyle = '#5b3a91'; ctx.beginPath(); ctx.arc(48, 40, 20, 0, Math.PI * 2); ctx.fill();
  ctx.beginPath(); ctx.ellipse(48, 112, 36, 40, 0, 0, Math.PI * 2); ctx.fill();
  return canvas.toDataURL('image/jpeg').split(',')[1];
}), 'base64');

try {
  await mkdir(output, { recursive: true });
  await context.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.origin !== new URL(baseUrl).origin) { unexpected.push(url.origin); return route.abort(); }
    if (!url.pathname.startsWith('/api/')) return route.continue();
    const respond = (json, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(json) });
    const p = url.pathname;
    if (p === '/api/developer/capabilities') return respond({ enabled: false });
    if (p === '/api/auth/me') return respond({ role: 'professor', professor_id: 'synthetic-professor', username: 'Synthetic Professor' });
    if (p === '/api/auth/professor/exams') return respond([exam]);
    if (p === '/api/auth/professor/recording-notifications') return respond([]);
    // The roster now shares its page with the other upload editors.
    if (p === `/api/exam/templates/${EXAM}/materials` || p === `/api/exam/templates/${EXAM}/questions`) return respond([]);
    if (p === `/api/exam/templates/${EXAM}/question-drafts`) return respond({ drafts: [], topics: [], can_edit: false });
    if (p === `/api/exam/templates/${EXAM}/question-drafts/context`) return respond({ topic_coverage_required: [], rubric: { criteria: [] }, can_edit: false, context_hash: 'synthetic' });
    if (p === `/api/exam/templates/${EXAM}/roster`) {
      if (request.method() === 'POST') {
        roster = [{ ...roster[0], name: 'Synthetic Uploaded Student' }];
        return respond({ rows_processed: 1, students_added: 1, students_updated: 0, photos_imported: 1 });
      }
      return respond(roster);
    }
    if (p.startsWith(`/api/exam/templates/${EXAM}/roster/`) && p.endsWith('/photo')) {
      photoRequests.push(p);
      if (p.includes(PHOTO)) return route.fulfill({ contentType: 'image/jpeg', body: jpeg, headers: { 'Cache-Control': 'private, no-store' } });
      return respond({ detail: 'Photo unavailable.' }, 404);
    }
    unexpected.push(`${request.method()} ${p}`); return respond({ detail: 'Unexpected synthetic request' }, 500);
  });
  await page.goto(`${baseUrl}/professor/exams/${EXAM}/roster`);
  await page.getByRole('button', { name: 'Preview saved roster' }).waitFor();
  assert.equal(photoRequests.length, 0, 'Photos should load only when the preview opens');
  await page.getByRole('button', { name: 'Preview saved roster' }).click();
  const dialog = page.getByRole('dialog');
  const photo = dialog.getByRole('img', { name: 'Reference photo for Synthetic Photo Student' });
  await photo.waitFor();
  await page.waitForFunction(() => document.querySelector('.roster-photo-thumbnail')?.naturalWidth > 0);
  await dialog.getByText('No preview', { exact: true }).waitFor();
  assert.equal(await dialog.getByText('No photo', { exact: true }).count(), 1);
  assert.equal(await dialog.locator('tbody tr').count(), 3);
  assert.ok(!photoRequests.some(p => p.includes(MISSING)), 'CSV-only students must not request a photo');
  const box = await photo.boundingBox();
  assert.equal(box.width, 48); assert.equal(box.height, 64);
  await page.screenshot({ path: path.join(output, 'saved-roster-light.png'), fullPage: true });

  await dialog.getByRole('button', { name: 'Close Preview', exact: true }).click();
  await page.getByRole('switch', { name: 'Dark mode' }).click();
  await page.getByRole('button', { name: 'Preview saved roster' }).click();
  assert.equal(await page.locator('html').getAttribute('data-theme'), 'dark');
  const nameColor = await dialog.locator('.roster-student-name').first().evaluate(el => getComputedStyle(el).color);
  const textColor = await page.locator('html').evaluate(el => getComputedStyle(el).getPropertyValue('--oe-text').trim());
  assert.equal(nameColor, await page.evaluate(color => {
    const el = document.createElement('span'); el.style.color = color; document.body.append(el);
    const result = getComputedStyle(el).color; el.remove(); return result;
  }, textColor), 'Roster names should use the dark theme text color');
  await page.screenshot({ path: path.join(output, 'saved-roster-dark.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: path.join(output, 'saved-roster-mobile.png'), fullPage: true });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'Modal must not overflow the mobile page');

  await dialog.getByRole('button', { name: 'Close Preview', exact: true }).click();
  await page.setViewportSize({ width: 1365, height: 950 });
  // Intercepted POST exercises the UI's post-upload state; it does not validate a real ZIP.
  await page.locator('#roster input[type=file]').setInputFiles({ name: 'synthetic-roster.zip', mimeType: 'application/zip', buffer: Buffer.from('synthetic archive fixture') });
  await page.getByRole('button', { name: 'Upload Roster & Official Photos' }).click();
  await page.getByRole('button', { name: 'Review uploaded roster' }).click();
  await dialog.getByRole('cell', { name: 'Synthetic Uploaded Student', exact: true }).waitFor();
  assert.equal(await dialog.locator('tbody tr').count(), 1);
  assert.match(await dialog.locator('.roster-modal-subtitle').textContent(), /1 students/);
  await dialog.getByRole('img', { name: 'Reference photo for Synthetic Uploaded Student' }).waitFor();
  await page.waitForFunction(() => document.querySelector('.roster-photo-thumbnail')?.naturalWidth > 0);
  assert.deepEqual(errors, []); assert.deepEqual(unexpected, []);
  const result = { passed: true, checks: ['saved photo thumbnail', 'CSV-only placeholder', 'failed photo placeholder',
    'deferred image loading', '48 x 64 size', 'dark mode', 'mobile containment', 'uploaded ZIP review uses saved rows'],
    jsErrors: errors, unexpectedRequests: unexpected, data: 'Synthetic fixtures only; no live backend or private photo accessed.' };
  await writeFile(path.join(output, 'actual-results.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
} finally {
  await context.close(); await browser.close();
}
