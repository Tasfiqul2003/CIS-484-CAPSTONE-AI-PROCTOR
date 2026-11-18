import {readFile} from 'node:fs/promises';
/** Bundle the real UI in memory. All static requests are fulfilled by Playwright;
 *  API requests stay with each suite's explicit synthetic fixtures. No server starts.
 */
import { build } from 'esbuild';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export async function offlineBrowserApp(context, baseUrl, { previewOnly = false, fullAvatarSimulation = false } = {}) {
  const mediaCalls = [];
  await context.exposeBinding('__recordOfflineBrowserMedia', (_source, name) => mediaCalls.push(String(name)));
  await context.addInitScript(() => {
    if (navigator.mediaDevices) navigator.mediaDevices.getUserMedia = () => {
      void window.__recordOfflineBrowserMedia('getUserMedia');
      return Promise.reject(new Error('Real device capture is blocked in this synthetic browser suite.'));
    };
    if (window.speechSynthesis) window.speechSynthesis.speak = () => {
      void window.__recordOfflineBrowserMedia('speechSynthesis.speak');
      throw new Error('Real speech playback is blocked in this synthetic browser suite.');
    };
  });
  const frontend = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const bundle = await build({ stdin: {
    contents: `import React, {StrictMode} from 'react'; import {createRoot} from 'react-dom/client';
      import './src/index.css'; import App from './src/App';
      import StudentSettingsPreview from './src/pages/student/StudentSettingsPreview';
      import Panel from './src/components/student-settings/StudentSettingsPanel';
      import {getDemoPolicy,defaultPreferences} from './src/components/student-settings/studentSettings';
      window.__studentSettingsTestModules={React,createRoot,Panel,getDemoPolicy,defaultPreferences};
      createRoot(document.getElementById('root')).render(<StrictMode>${previewOnly ? '<StudentSettingsPreview/>' : '<App/>'}</StrictMode>);`,
    resolveDir: frontend, loader: 'tsx',
  }, bundle: true, write: false, outdir: 'offline-browser-memory', jsx: 'automatic',
  define: { 'process.env.NODE_ENV': '"development"' }, logLevel: 'silent',
    // Exercise the existing detailed instructor simulator separately from the
    // current simple preview tab (covered by manage-exam-browser).
    plugins: fullAvatarSimulation ? [{name:'detailed-instructor-simulator',setup(builder){
      builder.onLoad({filter:/AvatarSettings\.tsx$/},async args=>({loader:'tsx',contents:
        (await readFile(args.path,'utf8')).replace('<StudentAvatarPreview simple settings=','<StudentAvatarPreview settings=')}));
    }}] : [] });
  const js = bundle.outputFiles.find(file=>file.path.endsWith('.js')).text;
  const css = bundle.outputFiles.find(file=>file.path.endsWith('.css'))?.text ?? '';
  const origin = new URL(baseUrl).origin;
  await context.route('**/*', async route => {
    const request = route.request(); const url = new URL(request.url());
    if (url.origin !== origin) return route.fallback();
    if (url.pathname === '/__browser_fixture__/app.js') return route.fulfill({ contentType:'application/javascript',body:js });
    if (url.pathname === '/__browser_fixture__/app.css') return route.fulfill({ contentType:'text/css',body:css });
    // Capabilities are a current app-shell read, unrelated to each feature fixture.
    if (url.pathname === '/api/developer/capabilities' && request.method()==='GET') return route.fulfill({ contentType:'application/json',body:'{"enabled":false}' });
    if (request.isNavigationRequest() && ['GET','HEAD'].includes(request.method())) return route.fulfill({ contentType:'text/html',body:'<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/__browser_fixture__/app.css"></head><body><div id="root"></div><script src="/__browser_fixture__/app.js"></script></body></html>' });
    return route.fallback();
  });
  return { mediaCalls };
}

/** Scroll immediately before pointer input; smooth document scrolling otherwise
 * races Playwright's automatic scroll-to-center on very long settings forms. */
export async function clickInView(locator) {
  await locator.evaluate(element => element.scrollIntoView({ block: 'center', behavior: 'instant' }));
  await locator.click();
}


/** Keep legacy substantive checks while navigating the current tabbed settings UI. */
export function tabbedAvatarLocators(page) {
  const tabs = { 'avatar-presentation-heading': 'Built-in examiner', 'avatar-student-heading': 'Student controls',
    'avatar-assistance-heading': 'Assistance', 'avatar-behavior-heading': 'Exam behavior',
    'avatar-save-heading': 'Saving and sharing' };
  const wrap = locator => new Proxy(locator, { get(target, key) {
    const value = target[key];
    if (typeof value !== 'function') return value;
    if (['first','last','nth','locator','getByLabel','getByRole','filter'].includes(key))
      return (...args) => wrap(value.apply(target,args));
    if (['click','fill','check','uncheck','setChecked','selectOption','press','setInputFiles','waitFor','focus'].includes(key))
      return async (...args) => {
        if (!args[0] || !['hidden','detached'].includes(args[0]?.state)) await target.waitFor({state:'attached'});
        if (await target.count() === 1) {
          const heading = await target.evaluate(el => el.closest('section[hidden]')?.getAttribute('aria-labelledby'));
          if (tabs[heading]) await page.locator('.avatar-tabs').getByRole('button',{name:tabs[heading],exact:true}).click();
        }
        return value.apply(target,args);
      };
    return value.bind(target);
  }});
  for (const name of ['getByLabel','getByRole']) {
    const original=page[name].bind(page);
    page[name]=(...args)=>{
      if (name==='getByRole' && args[1]?.name && ['Make preview page','Save to exam','Save draft',"Load the preview's settings here",'Undo my changes','Open the preview page','Open a preview of the saved settings'].includes(args[1].name))
        args[1]={...args[1],includeHidden:true};
      return wrap(original(...args));
    };
  }
}
