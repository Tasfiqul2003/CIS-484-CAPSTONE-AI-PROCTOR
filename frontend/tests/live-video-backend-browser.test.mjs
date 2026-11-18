/** Real loopback production routers/auth + native canvas media; synthetic SQLite ONLY. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID, createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const frontend=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const repository=path.resolve(frontend,'..');
const require=createRequire(process.env.AVATAR_NODE_MODULES_PATH
  ? path.join(path.resolve(process.env.AVATAR_NODE_MODULES_PATH),'package.json')
  : path.join(repository,'.cache/browser-tools/package.json'));
const {chromium}=require('playwright');
const output=process.env.LIVE_BACKEND_TEST_OUTPUT_DIR||path.join(repository,'.cache/browser-results/live-backend');
const evidence={startedAt:new Date().toISOString(),fixture:'production HTTP/auth routers + generated canvas + isolated synthetic SQLite; no exam/start/identity/source DB',results:[]};
const ownedFixtures=new Set();
const bundle=await build({stdin:{resolveDir:frontend,loader:'tsx',contents:`
 import React from 'react';import{createRoot}from'react-dom/client';
 import ProfessorLiveVideo from './src/pages/professor/ProfessorLiveVideo';
 import{createLiveVideo}from'./src/components/media/liveVideo';
 window.__deviceCalls=[];window.__peers=[];window.__states=[];
 if(navigator.mediaDevices){for(const name of ['getUserMedia','getDisplayMedia'])navigator.mediaDevices[name]=()=>{window.__deviceCalls.push(name);throw Error('Real devices forbidden');};}
 const NativePeer=RTCPeerConnection;window.RTCPeerConnection=class extends NativePeer{constructor(config){super(config);window.__peers.push(this);}};
 window.__cleanup=()=>{window.__live?.stop();if(window.__recorder?.state==='recording')window.__recorder.stop();window.__stream?.getTracks().forEach(track=>track.stop());cancelAnimationFrame(window.__animation);};
 window.__startStudent=async config=>{
   window.__config=config;const canvas=document.createElement('canvas');canvas.width=320;canvas.height=180;document.body.append(canvas);
   const drawing=canvas.getContext('2d');drawing.fillRect(0,0,320,180);const stream=canvas.captureStream(0);window.__stream=stream;
   const track=stream.getVideoTracks()[0];let count=0,last=0;const draw=now=>{if(now-last>75){last=now;count++;drawing.fillStyle='hsl('+((count*23)%360)+' 90% 45%)';drawing.fillRect(0,0,320,180);drawing.fillStyle='white';drawing.font='22px monospace';drawing.fillText('Synthetic '+count,15,95);track.requestFrame();}window.__animation=requestAnimationFrame(draw);};window.__animation=requestAnimationFrame(draw);
   const mime=['video/webm;codecs=vp8','video/webm'].find(type=>MediaRecorder.isTypeSupported(type));if(!mime)throw Error('Synthetic WebM unsupported');
   const started=await fetch('/api/exam/sessions/'+config.session_id+'/video-recording/start',{method:'POST',headers:{Authorization:'Bearer '+config.student_token,'Content-Type':'application/json'},body:JSON.stringify({content_type:mime})});
   if(!started.ok)throw Error('Synthetic recording initialization HTTP '+started.status);
   window.__chunks=[];const recorder=new MediaRecorder(stream,{mimeType:mime});window.__recorder=recorder;recorder.ondataavailable=event=>{if(event.data.size)window.__chunks.push(event.data);};recorder.start();window.__startedAt=performance.now();
   window.__live=createLiveVideo({sessionId:config.session_id,token:config.student_token,role:'student',stream,onState:(state,message)=>window.__states.push({state,message})});
 };
 window.__stopAndUpload=async()=>{
   await new Promise(resolve=>{window.__recorder.addEventListener('stop',resolve,{once:true});window.__recorder.stop();});
   const config=window.__config,base='/api/exam/sessions/'+config.session_id,headers={Authorization:'Bearer '+config.student_token};
   const blob=new Blob(window.__chunks,{type:'video/webm'});const bytes=await blob.arrayBuffer();const digest=await crypto.subtle.digest('SHA-256',bytes);const hash=[...new Uint8Array(digest)].map(v=>v.toString(16).padStart(2,'0')).join('');
   const boundary=await fetch(base+'/media-timeline/events',{method:'POST',headers:{...headers,'Content-Type':'application/json'},body:JSON.stringify({event_id:crypto.randomUUID(),kind:'recording_interrupted',question_sequence_num:1,media_offset_seconds:(performance.now()-window.__startedAt)/1000})});
   const upload=async(index,data=blob,session=config.session_id)=>{const form=new FormData();form.set('index',String(index));form.set('chunk',data,'synthetic.webm');return fetch('/api/exam/sessions/'+session+'/video-recording/chunks',{method:'POST',headers,body:form});};
   const first=await upload(0),duplicate=await upload(0),outOfOrder=await upload(2),overwrite=await upload(0,new Blob(['wrong-bytes'])),cross=await upload(0,blob,crypto.randomUUID());
   const complete=await fetch(base+'/video-recording/complete',{method:'POST',headers:{...headers,'Content-Type':'application/json'},body:JSON.stringify({expected_chunk_count:1})});
   return{boundary:boundary.status,first:first.status,duplicate:duplicate.status,duplicateBody:await duplicate.json(),outOfOrder:outOfOrder.status,overwrite:overwrite.status,cross:cross.status,complete:complete.status,completeBody:await complete.json(),bytes:blob.size,hash};
 };
 if(location.pathname.includes('/professor/'))createRoot(document.getElementById('root')).render(<ProfessorLiveVideo/>);
`},bundle:true,write:false,format:'iife',jsx:'automatic',logLevel:'silent',define:{'process.env.NODE_ENV':'"development"'}});
const javascript=bundle.outputFiles[0].text;
const browser=await chromium.launch({executablePath:process.env.AVATAR_CHROME_PATH||(process.platform==='win32'?'C:/Program Files/Google/Chrome/Application/chrome.exe':undefined),headless:true,args:['--mute-audio','--autoplay-policy=no-user-gesture-required','--disable-background-timer-throttling','--disable-backgrounding-occluded-windows','--disable-renderer-backgrounding']});
evidence.browser=await browser.version();

async function fixture(){
 const environment={...process.env};for(const key of Object.keys(environment))if(/^(DATABASE_URL|AUTH_SECRET_KEY|ADMIN_BOOTSTRAP_TOKEN|PG.*|OLLAMA_.*|EXAM_VIDEO_.*|CYBROS_VALIDATION_DATABASE_URL)$/.test(key))delete environment[key];
 const child=spawn(path.join(repository,'.venv/Scripts/python.exe'),[path.join(repository,'backend/tests/live_backend_fixture.py')],{cwd:repository,env:environment,stdio:['pipe','pipe','pipe'],windowsHide:true});
 const pending=new Map();let buffer='',initialResolve,initialReject,exited=false;
 const initial=new Promise((resolve,reject)=>{initialResolve=resolve;initialReject=reject;});
 child.stdout.on('data',chunk=>{buffer+=chunk.toString();let index;while((index=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,index);buffer=buffer.slice(index+1);try{const value=JSON.parse(line);if(value.kind==='fixture')initialResolve(value);else if(value.kind==='control'){pending.get(value.request_id)?.(value);pending.delete(value.request_id);}}catch{initialReject(Error('Invalid fixture IPC response'));}}});
 child.stderr.on('data',()=>{}); // Never publish fixture secrets or full error locals.
 child.stdin.on('error',()=>{});
 child.on('exit',()=>{exited=true;initialReject(Error('Owned synthetic fixture exited before readiness'));});
 const shutdown=async()=>{if(!exited){child.stdin.end();await Promise.race([new Promise(resolve=>child.once('exit',resolve)),new Promise(resolve=>setTimeout(resolve,4000))]);if(!exited){child.kill();await new Promise(resolve=>child.once('exit',resolve));}}ownedFixtures.delete(shutdown);assert.equal(exited,true);};
 ownedFixtures.add(shutdown);
 const timer=setTimeout(()=>initialReject(Error('Owned synthetic fixture readiness timed out')),15000);
 const config=await initial.finally(()=>clearTimeout(timer));
 assert.match(config.origin,/^http:\/\/127\.0\.0\.1:\d+$/);
 const control=operation=>new Promise((resolve,reject)=>{const request_id=randomUUID(),timeout=setTimeout(()=>{pending.delete(request_id);reject(Error('Fixture control timed out'));},5000);pending.set(request_id,value=>{clearTimeout(timeout);resolve(value);});child.stdin.write(JSON.stringify({request_id,operation})+'\n');});
 for(let tries=0;;tries++){try{if((await fetch(config.origin+'/__fixture/ready')).ok)break;}catch{}if(tries>=40)throw Error('Owned HTTP fixture did not become ready');await new Promise(resolve=>setTimeout(resolve,100));}
 return{config,control,stop:shutdown};
}

async function pair(){
 const backend=await fixture(),origin=backend.config.origin,errors=[],unexpected=[],roomIds=new Set();
 const contexts=[];
 async function context(){const value=await browser.newContext({viewport:{width:1000,height:720},permissions:[]});contexts.push(value);await value.route('**/*',route=>{const request=route.request(),url=new URL(request.url());if(url.origin!==origin){unexpected.push(url.origin);return route.abort('blockedbyclient');}if(url.pathname==='/__fixture/app.js')return route.fulfill({contentType:'application/javascript',body:javascript});if(request.isNavigationRequest())return route.fulfill({contentType:'text/html',body:'<!doctype html><div id="root"></div><script src="/__fixture/app.js"></script>'});if(url.pathname.startsWith('/api/'))return route.continue();unexpected.push(url.pathname);return route.abort('blockedbyclient');});return value;}
 async function login(value,account){let response;try{response=await value.request.post(origin+'/api/auth/login',{data:account});}catch{throw Error('Synthetic fixture login failed');}assert.equal(response.status(),200);}
 const studentContext=await context(),professorContext=await context();await login(professorContext,backend.config.owner);
 const student=await studentContext.newPage(),professor=await professorContext.newPage();
 for(const page of[student,professor])page.on('pageerror',error=>errors.push(error.message));
 professor.on('response',async response=>{if(response.url().includes('/live-video?')&&response.status()===200){try{const value=await response.json();roomIds.add(value.room_id);}catch{}}});
 await student.goto(origin+'/__student__');await student.evaluate(config=>window.__startStudent(config),backend.config);
 await professor.goto(origin+'/professor/exam-sessions/'+backend.config.session_id+'/live');await professor.getByRole('button',{name:'Start live viewing',exact:true}).click();
 await professor.waitForFunction(()=>document.querySelector('[role="status"]')?.textContent==='Live video connected.',null,{timeout:25000});
 await professor.waitForFunction(()=>document.querySelector('video')?.videoWidth===320,null,{timeout:10000});
 return{backend,origin,student,professor,studentContext,professorContext,roomIds,errors,unexpected,context,login,
  async close(){try{await student.evaluate(()=>window.__cleanup()).catch(()=>{});for(const value of contexts)await value.close();}finally{await backend.stop();}}};
}

async function check(name,run){const started=Date.now();let value;try{value=await pair();const details=await run(value);assert.deepEqual(value.errors,[]);assert.deepEqual(value.unexpected,[]);assert.deepEqual(await value.student.evaluate(()=>window.__deviceCalls),[]);assert.deepEqual(await value.professor.evaluate(()=>window.__deviceCalls),[]);evidence.results.push({name,status:'passed',durationMs:Date.now()-started,details});console.log('PASS '+name);}catch(error){evidence.results.push({name,status:'failed',durationMs:Date.now()-started,error:error.stack||String(error)});console.log('FAIL '+name+': '+error.message);}finally{await value?.close();}}

try{
 await check('actual auth/signaling room recreation and interrupted native WebM upload/range/decode',async value=>{
  const {backend,student,professor,origin}=value;
  const first=await professor.evaluate(async()=>{const stats=await window.__peers.at(-1).getStats();let frames=0;stats.forEach(report=>{if(report.type==='inbound-rtp'&&report.kind==='video')frames=report.framesDecoded||0;});return frames;});assert.ok(first>0);
  const oldRoom=[...value.roomIds][0];await backend.control('clear_rooms');
  await professor.waitForFunction(()=>window.__peers.length>=2&&window.__peers.at(-1).connectionState==='connected'&&document.querySelector('[role="status"]')?.textContent==='Live video connected.',null,{timeout:25000});
  assert.ok([...value.roomIds].some(id=>id!==oldRoom));
  const other=await value.context();await value.login(other,backend.config.other);
  const denied=await other.request.get(origin+'/api/exam/sessions/'+backend.config.session_id+'/live-video?peer_id='+randomUUID());assert.equal(denied.status(),404);
  const expired=await value.studentContext.request.get(origin+'/api/exam/sessions/'+backend.config.session_id+'/live-video?peer_id='+randomUUID(),{headers:{Authorization:'Bearer '+backend.config.expired_student_token}});assert.equal(expired.status(),401);
  const uploaded=await student.evaluate(()=>window.__stopAndUpload());
  assert.equal(uploaded.boundary,200);assert.equal(uploaded.first,200);assert.equal(uploaded.duplicate,200);assert.equal(uploaded.duplicateBody.duplicate,true);
  assert.equal(uploaded.outOfOrder,409);assert.equal(uploaded.overwrite,409);assert.equal(uploaded.cross,403);assert.equal(uploaded.complete,200);assert.equal(uploaded.completeBody.bytes,uploaded.bytes);
  const state=await backend.control('state');assert.equal(state.attempt_status,'flagged');assert.equal(state.video.status,'completed');
  await professor.waitForFunction(()=>window.__peers.every(peer=>peer.connectionState==='closed'),null,{timeout:8000});
  assert.equal(await professor.locator('video').evaluate(video=>getComputedStyle(video).visibility),'hidden');
  const url=origin+'/api/exam/sessions/'+backend.config.session_id+'/video';
  const response=await value.professorContext.request.get(url);assert.equal(response.status(),200);const bytes=await response.body();assert.equal(bytes.length,uploaded.bytes);assert.equal(createHash('sha256').update(bytes).digest('hex'),uploaded.hash);
  const ranged=await value.professorContext.request.get(url,{headers:{Range:'bytes=0-31'}});assert.equal(ranged.status(),206);assert.deepEqual(await ranged.body(),bytes.subarray(0,32));assert.equal(ranged.headers()['content-range'],'bytes 0-31/'+uploaded.bytes);assert.equal(ranged.headers()['x-content-type-options'],'nosniff');
  assert.equal((await other.request.get(url,{headers:{Range:'bytes=0-31'}})).status(),404);
  await professor.evaluate(url=>{const video=document.createElement('video');video.id='storedRecording';video.src=url;video.muted=true;video.autoplay=true;document.body.append(video);void video.play();},url);
  await professor.waitForFunction(()=>document.getElementById('storedRecording')?.videoWidth===320,null,{timeout:10000});
  return{nativeDecodedFrames:first,roomGenerationRecreated:true,actualLoginCookie:true,expiredStudentTokenDenied:true,wrongProfessorDenied:true,attemptFlagged:true,nativeWebMBytes:uploaded.bytes,exactHashAndRange:true,storedWebMDecodedWidth:320,identityAndExamStartNotExercised:true};
 });
 await check('actual professor JWT expiry closes native view through real backend authentication',async value=>{
  const short=await value.backend.control('short_professor_cookie');
  await value.professorContext.addCookies([{name:'oralexam_session',value:short.cookie,url:value.origin,httpOnly:true}]);
  await value.professor.waitForFunction(()=>document.querySelector('[role="status"]')?.textContent?.includes('expired or invalid'),null,{timeout:10000});
  await value.professor.waitForFunction(()=>window.__peers.every(peer=>peer.connectionState==='closed'),null,{timeout:8000});
  assert.equal(await value.professor.locator('video').evaluate(video=>video.srcObject===null&&getComputedStyle(video).visibility==='hidden'),true);
  assert.equal(await value.student.evaluate(()=>window.__stream.getVideoTracks()[0].readyState),'live');
  return{actualExpiredCookieDenied:true,nativeReceiverClosed:true,ownedCanvasTrackPreserved:true};
 });
}finally{evidence.finishedAt=new Date().toISOString();await mkdir(output,{recursive:true});await writeFile(path.join(output,'results.json'),JSON.stringify(evidence,null,2));try{await browser.close();}finally{for(const stop of [...ownedFixtures])await stop();}}
console.log(evidence.results.filter(result=>result.status==='passed').length+'/'+evidence.results.length+' real-backend native canvas checks passed');
if(evidence.results.some(result=>result.status==='failed'))process.exitCode=1;
