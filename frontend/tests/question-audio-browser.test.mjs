// Actual HTML audio playback of generated synthetic PCM. API and static traffic
// are intercepted in memory; real devices/providers and speaker output are blocked.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { build } from 'esbuild';

const require = createRequire(process.env.AVATAR_NODE_MODULES_PATH
  ? path.join(path.resolve(process.env.AVATAR_NODE_MODULES_PATH), 'package.json') : import.meta.url);
const { chromium } = require('playwright');
const frontend = fileURLToPath(new URL('..', import.meta.url));
const session = '30000000-0000-4000-8000-000000000001';
const assetId = sequence => `60000000-0000-4000-8000-${String(sequence).padStart(12, '0')}`;

function pcm(seconds) {
  const rate = 16000, count = Math.round(rate * seconds), dataSize = count * 2;
  const buffer = Buffer.alloc(44 + dataSize);
  buffer.write('RIFF', 0); buffer.writeUInt32LE(36 + dataSize, 4); buffer.write('WAVE', 8);
  buffer.write('fmt ', 12); buffer.writeUInt32LE(16, 16); buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22); buffer.writeUInt32LE(rate, 24); buffer.writeUInt32LE(rate * 2, 28);
  buffer.writeUInt16LE(2, 32); buffer.writeUInt16LE(16, 34); buffer.write('data', 36); buffer.writeUInt32LE(dataSize, 40);
  for (let i = 0; i < count; i++) buffer.writeInt16LE(Math.round(Math.sin(i / rate * 2 * Math.PI * 440) * 4000), 44 + i * 2);
  return buffer;
}
const shortAudio = pcm(.35), longAudio = pcm(2);
let mode = 'ordinary', calls = [], generationGate = null, bytesGate = null, capabilitiesGate = null;
let firstFailure = true, scenario = 0;
const results = [];
const bundle = await build({ stdin: { contents: `import React from 'react'; import {createRoot} from 'react-dom/client';
  import Player from './src/components/avatar/QuestionAudioPlayer';
  const root=createRoot(document.getElementById('root'));
  window.events=[]; window.observations=[];
  let props={sessionId:'${session}',token:'synthetic-session-token',sequence:1,disabled:false,speed:1,volume:70,
    onBusy:busy=>window.events.push({type:'busy',value:busy}), onState:state=>window.events.push({type:'state',value:state}),
    beforePlay:()=>window.events.push({type:'beforePlay'}),
    onObservation:async(kind,sequence,assetId)=>{window.observations.push({kind,sequence,assetId});
      if(window.deferObservationKind===kind)await new Promise((resolve,reject)=>{
        window.rejectOldObservation=()=>reject(new Error('Synthetic old observation failed'));});}};
  window.renderQuestion=next=>{props={...props,...next};root.render(<Player {...props}/>);};
  window.unmountQuestion=()=>root.unmount(); window.renderQuestion({});`,
  resolveDir: frontend, loader: 'tsx' }, bundle:true,write:false,outdir:'question-audio-browser-memory',jsx:'automatic',
  define:{'process.env.NODE_ENV':'"test"'},logLevel:'silent' });
const js = bundle.outputFiles.find(file=>file.path.endsWith('.js')).text;
const browser = await chromium.launch({headless:true,args:['--mute-audio','--autoplay-policy=no-user-gesture-required'],
  executablePath:process.env.AVATAR_CHROME_PATH || (process.platform==='win32'?'C:/Program Files/Google/Chrome/Application/chrome.exe':undefined)});
const context = await browser.newContext();
const page = await context.newPage(); page.setDefaultTimeout(5000);
const errors=[];page.on('pageerror',error=>errors.push(error.message));
await context.addInitScript(()=>{
  window.nativeAudioEvents=[];window.createdUrls=[];window.revokedUrls=[];window.blobHashes=[];window.captureCalls=[];
  for(const name of ['playing','ended','pause']) document.addEventListener(name,event=>{
    if(event.target instanceof HTMLAudioElement) window.nativeAudioEvents.push({type:name,trusted:event.isTrusted,time:event.target.currentTime});
  },true);
  const create=URL.createObjectURL.bind(URL),revoke=URL.revokeObjectURL.bind(URL);
  URL.createObjectURL=blob=>{const url=create(blob);window.createdUrls.push(url);
    void blob.arrayBuffer().then(bytes=>crypto.subtle.digest('SHA-256',bytes)).then(hash=>window.blobHashes.push(
      Array.from(new Uint8Array(hash)).map(value=>value.toString(16).padStart(2,'0')).join('')));return url;};
  URL.revokeObjectURL=url=>{window.revokedUrls.push(url);return revoke(url);};
  if(navigator.mediaDevices) navigator.mediaDevices.getUserMedia=()=>{window.captureCalls.push('getUserMedia');throw new Error('Real device access forbidden.');};
  if(window.speechSynthesis) window.speechSynthesis.speak=()=>{window.captureCalls.push('speechSynthesis');throw new Error('Browser speech forbidden.');};
});
await page.route('**/*',async route=>{
  const request=route.request(),url=new URL(request.url());
  const respond=(value,status=200)=>route.fulfill({status,contentType:'application/json',body:JSON.stringify(value)});
  if(url.pathname==='/bundle.js') return route.fulfill({contentType:'application/javascript',body:js});
  if(!url.pathname.startsWith('/api/')) return route.fulfill({contentType:'text/html',body:'<!doctype html><html><body><div id="root"></div><script src="/bundle.js"></script></body></html>'});
  const body=request.method()==='POST'?request.postDataJSON():null;
  calls.push({method:request.method(),path:url.pathname,authorization:request.headers().authorization,body});
  if(url.pathname.endsWith('/speech/capabilities')) {
    if(capabilitiesGate){const pending=capabilitiesGate;pending.arrive();await pending.pending;}
    return respond({synthesis:{available:mode!=='unavailable'}});
  }
  if(request.method()==='POST'&&url.pathname.endsWith('/question-audio')){
    const sequence=body.sequence_num;
    if(generationGate?.sequence===sequence){const gate=generationGate;gate.arrive();await gate.pending;}
    if(mode==='retry'&&firstFailure){firstFailure=false;return respond({detail:'Synthetic provider unavailable.'},503);}
    const bytes=mode==='long'?longAudio:shortAudio;
    const asset={asset_id:assetId(sequence),interaction_id:`40000000-0000-4000-8000-${String(sequence).padStart(12,'0')}`,
      audio_url:`/api/exam/sessions/${session}/question-audio/${assetId(sequence)}`,
      content_sha256:mode==='bad-hash'?'0'.repeat(64):createHash('sha256').update(bytes).digest('hex'),
      duration_seconds:mode==='long'?2:.35,status:'ready'};
    if(mode==='bad-metadata') asset.audio_url='https://unapproved.example/audio.wav';
    return respond(asset);
  }
  const match=url.pathname.match(/\/question-audio\/([^/]+)$/);
  if(request.method()==='GET'&&match){
    if(bytesGate){const gate=bytesGate;gate.arrive();await gate.pending;}
    return route.fulfill({contentType:'audio/wav',body:mode==='long'?longAudio:shortAudio});
  }
  throw new Error(`Unexpected audio test API ${request.method()} ${url.pathname}`);
});
function gate(sequence=1){let arrive,release;const arrived=new Promise(resolve=>arrive=resolve),pending=new Promise(resolve=>release=resolve);return{sequence,arrive,release,arrived,pending};}
async function reset(nextMode='ordinary'){
  generationGate?.release();bytesGate?.release();capabilitiesGate?.release();generationGate=null;bytesGate=null;capabilitiesGate=null;
  mode=nextMode;calls=[];firstFailure=true;
  if(nextMode==='delayed-capabilities') capabilitiesGate=gate();
  await page.goto(`http://127.0.0.1:52392/audio-fixture?case=${++scenario}`);
  await page.getByRole('region',{name:'Saved question audio',exact:true}).waitFor();
  if(nextMode!=='unavailable'&&nextMode!=='delayed-capabilities') await page.waitForFunction(()=>[...document.querySelectorAll('button')].some(button=>button.textContent==='Play saved question audio'&&!button.disabled));
}
const play=()=>page.getByRole('button',{name:/^(Play|Replay) saved question audio$/}).click();
const posts=()=>calls.filter(call=>call.method==='POST');
const gets=()=>calls.filter(call=>call.method==='GET'&&/\/question-audio\//.test(call.path));
async function ended(count=1){await page.waitForFunction(count=>window.observations.filter(item=>item.kind==='question_audio_ended').length===count,count);}
async function check(name,run){try{await run();results.push({name,passed:true});console.log(`PASS ${name}`);}catch(error){results.push({name,passed:false,error:String(error)});console.log(`FAIL ${name}: ${error.stack||error}`);}}
try{
  await check('Authenticated exact audio bytes produce trusted playing/ended observations and replay without synthesis',async()=>{
    await reset();await play();await ended();
    assert.equal(posts().length,1);assert.equal(gets().length,1);
    assert.ok(calls.every(call=>call.authorization==='Bearer synthetic-session-token'));
    assert.equal(posts()[0].body.sequence_num,1);assert.match(posts()[0].body.request_id,/^[0-9a-f-]{36}$/);
    const first=await page.evaluate(()=>({observations:window.observations,native:window.nativeAudioEvents,hashes:window.blobHashes,events:window.events}));
    assert.deepEqual(first.observations,[{kind:'question_audio_started',sequence:1,assetId:assetId(1)},{kind:'question_audio_ended',sequence:1,assetId:assetId(1)}]);
    assert.ok(first.native.some(event=>event.type==='playing'&&event.trusted));assert.ok(first.native.some(event=>event.type==='ended'&&event.trusted));
    assert.deepEqual(first.hashes,[createHash('sha256').update(shortAudio).digest('hex')]);
    assert.ok(first.events.some(event=>event.type==='state'&&event.value==='Speaking'));
    await play();await ended(2);assert.equal(posts().length,1);assert.equal(gets().length,1);
  });
  await check('Unavailable synthesis leaves readable status and cannot fabricate generation or playback',async()=>{
    await reset('unavailable');await page.getByText(/Saved question audio is unavailable/).waitFor();
    assert.equal(await page.getByRole('button',{name:'Play saved question audio',exact:true}).isDisabled(),true);
    assert.equal(posts().length,0);assert.deepEqual(await page.evaluate(()=>window.observations),[]);
  });
  await check('Malformed media metadata cannot fetch an external asset or play',async()=>{
    await reset('bad-metadata');await play();await page.getByRole('alert').filter({hasText:'response is invalid'}).waitFor();
    assert.equal(gets().length,0);assert.deepEqual(await page.evaluate(()=>window.nativeAudioEvents),[]);
  });
  await check('A byte/hash mismatch fails explicitly before creating a playable blob',async()=>{
    await reset('bad-hash');await play();await page.getByRole('alert').filter({hasText:'integrity check'}).waitFor();
    assert.equal(gets().length,1);assert.deepEqual(await page.evaluate(()=>window.createdUrls),[]);
    assert.deepEqual(await page.evaluate(()=>window.observations),[{kind:'question_audio_failed',sequence:1,assetId:assetId(1)}]);
  });
  await check('Retrying failed generation preserves its idempotency request identity',async()=>{
    await reset('retry');await play();await page.getByRole('alert').filter({hasText:'Synthetic provider unavailable'}).waitFor();
    await play();await ended();assert.equal(posts().length,2);assert.deepEqual(posts()[0].body,posts()[1].body);
  });
  await check('Stopping pending generation cancels it and a late result never starts playback',async()=>{
    await reset();generationGate=gate();await play();await generationGate.arrived;
    await page.getByRole('button',{name:'Stop saved audio',exact:true}).click();
    generationGate.release();await page.waitForTimeout(100);
    assert.deepEqual(await page.evaluate(()=>window.nativeAudioEvents),[]);assert.deepEqual(await page.evaluate(()=>window.observations),[]);
    assert.equal(await page.getByRole('button',{name:'Play saved question audio',exact:true}).isEnabled(),true);
  });
  await check('A question change cancels a pending old asset and only the new sequence can play',async()=>{
    await reset();generationGate=gate();await play();await generationGate.arrived;
    await page.evaluate(()=>window.renderQuestion({sequence:2}));generationGate.release();
    await page.waitForFunction(()=>[...document.querySelectorAll('button')].some(button=>button.textContent==='Play saved question audio'&&!button.disabled));
    generationGate=null;await play();await ended();
    assert.deepEqual(await page.evaluate(()=>window.observations),[{kind:'question_audio_started',sequence:2,assetId:assetId(2)},{kind:'question_audio_ended',sequence:2,assetId:assetId(2)}]);
  });
  await check('Stopping actual audio pauses it and records a failed observation for that same question',async()=>{
    await reset('long');await play();await page.waitForFunction(()=>window.observations.some(item=>item.kind==='question_audio_started'));
    await page.getByRole('button',{name:'Stop saved audio',exact:true}).click();
    assert.equal(await page.locator('audio').evaluate(audio=>audio.paused),true);
    assert.deepEqual(await page.evaluate(()=>window.observations),[{kind:'question_audio_started',sequence:1,assetId:assetId(1)},{kind:'question_audio_failed',sequence:1,assetId:assetId(1)}]);
  });
  await check('Old audio bytes arriving after a question change cannot create a playable blob',async()=>{
    await reset();bytesGate=gate();await play();await bytesGate.arrived;
    await page.evaluate(()=>window.renderQuestion({sequence:2}));bytesGate.release();bytesGate=null;
    await page.waitForFunction(()=>[...document.querySelectorAll('button')].some(button=>button.textContent==='Play saved question audio'&&!button.disabled));
    assert.deepEqual(await page.evaluate(()=>window.createdUrls),[]);
    assert.deepEqual(await page.evaluate(()=>window.observations),[]);
    await play();await ended();
    assert.ok((await page.evaluate(()=>window.observations)).every(event=>event.sequence===2&&event.assetId==='60000000-0000-4000-8000-000000000002'));
  });
  await check('A temporary disabled state during capability loading recovers without changing question',async()=>{
    await reset('delayed-capabilities');await capabilitiesGate.arrived;
    const idleBefore=await page.evaluate(()=>window.events.filter(event=>event.type==='state'&&event.value==='Idle').length);
    await page.evaluate(()=>window.renderQuestion({disabled:true}));
    await page.waitForFunction(count=>window.events.filter(event=>event.type==='state'&&event.value==='Idle').length>count,idleBefore);
    capabilitiesGate.release();capabilitiesGate=null;
    await page.evaluate(()=>window.renderQuestion({disabled:false}));
    await page.waitForFunction(()=>[...document.querySelectorAll('button')].some(button=>button.textContent==='Play saved question audio'&&!button.disabled),{},{timeout:5000});
    await play();await ended();
  });
  await check('Capability timeout becomes unavailable and a manual retry recovers without reloading the attempt',async()=>{
    await reset('delayed-capabilities');await capabilitiesGate.arrived;
    await page.getByRole('status').filter({hasText:/unavailable.*timed out/}).waitFor({timeout:8000});
    assert.equal(await page.getByRole('button',{name:'Play saved question audio',exact:true}).isDisabled(),true);
    capabilitiesGate.release();capabilitiesGate=null;
    await page.getByRole('button',{name:'Retry saved audio availability',exact:true}).click();
    await page.waitForFunction(()=>[...document.querySelectorAll('button')].some(button=>button.textContent==='Play saved question audio'&&!button.disabled));
    await play();await ended();
  });
  await check('A late failed observation from previous playback cannot replace the current playback status',async()=>{
    await reset();await page.evaluate(()=>window.deferObservationKind='question_audio_ended');
    await play();await ended();
    await page.evaluate(()=>window.deferObservationKind=null);
    await play();
    await page.waitForFunction(()=>window.observations.filter(item=>item.kind==='question_audio_started').length===2);
    await page.evaluate(()=>window.rejectOldObservation());
    await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
    assert.equal(await page.getByRole('alert').count(),0);
    await ended(2);
  });
  await check('Question-change cleanup attributes interruption to the old sequence and revokes its blob',async()=>{
    await reset('long');await play();await page.waitForFunction(()=>window.observations.some(item=>item.kind==='question_audio_started'));
    await page.evaluate(()=>window.renderQuestion({sequence:2}));
    await page.waitForFunction(()=>window.revokedUrls.length===1);
    const state=await page.evaluate(()=>({observations:window.observations,created:window.createdUrls,revoked:window.revokedUrls,src:document.querySelector('audio').getAttribute('src')}));
    assert.deepEqual(state.revoked,state.created);assert.equal(state.src,null);
    assert.deepEqual(state.observations,[{kind:'question_audio_started',sequence:1,assetId:assetId(1)},{kind:'question_audio_failed',sequence:1,assetId:assetId(1)}]);
  });
  await check('Unmount revokes a generated blob, releases busy state and makes no real capture calls',async()=>{
    await reset();await play();await ended();await page.evaluate(()=>window.unmountQuestion());
    assert.deepEqual(await page.evaluate(()=>window.revokedUrls),await page.evaluate(()=>window.createdUrls));
    assert.deepEqual(await page.evaluate(()=>window.captureCalls),[]);assert.deepEqual(errors,[]);
  });
}finally{generationGate?.release();bytesGate?.release();capabilitiesGate?.release();await browser.close();}
console.log(JSON.stringify({suite:'question-audio-browser',passed:results.filter(result=>result.passed).length,failed:results.filter(result=>!result.passed).length,mutedSyntheticPcm:true,servicesStarted:false}));
process.exitCode=results.some(result=>!result.passed)?1:0;
