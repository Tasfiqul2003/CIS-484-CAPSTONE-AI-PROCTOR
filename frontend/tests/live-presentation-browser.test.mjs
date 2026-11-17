// Actual integrated presentation controls. Browser TTS is a deterministic mock;
// saved WAV playback uses native media decoding with speaker output muted.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {build} from 'esbuild';
const require=createRequire(process.env.AVATAR_NODE_MODULES_PATH?path.join(path.resolve(process.env.AVATAR_NODE_MODULES_PATH),'package.json'):import.meta.url);
const {chromium}=require('playwright');
const session='30000000-0000-4000-8000-000000000001',asset='60000000-0000-4000-8000-000000000001';
const rate=16000,count=rate*2,bytes=Buffer.alloc(44+count*2);
bytes.write('RIFF',0);bytes.writeUInt32LE(36+count*2,4);bytes.write('WAVE',8);bytes.write('fmt ',12);
bytes.writeUInt32LE(16,16);bytes.writeUInt16LE(1,20);bytes.writeUInt16LE(1,22);bytes.writeUInt32LE(rate,24);
bytes.writeUInt32LE(rate*2,28);bytes.writeUInt16LE(2,32);bytes.writeUInt16LE(16,34);bytes.write('data',36);bytes.writeUInt32LE(count*2,40);
for(let i=0;i<count;i++)bytes.writeInt16LE(Math.round(Math.sin(i/rate*2*Math.PI*440)*4000),44+i*2);
const bundle=await build({stdin:{contents:`import React from 'react';import{createRoot}from'react-dom/client';
 import Presentation from './src/components/avatar/LiveExamPresentation';window.savedBusy=[];
 createRoot(document.getElementById('root')).render(<Presentation sessionId='${session}' token='synthetic-session-token'
 question='Synthetic approved question' sequence={1} answer='' expired={false} submitting={false}
 onTiming={()=>{}} onBusyChange={()=>{}} onTextSizeChange={()=>{}} onQuestionAudioBusy={busy=>window.savedBusy.push(busy)}/>);`,
 resolveDir:fileURLToPath(new URL('..',import.meta.url)),loader:'tsx'},bundle:true,write:false,outdir:'live-presentation-memory',jsx:'automatic',
 define:{'process.env.NODE_ENV':'"test"'},logLevel:'silent'});
const js=bundle.outputFiles.find(file=>file.path.endsWith('.js')).text,css=bundle.outputFiles.find(file=>file.path.endsWith('.css'))?.text??'';
const browser=await chromium.launch({headless:true,args:['--mute-audio','--autoplay-policy=no-user-gesture-required'],executablePath:process.env.AVATAR_CHROME_PATH||'C:/Program Files/Google/Chrome/Application/chrome.exe'});
try{
 const context=await browser.newContext({reducedMotion:'reduce'}),page=await context.newPage();page.setDefaultTimeout(6000);
 const errors=[],requests=[];page.on('pageerror',error=>errors.push(error.message));
 await context.addInitScript(()=>{
  window.browserSpeechCalls=0;window.captureCalls=0;
  Object.defineProperty(window,'SpeechSynthesisUtterance',{configurable:true,value:class{constructor(text){this.text=text;}}});
  Object.defineProperty(window,'speechSynthesis',{configurable:true,value:{cancel(){},getVoices(){return[{lang:'en-US',localService:true,default:true}];},
   speak(utterance){window.browserSpeechCalls++;const fail=window.browserSpeechCalls===1||window.failNextBrowserSpeech;
    window.failNextBrowserSpeech=false;setTimeout(()=>{if(fail)utterance.onerror?.({error:'synthetic-error'});else{utterance.onstart?.();setTimeout(()=>utterance.onend?.(),0);}},0);}}});
  if(navigator.mediaDevices)navigator.mediaDevices.getUserMedia=()=>{window.captureCalls++;throw new Error('Real capture blocked.');};
 });
 await page.route('**/*',async route=>{
  const request=route.request(),url=new URL(request.url());
  if(url.origin!=='http://127.0.0.1:52394')throw new Error('Unexpected external request.');
  const json=value=>route.fulfill({json:value});
  if(url.pathname==='/bundle.js')return route.fulfill({contentType:'application/javascript',body:js});
  if(url.pathname==='/bundle.css')return route.fulfill({contentType:'text/css',body:css});
  if(!url.pathname.startsWith('/api/'))return route.fulfill({contentType:'text/html',body:'<!doctype html><html><head><link rel="stylesheet" href="/bundle.css"></head><body><div id="root"></div><script src="/bundle.js"></script></body></html>'});
  requests.push({method:request.method(),path:url.pathname});
  if(url.pathname.endsWith('/presentation'))return json({session_id:session,revision:1,voice_profile:'clear',
   policy:{defaults:{avatar:'guide',background:'neutral',customAvatar:null,customBackground:null,voiceLabel:'Synthetic voice',speed:1,reducedMotion:false,animation:false},
    allowAvatar:false,allowBackground:false,allowSpeed:false,avatarChoices:[{id:'guide',label:'Guide'}],backgroundChoices:[{id:'neutral',label:'Neutral'}],minSpeed:1,maxSpeed:1},
   preferences:{avatar:'guide',background:'neutral',volume:70,textSize:16,reducedMotion:false,speed:1}});
  if(url.pathname.endsWith('/assistance'))return json({session_id:session,question_sequence_num:1,mode:'assessed',actions:{},server_now:new Date().toISOString(),deadline:null,question_deadline:null});
  if(url.pathname.endsWith('/speech/capabilities'))return json({synthesis:{available:true}});
  if(request.method()==='POST'&&url.pathname.endsWith('/question-audio'))return json({asset_id:asset,interaction_id:'40000000-0000-4000-8000-000000000001',
    audio_url:`/api/exam/sessions/${session}/question-audio/${asset}`,content_sha256:createHash('sha256').update(bytes).digest('hex'),duration_seconds:2,status:'ready'});
  if(request.method()==='GET'&&url.pathname.endsWith(`/question-audio/${asset}`))return route.fulfill({contentType:'audio/wav',body:bytes});
  throw new Error(`Unexpected presentation API ${request.method()} ${url.pathname}`);
 });
 await page.goto('http://127.0.0.1:52394/presentation');
 await page.getByText('Examiner controls and assistance',{exact:true}).click();
 await page.getByRole('button',{name:'Read question aloud',exact:true}).click();
 const retry=page.getByRole('button',{name:'Retry question audio',exact:true});await retry.waitFor();
 assert.equal(await page.evaluate(()=>window.browserSpeechCalls),1);
 await page.getByRole('button',{name:'Play saved question audio',exact:true}).click();
 await page.waitForFunction(()=>document.querySelector('audio').currentTime>0&&!document.querySelector('audio').paused);
 assert.equal(await page.getByRole('button',{name:'Read question aloud',exact:true}).isDisabled(),true);
 assert.equal(await retry.isDisabled(),true,'Browser speech retry must not overlap saved WAV playback');
 await retry.evaluate(button=>button.click());
 assert.equal(await page.evaluate(()=>window.browserSpeechCalls),1);
 await page.waitForFunction(()=>document.querySelector('audio').ended);
 await retry.click();await page.waitForFunction(()=>window.browserSpeechCalls===2);
 console.log('PASS saved audio blocks normal and retry browser speech, then allows retry after playback ends');
 await page.evaluate(()=>window.failNextBrowserSpeech=true);
 await page.getByRole('button',{name:'Read question aloud',exact:true}).click();await retry.waitFor();
 await page.getByRole('button',{name:'Student settings',exact:true}).click();
 const dialog=page.getByRole('dialog',{name:'Student settings',exact:true});
 await dialog.getByLabel('Volume',{exact:true}).fill('0');
 await dialog.getByRole('button',{name:'Close Settings',exact:true}).click();
 assert.equal(await retry.isDisabled(),true,'Muted question audio must not offer a no-op retry');
 assert.equal(await page.evaluate(()=>window.captureCalls),0);assert.deepEqual(errors,[]);
 assert.ok(requests.every(request=>request.method==='GET'||request.path.endsWith('/question-audio')));
 console.log('PASS muted preference disables retry without changing question, assistance or recording policy');
}finally{await browser.close();}
