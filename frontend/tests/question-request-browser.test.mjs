// Mocked request races across selected exams. Held completions deliberately
// ignore abort so exam/generation guards, not network timing, determine results.
import assert from'node:assert/strict';
import{createRequire}from'node:module';
import path from'node:path';
import{fileURLToPath}from'node:url';
import{build}from'esbuild';
const require=createRequire(process.env.AVATAR_NODE_MODULES_PATH?path.join(path.resolve(process.env.AVATAR_NODE_MODULES_PATH),'package.json'):import.meta.url);
const{chromium}=require('playwright');
const frontend=fileURLToPath(new URL('..',import.meta.url));
const A='20000000-0000-4000-8000-000000000001',B='20000000-0000-4000-8000-000000000002';
const bundle=await build({stdin:{contents:`import React,{useState}from'react';import{createRoot}from'react-dom/client';
import Drafts from'./src/components/exam/QuestionDrafts';import Bank from'./src/pages/professor/QuestionBank';
function Harness(){const[exam,setExam]=useState('${A}');window.approvals??=[];
window.switchExam=id=>{history.pushState({},'',location.pathname.replace(exam,id)+location.search);setExam(id);};
return location.search.includes('bank=1')?<div data-exam={exam}><Bank/></div>:<Drafts examId={exam} onApproved={async()=>window.approvals.push(exam)}/>;}
createRoot(document.getElementById('root')).render(<Harness/>);`,resolveDir:frontend,loader:'tsx'},
bundle:true,write:false,outdir:'question-request-memory',jsx:'automatic',define:{'process.env.NODE_ENV':'"test"'},logLevel:'silent'});
const script=bundle.outputFiles.find(file=>file.path.endsWith('.js')).text;
const browser=await chromium.launch({headless:true,args:['--mute-audio'],executablePath:process.env.AVATAR_CHROME_PATH||(process.platform==='win32'?'C:/Program Files/Google/Chrome/Application/chrome.exe':undefined)});
const page=await browser.newPage();page.setDefaultTimeout(6000);
const errors=[];page.on('pageerror',error=>errors.push(error.message));
await page.addInitScript(({A})=>{
window.delayExamOperation=new URL(location.href).searchParams.get('hold')??'';
window.delayedExamReady=false;window.approvals=[];window.alerts=[];
window.alert=value=>window.alerts.push(value);window.confirm=()=>true;
const original=window.fetch.bind(window);
window.fetch=async(...arguments_)=>{
const response=await original(...arguments_);const url=String(arguments_[0]),method=arguments_[1]?.method??'GET';
const operation=method==='PUT'&&url.endsWith('/question-drafts/context')?'context-save':
method==='GET'&&url.endsWith('/question-drafts/context')?'context-load':
url.endsWith('/question-drafts/generate')?'generate':url.endsWith('/approve')?'approve':url.endsWith('/reject')?'reject':
method==='GET'&&url.endsWith('/question-drafts')?'draft-load':method==='POST'&&url.endsWith('/questions')?'upload':
method==='DELETE'&&url.includes('/questions/')?'delete':method==='GET'&&url.endsWith('/questions')?'bank-load':'';
if(url.includes(A)&&operation&&operation===window.delayExamOperation){
const body=await response.text(),status=response.status;window.delayedExamReady=true;
await new Promise(resolve=>{window.releaseExamResponse=resolve;});
return new Response(body,{status,headers:{'Content-Type':'application/json'}});
}return response;
};
},{A});
const requests=[];let failLate=false,contextSaves=[];
function owner(id){return id===A?'Alpha':'Beta';}
function draft(id){return{id:`draft-${id}`,question_text:`${owner(id)} pending question?`,topic:owner(id),difficulty:3,status:'pending',approved_question_id:null};}
function context(id){return{topic_coverage_required:[owner(id)],rubric:{criteria:[{name:`${owner(id)} rubric`,description:'Synthetic context.',max_score:5}]},context_hash:(id===A?'a':'b').repeat(64),can_edit:true};}
await page.route('**/*',async route=>{
const request=route.request(),url=new URL(request.url());const json=(value,status=200)=>route.fulfill({status,contentType:'application/json',body:JSON.stringify(value)});
if(url.pathname.endsWith('/bundle.js'))return route.fulfill({contentType:'application/javascript',body:script});
if(!url.pathname.startsWith('/api/'))return route.fulfill({contentType:'text/html',body:'<!doctype html><html><body><div id="root"></div><script src="/bundle.js"></script></body></html>'});
requests.push({path:url.pathname,method:request.method()});
const id=url.pathname.includes(A)?A:B;
if(url.pathname.endsWith('/question-drafts/context')){
if(request.method()==='PUT'){contextSaves.push({exam:id,body:request.postDataJSON()});if(failLate)return json({detail:'Late old-exam context error'},503);}
return json(context(id));
}
if(url.pathname.endsWith('/question-drafts'))return json({topics:[owner(id)],can_edit:true,drafts:[draft(id)]});
if(url.pathname.endsWith('/question-drafts/generate'))return failLate?json({detail:'Late old-exam generation error'},503):json({status:'ready',drafts:[draft(id)]});
if(url.pathname.endsWith('/approve')||url.pathname.endsWith('/reject'))return failLate?json({detail:'Late old-exam review error'},503):json({status:url.pathname.endsWith('/approve')?'approved':'rejected'});
if(url.pathname.endsWith('/questions')){
if(request.method()==='POST')return json({questions_added:1,filename:'synthetic.txt'});
return json([{id:`question-${id}`,question_text:`${owner(id)} saved bank question`,topic:owner(id),difficulty:3,created_at:'2026-11-16T12:00:00Z'}]);
}
if(request.method()==='DELETE'&&url.pathname.includes('/questions/'))return failLate?json({detail:'Late old-exam delete error'},503):json({message:'Deleted'});
throw Error(`Unexpected mocked API ${request.method()} ${url.pathname}`);
});
async function visit({bank=false,hold=''}={}){
failLate=false;contextSaves=[];
await page.goto(`http://127.0.0.1:52395/professor/exams/${A}/questions?bank=${bank?1:0}&hold=${hold}`);
}
async function hold(operation){await page.evaluate(value=>{window.delayExamOperation=value;window.delayedExamReady=false;},operation);}
async function switchAndRelease({bank=false}={}){
await page.waitForFunction(()=>window.delayedExamReady);
await page.evaluate(id=>window.switchExam(id),B);
if(bank)await page.getByRole('heading',{name:'Beta saved bank question',exact:true}).waitFor();
else await page.getByRole('combobox',{name:'Draft topic',exact:true}).waitFor();
const oldReads=requests.filter(item=>item.path.includes(A)&&item.method==='GET').length;
await page.evaluate(()=>window.releaseExamResponse());await page.waitForTimeout(70);
assert.equal(requests.filter(item=>item.path.includes(A)&&item.method==='GET').length,oldReads);
assert.deepEqual(await page.evaluate(()=>window.approvals),[]);
assert.equal(await page.getByRole('alert').count(),0);
assert.equal(await page.getByText('Drafts are ready for your review. No question was added to the exam.').count(),0);
assert.equal(await page.getByText('Approved question added to the saved bank. Publishing remains a separate action.').count(),0);
}
try{
await visit({hold:'context-load'});
await switchAndRelease();
await page.getByText('Professor topics and assessment rubric',{exact:true}).click();
assert.equal(await page.getByRole('textbox',{name:'Exam topics, one per line'}).inputValue(),'Beta');
assert.equal(await page.getByRole('textbox',{name:'Criterion 1 name',exact:true}).inputValue(),'Beta rubric');
await page.getByRole('button',{name:'Save topics and rubric',exact:true}).click();
await page.getByText('Topics and rubric saved for this unpublished exam. Publishing remains a separate action.').waitFor();
assert.equal(contextSaves.at(-1).exam,B);assert.equal(contextSaves.at(-1).body.expected_context_hash,'b'.repeat(64));
console.log('PASS late context read cannot replace new exam topics/rubric/hash or redirect its explicit save');

await visit();await page.getByText('Professor topics and assessment rubric',{exact:true}).click();
await page.getByRole('textbox',{name:'Exam topics, one per line'}).waitFor();
await hold('context-save');
await page.getByRole('button',{name:'Save topics and rubric',exact:true}).click();
await switchAndRelease();
assert.equal(await page.getByRole('textbox',{name:'Exam topics, one per line'}).inputValue(),'Beta');
assert.equal(await page.getByText('Topics and rubric saved for this unpublished exam. Publishing remains a separate action.').count(),0);
console.log('PASS late context save cannot replace new exam editor, invoke old reload or publish a success notice');

for(const operation of ['draft-load','generate','approve','reject','generation-error']){
await visit(operation==='draft-load'?{hold:'draft-load'}:{});
if(operation!=='draft-load'){
await page.getByRole('button',{name:'Generate drafts',exact:true}).waitFor();
await hold(operation==='generation-error'?'generate':operation);
if(operation==='generation-error')failLate=true;
if(operation==='generate'||operation==='generation-error')await page.getByRole('button',{name:'Generate drafts',exact:true}).click();
else await page.getByRole('button',{name:operation==='approve'?'Approve into question bank':'Reject draft',exact:true}).click();
}
await switchAndRelease();
assert.equal(await page.getByRole('textbox',{name:'Question text',exact:true}).inputValue(),'Beta pending question?');
assert.equal(await page.getByRole('button',{name:'Generate drafts',exact:true}).isEnabled(),true);
}
console.log('PASS late draft reads/generation/approval/rejection/errors stay scoped to their original exam with no old callback');

await visit({bank:true,hold:'bank-load'});await switchAndRelease({bank:true});
assert.equal(await page.getByRole('heading',{name:'Alpha saved bank question',exact:true}).count(),0);
console.log('PASS parent saved-bank load cannot overwrite the newly selected exam');

for(const operation of ['upload','delete']){
await visit({bank:true});await page.getByRole('heading',{name:'Alpha saved bank question',exact:true}).waitFor();
await hold(operation);
if(operation==='upload')await page.locator('input[type=file]').setInputFiles({name:'synthetic.txt',mimeType:'text/plain',buffer:Buffer.from('Synthetic uploaded question?')});
else {failLate=true;await page.getByRole('button',{name:'Delete',exact:true}).click();}
await switchAndRelease({bank:true});
assert.equal(await page.getByRole('heading',{name:'Beta saved bank question',exact:true}).count(),1);
assert.deepEqual(await page.evaluate(()=>window.alerts),[]);
}
assert.deepEqual(errors,[]);
console.log('PASS late parent upload/delete completions cannot reload, alert or alter another exam bank');
}finally{await browser.close();}
