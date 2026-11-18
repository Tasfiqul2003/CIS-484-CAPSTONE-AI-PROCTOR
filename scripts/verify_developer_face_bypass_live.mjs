/** Actual localhost UI/API for the explicitly authorized synthetic identities. No exam starts or devices. */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const origin='http://127.0.0.1:5173';
const eids=['student.demo',...Array.from({length:52},(_,index)=>`student.demo${index+2}`)];
if(!process.argv.includes('--run')) {
  console.log(JSON.stringify({target:origin,synthetic_eids:eids,starts_services:false,starts_exams:false,capture:false,
    effect:'Temporary developer cookies in isolated browser contexts only; no face-history writes.'},null,2));
  process.exit(0);
}
const require=createRequire(process.env.AVATAR_NODE_MODULES_PATH
  ? path.join(path.resolve(process.env.AVATAR_NODE_MODULES_PATH),'package.json') : path.join(root,'frontend/package.json'));
const {chromium}=require('playwright');
const output=path.join(root,'private-data/p3-local/verification',`developer-face-bypass-${Date.now()}.json`);
const report={status:'started',step:'initialization',checks:[],capture_calls:0,blocked_privileged_requests:0,provider_calls:0};
let browser;
const check=(condition,code)=>assert.ok(condition,code);
try {
  browser=await chromium.launch({headless:true,args:['--mute-audio'],
    executablePath:process.env.AVATAR_CHROME_PATH||(process.platform==='win32'?'C:/Program Files/Google/Chrome/Application/chrome.exe':undefined)});
  for(const eid of eids) {
    report.step=`synthetic-ui-${eid}`;
    const context=await browser.newContext({permissions:[],viewport:{width:390,height:844}});
    try {
      const endpoint=origin+'/api/exam/student/developer-face-bypass';
      const capability=await context.request.get(endpoint);
      check(capability.status()===200,'CAPABILITY_HTTP');
      const caps=await capability.json();
      check(caps.enabled===true&&JSON.stringify(caps.allowed_eids)===JSON.stringify(eids),'CAPABILITY_SCOPE');
      const invalid=await context.request.post(endpoint,{data:{eid:'not.a.demo'}});
      check(invalid.status()===403,'NONDEMO_DENIED');
      const remote=await context.request.post(endpoint,{data:{eid},headers:{Origin:'https://example.invalid'}});
      check(remote.status()===403,'REMOTE_ORIGIN_DENIED');
      const granted=await context.request.post(endpoint,{data:{eid}});
      check(granted.status()===200,'GRANT_HTTP');
      const value=await granted.json();
      check(value.allowed===true&&value.matched===false&&value.developer_bypass===true
        &&value.identity_check_completed===false&&value.review_required===true&&value.student.eid===eid,'HONEST_IDENTITY_FLAGS');
      const cookie=(await context.cookies(origin)).find(item=>item.name==='cybros_developer_face_bypass');
      check(cookie?.httpOnly===true&&cookie.sameSite==='Strict','GRANT_COOKIE_FLAGS');
      await context.addInitScript(student=>{
        window.__developerBypassCapture=0;
        if(navigator.mediaDevices) for(const key of ['getUserMedia','getDisplayMedia']) navigator.mediaDevices[key]=()=>{
          window.__developerBypassCapture++;throw Error('Device capture is forbidden in this synthetic UI check');
        };
        sessionStorage.setItem('oralexam_student_id',student.id);sessionStorage.setItem('oralexam_student_eid',student.eid);
        sessionStorage.setItem('oralexam_student_name',student.name);sessionStorage.removeItem('oralexam_face_check_passed');
      },value.student);
      const page=await context.newPage();page.setDefaultTimeout(8000);
      let runtimeErrors=0;page.on('pageerror',()=>runtimeErrors++);
      await page.route('**/api/**',route=>{
        const pathname=new URL(route.request().url()).pathname;
        if(['/api/exam/student/developer-face-bypass','/api/exam/student/available','/api/developer/capabilities'].includes(pathname))return route.continue();
        report.blocked_privileged_requests++;return route.abort('blockedbyclient');
      });
      await page.goto(origin+'/student/face-verification');
      await page.getByText('About this check',{exact:true}).click();
      await page.getByRole('heading',{name:'Developer mode',exact:true}).waitFor();
      await page.getByLabel('Bypass',{exact:true}).fill(eid);
      await page.getByRole('button',{name:'Bypass photo check',exact:true}).click();
      await page.getByText(`Developer photo bypass accepted for ${eid}.`,{exact:false}).waitFor();
      const hint=await page.evaluate(()=>({matched:sessionStorage.getItem('oralexam_face_check_passed'),
        hint:JSON.parse(sessionStorage.getItem('oralexam_developer_face_bypass')||'null'),captures:window.__developerBypassCapture}));
      check(hint.matched!=='true'&&hint.hint?.eid===eid,'SEPARATE_UNVERIFIED_HINT');
      report.capture_calls+=hint.captures;
      await page.getByRole('button',{name:'Continue to Exam Portal →',exact:true}).click();
      await page.getByRole('heading',{name:'Your exams',exact:true}).waitFor();
      await page.getByText('Developer photo-check bypass · identity remains unverified.',{exact:false}).waitFor();
      check(runtimeErrors===0,'NO_BROWSER_ERRORS');
      const available=await context.request.post(origin+'/api/exam/student/available',{data:{eid}});
      check(available.status()===200,'PORTAL_ROSTER_HTTP');
      const exams=(await available.json()).exams;
      let previewChecked=false;
      if(exams.length) {
        const admitted=await context.request.post(origin+'/api/exam/verify-eid',{data:{eid,exam_template_id:exams[0].id}});
        check(admitted.status()===200,'ROSTERED_ADMISSION_HTTP');
        const admission=await admitted.json();
        check(admission.identity_check_completed===false&&admission.identity_review_required===true,'ADMISSION_UNVERIFIED');
        const preview=await context.request.get(origin+`/api/exam/templates/${exams[0].id}/student-presentation`,
          {headers:{Authorization:`Bearer ${admission.student_token}`}});
        check(preview.status()===200,'ACTUAL_PREVIEW_HTTP');previewChecked=true;
      }
      report.checks.push({eid,status:'passed',actual_ui_portal:true,rostered_preview_checked:previewChecked});
    } finally {await context.close();}
  }
  check(report.capture_calls===0&&report.blocked_privileged_requests===0,'NO_CAPTURE_OR_EXAM_START');
  report.status='passed';
} catch(error) {report.status='failed';report.failure_type=error?.name||'Error';process.exitCode=1;}
finally {
  await browser?.close();await mkdir(path.dirname(output),{recursive:true});
  await writeFile(output,JSON.stringify(report,null,2));
}
console.log(JSON.stringify({status:report.status,passed:report.checks.length,step:report.step,report:output,
  capture_calls:report.capture_calls,privileged_requests:report.blocked_privileged_requests},null,2));
