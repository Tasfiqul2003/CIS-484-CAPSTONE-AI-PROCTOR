// In-memory synthetic speech UI checks. No server, devices, speech engine,
// provider, backend or stored media; MediaRecorder and MediaStream are fakes.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const require = createRequire(process.env.AVATAR_NODE_MODULES_PATH
  ? path.join(path.resolve(process.env.AVATAR_NODE_MODULES_PATH), 'package.json') : import.meta.url);
const { chromium } = require('playwright');
const frontend = fileURLToPath(new URL('..', import.meta.url));
const bundle = await build({ stdin: { contents: `import React,{useState} from 'react';
  import {createRoot} from 'react-dom/client';
  import SpeechDraft from './src/components/exam/SpeechDraftPanel';
  function Harness(){const [sequence,setSequence]=useState(1); const [disabled,setDisabled]=useState(false);const[typed,setTyped]=useState('');
    window.advance=()=>setSequence(n=>n+1);window.disable=()=>setDisabled(true);
    return <><label htmlFor="typed-fixture">Typed answer</label><textarea id="typed-fixture" value={typed} onChange={event=>setTyped(event.target.value)}/><SpeechDraft sessionId="synthetic-session" token="synthetic-token" sequence={sequence}
      stream={window.syntheticStream} disabled={disabled}
      onBusyChange={busy=>window.busy=busy}
      onDraftConfirmed={(text,metadata)=>window.confirmations.push({text,metadata})}/></>;}
  createRoot(document.getElementById('root')).render(<Harness/>);`,
  resolveDir: frontend, loader: 'tsx' }, bundle: true, write: false,
  outdir: 'speech-browser-memory', jsx: 'automatic',
  define: { 'process.env.NODE_ENV': '"test"' }, logLevel: 'silent' });
const script = bundle.outputFiles.find(file => file.path.endsWith('.js')).text;
const browser = await chromium.launch({ headless: true,
  executablePath: process.env.AVATAR_CHROME_PATH || (process.platform === 'win32' ? 'C:/Program Files/Google/Chrome/Application/chrome.exe' : undefined) });
const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
await context.addInitScript(() => {
  window.confirmations = []; window.recordingStarts = 0; window.stoppedTracks = 0;
  window.mediaRequests = 0; window.speakerCancels = 0;
  const capMode=new URL(location.href).searchParams.get('holdcap');
  window.heldCapabilityReady=false;
  if(capMode){
    const nativeFetch=window.fetch.bind(window);let hold=true;
    window.fetch=async(...arguments_)=>{
      const response=await nativeFetch(...arguments_);
      if(hold&&String(arguments_[0]).endsWith('/speech/capabilities')){
        hold=false;const body=await response.text(),status=response.status;
        window.heldCapabilityReady=true;
        await new Promise(resolve=>{window.releaseCapabilityResponse=resolve;});
        const value=JSON.parse(body);if(window.lateCapabilityUnavailable)value.transcription.available=false;
        return new Response(JSON.stringify(value),{status,headers:{'Content-Type':'application/json'}});
      }return response;
    };
    if(capMode==='timeout'){
      const nativeTimeout=window.setTimeout.bind(window);
      window.setTimeout=(handler,delay,...arguments_)=>nativeTimeout(handler,delay===12000?40:delay,...arguments_);
    }
  }

  const track = { readyState: 'live', stop(){window.stoppedTracks++;} };
  class SyntheticStream {
    constructor(tracks=[track]){this.tracks=tracks;}
    getAudioTracks(){return this.tracks;}
  }
  class SyntheticRecorder {
    static isTypeSupported(type){return type.startsWith('audio/webm');}
    constructor(stream, options){this.state='inactive';this.mimeType=options.mimeType;}
    start(){this.state='recording';window.recordingStarts++;}
    stop(){if(this.state!=='recording')return;this.state='inactive';
      this.ondataavailable?.({data:new Blob([new Uint8Array([0x1a,0x45,0xdf,0xa3,0x01])],{type:this.mimeType})});
      this.onstop?.();}
  }
  window.MediaStream=SyntheticStream; window.MediaRecorder=SyntheticRecorder;
  window.syntheticStream=new SyntheticStream();
  Object.defineProperty(navigator,'mediaDevices',{configurable:true,value:{getUserMedia(){window.mediaRequests++;throw Error('Real devices forbidden');}}});
  if(window.speechSynthesis)window.speechSynthesis.cancel=()=>window.speakerCancels++;
});
const page = await context.newPage();
page.setDefaultTimeout(6000);
const errors=[]; page.on('pageerror', error=>errors.push(error.message));
let available=false, fail=false, delayed=false, nativeWaveOnly=false, transcriptions=0;
await page.route('**/*',async route=>{
  const request=route.request(),url=new URL(request.url());
  const json=(body,status=200)=>route.fulfill({status,contentType:'application/json',body:JSON.stringify(body)});
  if(url.pathname.endsWith('/bundle.js'))return route.fulfill({contentType:'application/javascript',body:script});
  if(url.pathname.endsWith('/speech/capabilities'))return json({transcription:{available,...(nativeWaveOnly?{accepted_mime_types:['audio/wav']}:{})}});
  if(url.pathname.endsWith('/speech/transcribe')){
    transcriptions++;
    assert.equal(request.headers()['authorization'],'Bearer synthetic-token');
    assert.equal(request.postDataBuffer()[0],nativeWaveOnly?0x52:0x1a);
    const id=url.searchParams.get('request_id'),sequence=Number(url.searchParams.get('sequence_num'));
    if(fail)return json({detail:{code:'provider_unavailable'}},503);
    if(delayed)await new Promise(resolve=>setTimeout(resolve,200));
    return json({request_id:id,transcript_draft_id:id,transcript_receipt:'synthetic-signed-receipt',
      interaction_id:`synthetic-interaction-${sequence}`,question_revision:`revision-${sequence}`,
      sequence_num:sequence,text:delayed?'Late synthetic draft':'Original synthetic machine draft',
      source:'machine_draft',status:'review_required'}).catch(()=>undefined);
  }
  if(url.pathname.startsWith('/api/'))throw Error(`Unexpected API ${url.pathname}`);
  return route.fulfill({contentType:'text/html',body:'<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><div id="root"></div><script src="/bundle.js"></script></body></html>'});
});
try {
  await page.goto('http://127.0.0.1:52392/');
  await page.getByText('Speech transcription is unavailable. Type your answer below.').waitFor();
  assert.equal(await page.getByRole('button',{name:'Record speech draft',exact:true}).isDisabled(),true);
  assert.equal(await page.evaluate(()=>window.mediaRequests),0);
  console.log('PASS unavailable provider leaves typed path and acquires no devices');
  available=true; await page.reload();
  await page.getByRole('button',{name:'Record speech draft',exact:true}).waitFor();
  await page.waitForFunction(()=>!document.querySelector('button').disabled);
  await page.getByRole('button',{name:'Record speech draft',exact:true}).click();
  assert.equal(transcriptions,0);
  assert.equal(await page.evaluate(()=>window.busy),true);
  await page.getByRole('button',{name:'Stop and transcribe',exact:true}).click();
  const review=page.getByRole('textbox',{name:'Review and edit the machine transcript'});
  await review.waitFor();
  assert.equal(await page.evaluate(()=>window.confirmations.length),0);
  await review.fill('Student corrected synthetic answer');
  await page.getByRole('button',{name:'Use reviewed transcript',exact:true}).click();
  const confirmation=await page.evaluate(()=>window.confirmations[0]);
  assert.equal(confirmation.text,'Student corrected synthetic answer');
  assert.equal(confirmation.metadata.machine_draft,'Original synthetic machine draft');
  assert.equal(confirmation.metadata.input_source,'confirmed_transcript');
  assert.equal(confirmation.metadata.transcript_receipt,'synthetic-signed-receipt');
  assert.equal(await page.evaluate(()=>window.stoppedTracks),0);
  assert.equal(await page.evaluate(()=>window.busy),false);
  console.log('PASS record/draft/edit/explicit confirmation preserves original provenance without answer submission');
  fail=true;
  await page.getByRole('button',{name:'Record speech draft',exact:true}).click();
  await page.getByRole('button',{name:'Stop and transcribe',exact:true}).click();
  await page.getByRole('alert').waitFor();
  assert.equal(await review.inputValue(),'Student corrected synthetic answer');
  assert.equal(await page.evaluate(()=>window.confirmations.length),1);
  fail=false;delayed=true;
  await page.getByRole('button',{name:'Record speech draft',exact:true}).click();
  await page.getByRole('button',{name:'Stop and transcribe',exact:true}).click();
  await page.getByText('Transcribing your draft. Exam time continues.').waitFor();
  await page.evaluate(()=>window.advance());
  await page.waitForTimeout(300);
  assert.equal(await review.count(),0);
  assert.equal(await page.evaluate(()=>window.confirmations.length),1);
  await page.getByRole('button',{name:'Record speech draft',exact:true}).click();
  await page.getByRole('button',{name:'Cancel speech draft',exact:true}).click();
  assert.equal(await page.evaluate(()=>window.busy),false);
  assert.equal(await page.evaluate(()=>window.mediaRequests),0);
  assert.equal(await page.evaluate(()=>window.stoppedTracks),0);
  assert.deepEqual(errors,[]);
  console.log('PASS provider failure preserves draft; cancellation and question change discard late results and retain owned tracks');
  nativeWaveOnly=true;delayed=false;await page.reload();
  await page.waitForFunction(()=>!document.querySelector('button').disabled);
  await page.evaluate(()=>{
    const original=window.setTimeout.bind(window);
    window.setTimeout=(handler,delay,...arguments_)=>original(handler,delay===55000?40:delay,...arguments_);
    window.OfflineAudioContext=class{
      decodeAudioData(){return new Promise(resolve=>{window.completeSlowDecode=()=>resolve({
        numberOfChannels:1,length:1600,duration:0.1,sampleRate:16000,getChannelData:()=>new Float32Array(1600),
      });});}
    };
  });
  const beforeSlowDecode=transcriptions;
  await page.getByRole('button',{name:'Record speech draft',exact:true}).click();
  await page.getByRole('button',{name:'Stop and transcribe',exact:true}).click();
  await page.getByText('Transcription timed out. Try again or type your answer.').waitFor();
  assert.equal(await page.getByRole('button',{name:'Record speech draft',exact:true}).isEnabled(),true);
  assert.equal(await page.evaluate(()=>window.busy),false);
  await page.evaluate(()=>window.completeSlowDecode());
  await page.waitForTimeout(60);
  assert.equal(transcriptions,beforeSlowDecode);
  assert.equal(await review.count(),0);
  await page.evaluate(()=>{
    window.OfflineAudioContext=class{
      async decodeAudioData(){return {numberOfChannels:1,length:1600,duration:0.1,sampleRate:16000,getChannelData:()=>new Float32Array(1600)};}
    };
  });
  await page.getByRole('button',{name:'Record speech draft',exact:true}).click();
  await page.getByRole('button',{name:'Stop and transcribe',exact:true}).click();
  await review.waitFor();
  assert.equal(await page.evaluate(()=>window.busy),false);
  assert.equal(await page.evaluate(()=>window.mediaRequests),0);
  assert.equal(await page.evaluate(()=>window.stoppedTracks),0);
  assert.deepEqual(errors,[]);
  console.log('PASS offline decode deadline releases speech controls, ignores late preparation and allows a clean retry without devices');
  await page.goto('http://127.0.0.1:52392/?holdcap=timeout');
  await page.getByRole('textbox',{name:'Typed answer',exact:true}).fill('Manual draft survives a speech availability timeout.');
  await page.getByText('Speech availability check timed out. Type your answer or retry.').waitFor();
  assert.equal(await page.getByRole('button',{name:'Record speech draft',exact:true}).isDisabled(),true);
  await page.getByRole('button',{name:'Retry speech availability',exact:true}).click();
  await page.waitForFunction(()=>!document.querySelector('.speech-draft button').disabled);
  await page.evaluate(()=>{window.lateCapabilityUnavailable=true;window.releaseCapabilityResponse();});
  await page.waitForTimeout(60);
  assert.equal(await page.getByRole('button',{name:'Record speech draft',exact:true}).isEnabled(),true);
  assert.equal(await page.getByRole('textbox',{name:'Typed answer',exact:true}).inputValue(),'Manual draft survives a speech availability timeout.');
  assert.equal(await page.getByRole('alert').count(),0);
  assert.equal(await page.evaluate(()=>window.mediaRequests),0);
  console.log('PASS capability timeout leaves typed draft intact, exposes retry and rejects a late superseded availability response');
  await page.goto('http://127.0.0.1:52392/?holdcap=late');
  await page.waitForFunction(()=>window.heldCapabilityReady);
  await page.evaluate(()=>window.advance());
  await page.waitForFunction(()=>!document.querySelector('.speech-draft button').disabled);
  await page.evaluate(()=>{window.lateCapabilityUnavailable=true;window.releaseCapabilityResponse();});
  await page.waitForTimeout(60);
  assert.equal(await page.getByRole('button',{name:'Record speech draft',exact:true}).isEnabled(),true);
  assert.equal(await review.count(),0);
  assert.equal(await page.getByRole('alert').count(),0);
  assert.equal(await page.evaluate(()=>window.mediaRequests),0);
  assert.deepEqual(errors,[]);
  console.log('PASS capability response from a prior question cannot change the new question controls');


} finally { await browser.close(); }
