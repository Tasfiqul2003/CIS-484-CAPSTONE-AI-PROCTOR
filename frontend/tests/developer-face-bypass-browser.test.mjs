// Synthetic UI only: bundle in memory, intercept every request, never acquire devices.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const require = createRequire(process.env.AVATAR_NODE_MODULES_PATH
  ? path.join(path.resolve(process.env.AVATAR_NODE_MODULES_PATH), 'package.json') : import.meta.url);
const { chromium } = require('playwright');
const frontend = fileURLToPath(new URL('..', import.meta.url));
const bundled = await build({ stdin: { contents: `import React from 'react';
  import {createRoot} from 'react-dom/client'; import './src/index.css';
  import FaceVerification from './src/pages/student/FaceVerification';
  const root=createRoot(document.getElementById('root')); window.unmountFace=()=>root.unmount();
  root.render(location.pathname==='/student/exams' ? <h1>Portal destination</h1> : <FaceVerification/>);`,
  resolveDir: frontend, loader: 'tsx' }, bundle: true, write: false, outdir: 'developer-bypass-memory',
  jsx: 'automatic', define: { 'process.env.NODE_ENV': '"test"' }, logLevel: 'silent' });
const js = bundled.outputFiles.find(file => file.path.endsWith('.js')).text;
const css = bundled.outputFiles.find(file => file.path.endsWith('.css'))?.text ?? '';
const eids = ['student.demo', 'student.demo2', 'student.demo3', 'student.demo4', 'student.demo53'];
const ids = eids.map((_, i) => `10000000-0000-4000-8000-00000000000${i + 1}`);
const endpoint = '/api/exam/student/developer-face-bypass';
const hintKey = 'oralexam_developer_face_bypass';
const browser = await chromium.launch({ headless: true, args: ['--mute-audio'],
  executablePath: process.env.AVATAR_CHROME_PATH || (process.platform === 'win32' ? 'C:/Program Files/Google/Chrome/Application/chrome.exe' : undefined) });
let passed = 0;

async function scenario(name, options, run) {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, reducedMotion: 'reduce' });
  const page = await context.newPage();
  page.setDefaultTimeout(6000);
  const errors = [], unexpected = [], calls = [];
  let pending = null;
  page.on('pageerror', error => errors.push(error.message));
  await context.addInitScript(({ initialEid, ids, oldAccess, capturePending }) => {
    if (location.pathname === '/student/face-verification') {
      sessionStorage.clear();
      sessionStorage.setItem('oralexam_student_id', ids[0]);
      sessionStorage.setItem('oralexam_student_eid', initialEid);
      sessionStorage.setItem('oralexam_student_name', 'Synthetic Student');
      if (oldAccess) {
        sessionStorage.setItem('oralexam_face_check_passed', 'true');
        sessionStorage.setItem('oralexam_exam_session_id', 'old-synthetic-session');
        sessionStorage.setItem('oralexam_exam_session_token', 'old-synthetic-token');
        sessionStorage.setItem('oralexam_developer_demo', 'true');
      }
    }
    window.deviceCalls = [];
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: {
      getUserMedia() {
        window.deviceCalls.push('getUserMedia');
        if (capturePending) return new Promise((_, reject) => { window.rejectSyntheticCapture = reject; });
        return Promise.reject(new DOMException('Synthetic permission denial; no device was accessed.', 'NotAllowedError'));
      },
    } });
  }, { initialEid: options.initialEid ?? eids[0], ids, oldAccess: !!options.oldAccess, capturePending: !!options.capturePending });
  const validResult = eid => ({ allowed: true, matched: false, developer_bypass: true,
    identity_check_completed: false, review_required: true,
    student: { id: ids[eids.indexOf(eid)], name: `Synthetic ${eid}`, eid },
    expires_at: new Date(Date.now() + 15 * 60 * 1000).toISOString() });
  await context.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.pathname === '/bundle.js') return route.fulfill({ contentType: 'application/javascript', body: js });
    if (url.pathname === '/bundle.css') return route.fulfill({ contentType: 'text/css', body: css });
    if (!url.pathname.startsWith('/api/')) return route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/bundle.css"></head><body><div id="root"></div><script src="/bundle.js"></script></body></html>' });
    calls.push({ method: request.method(), path: url.pathname, body: request.postData() });
    const json = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    if (url.pathname === endpoint && request.method() === 'GET') {
      return json(options.capability ?? { enabled: true, allowed_eids: eids, expires_in_seconds: 900 }, options.capabilityStatus ?? 200);
    }
    if (url.pathname === endpoint && request.method() === 'POST') {
      const body = request.postDataJSON();
      assert.deepEqual(Object.keys(body), ['eid']);
      assert.ok(eids.includes(body.eid));
      if (options.holdPost) { pending = { route, result: validResult(body.eid) }; return; }
      return json(options.result ? options.result(validResult(body.eid)) : validResult(body.eid), options.postStatus ?? 200);
    }
    unexpected.push(`${request.method()} ${url.pathname}`);
    return json({ detail: 'Unexpected synthetic API request' }, 500);
  });
  const read = key => page.evaluate(key => sessionStorage.getItem(key), key);
  const request = async (eid = eids[0]) => {
    await page.getByLabel('Bypass', { exact: true }).fill(eid);
    await page.getByRole('button', { name: 'Bypass photo check', exact: true }).click();
  };
  try {
    if (options.clock) await page.clock.install();
    await page.goto('http://127.0.0.1:52401/student/face-verification');
    await page.getByRole('heading', { name: 'Photo check', exact: true }).waitFor();
    await page.getByText('About this check', { exact: true }).click();
    await run({ page, calls, read, request, pending: () => pending });
    assert.deepEqual(unexpected, []);
    assert.deepEqual(errors, []);
    assert.ok(calls.every(call => call.path === endpoint && ['GET', 'POST'].includes(call.method)));
    if (!options.capturePending && !options.cameraDenial) assert.deepEqual(await page.evaluate(() => window.deviceCalls), []);
    console.log(`PASS ${name}`);
    passed++;
  } finally { await context.close(); }
}

try {
  await scenario('explicit developer label, exact authorized suggestions and narrow keyboard-accessible form', {}, async ({ page, read }) => {
    await page.getByRole('heading', { name: 'Developer mode', exact: true }).waitFor();
    assert.deepEqual(await page.locator('#developer-photo-bypass-eids option').evaluateAll(nodes => nodes.map(node => node.value)), eids);
    await page.getByLabel('Bypass', { exact: true }).focus();
    await page.keyboard.press('Tab');
    assert.equal(await page.getByRole('button', { name: 'Bypass photo check', exact: true }).evaluate(node => node === document.activeElement), true);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
    assert.equal(await read(hintKey), null);
  });

  for (const eid of eids) await scenario(`server-authorized ${eid} stays unverified, switches only synthetic identity and continues`, { oldAccess: true }, async ({ page, read, request, calls }) => {
    await request(eid);
    await page.getByText(`Developer photo bypass accepted for ${eid}.`, { exact: false }).waitFor();
    assert.equal(await page.getByText('Photo match found.', { exact: false }).count(), 0);
    assert.ok((await page.getByRole('status').innerText()).includes('Identity remains unverified and requires professor review.'));
    const hint = JSON.parse(await read(hintKey));
    assert.equal(hint.student_id, ids[eids.indexOf(eid)]);
    assert.equal(hint.eid, eid);
    assert.equal(await read('oralexam_student_id'), hint.student_id);
    assert.equal(await read('oralexam_student_eid'), eid);
    for (const key of ['oralexam_face_check_passed', 'oralexam_exam_session_id', 'oralexam_exam_session_token', 'oralexam_developer_demo']) assert.equal(await read(key), null);
    assert.equal(calls.filter(call => call.method === 'POST').length, 1);
    await page.getByRole('button', { name: 'Continue to Exam Portal', exact: false }).click();
    await page.getByRole('heading', { name: 'Portal destination' }).waitFor();
    assert.equal(new URL(page.url()).pathname, '/student/exams');
    assert.equal(await read('oralexam_face_check_passed'), null);
    assert.equal(JSON.parse(await read(hintKey)).eid, eid);
  });

  await scenario('ordinary EIDs cannot request the developer grant', { initialEid: 'ordinary.synthetic' }, async ({ page, calls, read }) => {
    await page.getByLabel('Bypass', { exact: true }).fill('ordinary.synthetic');
    assert.equal(await page.getByRole('button', { name: 'Bypass photo check', exact: true }).isDisabled(), true);
    await page.locator('form').evaluate(form => form.requestSubmit());
    assert.equal(calls.filter(call => call.method === 'POST').length, 0);
    assert.equal(await read(hintKey), null);
    assert.equal(await page.getByRole('button', { name: 'Start camera', exact: true }).isVisible(), true);
  });

  for (const [label, options] of [
    ['disabled', { capability: { enabled: false, allowed_eids: eids } }],
    ['failed', { capabilityStatus: 503 }],
    ['malformed', { capability: { enabled: true, allowed_eids: ['ordinary.synthetic'] } }],
  ]) await scenario(`${label} capability cannot enable a local bypass`, options, async ({ page, read, calls }) => {
    await page.waitForLoadState('networkidle');
    assert.equal(await page.getByLabel('Bypass', { exact: true }).count(), 0);
    assert.equal(await page.getByRole('button', { name: 'Start camera', exact: true }).isVisible(), true);
    assert.equal(await read(hintKey), null);
    assert.equal(calls.filter(call => call.method === 'POST').length, 0);
  });

  for (const [label, options] of [
    ['denied', { postStatus: 403, result: () => ({ detail: 'Synthetic account not authorized.' }) }],
    ['matched claim', { result: value => ({ ...value, matched: true }) }],
    ['verified claim', { result: value => ({ ...value, identity_check_completed: true }) }],
    ['missing review', { result: value => ({ ...value, review_required: false }) }],
    ['wrong account', { result: value => ({ ...value, student: { ...value.student, eid: eids[1] } }) }],
    ['invalid identity', { result: value => ({ ...value, student: { ...value.student, id: 'invalid' } }) }],
    ['expired', { result: value => ({ ...value, expires_at: new Date(Date.now() - 1000).toISOString() }) }],
  ]) await scenario(`${label} grant response never authorizes navigation`, options, async ({ page, read, request }) => {
    await request();
    await page.getByRole('alert').waitFor();
    assert.equal(await read(hintKey), null);
    assert.equal(await read('oralexam_face_check_passed'), null);
    assert.equal(await page.getByRole('button', { name: 'Continue to Exam Portal', exact: false }).count(), 0);
  });

  await scenario('pending grant blocks duplicate requests and camera startup; unmount cancels stale result', { holdPost: true }, async ({ page, calls, read, request, pending }) => {
    await request();
    await page.getByText('Requesting developer photo bypass…', { exact: true }).waitFor();
    assert.equal(await page.getByLabel('Bypass', { exact: true }).isDisabled(), true);
    assert.equal(await page.getByRole('button', { name: 'Start camera', exact: true }).isDisabled(), true);
    await page.locator('form').evaluate(form => { form.requestSubmit(); form.requestSubmit(); });
    assert.equal(calls.filter(call => call.method === 'POST').length, 1);
    assert.ok(pending());
    const failed = page.waitForEvent('requestfailed', request => request.method() === 'POST');
    await page.evaluate(() => window.unmountFace());
    await failed;
    await pending().route.fulfill({ contentType: 'application/json', body: JSON.stringify(pending().result) }).catch(() => {});
    assert.equal(await read(hintKey), null);
    assert.equal(await read('oralexam_face_check_passed'), null);
  });

  await scenario('grant timeout recovers without authorization', { holdPost: true, clock: true }, async ({ page, request, read }) => {
    await request();
    await page.getByText('Requesting developer photo bypass…', { exact: true }).waitFor();
    await page.clock.fastForward(11000);
    await page.getByRole('alert').filter({ hasText: 'timed out' }).waitFor();
    assert.equal(await page.getByRole('button', { name: 'Bypass photo check', exact: true }).isEnabled(), true);
    assert.equal(await read(hintKey), null);
  });

  await scenario('accepted grant expires without creating a photo match', { clock: true }, async ({ page, request, read }) => {
    await request();
    await page.getByRole('button', { name: 'Continue to Exam Portal', exact: false }).waitFor();
    await page.clock.fastForward(16 * 60 * 1000);
    await page.getByRole('alert').filter({ hasText: 'has expired' }).waitFor();
    assert.equal(await page.getByRole('button', { name: 'Continue to Exam Portal', exact: false }).count(), 0);
    assert.equal(await read('oralexam_face_check_passed'), null);
    assert.equal(await page.getByRole('button', { name: 'Bypass photo check', exact: true }).isEnabled(), true);
  });

  await scenario('editing an accepted synthetic selection clears the old navigation hint', {}, async ({ page, request, read }) => {
    await request();
    await page.getByRole('button', { name: 'Continue to Exam Portal', exact: false }).waitFor();
    await page.getByLabel('Bypass', { exact: true }).fill(eids[1]);
    assert.equal(await read(hintKey), null);
    assert.equal(await page.getByRole('button', { name: 'Continue to Exam Portal', exact: false }).count(), 0);
    assert.equal(await page.getByText('Developer photo bypass accepted for', { exact: false }).count(), 0);
    await request(eids[1]);
    await page.getByText(`Developer photo bypass accepted for ${eids[1]}.`, { exact: false }).waitFor();
    assert.equal(JSON.parse(await read(hintKey)).eid, eids[1]);
    assert.equal(await read('oralexam_face_check_passed'), null);
  });

  await scenario('active camera permission wait blocks bypass; synthetic denial preserves normal photo flow', { capturePending: true }, async ({ page, calls, read }) => {
    await page.getByLabel('Bypass', { exact: true }).waitFor();
    await page.getByRole('button', { name: 'Start camera', exact: true }).click();
    await page.getByText('Waiting for camera access…', { exact: true }).waitFor();
    assert.equal(await page.getByLabel('Bypass', { exact: true }).isDisabled(), true);
    assert.equal(await page.getByRole('button', { name: 'Bypass photo check', exact: true }).isDisabled(), true);
    await page.evaluate(() => window.rejectSyntheticCapture(new DOMException('Synthetic denial', 'NotAllowedError')));
    await page.getByRole('alert').filter({ hasText: 'Camera permission was denied' }).waitFor();
    assert.deepEqual(await page.evaluate(() => window.deviceCalls), ['getUserMedia']);
    assert.equal(await page.getByRole('button', { name: 'Try again', exact: true }).isEnabled(), true);
    assert.equal(calls.filter(call => call.method === 'POST').length, 0);
    assert.equal(await read(hintKey), null);
  });
  console.log(`Developer photo bypass browser scenarios: ${passed} passed; no real devices or services.`);
} finally { await browser.close(); }
