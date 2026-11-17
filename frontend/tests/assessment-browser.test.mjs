// In-memory professor assessment UI; all HTTP/model operations are mocked.
// No real student session, service, model, recording or private data is used.
import assert from 'node:assert/strict';
import {createRequire}from'node:module';
import path from'node:path';
import{fileURLToPath}from'node:url';
import{build}from'esbuild';
const require=createRequire(process.env.AVATAR_NODE_MODULES_PATH?path.join(path.resolve(process.env.AVATAR_NODE_MODULES_PATH),'package.json'):import.meta.url);
const{chromium}=require('playwright');
const frontend=fileURLToPath(new URL('..',import.meta.url));
const bundle=await build({stdin:{contents:`import React,{useState} from'react';import{createRoot}from'react-dom/client';
import Assessment from'./src/components/exam/ProvisionalAssessment';
function Harness(){const[session,setSession]=useState('synthetic-assessment');window.switchAssessment=setSession;
window.assessmentCallbacks??=[];
return <Assessment sessionId={session} onConfirmed={status=>window.assessmentCallbacks.push({session,status})}/>;}
createRoot(document.getElementById('root')).render(<Harness/>);`,resolveDir:frontend,loader:'tsx'},
bundle:true,write:false,outdir:'assessment-memory',jsx:'automatic',define:{'process.env.NODE_ENV':'"test"'},logLevel:'silent'});
const script=bundle.outputFiles.find(file=>file.path.endsWith('.js')).text;
const browser=await chromium.launch({headless:true,args:['--mute-audio'],executablePath:process.env.AVATAR_CHROME_PATH||(process.platform==='win32'?'C:/Program Files/Google/Chrome/Application/chrome.exe':undefined)});
const page=await browser.newPage();page.setDefaultTimeout(6000);
await page.addInitScript(()=>{
  const nativeFetch=window.fetch.bind(window);
  window.delayAssessmentOperation='';window.delayedAssessmentReady=false;
  window.fetch=async(...arguments_)=>{
    const response=await nativeFetch(...arguments_);
    const url=String(arguments_[0]);
    const operation=url.endsWith('/exam/grade')?'generate':url.endsWith('/grades')?'confirm':url.endsWith('/synthetic-assessment/report')?'load':'';
    if(operation && operation===window.delayAssessmentOperation){
      const body=await response.text(); // Response is complete before holding its continuation.
      const status=response.status;window.delayedAssessmentReady=true;
      await new Promise(resolve=>{window.releaseAssessmentResponse=resolve;});
      // Deliberately ignore later abort to simulate an already queued completion.
      return new Response(body,{status,headers:{'Content-Type':'application/json'}});
    }
    return response;
  };
});

const errors=[];page.on('pageerror',error=>errors.push(error.message));
const professor='10000000-0000-4000-8000-000000000001';
let mode='manual',status='pending_grading',grades=[],generated=0,confirmations=[];
const reportRequests=[];
const criteria=[{name:'Accuracy',description:'Explain the base case.',max_score:5},{name:'Reasoning',description:'Explain the recursive step.',max_score:5}];
function report(){return{session:{status,developer_demo:false,recording_status:'completed',recording_expires_at:'2099-11-16T23:59:59Z'},grades,rubric_criteria:criteria,rubric_error:null};}
await page.route('**/*',async route=>{
const request=route.request(),url=new URL(request.url());
const json=(value,code=200)=>route.fulfill({status:code,contentType:'application/json',body:JSON.stringify(value)});
if(url.pathname.endsWith('/bundle.js'))return route.fulfill({contentType:'application/javascript',body:script});
if(!url.pathname.startsWith('/api/'))return route.fulfill({contentType:'text/html',body:'<!doctype html><html><body><div id="root"></div><script src="/bundle.js"></script></body></html>'});
if(url.pathname==='/api/auth/me')return json({role:'professor',professor_id:professor});
if(url.pathname.endsWith('/report')){
reportRequests.push(url.pathname);
if(url.pathname.includes('/new-assessment/'))return json({...report(),grades:[],session:{...report().session,status:'pending_grading'},rubric_criteria:[{name:'New session criterion',max_score:10,description:'New session only.'}]});
if(mode==='fresh-suggestions')return json({...report(),grades:criteria.map(value=>({rubric_criterion:value.name,max_score:value.max_score,score:null,model_suggested_score:4,professor_notes:'[AI rationale] Saved suggestion.'}))});
return mode==='denied'?json({detail:'Session not found'},404):json(report());
}
if(url.pathname==='/api/exam/grade'){
generated++;
if(mode==='outage'||mode==='stale-error')return json({detail:'The evaluation provider timed out. No grades were saved.'},504);
grades=criteria.map((criterion,index)=>({rubric_criterion:criterion.name,max_score:criterion.max_score,model_suggested_score:index?2:4,score:null,professor_notes:'[AI rationale] Synthetic transcript evidence.',graded_at:null}));
return json({session_id:'synthetic-assessment',grades,note:'Suggested scores only.'});
}
if(url.pathname.endsWith('/grades')){
const body=request.postDataJSON();confirmations.push(body);
assert.equal(body.professor_id,professor);
assert.equal(body.grades.length,2);
grades=body.grades.map(value=>({...value,max_score:5,score:value.score,model_suggested_score:grades.find(row=>row.rubric_criterion===value.rubric_criterion)?.model_suggested_score??null,graded_at:'2026-11-16'}));status='graded';
return json({session_status:'graded',grades,total:grades.reduce((sum,item)=>sum+item.score,0),max_total:10,unscored_criteria:0});
}
throw Error(`Unexpected synthetic API ${url.pathname}`);
});
async function visit(nextMode){mode=nextMode;status='pending_grading';grades=[];generated=0;confirmations=[];await page.goto(`http://127.0.0.1:52394/${nextMode}`);}
try{
await visit('manual');
await page.getByRole('spinbutton',{name:'Your score for Accuracy'}).waitFor();
assert.equal(generated,0);assert.equal(confirmations.length,0);
await page.getByRole('spinbutton',{name:'Your score for Accuracy'}).fill('4');
await page.getByRole('spinbutton',{name:'Your score for Reasoning'}).fill('3');
await page.getByRole('textbox',{name:'Professor notes for Accuracy'}).fill('Manual review of synthetic response.');
await page.getByRole('button',{name:'Confirm professor assessment',exact:true}).click();
await page.getByText('Professor assessment confirmed and saved. AI suggestions remain labeled provisional.').waitFor();
assert.equal(generated,0);assert.equal(confirmations.length,1);assert.equal(confirmations[0].grades[0].score,4);
console.log('PASS complete manual scores and notes confirm explicitly without any model request; actor comes from auth/me');
await visit('provisional');
await page.getByRole('button',{name:'Generate provisional evaluation',exact:true}).click();
await page.getByRole('button',{name:'Use suggestion for Accuracy',exact:true}).waitFor();
assert.equal(generated,1);assert.equal(confirmations.length,0);
assert.equal(await page.getByRole('button',{name:'Generate provisional evaluation',exact:true}).isDisabled(),true);
await page.getByRole('button',{name:'Use suggestion for Accuracy',exact:true}).click();
await page.getByRole('button',{name:'Use suggestion for Reasoning',exact:true}).click();
await page.getByRole('spinbutton',{name:'Your score for Reasoning'}).fill('3');
await page.getByRole('button',{name:'Confirm professor assessment',exact:true}).click();
await page.getByText('Professor assessment confirmed and saved. AI suggestions remain labeled provisional.').waitFor();
assert.equal(confirmations.length,1);assert.equal(confirmations[0].grades[1].score,3);
console.log('PASS private AI generation creates suggestions only; explicit accept/edit and confirmation save professor scores');
await visit('outage');
await page.getByRole('spinbutton',{name:'Your score for Accuracy'}).fill('6');
await page.getByRole('spinbutton',{name:'Your score for Reasoning'}).fill('2');
await page.getByRole('button',{name:'Confirm professor assessment',exact:true}).click();
await page.getByText('Enter an explicit finite score within the displayed bound for every criterion.').waitFor();
assert.equal(confirmations.length,0);
await page.getByRole('spinbutton',{name:'Your score for Accuracy'}).fill('4');
await page.getByRole('button',{name:'Generate provisional evaluation',exact:true}).click();
await page.getByText('The evaluation provider timed out. No grades were saved.').waitFor();
assert.equal(await page.getByRole('spinbutton',{name:'Your score for Accuracy'}).inputValue(),'4');
await page.getByRole('button',{name:'Confirm professor assessment',exact:true}).click();
await page.getByText('Professor assessment confirmed and saved. AI suggestions remain labeled provisional.').waitFor();
assert.equal(confirmations.length,1);
console.log('PASS out-of-bound score blocked before API; provider timeout preserves manual drafts and manual confirmation remains available');
await visit('denied');
await page.getByText('Session not found',{exact:true}).waitFor();
assert.equal(await page.getByRole('button',{name:'Confirm professor assessment',exact:true}).count(),0);
assert.equal(await page.getByRole('spinbutton').count(),0);
assert.deepEqual(errors,[]);
console.log('PASS inaccessible private report exposes no grading fields or mutation controls');
await visit('fresh-suggestions');
await page.getByRole('button',{name:'Use suggestion for Accuracy',exact:true}).waitFor();
assert.equal(await page.getByRole('spinbutton',{name:'Your score for Accuracy'}).inputValue(),'');
assert.equal(await page.getByRole('spinbutton',{name:'Your score for Reasoning'}).inputValue(),'');
await page.getByRole('button',{name:'Use suggestion for Accuracy',exact:true}).click();
assert.equal(await page.getByRole('spinbutton',{name:'Your score for Accuracy'}).inputValue(),'4');
assert.equal(confirmations.length,0);assert.equal(generated,0);
console.log('PASS fresh saved suggestions remain unaccepted until explicit Use suggestion action');

await visit('stale-load');
// A reload lookup is held after its body has completed, so abort alone cannot
// suppress it; the component must retain the initiating session/generation.
await page.getByRole('spinbutton',{name:'Your score for Accuracy'}).waitFor();
await page.evaluate(()=>{window.delayAssessmentOperation='load';window.delayedAssessmentReady=false;});
await page.getByRole('button',{name:'Reload assessment',exact:true}).click();
await page.waitForFunction(()=>window.delayedAssessmentReady);
await page.evaluate(()=>window.switchAssessment('new-assessment'));
await page.getByRole('spinbutton',{name:'Your score for New session criterion'}).waitFor();
await page.evaluate(()=>window.releaseAssessmentResponse());
await page.waitForTimeout(100);
assert.equal(await page.getByRole('spinbutton',{name:'Your score for Accuracy'}).count(),0);
assert.equal(await page.getByRole('spinbutton',{name:'Your score for New session criterion'}).count(),1);
console.log('PASS late report completion cannot replace a newly selected session');

for(const operation of ['generate','confirm','stale-error']){
await visit(operation==='stale-error'?'stale-error':`stale-${operation}`);
await page.getByRole('spinbutton',{name:'Your score for Accuracy'}).waitFor();
await page.evaluate(value=>{window.delayAssessmentOperation=value;window.delayedAssessmentReady=false;},operation==='confirm'?'confirm':'generate');
if(operation==='confirm'){
await page.getByRole('spinbutton',{name:'Your score for Accuracy'}).fill('4');
await page.getByRole('spinbutton',{name:'Your score for Reasoning'}).fill('3');
await page.getByRole('button',{name:'Confirm professor assessment',exact:true}).click();
}else await page.getByRole('button',{name:'Generate provisional evaluation',exact:true}).click();
await page.waitForFunction(()=>window.delayedAssessmentReady);
await page.evaluate(()=>window.switchAssessment('new-assessment'));
await page.getByRole('spinbutton',{name:'Your score for New session criterion'}).waitFor();
const oldLookups=reportRequests.filter(url=>url.includes('/synthetic-assessment/')).length;
await page.evaluate(()=>window.releaseAssessmentResponse());
await page.waitForTimeout(100);
assert.equal(reportRequests.filter(url=>url.includes('/synthetic-assessment/')).length,oldLookups);
assert.equal(await page.getByRole('spinbutton',{name:'Your score for Accuracy'}).count(),0);
assert.equal(await page.getByRole('spinbutton',{name:'Your score for New session criterion'}).count(),1);
assert.equal(await page.getByRole('button',{name:'Generate provisional evaluation',exact:true}).isEnabled(),true);
assert.deepEqual(await page.evaluate(()=>window.assessmentCallbacks),[]);
assert.equal(await page.getByText('Professor assessment confirmed and saved. AI suggestions remain labeled provisional.').count(),0);
assert.equal(await page.getByText('Private AI suggestions are ready. Review every criterion and explicitly confirm your scores.').count(),0);
assert.equal(await page.getByRole('alert').count(),0);
}
assert.deepEqual(errors,[]);
console.log('PASS late generation, confirmation and provider-error completions cannot reload old sessions, change notices or invoke callbacks');

}finally{await browser.close();}
