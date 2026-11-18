// Actual oralCapture implementation with generated microphone levels and fake owned tracks.
import assert from 'node:assert/strict';import{createRequire}from'node:module';import path from'node:path';
import{fileURLToPath}from'node:url';import{build}from'esbuild';
const require=createRequire(process.env.AVATAR_NODE_MODULES_PATH?path.join(path.resolve(process.env.AVATAR_NODE_MODULES_PATH),'package.json'):import.meta.url);
const{chromium}=require('playwright');const frontend=fileURLToPath(new URL('..',import.meta.url));
const result=await build({stdin:{contents:`import{captureOralAnswer}from'./src/components/exam/oralCapture';window.captureOralAnswer=captureOralAnswer;`,
 resolveDir:frontend,loader:'ts'},bundle:true,write:false,logLevel:'silent'});
const browser=await chromium.launch({headless:true,executablePath:process.env.AVATAR_CHROME_PATH||(process.platform==='win32'?'C:/Program Files/Google/Chrome/Application/chrome.exe':undefined)});
const page=await browser.newPage();await page.route('**/*',route=>route.fulfill({contentType:'text/html',body:'<html><body>Synthetic oral capture</body></html>'}));
try{await page.goto('http://127.0.0.1:52394/');await page.addScriptTag({content:result.outputFiles[0].text});
 const output=await page.evaluate(async()=>{
  let now=0,mode='speech',stopped=0,closed=0,captures=0,latestTrack;
  const originalInterval=window.setInterval.bind(window),nativeNow=performance.now.bind(performance);
  Object.defineProperty(performance,'now',{configurable:true,value:()=>now});
  window.setInterval=(fn,ms)=>originalInterval(()=>{now+=ms*10;fn();},1);
  class Track extends EventTarget{readyState='live';enabled=true;muted=false;
   clone(){latestTrack=new Track();return latestTrack;}stop(){stopped++;this.readyState='ended';}}
  const original=new Track();class Stream{constructor(tracks){this.tracks=tracks;}getTracks(){return this.tracks;}getAudioTracks(){return this.tracks;}}
  window.MediaStream=Stream;const shared=new Stream([original]);
  Object.defineProperty(navigator,'mediaDevices',{configurable:true,value:{getUserMedia:async()=>{captures++;return new Stream([new Track()]);}}});
  window.AudioContext=class{state='running';async resume(){}async close(){closed++;}createMediaStreamSource(){return{connect(){}};}
   createAnalyser(){return{fftSize:1024,getFloatTimeDomainData(buffer){buffer.fill(mode==='speech'&&now>=500&&now<=2500?.2:0);}};}};
  window.MediaRecorder=class{state='inactive';static isTypeSupported(){return true;}constructor(source,options){this.mimeType=options.mimeType;}
   start(){this.state='recording';}stop(){if(this.state!=='recording')return;this.state='inactive';
    this.ondataavailable?.({data:new Blob(['synthetic-audio'],{type:this.mimeType})});queueMicrotask(()=>this.onstop?.());}};
  const first=await window.captureOralAnswer(shared,new AbortController().signal,()=>{});
  const speech={size:first.size,now,original:original.readyState,stopped,closed,captures};
  now=0;mode='silence';const quiet=await window.captureOralAnswer(shared,new AbortController().signal,()=>{});
  const silence={quiet,now,original:original.readyState,stopped,closed};
  now=0;const abort=new AbortController();const pending=window.captureOralAnswer(shared,abort.signal,()=>{});
  setTimeout(()=>abort.abort(),2);let cancelled=false;try{await pending;}catch(error){cancelled=error.name==='AbortError';}
  const cancellation={cancelled,original:original.readyState,stopped,closed};
  now=0;const controller=new AbortController();const muted=window.captureOralAnswer(shared,controller.signal,()=>{});
  setTimeout(()=>latestTrack.dispatchEvent(new Event('mute')),2);let disconnected=false;try{await muted;}catch(error){disconnected=/disconnected/.test(error.message);}
  Object.defineProperty(performance,'now',{configurable:true,value:nativeNow});
  return{speech,silence,cancellation,disconnected,stopped,closed,captures};
 });
 assert.ok(output.speech.size>0);assert.ok(output.speech.now>=5500);assert.equal(output.speech.original,'live');
 assert.equal(output.silence.quiet,null);assert.ok(output.silence.now>=20000);assert.equal(output.silence.original,'live');
 assert.equal(output.cancellation.cancelled,true);assert.equal(output.cancellation.original,'live');
 assert.equal(output.disconnected,true);assert.equal(output.stopped,4);assert.equal(output.closed,4);assert.equal(output.captures,0);
 console.log('PASS actual capture: speech then silence, no-speech timeout, abort and mute release owned clones without stopping assessed microphone');
}finally{await browser.close();}
