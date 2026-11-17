/** Actual local WebRTC over generated canvas ONLY; no devices/app/backend services.
 * Static assets and authentication/signaling APIs are intercepted in memory.
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const frontend = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(process.env.AVATAR_NODE_MODULES_PATH
  ? path.join(path.resolve(process.env.AVATAR_NODE_MODULES_PATH), 'package.json')
  : path.join(frontend, '../.cache/browser-tools/package.json'));
const { chromium } = require('playwright');
const executablePath = process.env.AVATAR_CHROME_PATH || (process.platform === 'win32'
  ? 'C:/Program Files/Google/Chrome/Application/chrome.exe' : undefined);
const output = process.env.LIVE_VIDEO_TEST_OUTPUT_DIR || path.join(frontend, '../.cache/browser-results/live-transport');
const origin = 'http://127.0.0.1:5173';
const sid = '20000000-0000-4000-8000-000000000001';
const studentToken = 'synthetic-live-student-token';
const professorCookie = 'synthetic-live-professor-cookie';
const report = { startedAt: new Date().toISOString(), node: process.version,
  evidence: 'Native Chromium RTCPeerConnection with generated canvas and mocked in-memory signaling/auth; no application backend or real media.', results: [] };

const bundle = await build({ stdin: { contents: `
  import React from 'react';
  import {createRoot} from 'react-dom/client';
  import {createLiveVideo} from './src/components/media/liveVideo';
  import ProfessorLiveVideo from './src/pages/professor/ProfessorLiveVideo';
  window.__deviceCalls=[]; window.__peers=[]; window.__studentStates=[];
  const deny=name=>{window.__deviceCalls.push(name);throw new Error('Real devices are forbidden in this canvas fixture.');};
  if(navigator.mediaDevices){
    navigator.mediaDevices.getUserMedia=()=>deny('getUserMedia');
    navigator.mediaDevices.getDisplayMedia=()=>deny('getDisplayMedia');
  }
  const NativePeer=window.RTCPeerConnection;
  window.RTCPeerConnection=class extends NativePeer {
    constructor(config){super(config);window.__peers.push(this);}
  };
  window.__cleanup=()=>{
    window.__controller?.stop();
    window.__ownedStream?.getTracks().forEach(track=>track.stop());
    if(window.__animation)cancelAnimationFrame(window.__animation);
  };
  if(location.pathname==='/__student__'){
    const canvas=document.createElement('canvas');canvas.width=320;canvas.height=180;document.body.append(canvas);
    const context=canvas.getContext('2d');
    context.fillStyle='#a00';context.fillRect(0,0,320,180);
    const stream=canvas.captureStream(0);
    window.__ownedStream=stream;window.__frozen=false;window.__drawCount=0;
    const track=stream.getVideoTracks()[0];
    let last=0;
    const draw=now=>{
      if(!window.__frozen&&now-last>75){
        last=now;window.__drawCount++;
        context.fillStyle='hsl('+((window.__drawCount*19)%360)+' 90% 45%)';context.fillRect(0,0,320,180);
        context.fillStyle='#fff';context.font='26px monospace';context.fillText('Synthetic '+window.__drawCount,20,95);
        track.requestFrame();
      }
      window.__animation=requestAnimationFrame(draw);
    };
    window.__animation=requestAnimationFrame(draw);
    window.__controller=createLiveVideo({sessionId:'${sid}',token:'${studentToken}',role:'student',stream,
      onState:(state,message)=>window.__studentStates.push({state,message})});
  }else createRoot(document.getElementById('root')).render(<ProfessorLiveVideo/>);
`, resolveDir: frontend, loader: 'tsx' }, bundle: true, write: false,
  jsx: 'automatic', format: 'iife', logLevel: 'silent', define: { 'process.env.NODE_ENV': '"development"' } });
const javascript = bundle.outputFiles[0].text;
const browser = await chromium.launch({ executablePath, headless: true, args: [
  '--mute-audio', '--autoplay-policy=no-user-gesture-required',
  '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding',
] });
report.browser = await browser.version();

async function makePair() {
  const state = { active: true, studentAuth: true, professorAuth: true, roomId: crypto.randomUUID(),
    epoch: 0, sequence: 0, peers: new Map(), signals: [], unexpected: [], pageErrors: [], signalCount: 0 };
  const context = await browser.newContext({ viewport: { width: 1000, height: 720 }, permissions: [] });
  await context.addCookies([{ name: 'oralexam_session', value: professorCookie, url: origin }]);
  await context.route('**/*', async route => {
    const request = route.request();
    const url = new URL(request.url());
    const respond = (json, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(json) });
    if (url.origin !== origin) { state.unexpected.push(url.origin); return route.abort('blockedbyclient'); }
    if (url.pathname === '/__canvas_fixture__/app.js') return route.fulfill({ contentType: 'application/javascript', body: javascript });
    if (request.isNavigationRequest()) return route.fulfill({ contentType: 'text/html', body:
      '<!doctype html><meta charset="utf-8"><div id="root"></div><script src="/__canvas_fixture__/app.js"></script>' });
    if (url.pathname !== `/api/exam/sessions/${sid}/live-video`) {
      state.unexpected.push(url.pathname); return route.abort('blockedbyclient');
    }
    const authorization = request.headers().authorization;
    const role = authorization ? 'student' : 'professor';
    if ((role === 'student' && (authorization !== `Bearer ${studentToken}` || !state.studentAuth))
        || (role === 'professor' && (!state.professorAuth || !request.headers().cookie?.includes(`oralexam_session=${professorCookie}`)))) {
      return respond({ detail: 'Synthetic participant authorization expired.' }, 401);
    }
    if (!state.active) return respond({ detail: 'The synthetic assessed attempt ended.' }, 410);
    const now = Date.now();
    let expired = false;
    for (const [name, peer] of state.peers) if (now - peer.seen >= 15000) { state.peers.delete(name); expired = true; }
    if (expired) { state.epoch++; state.signals = []; }
    state.signals = state.signals.filter(message => now - message.created < 30000);
    if (request.method() === 'GET') {
      const peerId = url.searchParams.get('peer_id');
      const current = state.peers.get(role);
      if (current && current.id !== peerId) return respond({ detail: 'Synthetic role already has a tab.' }, 409);
      if (!current) { state.epoch++; state.signals = []; }
      state.peers.set(role, { id: peerId, seen: now });
      const other = role === 'student' ? 'professor' : 'student';
      const after = url.searchParams.get('room_id') === state.roomId ? Number(url.searchParams.get('after') || 0) : 0;
      return respond({ room_id: state.roomId, epoch: state.epoch, peer_present: state.peers.has(other), cursor: state.sequence,
        signals: state.signals.filter(message => message.role === other && message.sequence > after)
          .map(({ kind, payload, sequence }) => ({ kind, payload, sequence })) });
    }
    const body = request.postDataJSON();
    if (state.peers.get(role)?.id !== body.peer_id || state.epoch !== body.epoch || state.roomId !== body.room_id) return respond({ detail: 'Synthetic stale epoch.' }, 409);
    if (body.kind === 'leave') {
      state.peers.delete(role); state.epoch++; state.signals = [];
      return respond({ accepted: true });
    }
    if (state.signals.length >= 128 || state.peers.size !== 2) return respond({ detail: 'Synthetic signaling capacity unavailable.' }, 429);
    state.signalCount++;
    state.signals.push({ role, kind: body.kind, payload: body.payload, sequence: ++state.sequence, created: now });
    return respond({ accepted: true });
  });
  const student = await context.newPage();
  const professor = await context.newPage();
  student.on('pageerror', error => state.pageErrors.push(error.message));
  professor.on('pageerror', error => state.pageErrors.push(error.message));
  await student.goto(`${origin}/__student__`);
  await professor.goto(`${origin}/professor/exam-sessions/${sid}/live`);
  await professor.getByRole('button', { name: 'Start live viewing', exact: true }).click();
  await professor.waitForFunction(() => document.querySelector('[role="status"]')?.textContent === 'Live video connected.', undefined, { timeout: 20000 });
  await professor.waitForFunction(() => {
    const video = document.querySelector('video'); return video?.readyState >= 2 && video.videoWidth === 320 && video.srcObject;
  }, undefined, { timeout: 10000 });
  return { state, context, student, professor,
    async close() {
      await student.evaluate(() => window.__cleanup()).catch(() => undefined);
      await context.close();
    } };
}

async function probe(page) {
  return page.evaluate(async () => {
    const video = document.querySelector('video');
    const peer = window.__peers.at(-1);
    const stats = await peer.getStats();
    let frames = 0, bytes = 0;
    stats.forEach(report => { if (report.type === 'inbound-rtp' && report.kind === 'video') {
      frames = report.framesDecoded || 0; bytes = report.bytesReceived || 0;
    } });
    const sample = document.createElement('canvas'); sample.width = 16; sample.height = 16;
    const context = sample.getContext('2d'); context.drawImage(video, 0, 0, 16, 16);
    return { frames, bytes, pixel: [...context.getImageData(0, 0, 1, 1).data],
      width: video.videoWidth, height: video.videoHeight, visible: getComputedStyle(video).visibility,
      muted: video.muted, connectionState: peer.connectionState, iceServers: peer.getConfiguration().iceServers };
  });
}

async function assertClosed(pair) {
  await pair.professor.waitForFunction(() => window.__peers.every(peer => peer.connectionState === 'closed'), undefined, { timeout: 20000 });
  assert.equal(await pair.professor.locator('video').evaluate(video => getComputedStyle(video).visibility), 'hidden');
  assert.equal(await pair.professor.locator('video').evaluate(video => video.srcObject === null), true);
  assert.deepEqual(await pair.student.evaluate(() => window.__deviceCalls), []);
  assert.deepEqual(await pair.professor.evaluate(() => window.__deviceCalls), []);
  assert.deepEqual(pair.state.unexpected, []);
  assert.deepEqual(pair.state.pageErrors, []);
}

async function check(name, operation) {
  const started = Date.now();
  let pair;
  try {
    pair = await makePair();
    const evidence = await operation(pair);
    report.results.push({ name, status: 'passed', durationMs: Date.now() - started, signalCount: pair.state.signalCount, evidence });
    console.log(`PASS ${name}`);
  } catch (error) {
    report.results.push({ name, status: 'failed', durationMs: Date.now() - started, error: error.stack || String(error) });
    console.log(`FAIL ${name}: ${error.message}`);
  } finally { await pair?.close(); }
}

try {
  await check('native changing remote frames and frozen-frame fail-closed presentation', async pair => {
    const first = await probe(pair.professor);
    assert.ok(first.frames > 0 && first.bytes > 0);
    assert.equal(first.width, 320); assert.equal(first.height, 180);
    assert.equal(first.visible, 'visible'); assert.equal(first.muted, true);
    assert.equal(first.connectionState, 'connected'); assert.deepEqual(first.iceServers, []);
    await pair.professor.waitForTimeout(1200);
    const second = await probe(pair.professor);
    assert.ok(second.frames > first.frames); assert.notDeepEqual(second.pixel, first.pixel);
    await pair.student.evaluate(() => { window.__frozen = true; });
    await pair.professor.waitForFunction(() => document.querySelector('[role="status"]')?.textContent?.includes('No fresh video frames'), undefined, { timeout: 12000 });
    assert.equal(await pair.professor.locator('video').evaluate(video => getComputedStyle(video).visibility), 'hidden');
    await pair.professor.waitForFunction(() => document.querySelector('[role="status"]')?.textContent?.includes('Fresh video could not be verified'), undefined, { timeout: 10000 });
    await assertClosed(pair);
    assert.equal(await pair.student.evaluate(() => window.__ownedStream.getVideoTracks()[0].readyState), 'live');
    return { first, second, generatedCanvasOnly: true, stoppedTracksOwnedByFixture: true };
  });
  await check('native transport disconnect closes the professor view without stopping the owned stream', async pair => {
    await pair.student.evaluate(() => window.__peers.at(-1).close());
    await assertClosed(pair);
    assert.equal(await pair.student.evaluate(() => window.__ownedStream.getVideoTracks()[0].readyState), 'live');
    return { professorPeerClosed: true, sourceTrackStillLive: true };
  });
  await check('expired mocked professor authorization closes native peer and clears video', async pair => {
    pair.state.professorAuth = false;
    await pair.professor.waitForFunction(() => document.querySelector('[role="status"]')?.textContent?.includes('authorization expired'), undefined, { timeout: 8000 });
    await assertClosed(pair);
    return { authorizationMocked: true, nativeProfessorPeerClosed: true };
  });
  await check('ended mocked attempt closes both native peers', async pair => {
    pair.state.active = false;
    await pair.professor.waitForFunction(() => document.querySelector('[role="status"]')?.textContent?.includes('assessed attempt ended'), undefined, { timeout: 8000 });
    await assertClosed(pair);
    await pair.student.waitForFunction(() => window.__peers.every(peer => peer.connectionState === 'closed'), undefined, { timeout: 8000 });
    return { attemptStateMocked: true, bothNativePeersClosed: true };
  });
} finally {
  report.finishedAt = new Date().toISOString();
  await mkdir(output, { recursive: true });
  await writeFile(path.join(output, 'results.json'), JSON.stringify(report, null, 2));
  await browser.close();
}
console.log(`${report.results.filter(result => result.status === 'passed').length}/${report.results.length} native canvas WebRTC checks passed; ${report.browser}`);
if (report.results.some(result => result.status === 'failed')) process.exitCode = 1;
