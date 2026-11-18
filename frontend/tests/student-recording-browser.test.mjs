import {createHash} from 'node:crypto';
// Actual StudentExam recording orchestration; child presentation/speech widgets,
// network, recorder and streams are synthetic. No native device is acquired.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const require = createRequire(process.env.AVATAR_NODE_MODULES_PATH
  ? path.join(path.resolve(process.env.AVATAR_NODE_MODULES_PATH), 'package.json') : import.meta.url);
const { chromium } = require('playwright');
const realAutomatic=process.env.CYBROS_TEST_REAL_AUTOMATIC==='1';
const frontend = fileURLToPath(new URL('..', import.meta.url));
const bundle = await build({ stdin: { contents: `import React from 'react';import{createRoot}from'react-dom/client';import './src/index.css';
  import StudentExam from './src/pages/student/StudentExam';const root=createRoot(document.getElementById('root'));
  window.unmountHarness=()=>root.unmount();root.render(<StudentExam/>);`,
  resolveDir: frontend, loader: 'tsx' }, bundle: true, write: false, outdir: 'recording-browser-memory', jsx: 'automatic',
  define: { 'process.env.NODE_ENV': '"test"' }, logLevel: 'silent', plugins: [{ name: 'isolated-children', setup(builder) {
    if(realAutomatic) builder.onLoad({filter:/oralCapture\.ts$/},()=>({loader:'ts',contents:`
      export async function captureOralAnswer(stream,signal,onLevel){if(signal.aborted)throw new DOMException('Cancelled','AbortError');return new Blob(['Synthetic automatic answer'],{type:'audio/webm'});}` }));
    builder.onResolve({ filter: /\/(EnvironmentPreview|LiveExamPresentation|SpeechDraftPanel|AutomaticOralExam|liveVideo)$/ }, args =>
      realAutomatic && args.path.endsWith('/AutomaticOralExam') ? undefined : ({ path: args.path.split('/').at(-1), namespace: 'recording-fixture' }));
    builder.onLoad({ filter: /.*/, namespace: 'recording-fixture' }, args => ({ loader: 'tsx', resolveDir: frontend,
      contents: args.path === 'EnvironmentPreview' ? `import React from 'react';export default function Preview({onContinue}){
        return <button onClick={()=>onContinue({avatar:'guide',background:'neutral',volume:0,textSize:16,reducedMotion:true,speed:1})}>Continue fixture preview</button>;}`
        : args.path === 'AutomaticOralExam' ? `import{useEffect}from'react';export default function Automatic(props){
          useEffect(()=>{if(props.disabled||window.fixture.scenario!=='automatic-completion')return;
            const timer=setTimeout(()=>props.onAnswer('Synthetic automatic answer',{input_source:'automatic_transcript',
              transcript_draft_id:'50000000-0000-4000-8000-000000000001',machine_draft:'Synthetic automatic answer',transcript_receipt:'synthetic-receipt'}),100);
            return()=>clearTimeout(timer);},[props.disabled,props.sequence]);return null;}`
        : args.path === 'liveVideo'  ? `export function createLiveVideo(options){let stopped=false;
          options.onState('waiting','Synthetic live controller');return{stop(){if(!stopped){stopped=true;window.fixture.liveStops++;}}};}`
        : `export default function Fixture(){return null;}` }));
  } }] });
const script = bundle.outputFiles.find(file => file.path.endsWith('.js')).text;
const styles = bundle.outputFiles.find(file => file.path.endsWith('.css'))?.text ?? '';
const browser = await chromium.launch({ headless: true, args: ['--mute-audio'],
  executablePath: process.env.AVATAR_CHROME_PATH || (process.platform === 'win32' ? 'C:/Program Files/Google/Chrome/Application/chrome.exe' : undefined) });
const exam = '20000000-0000-4000-8000-000000000001', student = '10000000-0000-4000-8000-000000000001';
const sid = '30000000-0000-4000-8000-000000000001';
let passed = 0;
async function waitUntil(check) {
  const deadline = Date.now() + 4000;
  while (!check()) {
    assert.ok(Date.now() < deadline, 'Synthetic response did not settle');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}
try {
  const selected = process.env.CYBROS_RECORDING_SCENARIOS?.split(',');
  for (const scenario of (selected ?? (realAutomatic?['automatic-completion']:['upload-failure', 'upload-timeout', 'track-ended', 'recorder-error', 'unexpected-stop', 'normal-completion', 'final-upload-retry',
    'automatic-completion', 'early-end', 'early-end-retry', 'early-end-timeout', 'technical-restart', 'completed-restart-denied', 'leave-pending-capture', 'leave-pending-start', 'leave-pending-recording-start', 'recording-start-failure', 'recording-declined', 'permission-denied']))) {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const errors = [], unexpected = [], events = [], accepted = new Set();
    let endCalls = 0; let status = 'in_progress', answerCalls = 0, completeCalls = 0, failedOnce = false, startCalls = 0, recordingStartCalls = 0;
    let releaseStart;
    await context.addInitScript(({ exam, student, scenario }) => {
      // Local UI fixture flags do not exercise or alter a server identity gate.
      sessionStorage.setItem('oralexam_face_check_passed', 'true');
      sessionStorage.setItem('oralexam_student_id', student);
      sessionStorage.setItem(`oralexam_exam_token:${exam}:${student}`, 'synthetic-exam-token');
      if(['technical-restart','completed-restart-denied'].includes(scenario))sessionStorage.setItem(`oralexam_attempt:${exam}:${student}`,JSON.stringify({id:'old-synthetic-attempt',token:'synthetic-session-token'}));
      const fixture = window.fixture = { scenario, stoppedTracks: 0, liveStops: 0, fakeCaptureCalls: 0,
        nativeCaptureCalls: 0, displayCalls: 0, recordingStarts: 0 };
      class Track extends EventTarget {
        readyState = 'live';
        stop() { if (this.readyState !== 'ended') { fixture.stoppedTracks++; this.readyState = 'ended'; } }
        end() { this.readyState = 'ended'; this.dispatchEvent(new Event('ended')); }
      }
      const tracks = [new Track(), new Track()];
      class SyntheticStream { getTracks() { return tracks; } getAudioTracks() { return [tracks[1]]; } getVideoTracks() { return []; } }
      const stream = new SyntheticStream();
      Object.defineProperty(HTMLMediaElement.prototype, 'srcObject', { configurable: true,
        get() { return this.fixtureStream || null; }, set(value) { this.fixtureStream = value; } });
      Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: {
        getUserMedia: async () => { fixture.fakeCaptureCalls++;
          if (scenario === 'permission-denied') throw new DOMException('Synthetic denial', 'NotAllowedError');
          if (scenario === 'leave-pending-capture') return new Promise(resolve => { fixture.resolveCapture = () => resolve(stream); });
          return stream; },
        getDisplayMedia: () => { fixture.displayCalls++; throw Error('Display capture forbidden'); },
      } });
      class SyntheticRecorder extends EventTarget {
        static isTypeSupported(type) { return type.startsWith('video/webm'); }
        state = 'inactive';
        constructor() { super(); fixture.recorder = this; }
        start() { this.state = 'recording'; fixture.recordingStarts++; }
        chunk() { const event = new Event('dataavailable'); Object.defineProperty(event, 'data', {
          value: new Blob([new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 0x01])], { type: 'video/webm' }) }); this.dispatchEvent(event); }
        stop() { if (this.state === 'inactive') return; this.state = 'inactive';
          queueMicrotask(() => { this.chunk(); this.dispatchEvent(new Event('stop')); }); }
      }
      window.MediaRecorder = SyntheticRecorder;
      fixture.emitChunk = () => fixture.recorder.chunk();
      fixture.endTrack = () => tracks[0].end();
      fixture.recorderError = () => fixture.recorder.dispatchEvent(new Event('error'));
      fixture.stopRecorder = () => fixture.recorder.stop();
      if (['upload-timeout','early-end-timeout'].includes(scenario)) {
        const timeout = window.setTimeout.bind(window);
        window.setTimeout = (callback, ms, ...args) => timeout(callback, ms === 15000 ? 75 : ms, ...args);
      }
      if(scenario==='automatic-completion'){
        const nativeTimeout=window.setTimeout.bind(window);
        window.setTimeout=(fn,ms,...args)=>nativeTimeout(fn,ms===1000?5:ms,...args);
        HTMLMediaElement.prototype.play=function(){nativeTimeout(()=>this.dispatchEvent(new Event('ended')),30);return Promise.resolve();};
        HTMLMediaElement.prototype.pause=function(){};
      }
      if (window.speechSynthesis) window.speechSynthesis.speak = () => { throw Error('Speech output forbidden'); };
    }, { exam, student, scenario });
    const page = await context.newPage(); page.setDefaultTimeout(6000);
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/*', async route => {
      const request = route.request(), url = new URL(request.url());
      const json = (body, code = 200) => route.fulfill({ status: code, contentType: 'application/json', body: JSON.stringify(body) });
      if (url.origin !== 'http://127.0.0.1:52396') { unexpected.push(url.origin); return route.abort(); }
      if (url.pathname === '/bundle.css') return route.fulfill({contentType:'text/css',body:styles});
      if (url.pathname === '/bundle.js') return route.fulfill({ contentType: 'application/javascript', body: script });
      if (!url.pathname.startsWith('/api/')) return route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><link rel="stylesheet" href="/bundle.css"><div id="root"></div><script src="/bundle.js"></script></body></html>' });
      if (url.pathname.endsWith('/video-recording/preflight')) return json({ ready: true, recording_required: true, retention_until: '2099-01-01T00:00:00Z' });
      if (url.pathname === '/api/avatar/status') return json({enabled:false,ready:false});
      if (url.pathname === '/api/exam/start') {
        startCalls++;
        const respond = () => json({ session_id: sid, session_token: 'synthetic-session-token', status,
          sequence_num: 1, question: 'Synthetic approved question', developer_demo: false,
          record_examination: true, generate_transcript: true, recording_consent_status: 'pending',
          server_now: new Date().toISOString(), deadline: null, question_deadline: null, pause_until: null });
        if (scenario === 'leave-pending-start') { releaseStart = respond; return; }
        return respond();
      }
      assert.equal(request.headers()['authorization'], 'Bearer synthetic-session-token');
      if(url.pathname==='/api/exam/sessions/old-synthetic-attempt')return json({status:'flagged',technical_restart_allowed:scenario==='technical-restart'});
      if (url.pathname.endsWith('/recording-consent')) return json({
        recording_consent_status: request.postDataJSON().consent ? 'consented' : 'declined',
        recording_enabled: request.postDataJSON().consent, decided_at: new Date().toISOString(),
        server_now: new Date().toISOString(), deadline: null, question_deadline: null });
      if (url.pathname.endsWith('/video-recording/failure')) return json({ status: request.postDataJSON().status });
      if(realAutomatic && url.pathname.endsWith('/presentation'))return json({detail:'Synthetic optional settings unavailable'},503);
      if(realAutomatic && url.pathname.endsWith('/speech/capabilities'))return json({synthesis:{available:true},transcription:{available:true,accepted_mime_types:['audio/webm']}});
      const bytes=Buffer.from('synthetic-wave');
      const asset={asset_id:'50000000-0000-4000-8000-000000000001',interaction_id:'40000000-0000-4000-8000-000000000001',
        audio_url:`/api/exam/sessions/${sid}/question-audio/50000000-0000-4000-8000-000000000001`,status:'ready',duration_seconds:1,
        byte_count:bytes.length,content_sha256:createHash('sha256').update(bytes).digest('hex'),media_type:'audio/wav'};
      if(realAutomatic && url.pathname.endsWith('/question-audio'))return json(asset);
      if(realAutomatic && url.pathname.includes('/question-audio/'))return route.fulfill({contentType:'audio/wav',body:bytes});
      if(realAutomatic && url.pathname.endsWith('/speech/transcribe'))return json({request_id:url.searchParams.get('request_id'),
        transcript_draft_id:url.searchParams.get('request_id'),transcript_receipt:'synthetic-receipt',interaction_id:asset.interaction_id,
        question_revision:asset.interaction_id,sequence_num:1,text:'Synthetic automatic answer',source:'machine_draft',status:'review_required'});
      if(realAutomatic && url.pathname.endsWith('/speech/assess'))return json({request_id:request.postDataJSON().request_id,sequence_num:1,decision:'clear'});
      if (url.pathname.endsWith('/video-recording/start')) {
        recordingStartCalls++;
        if (scenario === 'leave-pending-recording-start') { releaseStart = () => json({ status: 'recording' }); return; }
        if (scenario === 'recording-start-failure') return json({ detail: 'Synthetic unavailable storage' }, 507);
        return json({ status: 'recording' });
      }
      if (url.pathname.endsWith('/media-timeline/events')) {
        const event = request.postDataJSON(); events.push(event);
        if (['recording_interrupted', 'recording_ended'].includes(event.kind) && status === 'in_progress') status = 'flagged';
        return json({ event, duplicate: false });
      }
      if (url.pathname.endsWith('/video-recording/chunks')) {
        const index = Number(request.postDataBuffer().toString().match(/name="index"\r\n\r\n(\d+)/)?.[1]);
        assert.ok(Number.isInteger(index));
        if (!failedOnce && ((scenario.startsWith('upload-') && index === 0) || (scenario === 'final-upload-retry' && index === 1))) {
          failedOnce = true;
          if (scenario === 'upload-timeout') return; // AbortController, not a backend response, must end this request.
          return json({ detail: 'Synthetic storage failure' }, 503);
        }
        assert.ok(index === accepted.size || accepted.has(index), 'Chunks retain their original ordered identities');
        accepted.add(index); return json({ accepted: true, index });
      }
      if(url.pathname.endsWith('/end')){endCalls++;status='pending_grading';if(scenario==='early-end-timeout'&&endCalls===1)return;if(scenario==='early-end-retry'&&endCalls===1)return json({detail:'Synthetic lost end response'},503);return json({done:true,status});}
      if (url.pathname === '/api/exam/answer') { if(scenario==='automatic-completion'){assert.equal(request.postDataJSON().input_source,'automatic_transcript');assert.equal(request.postDataJSON().answer_transcript,'Synthetic automatic answer');} answerCalls++; assert.equal(status, 'in_progress'); status = 'pending_grading'; return json({ done: true }); }
      if (url.pathname.endsWith('/video-recording/complete')) {
        completeCalls++; assert.notEqual(status, 'in_progress');
        assert.equal(request.postDataJSON().expected_chunk_count, accepted.size); return json({ status: 'completed' });
      }
      unexpected.push(`${request.method()} ${url.pathname}`); return json({ detail: 'Unexpected request' }, 500);
    });
    try {
      await page.goto(`http://127.0.0.1:52396/student/exam?templateId=${exam}&studentId=${student}`);
      await page.getByRole('button', { name: 'Continue fixture preview', exact: true }).click();
      await page.getByRole('button', { name: scenario === 'recording-declined' ? 'Decline recording and use typed answers' : 'I consent — start recording and exam', exact: true }).click();
      if(scenario==='completed-restart-denied'){await page.getByText('You have already completed this exam.',{exact:true}).waitFor();assert.equal(startCalls,0);assert.equal(recordingStartCalls,0);assert.deepEqual(unexpected,[]);assert.deepEqual(errors,[]);console.log('PASS completed-restart-denied: ordinary terminal attempt cannot reopen');passed++;continue;}
      if (scenario.startsWith('leave-pending-')) {
        if (scenario === 'leave-pending-capture') {
          await page.waitForFunction(() => window.fixture.fakeCaptureCalls === 1);
          await page.evaluate(() => { window.unmountHarness(); window.fixture.resolveCapture(); });
        } else if (scenario.startsWith('leave-pending-')) {
          await waitUntil(() => typeof releaseStart === 'function');
          await page.evaluate(() => window.unmountHarness()); await releaseStart();
        } else await page.getByRole('heading', { name: 'Unable to start your exam', exact: true }).waitFor();
        await page.waitForFunction(() => window.fixture.stoppedTracks === 2);
        if (scenario !== 'leave-pending-capture') {
          await waitUntil(() => status === 'flagged');
          assert.equal(startCalls, 1);
          assert.ok(await page.evaluate(({ exam, student }) => !!sessionStorage.getItem(`oralexam_attempt:${exam}:${student}`), { exam, student }));
        } else { await waitUntil(() => status === 'flagged'); assert.equal(startCalls, 1); assert.equal(recordingStartCalls, 0); }
        const resource = await page.evaluate(() => ({ starts: window.fixture.recordingStarts, live: window.fixture.liveStops }));
        assert.equal(resource.starts, 0); assert.equal(resource.live, 0);
        assert.equal(answerCalls, 0); assert.equal(completeCalls, 0);
        assert.deepEqual(unexpected, []); assert.deepEqual(errors, []);
        console.log(`PASS ${scenario}: late startup cannot acquire ongoing resources or lose a created attempt receipt`); passed++;
        continue;
      }
      if (['recording-declined', 'permission-denied', 'recording-start-failure'].includes(scenario)) {
        await page.getByLabel('Your answer', { exact: true }).fill('Synthetic typed answer without recording');
        await page.getByRole('button', { name: /Submit answer/ }).click();
        await page.getByText('No complete recording was saved for this attempt.', { exact: false }).waitFor();
        assert.equal(answerCalls, 1); assert.equal(completeCalls, 0); assert.equal(status, 'pending_grading');
        assert.equal(events.length, 0, 'No recording timeline is invented for a typed-only attempt');
        assert.equal(await page.evaluate(() => window.fixture.fakeCaptureCalls), scenario === 'recording-declined' ? 0 : 1);
        assert.equal(await page.evaluate(() => window.fixture.recordingStarts), 0);
        assert.deepEqual(unexpected, []); assert.deepEqual(errors, []);
        console.log(`PASS ${scenario}: typed answers submit without media, with no false recording completion`); passed++; continue;
      }
      if(scenario==='automatic-completion'){
        await page.waitForFunction(()=>!!window.fixture.recorder);
        await page.evaluate(()=>window.fixture.emitChunk());
        await page.getByText('The exam recording has also been saved.',{exact:false}).waitFor();
        assert.equal(answerCalls,1);assert.equal(completeCalls,1);assert.equal(status,'pending_grading');
        assert.deepEqual(unexpected,[]);assert.deepEqual(errors,[]);
        if(realAutomatic) assert.deepEqual(events.filter(event=>event.kind.startsWith('question_audio')).map(event=>event.kind),['question_audio_started','question_audio_ended']);
        console.log('PASS automatic-completion: controller answer submits once and finalizes recording without typing or submit click');passed++;continue;
      }
      await page.getByText('Accessibility and recovery',{exact:true}).click();
      await page.getByRole('button',{name:'Use keyboard controls',exact:true}).click();
      const answer = page.getByLabel('Your answer', { exact: true });
      await answer.fill('Synthetic answer retained across failure');
      const submit = page.getByRole('button', { name: 'Submit answer →', exact: true });
      if(scenario.startsWith('early-end')){
        await page.evaluate(()=>window.fixture.emitChunk());await waitUntil(()=>accepted.size===1);
        const end=page.getByRole('button',{name:'End exam',exact:true});await end.click();
        const dialog=page.getByRole('dialog',{name:'End this exam?'});await dialog.waitFor();
        const box=await dialog.boundingBox();assert.ok(box.x>=0&&box.x+box.width<=390);
        if(scenario==='early-end')await page.screenshot({path:path.join(process.env.TEMP || process.env.TMP || frontend,'cybros-merge-end-exam-dialog.png'),fullPage:true});
        await page.getByRole('button',{name:'Continue exam',exact:true}).click();
        assert.equal(endCalls,0);assert.equal(answerCalls,0);assert.equal(await answer.inputValue(),'Synthetic answer retained across failure');
        await end.click();await page.getByRole('button',{name:'End exam and save',exact:true}).click();
        if(['early-end-retry','early-end-timeout'].includes(scenario))await page.getByRole('button',{name:'Retry ending exam',exact:true}).click();
        await page.getByText('The exam recording has also been saved.',{exact:false}).waitFor();
        assert.equal(answerCalls,0);assert.equal(completeCalls,1);assert.equal(accepted.size,2);
        assert.equal(endCalls,['early-end-retry','early-end-timeout'].includes(scenario)?2:1);assert.equal(status,'pending_grading');
        assert.deepEqual(unexpected,[]);assert.deepEqual(errors,[]);
        console.log(`PASS ${scenario}: confirmation/cancel, no unfinished answer submission, idempotent end retry and recording finalization`);passed++;continue;
      }
      if (['normal-completion', 'final-upload-retry','technical-restart'].includes(scenario)) {
        await page.evaluate(() => window.fixture.emitChunk());
        await page.waitForFunction(() => window.fixture.recorder.state === 'recording');
        await waitUntil(() => accepted.size === 1);
        await submit.click();
        if (scenario === 'final-upload-retry') {
          await page.getByRole('button', { name: 'Retry saving the completed recording', exact: true }).click();
        }
        await page.getByText('The exam recording has also been saved.', { exact: false }).waitFor();
        assert.equal(status, 'pending_grading'); assert.equal(answerCalls, 1);
        if(scenario==='technical-restart')assert.equal(startCalls,1);
        assert.equal(events.filter(event => event.kind === 'recording_interrupted').length, 0);
        assert.equal(accepted.size, 2); assert.equal(completeCalls, 1);
      } else {
        if (scenario.startsWith('upload-')) await page.evaluate(() => window.fixture.emitChunk());
        if (scenario === 'track-ended') await page.evaluate(() => window.fixture.endTrack());
        if (scenario === 'recorder-error') await page.evaluate(() => window.fixture.recorderError());
        if (scenario === 'unexpected-stop') await page.evaluate(() => window.fixture.stopRecorder());
        const save = page.getByRole('button', { name: 'Save interrupted recording', exact: true });
        await save.waitFor();
        await page.waitForFunction(() => window.fixture.recorder.state === 'inactive' && window.fixture.liveStops === 1);
        assert.equal(await submit.isDisabled(), true); assert.equal(await answer.isDisabled(), true);
        assert.equal(await answer.inputValue(), 'Synthetic answer retained across failure');
        await page.getByText('The assessed attempt cannot continue safely.', { exact: false }).waitFor();
        await waitUntil(() => accepted.size === (scenario.startsWith('upload-') ? 2 : 1));
        await save.click();
        await page.getByText('The available partial recording was saved for professor review.', { exact: false }).waitFor();
        assert.equal(status, 'flagged'); assert.equal(answerCalls, 0); assert.equal(completeCalls, 1);
        assert.equal(await submit.isDisabled(), true);
        assert.equal(events.filter(event => event.kind === 'recording_interrupted').length, 1);
        assert.equal(await page.getByText('Exam Complete', { exact: true }).count(), 0);
      }
      const resources = await page.evaluate(() => ({ live: window.fixture.liveStops,
        stopped: window.fixture.stoppedTracks, captures: window.fixture.fakeCaptureCalls,
        display: window.fixture.displayCalls, state: window.fixture.recorder.state }));
      assert.equal(resources.live, 1); assert.equal(resources.state, 'inactive');
      assert.equal(resources.stopped, scenario === 'track-ended' ? 1 : 2);
      assert.equal(resources.captures, 1); assert.equal(resources.display, 0);
      assert.deepEqual(unexpected, []); assert.deepEqual(errors, []);
      console.log(`PASS ${scenario}: retained bytes, correct termination, no resume, owned resources released`); passed++;
    } catch(error) { console.log('FAIL STATE',await page.locator('body').innerText(),{unexpected,errors,events});throw error; } finally { await context.close(); }
  }
  console.log(`${passed} synthetic StudentExam recording scenarios passed; native capture/provider/backend use: zero.`);
} finally { await browser.close(); }
