// Professor review with in-memory API fixtures and real muted synthetic PCM playback.
// No backend, provider, test server, real students or recording devices are used.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { build } from 'esbuild';

const require=createRequire(process.env.AVATAR_NODE_MODULES_PATH
  ?path.join(path.resolve(process.env.AVATAR_NODE_MODULES_PATH),'package.json'):import.meta.url);
const {chromium}=require('playwright');
const frontend=fileURLToPath(new URL('..',import.meta.url));
const session='30000000-0000-4000-8000-000000000001';
const assetId=sequence=>`60000000-0000-4000-8000-${String(sequence).padStart(12,'0')}`;
const assetUrl=sequence=>`/api/exam/sessions/${session}/question-audio/${assetId(sequence)}`;
function pcm(seconds,frequency=440){
  const rate=16000,count=Math.round(rate*seconds),dataSize=count*2,bytes=Buffer.alloc(44+dataSize);
  bytes.write('RIFF',0);bytes.writeUInt32LE(36+dataSize,4);bytes.write('WAVE',8);
  bytes.write('fmt ',12);bytes.writeUInt32LE(16,16);bytes.writeUInt16LE(1,20);bytes.writeUInt16LE(1,22);
  bytes.writeUInt32LE(rate,24);bytes.writeUInt32LE(rate*2,28);bytes.writeUInt16LE(2,32);bytes.writeUInt16LE(16,34);
  bytes.write('data',36);bytes.writeUInt32LE(dataSize,40);
  for(let i=0;i<count;i++)bytes.writeInt16LE(Math.round(Math.sin(i/rate*2*Math.PI*frequency)*4000),44+i*2);
  return bytes;
}
const recording=pcm(2),questionOne=pcm(2,440),questionTwo=pcm(2,660);
const bundle=await build({stdin:{contents:`import React from 'react';import{createRoot}from'react-dom/client';
  import './src/index.css';import './src/styles/exam-ui-tokens.css';
  import Review from './src/pages/professor/ExamSessionReview';
  const root=createRoot(document.getElementById('root'));window.unmountReview=()=>root.unmount();root.render(<Review/>);`,resolveDir:frontend,loader:'tsx'},
  bundle:true,write:false,outdir:'saved-review-browser-memory',jsx:'automatic',define:{'process.env.NODE_ENV':'"test"'},logLevel:'silent'});
const js=bundle.outputFiles.find(file=>file.path.endsWith('.js')).text;
const css=bundle.outputFiles.find(file=>file.path.endsWith('.css'))?.text??'';
const browser=await chromium.launch({headless:true,args:['--mute-audio','--autoplay-policy=no-user-gesture-required'],
  executablePath:process.env.AVATAR_CHROME_PATH||(process.platform==='win32'?'C:/Program Files/Google/Chrome/Application/chrome.exe':undefined)});
const context=await browser.newContext({viewport:{width:1280,height:900}});
const page=await context.newPage();page.setDefaultTimeout(5000);
let mode='ordinary',caseId=0,calls=[];
const errors=[],results=[];page.on('pageerror',error=>errors.push(error.message));
await context.addInitScript(()=>{
  window.captureCalls=[];window.mediaEvents=[];
  if(navigator.mediaDevices)navigator.mediaDevices.getUserMedia=()=>{window.captureCalls.push('getUserMedia');throw new Error('Synthetic review blocks real capture.');};
  for(const kind of ['playing','ended','pause'])document.addEventListener(kind,event=>{
    if(event.target instanceof HTMLMediaElement)window.mediaEvents.push({kind,label:event.target.getAttribute('aria-label'),trusted:event.isTrusted,time:event.target.currentTime});
  },true);
});
function fixture(){
  return{session_id:session,student_name:'Synthetic Student',student_eid:'synthetic-eid',exam_title:'Synthetic reviewed exam',
    course:'SYNTH101',status:'completed',recording_expires_at:'2027-11-16T04:59:59+00:00',video_url:`/api/exam/sessions/${session}/video`,
    answers:[1,2,3,4].map(sequence=>({interaction_id:`40000000-0000-4000-8000-${String(sequence).padStart(12,'0')}`,
      sequence_num:sequence,question:`Synthetic question ${sequence}`,answer:sequence===3?null:`Student response ${sequence}`,
      answer_timestamp_start:sequence===1?.2:sequence===2&&mode==='pending-play'?.9:null,
      answer_timestamp_end:sequence===1?.55:sequence===2&&mode==='pending-play'?1.4:null,
      response_media_status:sequence===1||(sequence===2&&mode==='pending-play')?'available':'offsets_unavailable',transcript_source:sequence===1?'confirmed_transcript':sequence===2?'typed':sequence===3?'timeout':'unknown',
      machine_transcript_draft:sequence===1?'Original machine draft one':null,
      question_audio_assets:sequence<=3?[{asset_id:assetId(sequence),audio_url:mode==='expired-asset'&&sequence===1?undefined:assetUrl(sequence),
        status:mode==='expired-asset'&&sequence===1?'expired':'ready',playback_status:sequence===1?'ended_reported':sequence===2?'started_reported':'not_reported'}]:[]})),
    media_events:[{event_id:'synthetic-event-one',question_sequence_num:1,kind:'question_audio_ended',media_offset_seconds:.15,continuity_boundary:false},
      {event_id:'synthetic-event-two',question_sequence_num:2,kind:'recording_interrupted',media_offset_seconds:null,continuity_boundary:true}]};
}
await page.route('**/*',async route=>{
  const request=route.request(),url=new URL(request.url());
  if(url.origin!=='http://127.0.0.1:52393')throw new Error(`Unexpected external review request ${url.origin}`);
  if(url.pathname==='/bundle.js')return route.fulfill({contentType:'application/javascript',body:js});
  if(url.pathname==='/bundle.css')return route.fulfill({contentType:'text/css',body:css});
  if(!url.pathname.startsWith('/api/'))return route.fulfill({contentType:'text/html',body:'<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/bundle.css"></head><body><div id="root"></div><script src="/bundle.js"></script></body></html>'});
  calls.push({path:url.pathname,method:request.method(),range:request.headers().range});
  if(request.method()==='GET'&&url.pathname==='/api/auth/me')return route.fulfill({json:{
    role:'professor',professor_id:'50000000-0000-4000-8000-000000000001',
  }});
  if(request.method()==='GET'&&url.pathname===`/api/exam/${session}/report`)return route.fulfill({json:{
    session:{status:'pending_grading',developer_demo:false,recording_status:mode==='expired-recording'?'expired':'completed',
      recording_expires_at:mode==='expired-recording'?'2020-01-01T00:00:00Z':'2027-11-16T04:59:59Z'},
    grades:[],rubric_criteria:[{name:'Synthetic Accuracy',description:'Private synthetic professor criterion.',max_score:10}],rubric_error:null,
  }});
  if(url.pathname.endsWith('/review'))return route.fulfill({status:mode==='denied'?403:200,contentType:'application/json',body:JSON.stringify(mode==='denied'?{detail:'Synthetic professor access denied.'}:fixture())});
  let bytes;
    if(url.pathname.endsWith('/video')){
    if(mode==='expired-recording')return route.fulfill({status:410,contentType:'application/json',body:'{"detail":"Synthetic recording expired."}'});
    bytes=mode==='short-recording'?pcm(.35):recording;
  }else if(url.pathname===assetUrl(1))bytes=mode==='invalid-asset'?Buffer.from('synthetic unsupported audio'):questionOne;
  else if(url.pathname===assetUrl(2)||url.pathname===assetUrl(3))bytes=questionTwo;
  else throw new Error(`Unexpected review API ${request.method()} ${url.pathname}`);
  const range=request.headers().range?.match(/^bytes=(\d+)-(\d*)$/);
  if(range){const start=Number(range[1]),end=Math.min(range[2]?Number(range[2]):bytes.length-1,bytes.length-1);
    return route.fulfill({status:206,headers:{'Content-Type':'audio/wav','Accept-Ranges':'bytes','Content-Range':`bytes ${start}-${end}/${bytes.length}`},body:bytes.subarray(start,end+1)});}
  return route.fulfill({contentType:'audio/wav',headers:{'Accept-Ranges':'bytes'},body:bytes});
});
async function reset(next='ordinary'){
  mode=next;calls=[];await page.goto(`http://127.0.0.1:52393/professor/exam-sessions/${session}/review?case=${++caseId}`);
  await page.getByRole('heading',{name:'Exam recording and transcript',exact:true}).waitFor();
  if(next==='denied')await page.getByRole('alert').waitFor();
  else await page.getByRole('heading',{name:'Synthetic question 1',exact:true}).waitFor();
}
const exchange=sequence=>page.getByRole('listitem').filter({has:page.getByRole('heading',{name:`Synthetic question ${sequence}`,exact:true})});
async function check(name,run){try{await run();results.push({name,passed:true});console.log(`PASS ${name}`);}catch(error){results.push({name,passed:false,error:String(error)});console.log(`FAIL ${name}: ${error.stack||error}`);}}
try{
  await check('Review preserves ordered question/answer pairing and separately labeled transcript provenance',async()=>{
    await reset();assert.deepEqual(await page.locator('h3').allTextContents(),[1,2,3,4].map(sequence=>`Synthetic question ${sequence}`));
    assert.match(await exchange(1).innerText(),/Student response 1/);assert.match(await exchange(1).innerText(),/Student-confirmed speech transcript/);
    await exchange(1).getByText('Original speech draft',{exact:true}).click();
    assert.equal(await exchange(1).getByText('Original machine draft one',{exact:true}).isVisible(),true);
    assert.match(await exchange(2).innerText(),/Typed answer/);assert.match(await exchange(3).innerText(),/Question timed out/);
    assert.match(await exchange(4).innerText(),/Legacy source unknown/);
    await page.getByRole('heading',{name:'Professor assessment',exact:true}).waitFor();
    await page.getByLabel('Your score for Synthetic Accuracy',{exact:true}).waitFor();
    assert.ok(calls.some(call=>call.path===`/api/exam/${session}/report`&&call.method==='GET'));
    assert.ok(calls.some(call=>call.path==='/api/auth/me'&&call.method==='GET'));
  });
  await check('Saved question assets stay attached to their own exchange and truthful playback evidence',async()=>{
    await reset();
    for(const sequence of [1,2,3])assert.equal(await exchange(sequence).getByLabel(`Saved question audio for exchange ${sequence}`,{exact:true}).getAttribute('src'),assetUrl(sequence));
    assert.match(await exchange(1).innerText(),/browser reported playback ended/);
    assert.match(await exchange(2).innerText(),/without a completed-playback report/);
    assert.match(await exchange(3).innerText(),/Generated question audio; browser playback was not reported/);
    assert.match(await exchange(4).innerText(),/Original delivered-question audio unavailable/);
    assert.equal(await exchange(4).locator('audio').count(),0);
  });
  await check('Real synthetic question audio, recording playback and speed changes cannot overlap',async()=>{
    await reset();await page.waitForFunction(()=>Number.isFinite(document.querySelector('video').duration));
    await page.getByLabel('Saved question audio for exchange 1',{exact:true}).evaluate(audio=>audio.play());
    await page.waitForFunction(()=>!document.querySelector('audio').paused);
    await page.getByRole('combobox',{name:/^Playback speed/}).selectOption('1.5');
    assert.equal(await page.getByLabel('Saved question audio for exchange 1',{exact:true}).evaluate(audio=>audio.playbackRate),1.5);
    assert.equal(await page.getByLabel('Saved question audio for exchange 1',{exact:true}).evaluate(audio=>audio.paused),false);
    await page.getByLabel('Saved question audio for exchange 2',{exact:true}).evaluate(audio=>audio.play());
    assert.equal(await page.getByLabel('Saved question audio for exchange 1',{exact:true}).evaluate(audio=>audio.paused),true);
    assert.equal(await page.getByLabel('Saved question audio for exchange 2',{exact:true}).evaluate(audio=>audio.playbackRate),1.5);
    assert.equal(await page.getByLabel('Saved question audio for exchange 2',{exact:true}).evaluate(audio=>audio.paused),false);
    await page.locator('video').evaluate(video=>video.play());
    assert.equal(await page.getByLabel('Saved question audio for exchange 2',{exact:true}).evaluate(audio=>audio.paused),true);
    assert.ok((await page.evaluate(()=>window.mediaEvents)).some(event=>event.kind==='playing'&&event.trusted));
  });
  await check('Play exchange seeks the recording to its saved bounds and stops at the exchange end',async()=>{
    await reset();await page.waitForFunction(()=>Number.isFinite(document.querySelector('video').duration));
    await page.getByRole('button',{name:'Play exchange 1',exact:true}).click();
    await page.waitForFunction(()=>document.querySelector('video').currentTime>=.2);
    await page.waitForFunction(()=>document.querySelector('video').paused&&document.querySelector('video').currentTime>=.55);
    const end=await page.locator('video').evaluate(video=>video.currentTime);assert.ok(end<1.2,`Exchange continued past intended segment: ${end}`);
    assert.equal(await exchange(2).getByRole('button',{name:'Play exchange 2',exact:true}).count(),0);
  });
  await check('Interrupted/missing observations remain explicit continuity boundaries',async()=>{
    await reset();await page.getByText('Delivery and interruption timeline',{exact:true}).click();
    const timeline=page.locator('details').filter({has:page.getByText('Delivery and interruption timeline',{exact:true})});
    assert.match(await timeline.innerText(),/Question 1: Question audio ended \(browser reported\)/);
    assert.match(await timeline.innerText(),/Question 2: Recording interrupted — continuity boundary/);
    assert.match(await timeline.innerText(),/offset unavailable/);
    assert.equal(await timeline.getByRole('listitem').count(),2);
  });
  await check('A shortened recording cannot silently play an exchange whose end is unavailable',async()=>{
    await reset('short-recording');await page.waitForFunction(()=>Number.isFinite(document.querySelector('video').duration));
    await page.getByRole('button',{name:'Play exchange 1',exact:true}).click();
    await page.getByRole('alert').filter({hasText:'cannot be located in the available recording'}).waitFor();
    assert.equal(await page.locator('video').evaluate(video=>video.paused),true);
    assert.equal((await page.evaluate(()=>window.mediaEvents)).filter(event=>event.kind==='playing').length,0);
  });
  await check('A rejected old play request cannot report failure for a newer exchange',async()=>{
    await reset('pending-play');await page.waitForFunction(()=>Number.isFinite(document.querySelector('video').duration));
    await page.locator('video').evaluate(video=>{
      const original=video.play.bind(video);let first=true;
      video.play=()=>{if(first){first=false;return new Promise((resolve,reject)=>{window.rejectOldVideoPlay=()=>reject(new DOMException('Synthetic superseded play','AbortError'));});}return original();};
    });
    await page.getByRole('button',{name:'Play exchange 1',exact:true}).click();
    await page.waitForFunction(()=>typeof window.rejectOldVideoPlay==='function');
    await page.getByRole('button',{name:'Play exchange 2',exact:true}).click();
    await page.waitForFunction(()=>!document.querySelector('video').paused&&document.querySelector('video').currentTime>=.9);
    await page.evaluate(()=>window.rejectOldVideoPlay());
    await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
    assert.equal(await page.getByRole('alert').count(),0);
    await page.locator('video').evaluate(video=>video.pause());
  });
  await check('Question-audio handoff invalidates pending recording playback and clears old segment bounds',async()=>{
    await reset();await page.waitForFunction(()=>Number.isFinite(document.querySelector('video').duration));
    await page.locator('video').evaluate(video=>{
      const original=video.play.bind(video);let first=true;
      video.play=()=>{if(first){first=false;return new Promise((resolve,reject)=>{window.rejectOldVideoPlay=()=>reject(new DOMException('Synthetic superseded play','AbortError'));});}return original();};
    });
    await page.getByRole('button',{name:'Play exchange 1',exact:true}).click();
    await page.waitForFunction(()=>typeof window.rejectOldVideoPlay==='function');
    await page.getByLabel('Saved question audio for exchange 2',{exact:true}).evaluate(audio=>audio.play());
    await page.evaluate(()=>window.rejectOldVideoPlay());
    await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
    assert.equal(await page.getByRole('alert').count(),0);
    await page.locator('video').evaluate(video=>video.play());
    await page.waitForFunction(()=>document.querySelector('video').currentTime>.8&&!document.querySelector('video').paused);
    assert.equal(await page.getByLabel('Saved question audio for exchange 2',{exact:true}).evaluate(audio=>audio.paused),true);
    await page.locator('video').evaluate(video=>video.pause());
  });
  await check('Unmount pauses detached recording and saved-question players',async()=>{
    await reset();await page.getByLabel('Saved question audio for exchange 1',{exact:true}).evaluate(audio=>audio.play());
    await page.evaluate(()=>{window.detachedAudio=document.querySelector('audio');window.unmountReview();});
    await page.waitForFunction(()=>window.detachedAudio.paused);
    await reset();await page.locator('video').evaluate(video=>video.play());
    await page.evaluate(()=>{window.detachedVideo=document.querySelector('video');window.unmountReview();});
    await page.waitForFunction(()=>window.detachedVideo.paused);
  });
  await check('Expired or unsupported question assets keep the delivered text and truthful errors',async()=>{
    await reset('expired-asset');assert.equal(await exchange(1).locator('audio').count(),0);
    assert.match(await exchange(1).innerText(),/Saved question audio has expired or is unavailable/);
    await reset('invalid-asset');await page.getByText(/Saved question audio is missing, expired, or unsupported/).waitFor();
    assert.equal(await page.getByRole('heading',{name:'Synthetic question 1',exact:true}).isVisible(),true);
  });
  await check('Expired recording and denied review never produce a false successful playback state',async()=>{
    await reset('expired-recording');await page.getByText('Recording unavailable, expired, or unsupported by this browser.',{exact:true}).waitFor();
    await reset('denied');assert.match(await page.getByRole('alert').innerText(),/Synthetic professor access denied/);
    assert.equal(await page.locator('video,audio').count(),0);assert.equal(await page.locator('h3').count(),0);
  });
  await check('Review fits a narrow viewport and uses only mocked reads without capture/runtime errors',async()=>{
    await page.setViewportSize({width:390,height:844});await reset();
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
    assert.ok(calls.every(call=>call.method==='GET'));assert.deepEqual(await page.evaluate(()=>window.captureCalls),[]);assert.deepEqual(errors,[]);
  });
}finally{await browser.close();}
console.log(JSON.stringify({suite:'saved-review-browser',passed:results.filter(result=>result.passed).length,failed:results.filter(result=>!result.passed).length,mutedSyntheticPcm:true,servicesStarted:false}));
process.exitCode=results.some(result=>!result.passed)?1:0;
