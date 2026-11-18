// Playback recovery: synthetic pending promises plus real generated WAV/WebAudio. No devices.
import assert from 'node:assert/strict';import path from 'node:path';import{createRequire}from'node:module';
import{build}from'esbuild';import{fileURLToPath}from'node:url';
const require=createRequire(process.env.AVATAR_NODE_MODULES_PATH?path.join(process.env.AVATAR_NODE_MODULES_PATH,'package.json'):import.meta.url);const frontend=fileURLToPath(new URL('..',import.meta.url));const{chromium}=require('playwright');
const output=await build({stdin:{contents:`import{playExaminerAudio}from'./src/components/exam/playExaminerAudio';import{createRecordingMix}from'./src/components/exam-recording/recordingMix';window.playExaminerAudio=playExaminerAudio;window.createRecordingMix=createRecordingMix;`,resolveDir:frontend,loader:'ts'},bundle:true,write:false,logLevel:'silent'});
const browser=await chromium.launch({headless:true,args:['--mute-audio','--autoplay-policy=user-gesture-required'],executablePath:process.env.AVATAR_CHROME_PATH||'C:/Program Files/Google/Chrome/Application/chrome.exe'});
const page=await browser.newPage();page.setDefaultTimeout(8000);
await page.route('**/*',route=>route.fulfill({contentType:'text/html',body:'<button id="play">Play examiner audio</button><video id="voice" playsinline></video>'}));
try{
 await page.goto('http://127.0.0.1:52395/');await page.addScriptTag({content:output.outputFiles[0].text});
 const pending=await page.evaluate(async()=>{
  const element=new EventTarget();Object.assign(element,{ended:false,play:()=>new Promise(()=>{}),pause(){this.paused=true;}});
  let started=0,ready=null;const control=new AbortController();
  try{await window.playExaminerAudio(element,'synthetic-clip',control.signal,{onReady:fn=>ready=fn,onStarted:()=>started++,onBlocked:()=>{},startTimeoutMs:25});return{wrong:true};}
  catch(error){return{started,readyCleared:ready===null,paused:element.paused,message:error.message};}
 });assert.equal(pending.started,0);assert.equal(pending.readyCleared,true);assert.equal(pending.paused,true);assert.match(pending.message,/did not start/);
 console.log('PASS unresolved browser play promise is bounded and never starts listening');
 await page.evaluate(()=>{
  window.recovery={calls:0,resumes:0,started:0,blocked:0};const element=new EventTarget();
  Object.assign(element,{ended:false,pause(){},play(){window.recovery.calls++;if(window.recovery.calls===1)return Promise.reject(new DOMException('Gesture required','NotAllowedError'));
   setTimeout(()=>element.dispatchEvent(new Event('ended')),20);return Promise.resolve();}});
  window.recovered=window.playExaminerAudio(element,'same-generated-clip',new AbortController().signal,{
   resumeAudio:()=>{window.recovery.resumes++;return Promise.resolve();},onReady:fn=>document.querySelector('#play').onclick=fn,
   onStarted:()=>window.recovery.started++,onBlocked:()=>window.recovery.blocked++,startTimeoutMs:3000});
 });await page.waitForFunction(()=>window.recovery.blocked===1);await page.getByRole('button',{name:'Play examiner audio'}).click();
 await page.evaluate(()=>window.recovered);const recovery=await page.evaluate(()=>window.recovery);
 assert.deepEqual(recovery,{calls:2,resumes:2,started:1,blocked:1});console.log('PASS blocked autoplay recovers by gesture using the same clip with one listening handoff');
 await page.reload();await page.addScriptTag({content:output.outputFiles[0].text});
 await page.evaluate(()=>{
  window.deviceCalls=0;Object.defineProperty(navigator,'mediaDevices',{configurable:true,value:{getUserMedia(){window.deviceCalls++;throw Error('Real devices forbidden');}}});
  const sourceContext=new AudioContext(),source=sourceContext.createMediaStreamDestination();
  const mix=window.createRecordingMix(source.stream);if(!mix)throw Error('Mix could not be created');
  const voice=document.querySelector('#voice');mix.attach(voice);
  const meterContext=new AudioContext(),analyser=meterContext.createAnalyser();analyser.fftSize=1024;
  meterContext.createMediaStreamSource(mix.stream).connect(analyser);
  const frames=16000*2,bytes=new ArrayBuffer(44+frames*2),data=new DataView(bytes);
  const ascii=(offset,text)=>{for(let i=0;i<text.length;i++)data.setUint8(offset+i,text.charCodeAt(i));};
  ascii(0,'RIFF');data.setUint32(4,36+frames*2,true);ascii(8,'WAVE');ascii(12,'fmt ');data.setUint32(16,16,true);data.setUint16(20,1,true);data.setUint16(22,1,true);
  data.setUint32(24,16000,true);data.setUint32(28,32000,true);data.setUint16(32,2,true);data.setUint16(34,16,true);ascii(36,'data');data.setUint32(40,frames*2,true);
  for(let i=0;i<frames;i++)data.setInt16(44+i*2,Math.sin(i*2*Math.PI*440/16000)*8000,true);
  const url=URL.createObjectURL(new Blob([bytes],{type:'audio/wav'}));window.nativeStarted=false;window.nativeDone=false;
  window.sampleMix=()=>{const buffer=new Float32Array(analyser.fftSize);analyser.getFloatTimeDomainData(buffer);return Math.sqrt(buffer.reduce((sum,x)=>sum+x*x,0)/buffer.length);};
  window.nativePlayback=window.playExaminerAudio(voice,url,new AbortController().signal,{
   resumeAudio:()=>mix.resume(),onReady:fn=>{document.querySelector('#play').onclick=()=>{void meterContext.resume();fn?.();};},
   onStarted:()=>window.nativeStarted=true,onBlocked:message=>window.blockedMessage=message,startTimeoutMs:6000,
  }).then(()=>window.nativeDone=true);
  window.closeNative=()=>{const originalLive=source.stream.getAudioTracks()[0].readyState==='live';mix.close();void sourceContext.close();void meterContext.close();URL.revokeObjectURL(url);return originalLive;};
 });
 await page.getByRole('button',{name:'Play examiner audio'}).click();await page.waitForFunction(()=>window.nativeStarted===true);
 await page.waitForFunction(()=>window.sampleMix()>.001);await page.evaluate(()=>window.nativePlayback);
 assert.equal(await page.evaluate(()=>window.nativeDone),true);assert.equal(await page.evaluate(()=>window.deviceCalls),0);
 assert.equal(await page.evaluate(()=>window.closeNative()),true);
 console.log('PASS real generated WAV decodes, gesture unlocks suspended WebAudio, and non-silent examiner audio reaches recording mix without any device capture');
}finally{await browser.close();}
