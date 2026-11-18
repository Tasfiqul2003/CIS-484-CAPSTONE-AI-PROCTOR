// In-memory professor question-bank exercise: all APIs and generation mocked.
// No application server, model, devices, records or infrastructure are touched.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const require = createRequire(process.env.AVATAR_NODE_MODULES_PATH
  ? path.join(path.resolve(process.env.AVATAR_NODE_MODULES_PATH), 'package.json') : import.meta.url);
const { chromium } = require('playwright');
const frontend = fileURLToPath(new URL('..', import.meta.url));
const bundle = await build({ stdin: { contents: `import React from 'react';import{createRoot}from'react-dom/client';
  import QuestionBank from './src/pages/professor/QuestionBank';
  createRoot(document.getElementById('root')).render(<QuestionBank/>);`,resolveDir:frontend,loader:'tsx'},
  bundle:true,write:false,outdir:'question-drafts-memory',jsx:'automatic',
  define:{'process.env.NODE_ENV':'"test"'},logLevel:'silent'});
const script=bundle.outputFiles.find(file=>file.path.endsWith('.js')).text;
const browser=await chromium.launch({headless:true,executablePath:process.env.AVATAR_CHROME_PATH || (process.platform==='win32'?'C:/Program Files/Google/Chrome/Application/chrome.exe':undefined)});
const page=await browser.newPage();page.setDefaultTimeout(6000);
const errors=[];page.on('pageerror',error=>errors.push(error.message));
const exam='20000000-0000-4000-8000-000000000001';
const questions=[{id:'original',question_text:'Original professor-approved bank question',topic:'Recursion',difficulty:3,created_at:'2026-11-16T12:00:00Z'}];
let drafts=[],editable=true,contextFrozen=false,fail=false,drop=false;
const jobs=new Map(),requests=[];
let contextHash='initial-context', savedTopics=['Recursion','Sorting'], savedRubric={criteria:[]};
const contextSaves=[];
await page.route('**/*',async route=>{
  const request=route.request(),url=new URL(request.url());
  const json=(value,status=200)=>route.fulfill({status,contentType:'application/json',body:JSON.stringify(value)});
  if(url.pathname==='/api/auth/me')return json({role:'professor',professor_id:'synthetic-professor'});
if(url.pathname==='/api/auth/professor/exams')return json([{id:exam,title:'Synthetic exam',course:'SYNTH'}]);
if(url.pathname.endsWith('/bundle.js'))return route.fulfill({contentType:'application/javascript',body:script});
  if(!url.pathname.startsWith('/api/'))return route.fulfill({contentType:'text/html',body:'<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script src="/bundle.js"></script></body></html>'});
  if(url.pathname.endsWith('/questions'))return json(questions);
  if(url.pathname.endsWith('/question-drafts/context')){
    if(request.method()==='PUT'){
      const body=request.postDataJSON();contextSaves.push(body);
      if(body.expected_context_hash!==contextHash)return json({detail:'The assessment context changed. Reload it before saving your edits.'},409);
      savedTopics=body.topic_coverage_required;savedRubric=body.rubric;contextHash='saved-context';
    }
    return json({topic_coverage_required:savedTopics,rubric:savedRubric,context_hash:contextHash,can_edit:editable&&!contextFrozen,
      context_locked_after_attempt:contextFrozen,notice:contextFrozen?'Assessment context is fixed after an assessed attempt. Create a new exam to change topics or rubric.':null});
  }
  if(url.pathname.endsWith('/question-drafts'))return json({topics:savedTopics,can_edit:editable,drafts});
  if(url.pathname.endsWith('/question-drafts/generate')){
    const body=request.postDataJSON();requests.push(body);
    if(fail)return json({detail:'The configured local question generator is unavailable. No drafts were approved.'},503);
    if(!jobs.has(body.request_id)){
      const generated=Array.from({length:body.count},(_,index)=>({id:`draft-${jobs.size}-${index}`,request_id:body.request_id,
        question_text:`Synthetic unapproved question ${jobs.size}-${index}?`,topic:body.topic,difficulty:body.difficulty,status:'pending',approved_question_id:null}));
      jobs.set(body.request_id,generated);drafts.push(...generated);
    }
    if(drop){drop=false;return route.abort('failed');}
    return json({request_id:body.request_id,status:'ready',drafts:jobs.get(body.request_id)});
  }
  const review=url.pathname.match(/\/question-drafts\/([^/]+)\/(approve|reject)$/);
  if(review){
    const item=drafts.find(draft=>draft.id===review[1]);
    if(review[2]==='approve'){
      const body=request.postDataJSON();item.status='approved';item.approved_question_id=`question-${item.id}`;
      questions.push({id:item.approved_question_id,...body,created_at:'2026-11-16T12:01:00Z'});
    }else item.status='rejected';
    return json({status:item.status,draft_id:item.id,question_id:item.approved_question_id});
  }
  throw Error(`Unexpected synthetic API ${request.method()} ${url.pathname}`);
});
const saved=page.getByRole('heading',{name:'Saved Questions'}).locator('..').locator('..').locator('.question-count');
try{
  await page.goto(`http://127.0.0.1:52393/professor/exams/${exam}/questions`);
  await page.getByRole('button',{name:'Generate drafts',exact:true}).waitFor();
  await page.getByText('Professor topics and assessment rubric',{exact:true}).click();
  await page.getByRole('textbox',{name:'Exam topics, one per line'}).fill('Recursion\nSorting');
  await page.getByRole('button',{name:'Add rubric criterion'}).click();
  await page.getByRole('textbox',{name:'Criterion 1 name',exact:true}).fill('Accuracy');
  await page.getByRole('spinbutton',{name:'Criterion 1 maximum score'}).fill('5');
  await page.getByRole('textbox',{name:'Criterion 1 description'}).fill('Explain a base case and recursive step.');
  assert.equal(contextSaves.length,0);
  await page.getByRole('button',{name:'Save topics and rubric',exact:true}).click();
  await page.getByText('Topics and rubric saved for this unpublished exam. Publishing remains a separate action.').waitFor();
  assert.equal(contextSaves.length,1);
  assert.equal(contextSaves[0].expected_context_hash,'initial-context');
  assert.equal(contextSaves[0].rubric.criteria[0].max_score,5);
  console.log('PASS professor context loads unchanged and saves topics/rubric only after explicit action');
  await page.getByRole('spinbutton',{name:'Number of drafts'}).fill('2');
  await page.getByRole('button',{name:'Generate drafts',exact:true}).click();
  await page.getByRole('heading',{name:'Draft 1 · pending'}).waitFor();
  assert.equal(await saved.textContent(),'1');
  const first=page.getByRole('heading',{name:'Draft 1 · pending'}).locator('..');
  await first.getByRole('textbox',{name:'Question text'}).fill('Professor reviewed and edited question?');
  await first.getByRole('button',{name:'Approve into question bank'}).click();
  await page.getByRole('heading',{name:'Professor reviewed and edited question?'}).waitFor();
  assert.equal(await saved.textContent(),'2');
  await page.getByRole('button',{name:'Reject draft',exact:true}).click();
  await page.getByRole('heading',{name:'Draft 2 · rejected'}).waitFor();
  assert.equal(questions.length,2);
  console.log('PASS generated drafts stay outside saved bank until explicit edited approval; reject never adds a question');
  drop=true;
  await page.getByRole('button',{name:'Generate drafts',exact:true}).click();
  await page.getByRole('alert').waitFor();
  await page.getByRole('button',{name:'Generate drafts',exact:true}).click();
  await page.getByText('Drafts are ready for your review. No question was added to the exam.').waitFor();
  assert.equal(requests.at(-1).request_id,requests.at(-2).request_id);
  assert.equal(jobs.size,2);
  assert.equal(questions.length,2);
  console.log('PASS lost generation response retries the same UUID and produces one draft batch');
  fail=true;
  await page.getByRole('button',{name:'Generate drafts',exact:true}).click();
  await page.getByText('The configured local question generator is unavailable. No drafts were approved.').waitFor();
  assert.equal(questions.length,2);
  editable=false;await page.reload();
  await page.getByText('Generation and review require an unpublished exam with no active student attempts.').waitFor();
  assert.equal(await page.getByRole('button',{name:'Generate drafts',exact:true}).isDisabled(),true);
  editable=true;contextFrozen=true;await page.reload();
  await page.getByText('Professor topics and assessment rubric',{exact:true}).click();
  await page.getByText('Assessment context is fixed after an assessed attempt. Create a new exam to change topics or rubric.').waitFor();
  assert.equal(await page.getByRole('button',{name:'Save topics and rubric',exact:true}).isDisabled(),true);
  assert.equal(await page.getByRole('button',{name:'Generate drafts',exact:true}).isEnabled(),true);
  console.log('PASS completed assessed attempt locks rubric editor with create-new-exam notice while draft generation policy stays independent');
  assert.deepEqual(errors,[]);
  console.log('PASS generator outage is explicit and published/active exam view disables draft mutation');
}finally{await browser.close();}
