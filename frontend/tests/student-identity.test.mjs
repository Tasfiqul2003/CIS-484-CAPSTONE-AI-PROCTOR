import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
const require=createRequire(import.meta.url), ts=require('typescript');
const source=await readFile(new URL('../src/pages/student/studentIdentity.ts',import.meta.url),'utf8');
const compiled=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText;
const {hasStudentFaceAccess,readDeveloperFaceBypass,clearDeveloperFaceBypass,DEVELOPER_FACE_BYPASS_KEY}=await import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`);
const id='10000000-0000-4000-8000-000000000001';
function storage(){const values=new Map([['oralexam_student_id',id],['oralexam_student_eid','student.demo']]);
  globalThis.sessionStorage={getItem:key=>values.get(key)??null,setItem:(key,value)=>values.set(key,value),removeItem:key=>values.delete(key)};return values;}
function grant(extra={}){return JSON.stringify({student_id:id,eid:'student.demo',expires_at:new Date(Date.now()+60000).toISOString(),...extra});}
test('developer navigation uses separate identity hint without claiming a face match',()=>{
  const values=storage();values.set(DEVELOPER_FACE_BYPASS_KEY,grant());assert.equal(hasStudentFaceAccess(id),true);
  assert.equal(values.has('oralexam_face_check_passed'),false);assert.equal(readDeveloperFaceBypass(id).eid,'student.demo');
  clearDeveloperFaceBypass();assert.equal(hasStudentFaceAccess(id),false);
});
test('stale, cross-student, cross-EID and non-demo hints do not permit navigation',()=>{
  const values=storage();
  for(const extra of [{student_id:'another-student'},{eid:'real.student'},{eid:'student.demo2'},{expires_at:'invalid'},{expires_at:'2000-01-01T00:00:00Z'}]){
    values.set(DEVELOPER_FACE_BYPASS_KEY,grant(extra));assert.equal(hasStudentFaceAccess(id),false);
  }
  values.set(DEVELOPER_FACE_BYPASS_KEY,'malformed');assert.equal(hasStudentFaceAccess(id),false);
});
test('normal verified face marker remains valid only for the stored identity',()=>{
  const values=storage();values.set('oralexam_face_check_passed','true');assert.equal(hasStudentFaceAccess(id),true);
  assert.equal(hasStudentFaceAccess('different'),false);
});

 test('new synthetic roster boundaries are allowed but lookalikes remain denied',()=>{
   const values=storage();
   for(const eid of ['student.demo4','student.demo53']){
     values.set('oralexam_student_eid',eid);values.set(DEVELOPER_FACE_BYPASS_KEY,grant({eid}));
     assert.equal(hasStudentFaceAccess(id),true);
   }
   for(const eid of ['student.demo0','student.demo1','student.demo04','student.demo54','student.demo53.evil']){
     values.set('oralexam_student_eid',eid);values.set(DEVELOPER_FACE_BYPASS_KEY,grant({eid}));
     assert.equal(hasStudentFaceAccess(id),false);
   }
 });
