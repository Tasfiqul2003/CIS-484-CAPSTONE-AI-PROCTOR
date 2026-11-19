import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';

// Isolated synthetic browser session: every API request is intercepted.
const require = createRequire(process.env.AVATAR_NODE_MODULES_PATH
  ? path.join(path.resolve(process.env.AVATAR_NODE_MODULES_PATH), 'package.json') : import.meta.url);
const { chromium } = require('playwright');
let baseUrl = process.env.PORTAL_THEME_TEST_URL || 'http://localhost:5173';
let server;
// An optional production build makes this check independent of a user's dev server.
if (process.env.PORTAL_THEME_BUILD_DIR) {
  const root = path.resolve(process.env.PORTAL_THEME_BUILD_DIR);
  server = createServer(async (request, response) => {
    const pathname = new URL(request.url, 'http://localhost').pathname;
    if (pathname === '/__portal-theme.css' && process.env.PORTAL_THEME_STYLESHEET) {
      response.setHeader('Content-Type', 'text/css');
      response.end(await readFile(path.resolve(process.env.PORTAL_THEME_STYLESHEET)));
      return;
    }
    const file = path.extname(pathname) ? path.resolve(root, '.' + pathname) : path.join(root, 'index.html');
    if (!file.startsWith(root + path.sep)) { response.writeHead(403).end(); return; }
    try {
      let content = await readFile(file);
      if (file.endsWith('index.html') && process.env.PORTAL_THEME_STYLESHEET) {
        content = Buffer.from(content.toString().replace('</head>', '<link rel="stylesheet" href="/__portal-theme.css"></head>'));
      }
      const types = { '.css': 'text/css', '.js': 'application/javascript', '.png': 'image/png', '.svg': 'image/svg+xml', '.html': 'text/html' };
      response.setHeader('Content-Type', types[path.extname(file)] || 'application/octet-stream');
      response.end(content);
    } catch { response.writeHead(404).end(); }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
}
const outputDir = path.resolve(process.env.PORTAL_THEME_OUTPUT_DIR || 'tests/results/portal-theme');
const browser = await chromium.launch({ headless: true, executablePath: process.env.AVATAR_CHROME_PATH
  || (process.platform === 'win32' ? 'C:/Program Files/Google/Chrome/Application/chrome.exe' : undefined) });
const context = await browser.newContext({ viewport: { width: 1365, height: 900 }, reducedMotion: 'reduce' });
const page = await context.newPage();
const errors = [], unexpectedRequests = [], diagnostics = [], requests = [];
const EXAM = 'synthetic-theme-exam', STUDENT = 'synthetic-theme-student', SESSION = 'synthetic-theme-session';
const themeKey = 'oralexam:portal-theme:v1';
let developerMode = false, failPreflight = false;
let savedTime = { time_limit_minutes: 37, question_time_limit_minutes: 2 };
const exam = { id: EXAM, title: 'Synthetic Theme Exam', course: 'SYNTH 101', description: 'Synthetic appearance checks.',
  status: 'published', icon: null, created_at: '2026-11-01T12:00:00Z', time_limit_minutes: 37,
  question_count: 1, submission_count: 1, in_progress_count: 0, awaiting_grading_count: 1, completed_count: 0, flagged_count: 0 };
const student = { id: STUDENT, name: 'Synthetic Student', eid: 'synthetic-eid' };
const question = { id: 'synthetic-question', question_text: 'Explain a synthetic topic.', topic: 'Synthetic', difficulty: 2, created_at: exam.created_at };
const material = { id: 'synthetic-material', filename: 'synthetic-material.txt', content_type: 'text/plain',
  created_at: exam.created_at, characters_extracted: 42, has_summary: true };
const attempt = () => ({ session_id: SESSION, session_token: 'synthetic-token', status: 'in_progress', sequence_num: 1, developer_demo: developerMode,
  question: question.question_text, server_now: new Date().toISOString(), deadline: null, question_deadline: null });
const presentation = { session_id: SESSION, revision: 0, voice_profile: 'calm',
  policy: { defaults: { avatar: 'guide', background: 'neutral', customAvatar: null, customBackground: null,
    voiceLabel: 'Calm', speed: 1, reducedMotion: true, animation: false },
  allowAvatar: true, allowBackground: true, allowSpeed: true, minSpeed: .75, maxSpeed: 1.25,
  avatarChoices: [{ id: 'guide', label: 'Guide' }, { id: 'geometric', label: 'Geometric' }],
  backgroundChoices: [{ id: 'neutral', label: 'Neutral' }, { id: 'library', label: 'Library' }] },
  preferences: { volume: 0, textSize: 16, reducedMotion: true, avatar: 'guide', background: 'neutral', speed: 1 } };

async function fixtures(target) {
  await target.addInitScript(({ EXAM, STUDENT }) => {
    sessionStorage.setItem('oralexam_student_id', STUDENT);
    sessionStorage.setItem('oralexam_student_eid', 'synthetic-eid');
    sessionStorage.setItem('oralexam_student_name', 'Synthetic Student');
    sessionStorage.setItem('oralexam_face_check_passed', 'true');
    sessionStorage.setItem(`oralexam_exam_token:${EXAM}:${STUDENT}`, 'synthetic-token');
    sessionStorage.setItem('oralexam_exam_session_id', 'synthetic-theme-session');
    if (window.speechSynthesis) window.speechSynthesis.speak = () => {};
    if (navigator.mediaDevices) navigator.mediaDevices.getUserMedia = () => Promise.reject(new Error('Synthetic test blocks media capture.'));
  }, { EXAM, STUDENT });
  await target.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.origin !== new URL(baseUrl).origin) { unexpectedRequests.push(url.origin); return route.abort(); }
    if (!url.pathname.startsWith('/api/')) return route.continue();
    requests.push(`${request.method()} ${url.pathname}`);
    const respond = (json, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(json) });
    const p = url.pathname;
    if (p === '/api/developer/capabilities') return respond(developerMode ? { enabled: true, minimal: true, ai_available: false, services: { ai: false, flashhead: false, voice: false, microphone: false, camera: false } } : { enabled: false });
    if (p === '/api/auth/me') return respond({ id: 'synthetic-account', professor_id: 'synthetic-professor', role: 'professor', username: 'Synthetic Professor' });
    if (p === '/api/auth/professor/exams') return respond([exam]);
    if (p === `/api/exam/templates/${EXAM}/question-drafts`) return respond({ drafts: [], topics: ['Synthetic'], can_edit: false });
    if (p === `/api/exam/templates/${EXAM}/question-drafts/context`) return respond({ topic_coverage_required: ['Synthetic'], rubric: { criteria: [{ name: 'Understanding', description: 'Synthetic criterion', max_score: 10 }] }, context_hash: 'synthetic-context', can_edit: false, notice: 'Synthetic published exam.' });
    if (p === '/api/auth/professor/recording-notifications') return respond([]);
    if (p === '/api/exam/student/developer-face-bypass') return respond({ enabled: false });
    if (p === `/api/exam/sessions/${SESSION}/recording-review`) return respond({ status: 'completed', failure_reason: null, playable: false, transcript_status: 'completed', generated_transcript: 'Synthetic saved transcript.' });
    if (p === '/api/exam/student/available') return respond({ student, exams: [exam] });
    if (p === `/api/exam/templates/${EXAM}/questions`) return respond([question]);
    if (p === `/api/exam/templates/${EXAM}/materials`) return respond([material]);
    if (p === `/api/exam/templates/${EXAM}/materials/${material.id}`) return respond({ ...material, extracted_text: 'Synthetic course content.', summary: 'Synthetic summary.' });
    if (p === `/api/exam/templates/${EXAM}/roster`) return respond([{ student_id: STUDENT, ...student }]);
    if (p === `/api/exam/templates/${EXAM}/time-settings`) { if (request.method() === 'PUT') savedTime = request.postDataJSON(); return respond(savedTime); }
    if (p === `/api/exam/templates/${EXAM}/ods-accommodations`) return respond({ time_limit_minutes: 37, question_time_limit_minutes: null,
      assignments: [{ student_id: STUDENT, eid: student.eid, name: student.name, extended_time_multiplier: 1.5, effective_time_limit_minutes: 55.5 }] });
    if (p === `/api/exam/templates/${EXAM}/avatar-policy`) return respond({ detail: 'No saved policy in synthetic fixture.' }, 404);
    if (p === `/api/exam/templates/${EXAM}/progress`) return respond([{ ...student, student_id: STUDENT, student_name: student.name,
      email: 'synthetic@example.invalid', session_id: SESSION, status: 'pending_grading', started_at: exam.created_at, ended_at: exam.created_at }]);
    if (p === '/api/exam/start' || p === `/api/exam/sessions/${SESSION}`) return respond(attempt());
    if (p === '/api/exam/answer') return respond({ done: true });
    if (p === `/api/exam/sessions/${SESSION}/presentation`) return respond(presentation);
    if (p === `/api/exam/sessions/${SESSION}/assistance`) return respond({ ...attempt(), question_sequence_num: 1, mode: 'assessed', actions: {} });

    if (p === '/api/avatar/status') return respond({ enabled: false, ready: false });
    if (p === `/api/exam/templates/${EXAM}/materials/${material.id}`) return respond({ ...material, extracted_text: 'Synthetic source text.', summary: 'Synthetic material summary.' });
    if (p === '/api/avatar/professor/avatars') return respond({ enabled: true, ready: true, avatars: [], selected: null, consent_text: 'Synthetic consent text.' });
    if (p === `/api/exam/templates/${EXAM}/rubric`) return respond({ default: true, criteria: [{ name: 'Understanding', max_score: 10 }], default_criteria: [{ name: 'Understanding', max_score: 10 }] });
    if (p === '/api/exam/video-recording/preflight') return failPreflight ? respond({ detail: 'Synthetic unavailable recording service.' }, 503) : respond({ ready: true, recording_required: false });
    if (p === `/api/exam/sessions/${SESSION}/review`) return respond({ student_name: student.name, student_eid: student.eid, exam_title: exam.title, exam_template_id: EXAM, course: exam.course, status: 'pending_grading', video_url: '/api/synthetic-video' });
    if (p === `/api/exam/${SESSION}/report`) return respond({ session: { id: SESSION, status: 'pending_grading', student_name: student.name, student_eid: student.eid, exam_title: exam.title, exam_template_id: EXAM, course: exam.course, started_at: exam.created_at, ended_at: exam.created_at }, interactions: [{ sequence_num: 1, question_source: 'bank', avatar_root_sequence: 1, avatar_followup_index: 0, question_text: question.question_text, student_answer_transcript: 'A synthetic response.', ai_evaluation: 'Synthetic review note.', topic: 'Synthetic', asked_at_s: 0 }], grades: [], integrity_events: [], assessment: { status: 'not_started' } });
    if (p === '/api/synthetic-video') return route.fulfill({ status: 204, body: '' });


    if (p === `/api/exam/templates/${EXAM}/recording-settings`) return respond({ record_examination: false, generate_transcript: false });
    if (p === `/api/exam/templates/${EXAM}/student-presentation`) return respond({ ...presentation, session_id: EXAM, exam_id: EXAM, notice: null, preferences: request.method() === 'PUT' ? request.postDataJSON().preferences : presentation.preferences });
    if (p === `/api/exam/sessions/${SESSION}/recording-consent`) return respond({ ...attempt(), recording_consent_status: 'not_required' });

    unexpectedRequests.push(`${request.method()} ${p}`);
    return respond({ detail: 'Unexpected synthetic request.' }, 500);
  });
}
await fixtures(context);
page.on('pageerror', error => errors.push(error.message));
page.setDefaultTimeout(10000);
await mkdir(outputDir, { recursive: true });
const toggle = () => page.getByRole('switch', { name: 'Dark mode', exact: true });
async function visit(route) {
  await page.goto(baseUrl + route);
  await toggle().waitFor();
  await page.waitForTimeout(220);
}
async function homeImage() {
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(200);
  return page.screenshot({ fullPage: true, animations: 'disabled', caret: 'hide' });
}
async function expectTheme(theme) {
  await page.waitForFunction(theme => document.documentElement.dataset.theme === theme, theme);
  assert.equal(await toggle().getAttribute('aria-checked'), String(theme === 'dark'));
}
async function appearance() {
  return page.evaluate(() => {
    const css = getComputedStyle(document.body);
    return { background: css.backgroundColor, color: css.color, scheme: getComputedStyle(document.documentElement).colorScheme,
      header: document.querySelector('header') ? getComputedStyle(document.querySelector('header')).backgroundColor : null };
  });
}
async function inspectDark(route) {
  await expectTheme('dark');
  const findings = await page.evaluate(() => {
    const rgb = color => color.match(/[\d.]+/g)?.slice(0, 3).map(Number) || [0, 0, 0];
    const luma = color => rgb(color).map(v => v / 255).map(v => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4)
      .reduce((sum, v, i) => sum + v * [.2126, .7152, .0722][i], 0);
    const bright = [], contrast = [];
    for (const el of document.querySelectorAll('body *')) {
      const box = el.getBoundingClientRect(), css = getComputedStyle(el);
      if (!box.width || !box.height || css.visibility === 'hidden' || css.display === 'none') continue;
      if (el.closest('svg, video, canvas, .ai-avatar, .avatar-stage, .student-demo-stage, .exam-stage-avatar')) continue;
      const label = `${el.tagName.toLowerCase()}.${String(el.className).replaceAll(' ', '.')}`;
      const background = rgb(css.backgroundColor);
      // Light neutral panels indicate a missed override; colored primary buttons are intentional.
      if (box.width > 100 && box.height > 40 && background.every(v => v > 185)
        && Math.max(...background) - Math.min(...background) < 35) bright.push(label);
      if (!Array.from(el.childNodes).some(n => n.nodeType === Node.TEXT_NODE && n.textContent.trim()) || el.closest(':disabled')) continue;
      let bg = el;
      while (bg && (getComputedStyle(bg).backgroundColor === 'rgba(0, 0, 0, 0)' || getComputedStyle(bg).backgroundColor === 'transparent')) bg = bg.parentElement;
      if (!bg || getComputedStyle(bg).backgroundImage !== 'none') continue;
      const a = luma(css.color), b = luma(getComputedStyle(bg).backgroundColor), ratio = (Math.max(a,b)+.05)/(Math.min(a,b)+.05);
      const large = parseFloat(css.fontSize) >= 24 || (parseFloat(css.fontSize) >= 18.66 && Number(css.fontWeight) >= 700);
      if (ratio < (large ? 3 : 4.5)) contrast.push({ label, ratio: Number(ratio.toFixed(2)), color: css.color, background: getComputedStyle(bg).backgroundColor });
    }
    return { bright: [...new Set(bright)], contrast, overflow: document.documentElement.scrollWidth > innerWidth + 1 };
  });
  diagnostics.push({ route, width: page.viewportSize().width, ...findings });
  return findings;
}



const categories=['avatar-interaction','time-scheduling','ods-accommodations','ai-questioning','recording-transcript','ai-results'];
const liveRoute=`/student/exam?templateId=${EXAM}&studentId=${STUDENT}`;
const routes=['/professor/login','/professor/dashboard','/professor/exams','/professor/avatar','/professor/exams/new',`/professor/exams/${EXAM}`,`/professor/exams/${EXAM}/questions`,`/professor/exams/${EXAM}/materials`,`/professor/exams/${EXAM}/roster`,...categories.map(c=>`/professor/exams/${EXAM}/settings/${c}`),`/professor/exams/${EXAM}/submissions`,`/professor/exam-sessions/${SESSION}/live`,`/professor/exam-sessions/${SESSION}/review`,`/professor/exams/${EXAM}/submissions/${SESSION}`,'/student/verification','/student/face-verification','/student/exams','/student/settings-preview','/student/exam/submitted',liveRoute];
const completed=[];
async function check(name,run){ await run(); completed.push(name); console.log(`PASS ${name}`); }
try {
  await page.goto(baseUrl+'/'); await page.locator('h1').waitFor();
  const home=await appearance(),homeBefore=await homeImage();
  assert.equal(await toggle().count(),0);
  await check('Keyboard switching preserves input and persists between portals and reloads',async()=>{
    await visit('/professor/login'); await expectTheme('light');
    await page.locator('#username').fill('synthetic-unsent-name');
    await toggle().focus(); await page.keyboard.press('Space'); await expectTheme('dark');
    assert.equal(await page.locator('#username').inputValue(),'synthetic-unsent-name');
    await page.reload(); await expectTheme('dark');
    await visit('/student/verification'); await expectTheme('dark');
    await toggle().click(); await visit('/professor/login'); await expectTheme('light');
    await toggle().click(); await expectTheme('dark');
  });
  await check('Homepage stays light and its screenshot is unchanged with dark saved',async()=>{
    await page.goto(baseUrl+'/'); await page.locator('h1').waitFor();
    assert.equal(await toggle().count(),0);
    assert.equal(await page.evaluate(()=>document.documentElement.dataset.theme),'light');
    assert.deepEqual(await appearance(),home);
    assert.ok(homeBefore.equals(await homeImage()),'Homepage changed with stored dark preference.');
    await page.getByRole('link',{name:/Professor/i}).first().click(); await expectTheme('dark');
  });
  const widths=process.env.PORTAL_THEME_WIDTHS==='desktop'?[1365]:[1365,390,320];
  for(const width of widths){
    await page.setViewportSize({width,height:900});
    for(const route of routes){
      await visit(route); assert.equal(await toggle().count(),1,route);
      const box=await toggle().boundingBox(); assert.ok(box.height>=44,'Switch target is too small.');
      const findings=await inspectDark(route); assert.equal(findings.overflow,false,route+' overflow at '+width);
    }
    await visit('/professor/dashboard'); await page.screenshot({path:path.join(outputDir,`professor-dashboard-dark-${width}.png`),fullPage:true});
    await visit('/student/verification'); await page.screenshot({path:path.join(outputDir,`student-verification-dark-${width}.png`),fullPage:true});
    console.log(`PASS ${routes.length} portal routes at ${width}px`);
  }
  await page.setViewportSize({width:1365,height:900});
  await check('Unsaved time settings survive theme changes',async()=>{
    await visit(`/professor/exams/${EXAM}/settings/time-scheduling`);
    await page.locator('#exam-time-limit').fill('45');
    await toggle().click(); await toggle().click(); await expectTheme('dark');
    assert.equal(await page.locator('#exam-time-limit').inputValue(),'45');
    await page.screenshot({path:path.join(outputDir,'time-settings-dark.png'),fullPage:true});
  });
  await check('All avatar tabs and custom rubric editor stay dark',async()=>{
    await visit(`/professor/exams/${EXAM}/settings/avatar-interaction`);
    const tabs=page.locator('.avatar-tabs button'); assert.equal(await tabs.count(),7);
    for(let i=0;i<7;i++){const name=await tabs.nth(i).innerText(); await tabs.nth(i).click(); await page.waitForTimeout(100); await inspectDark('avatar-tab-'+name);}
    await visit(`/professor/exams/${EXAM}/settings/ai-results`);
    await page.getByRole('radio',{name:/My own rubric/}).check();
    await page.getByLabel('Criterion 1 name',{exact:true}).fill('Synthetic criterion');
    await inspectDark('custom-rubric');
  });
  await check('Question, material and student-settings dialogs stay dark',async()=>{
    for(const section of ['questions','materials']){
      await visit(`/professor/exams/${EXAM}/${section}`);
      await page.locator(`#${section}`).getByRole('button',{name:'Preview',exact:true}).first().click();
      await page.getByRole('dialog').waitFor(); await inspectDark(section+'-preview-dialog');
      await page.getByRole('button',{name:'Close Preview',exact:true}).click();
    }
    await visit('/student/settings-preview');
    await page.getByRole('button',{name:'Student settings',exact:true}).click();
    await page.getByRole('dialog').waitFor(); await inspectDark('student-preview-settings-dialog');
    await page.keyboard.press('Escape');
  });
  await check('Environment preview and recording notice retain the theme',async()=>{
    developerMode=true;
    await visit(liveRoute);
    await page.getByRole('button',{name:'Save and continue to recording notice',exact:true}).click();
    await page.getByRole('heading',{name:'Exam recording notice',exact:true}).waitFor();
    await inspectDark('recording-notice');
    developerMode=false;
  });
  await check('Cross-tab updates sync without darkening the homepage',async()=>{
    await visit('/professor/login'); const other=await context.newPage(); await other.goto(baseUrl+'/');
    await other.evaluate(key=>localStorage.setItem(key,'light'),themeKey); await expectTheme('light');
    await other.evaluate(key=>localStorage.setItem(key,'dark'),themeKey); await expectTheme('dark');
    assert.equal(await other.evaluate(()=>document.documentElement.dataset.theme),'light'); await other.close();
  });
  await check('Blocked persistent storage falls back to session storage',async()=>{
    const isolated=await browser.newContext(); await fixtures(isolated);
    await isolated.addInitScript(()=>{Object.defineProperty(window,'localStorage',{get(){throw new DOMException('Synthetic blocked storage','SecurityError');}});});
    const tab=await isolated.newPage(); await tab.goto(baseUrl+'/professor/login');
    const control=tab.getByRole('switch',{name:'Dark mode',exact:true}); await control.click(); await tab.reload();
    assert.equal(await control.getAttribute('aria-checked'),'true');
    await tab.goto(baseUrl+'/'); assert.equal(await control.count(),0); await isolated.close();
  });
  assert.deepEqual(errors,[],'Browser JavaScript errors');
  assert.deepEqual(unexpectedRequests,[],'Unexpected API/external requests');
  const failures=diagnostics.filter(d=>d.bright.length||d.contrast.length||d.overflow);
  await writeFile(path.join(outputDir,'results.json'),JSON.stringify({completed,diagnostics,errors,unexpectedRequests,failures},null,2));
  assert.deepEqual(failures,[],'Dark appearance failures; inspect results.json.');
  console.log(`PASS ${completed.length} behavior checks and ${diagnostics.length} dark appearance observations.`);
}catch(error){
  await writeFile(path.join(outputDir,'results.json'),JSON.stringify({completed,diagnostics,errors,unexpectedRequests,failure:error.stack},null,2));
  await page.screenshot({path:path.join(outputDir,'failure.png'),fullPage:true}).catch(()=>{});
  throw error;
}finally{await browser.close();if(server)await new Promise(resolve=>server.close(resolve));}
