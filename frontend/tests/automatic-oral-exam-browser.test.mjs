// Synthetic browser state-machine checks: no real devices, model, avatar or database.
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
import {createRoot} from 'react-dom/client'; import './src/index.css'; import './src/pages/student/StudentExam.css'; import './src/pages/student/examiner-workspace.css'; import AutomaticOralExam from './src/components/exam/AutomaticOralExam';
function Harness(){const[sequence,setSequence]=useState(1);const[disabled,setDisabled]=useState(false);
window.advance=()=>setSequence(n=>n+1);window.disable=()=>setDisabled(true);
return <div className="student-exam-page student-exam-active"><header className="student-exam-header">
<div className="student-exam-logo"><span style={{color:'#7751bd'}}>◉</span><strong>OralExam AI</strong></div>
<p className="student-exam-title">Introduction to Computer Science · Oral examination</p>
<div className="exam-header-controls"><div className="exam-timer-chip"><span>Time elapsed</span><strong>02:50</strong></div><div className="exam-timer-chip"><span>Time limit</span><strong>None</strong></div></div></header>
<main className="student-exam-content student-exam-stage-content"><AutomaticOralExam sessionId="synthetic-session" token="synthetic-token" sequence={sequence}
question={'Synthetic question '+sequence} disabled={disabled} flashhead={window.scenario==='flashhead'||window.scenario==='captions-flashhead'}
stream={null} preferences={{volume:70,avatar:'guide',background:'neutral',speed:1,textSize:16,reducedMotion:false}}
onTiming={value=>window.events.push('timing')} onMediaElement={()=>{}}
onAnswer={(text,metadata)=>{window.answers.push({text,metadata});window.events.push('answer:'+sequence);
 if(window.scenario==='followup'&&sequence===1)setSequence(2);else setDisabled(true);}}/>
<details className="exam-response-panel exam-capture-panel"><summary>Camera, microphone and live viewing</summary><p>Synthetic media preview</p></details>
<details className="exam-response-panel exam-recovery-panel"><summary>Accessibility and recovery</summary><p>Use keyboard controls or recover your audio.</p></details>
<div className="exam-end-actions"><button className="exam-end-button">End exam</button></div></main></div>;}
createRoot(document.getElementById('root')).render(<Harness/>);`, resolveDir: frontend, loader: 'tsx' },
bundle: true, write: false, outdir: 'oral-memory', jsx: 'automatic', logLevel: 'silent',
define: { 'process.env.NODE_ENV': '"test"' }, plugins: [{ name:'synthetic-capture', setup(build){
  build.onLoad({filter:/oralCapture\.ts$/},()=>({loader:'ts',contents:`
export async function captureOralAnswer(stream,signal,onLevel){
 window.events.push('listen'); if(window.playing)throw Error('Listening while examiner is speaking');
 if(signal.aborted)throw new DOMException('Cancelled','AbortError');
 const value=window.captureQueue.shift();
 if(value==='CAPTURE_ERROR')throw Error('Synthetic microphone disconnected');
 if(value===undefined)return await new Promise((resolve,reject)=>signal.addEventListener('abort',()=>{
   window.events.push('capture-cancelled');reject(new DOMException('Cancelled','AbortError'));},{once:true}));
 onLevel(.5);return value===null?null:new Blob([value],{type:'audio/webm'});
}` }));
}}] });
const script=bundle.outputFiles.find(file=>file.path.endsWith('.js')).text;
const styles=bundle.outputFiles.find(file=>file.path.endsWith('.css'))?.text||'';
let savedBackground='neutral', environmentLocked=false, environmentFailure=false;
const browser=await chromium.launch({headless:true,executablePath:process.env.AVATAR_CHROME_PATH
  ||(process.platform==='win32'?'C:/Program Files/Google/Chrome/Application/chrome.exe':undefined)});
const context=await browser.newContext({viewport:{width:1440,height:1100}});
await context.addInitScript(()=>{
 window.scenario=new URL(location.href).searchParams.get('case')||'clear';window.events=[];window.answers=[];window.playing=false;
 const queues={clear:['Understandable answer'],followup:['First answer','Follow-up answer'],unclear:['gibberish','Clear answer'],
 silence:[null,null,null],skip:['move on'],repeat:['repeat the question','Final answer'],clarify:['can you clarify','Final answer'],
 denied:['can you clarify','Final answer'],failure:['Clear answer'],late:['Late answer'],captureError:['CAPTURE_ERROR'],
 captions:['Recognized caption test answer'],'captions-flashhead':['Recognized avatar answer'],flashhead:['Clear answer']};queues['blocked-playback']=['Recovered answer'];window.captureQueue=queues[window.scenario]||[];
 const nativeTimeout=window.setTimeout.bind(window);
 window.setTimeout=(fn,ms,...args)=>nativeTimeout(fn,ms===1000?5:(window.scenario==='stalled-playback'&&ms===30000)||(window.scenario==='hung-generation'&&ms===45000)?200:ms,...args);
 Object.defineProperty(HTMLMediaElement.prototype,'src',{configurable:true,get(){return this.syntheticSrc||'';},set(value){this.syntheticSrc=value;}});
 HTMLMediaElement.prototype.play=function(){window.events.push('play');window.playing=true;
   window.playCalls=(window.playCalls||0)+1;if(window.scenario==='stalled-playback')return new Promise(()=>{});
   if(window.scenario==='blocked-playback'&&window.playCalls===1)return Promise.reject(new DOMException('Gesture required','NotAllowedError'));
   return new Promise(resolve=>{const finish=()=>{window.playing=false;this.dispatchEvent(new Event('ended'));};if(window.scenario.startsWith('captions'))window.finishPlayback=finish;else nativeTimeout(finish,10);resolve();});};
 HTMLMediaElement.prototype.pause=function(){window.playing=false;};
 Object.defineProperty(navigator,'mediaDevices',{value:{getUserMedia(){throw Error('Real devices forbidden');}},configurable:true});
});
const page=await context.newPage();page.setDefaultTimeout(6000);
const errors=[];page.on('pageerror',error=>errors.push(error.message));
let scenario='clear', utterances=[], assessments=0, completes=0, transcriptions=0;
const state=(sequence)=>({session_id:'synthetic-session',question_sequence_num:sequence,mode:'assessed',
 server_now:new Date().toISOString(),deadline:null,question_deadline:null,pause_until:null,
 actions:scenario==='denied'?{}:{repeat:{limit:2,used:0,remaining:2,timerContinues:true},clarification:{limit:1,used:0,remaining:1,timerContinues:true}}});
await page.route('**/*',async route=>{
 const request=route.request(),url=new URL(request.url());
 const json=(body,status=200)=>route.fulfill({status,contentType:'application/json',body:JSON.stringify(body)}).catch(()=>{});
 if(url.pathname==='/bundle.css')return route.fulfill({contentType:'text/css',body:styles});
 if(url.pathname==='/bundle.js')return route.fulfill({contentType:'application/javascript',body:script});
 if(url.pathname.endsWith('/presentation')) {
   assert.equal(request.headers().authorization,'Bearer synthetic-token');
   if(request.method()==='PUT') {
     if(environmentFailure)return json({detail:'Synthetic save failure'},503);
     savedBackground=request.postDataJSON().background;
   }
   const backgrounds=environmentLocked?['neutral']:['neutral','library','classroom','office','nature'];
   return json({session_id:'synthetic-session',revision:1,voice_profile:'clear',policy:{
     defaults:{avatar:'guide',background:'neutral',customAvatar:null,customBackground:null,voiceLabel:'Clear voice',speed:1,reducedMotion:false,animation:false},
     allowAvatar:false,allowBackground:!environmentLocked,allowSpeed:false,
     avatarChoices:[{id:'guide',label:'Guide examiner'}],backgroundChoices:backgrounds.map(id=>({id,label:id+' background'})),minSpeed:1,maxSpeed:1},
     preferences:{avatar:'guide',background:environmentLocked?'neutral':savedBackground,volume:70,textSize:16,reducedMotion:false,speed:1}});
 }
 if(url.pathname.endsWith('/speech/capabilities'))return json({transcription:{available:true,accepted_mime_types:['audio/webm']},synthesis:{available:true}});
 if(url.pathname.endsWith('/speech/utterance')){const body=request.postDataJSON();utterances.push(body);if(scenario==='hung-generation')return;
   assert.equal(request.headers().authorization,'Bearer synthetic-token');
   return route.fulfill({contentType:'audio/wav',body:Buffer.from('synthetic-wave')});}
 if(url.pathname.endsWith('/idle'))return json({url:''});
 if(url.pathname.endsWith('/speak'))return route.fulfill({contentType:'application/x-ndjson',body:
   JSON.stringify({type:'clip',url:'/api/avatar/media/synthetic.mp4',text:'Synthetic spoken clip'})+'\n'+JSON.stringify({type:'done'})+'\n'});
 if(url.pathname.endsWith('/speech/transcribe')){transcriptions++;const id=url.searchParams.get('request_id');
   if(scenario==='late')await new Promise(resolve=>setTimeout(resolve,200));
   return json({request_id:id,transcript_draft_id:id,transcript_receipt:'synthetic-receipt',interaction_id:'synthetic-interaction',
     question_revision:'synthetic-revision',sequence_num:Number(url.searchParams.get('sequence_num')),text:request.postData(),
     source:'machine_draft',status:'review_required'});}
 if(url.pathname.endsWith('/speech/assess')){assessments++;const body=request.postDataJSON();
   if(scenario==='failure')return json({detail:'Synthetic Ollama unavailable'},503);
   return json({request_id:body.request_id,sequence_num:body.sequence_num,decision:body.machine_draft==='gibberish'?'unclear':'clear'});}
 if(url.pathname.endsWith('/assistance')){if(request.method()==='GET')return json(state(1));const body=request.postDataJSON();return json({...state(1),request_id:body.request_id,action:body.action,status:'succeeded',text:'Synthetic assistance'});}
 if(url.pathname.includes('/assistance/')){const body=request.postDataJSON();const id=url.pathname.split('/').at(-2);
   if(url.pathname.endsWith('/complete')){completes++;return json({...state(1),request_id:id,action:'clarification',status:'succeeded',text:'Synthetic clarification'});}
   return json({...state(1),request_id:body.request_id,action:url.pathname.split('/').at(-1),status:'succeeded',text:'Synthetic assistance'});}
 if(url.pathname.startsWith('/api/'))throw Error('Unexpected API '+url.pathname);
 return route.fulfill({contentType:'text/html',body:'<link rel="stylesheet" href="/bundle.css"><div id="root"></div><script src="/bundle.js"></script>'});
});
async function open(name){scenario=name;utterances=[];assessments=0;completes=0;transcriptions=0;
 await page.goto('http://127.0.0.1:52393/?case='+name);}
async function answered(){await page.waitForFunction(()=>window.answers.length>0);return page.evaluate(()=>window.answers);}
try{
 for(const mode of ['captions','captions-flashhead']) {
   await open(mode);await page.getByRole('region',{name:'Examiner captions overlay',exact:true}).waitFor();
   const select=page.getByRole('combobox',{name:'Exam environment',exact:true});
   const plays=await page.evaluate(()=>window.playCalls);
   const video=await page.locator('.automatic-examiner-stage > video').elementHandle();
   const styles=new Set();
   for(const background of ['neutral','library','classroom','office','nature']) {
     await select.selectOption(background);
     await page.waitForFunction(bg=>document.querySelector('[data-background]')?.dataset.background===bg,background);
     styles.add(await page.locator('[data-background]').evaluate(el=>getComputedStyle(el).backgroundImage));
   }
   assert.equal(styles.size,5);assert.equal(await page.evaluate(()=>window.playCalls),plays);
   assert.equal(await page.locator('.automatic-examiner-stage > video').evaluate((el,old)=>el===old,video),true);
   assert.equal(await page.evaluate(()=>window.events.includes('listen')),false);
   assert.equal(await page.getByRole('img',{name:'Static faceless examiner'}).count(),mode==='captions'?1:0);
   const frame=await page.locator('[data-background]').boundingBox();
   assert.ok(frame.width>0&&frame.height>0);
   if(mode==='captions-flashhead') {
     const clip=await page.locator('.automatic-examiner-video').boundingBox();
     assert.ok(clip.width<frame.width&&clip.height<frame.height);
   }
   await page.screenshot({path:path.join(frontend,'../.cache/environment-'+mode+'.png'),fullPage:true});
   await page.reload();await select.waitFor();assert.equal(await select.inputValue(),'nature');
   environmentFailure=true;await select.selectOption('office');await page.getByText('Environment could not be saved.',{exact:false}).waitFor();
   assert.equal(await select.inputValue(),'nature');environmentFailure=false;
   await page.setViewportSize({width:390,height:844});
   assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
   await page.setViewportSize({width:1280,height:900});
 }
 environmentLocked=true;await open('captions');await page.getByText('Your professor has fixed the exam environment.').waitFor();
 assert.equal(await page.getByRole('combobox',{name:'Exam environment'}).count(),0);environmentLocked=false;
 console.log('PASS five environments with FlashHead on/off, persistent selection, save failure, professor locks, mobile bounds and uninterrupted playback');
 await open('clear');let answers=await answered();assert.equal(answers[0].metadata.input_source,'automatic_transcript');
 assert.equal(answers[0].text,'Understandable answer');assert.equal(assessments,1);
 assert.ok(await page.getByRole('region',{name:'What the examiner heard',exact:true}).innerText().then(text=>text.includes('Understandable answer')));
 let events=await page.evaluate(()=>window.events);assert.ok(events.indexOf('play')<events.indexOf('listen'));
 assert.equal(await page.getByRole('textbox').count(),0);assert.equal(utterances[0].kind,'question');
 console.log('PASS placeholder speech, playback before listening, Ollama check and automatic provenance without clicks');
 await open('followup');await page.waitForFunction(()=>window.answers.length===2);
 assert.deepEqual(utterances.map(x=>x.sequence_num),[1,2]);console.log('PASS server-delivered follow-up runs the same automatic oral loop');
 await open('unclear');answers=await answered();assert.equal(answers.length,1);assert.equal(answers[0].text,'Clear answer');
 assert.deepEqual(utterances.map(x=>x.kind),['question','retry']);assert.equal(assessments,2);
 assert.ok((await page.getByRole('log',{name:'Recognized speech'}).innerText()).includes('gibberish'));
 console.log('PASS unintelligible response prompts aloud and listens again without submitting gibberish; transcript panel retains heard attempts');
 await open('silence');answers=await answered();assert.equal(answers[0].metadata.input_source,'unanswered_voice');
 assert.deepEqual(utterances.map(x=>x.kind),['question','silence','silence','move_on']);assert.equal(transcriptions,0);
 await open('skip');answers=await answered();assert.equal(answers[0].metadata.input_source,'unanswered_voice');assert.equal(assessments,0);
 console.log('PASS bounded silence retries and explicit spoken move-on record unanswered provenance');
 for(const name of ['repeat','clarify','denied']){await open(name);answers=await answered();
  assert.equal(answers[0].text,'Final answer');assert.equal(completes,name==='denied'?0:1);
  assert.equal(utterances[1].kind,name==='denied'?'assistance_unavailable':'assistance');}
 console.log('PASS spoken assistance obeys saved allowances and releases the reading pause before listening');
 await open('failure');await page.getByRole('alert').waitFor();assert.equal(await page.evaluate(()=>window.answers.length),0);
 await open('captureError');await page.getByRole('alert').waitFor();assert.equal(await page.evaluate(()=>window.answers.length),0);
 console.log('PASS model and device failures stop without inventing or submitting an answer');
 await open('late');await page.waitForFunction(()=>window.events.includes('listen'));await page.evaluate(()=>window.disable());
 await page.waitForTimeout(300);assert.equal(await page.evaluate(()=>window.answers.length),0);
 assert.equal(await page.getByRole('log',{name:'Recognized speech'}).getByText('Late answer',{exact:true}).count(),0);
 console.log('PASS interruption cancels the turn and discards late transcription');
 await open('flashhead');await answered();assert.equal(utterances.length,0);
 console.log('PASS enabled FlashHead uses matching audio/video clips');
 await page.evaluate(()=>localStorage.removeItem('oralexam_captions_enabled'));
 await open('captions');await page.getByRole('region',{name:'Examiner captions overlay',exact:true}).waitFor();
 const toggle=page.getByRole('button',{name:'Examiner captions',exact:true});
 assert.equal(await toggle.getAttribute('aria-pressed'),'true');
 assert.equal(await page.getByRole('region',{name:'Examiner captions overlay',exact:true}).innerText(),'Synthetic question 1');
 await toggle.click();assert.equal(await page.getByRole('region',{name:'Examiner captions overlay',exact:true}).count(),0);
 assert.equal(utterances.length,1);await toggle.click();
 assert.equal(await page.getByRole('region',{name:'Examiner captions overlay',exact:true}).count(),1);assert.equal(utterances.length,1);
 await page.screenshot({path:path.join(frontend,'../.cache/oral-captions-overlay.png'),fullPage:true});
 await page.evaluate(()=>window.finishPlayback());await answered();
 assert.ok((await page.getByRole('log',{name:'Recognized speech'}).innerText()).includes('Recognized caption test answer'));
 await page.screenshot({path:path.join(frontend,'../.cache/oral-heard-panel.png'),fullPage:true});
 await toggle.click();await open('captions');await page.waitForFunction(()=>document.querySelector('[data-phase="speaking"]'));
 assert.equal(await toggle.getAttribute('aria-pressed'),'false');
 assert.equal(await page.getByRole('region',{name:'Examiner captions overlay',exact:true}).count(),0);
 await toggle.click();await page.evaluate(()=>window.finishPlayback());await answered();
 await open('captions-flashhead');await page.getByRole('region',{name:'Examiner captions overlay',exact:true}).waitFor();
 assert.equal(await page.getByRole('region',{name:'Examiner captions overlay',exact:true}).innerText(),'Synthetic spoken clip');
 assert.equal(utterances.length,0);await page.evaluate(()=>window.finishPlayback());await answered();
 console.log('PASS captions overlay toggles without speech restarts, persists its setting, and works independently over placeholder and avatar video');
 await open('blocked-playback');await page.getByRole('button',{name:'Play examiner audio',exact:true}).click();
 answers=await answered();assert.equal(answers[0].text,'Recovered answer');assert.equal(utterances.length,1);
 assert.equal(await page.evaluate(()=>window.playCalls),2);
 await open('stalled-playback');await page.getByRole('alert').waitFor();
 assert.equal(await page.evaluate(()=>window.answers.length),0);assert.equal(await page.evaluate(()=>window.events.includes('listen')),false);
 await open('hung-generation');await page.getByRole('alert').waitFor();
 assert.equal(await page.evaluate(()=>window.events.includes('play')),false);
 console.log('PASS blocked playback resumes the same clip; hung playback and synthesis are bounded without recording an invented answer');
 await open('listening-preview');await page.waitForFunction(()=>document.querySelector('[data-phase="listening"]'));
 await page.screenshot({path:path.join(frontend,'../.cache/automatic-oral-placeholder.png'),fullPage:true});
 await page.screenshot({path:path.join(frontend,'../.cache/examiner-polish-desktop.png'),fullPage:true});
 const stage=await page.locator('.automatic-examiner-stage').boundingBox();
 const transcript=await page.getByRole('region',{name:'What the examiner heard',exact:true}).boundingBox();
 assert.ok(stage.width<=960&&stage.x>0&&transcript.y>stage.y+stage.height);
 for(const width of [390,760]) {
   await page.setViewportSize({width,height:1000});
   assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
   await page.screenshot({path:path.join(frontend,'../.cache/examiner-polish-'+width+'.png'),fullPage:true});
 }
 console.log('PASS polished workspace desktop/mobile bounds and stage-before-transcript layout (synthetic header/supporting-panel scaffold)');

 assert.deepEqual(errors,[]);
}catch(error){console.log('FAIL STATE',await page.evaluate(()=>({events:window.events,answers:window.answers,text:document.body.innerText})),{utterances,assessments,errors});throw error;}finally{await context.close();await browser.close();}
