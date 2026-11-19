# Portal dark mode

## Implemented

- A compact, keyboard-operable Dark mode switch appears in professor and student screens, including login, verification, examiner environment preview, exam states, settings, review, live video, and submission.
- Both portals share `oralexam:portal-theme:v1` in browser local storage. Navigation and reload retain the choice; other tabs synchronize changes. The homepage always selects light and has no switch.
- If persistent storage is blocked, session storage is used. If both are unavailable, switching works only in the current document. Preferences are separate for different browser origins, including `localhost` versus `127.0.0.1` and different ports.
- The existing palette is reused; media and avatar artwork keep their original colors. Legacy surfaces and the newer recording/review screens receive scoped dark overrides.
- The rubric layout now fits narrow screens in either theme. No timing, grading, authentication, database, or developer-mode configuration is changed by this feature.

## Verification — November 19, 2026

- TypeScript passed: `node frontend/node_modules/typescript/bin/tsc --project frontend/tsconfig.json`.
- Vite production build passed, with output in ignored `tests/results/portal-theme-final-20261119/build`. Tracked `frontend/dist` was preserved. Vite reported a JavaScript chunk over 500 kB.
- The production-build browser suite passed **8 behavior checks and 87 dark appearance observations**. It covers 25 portal URLs (including preserved legacy redirects) at 1365px, 390px, and 320px; keyboard/reload/cross-portal persistence; cross-tab updates; blocked-storage fallback; avatar tabs; custom rubric editing; question/material/settings dialogs; unsaved input; environment preview; and the recording notice.
- No browser JavaScript errors or unexpected API/external requests were recorded. Homepage screenshots were identical before and after saving the dark preference.
- Initial checks found narrow rubric overflow and missed notification/roster colors. These were corrected before the final passing build and browser run.

## Run the browser check

Install frontend dependencies and provide Playwright and Chrome. If Playwright is installed elsewhere, set `AVATAR_NODE_MODULES_PATH` to the directory containing that package. `AVATAR_CHROME_PATH` can override the Chrome executable.

```powershell
$env:PORTAL_THEME_TEST_URL = 'http://localhost:5173'
node frontend/tests/portal-theme-browser.test.mjs
```

Alternatively, set `PORTAL_THEME_BUILD_DIR` to a Vite build directory to test it through a temporary loopback server. `PORTAL_THEME_OUTPUT_DIR` selects ignored local result storage; the default is `tests/results/portal-theme`.

Every API call uses synthetic fixtures; external origins and real device capture are blocked. These are appearance/interaction checks, not live database, identity verification, recording, speech, model, or grading validation. Computed contrast/overflow checks are heuristics rather than an accessibility certification. Hardware-dependent exam workflows are outside this check.
