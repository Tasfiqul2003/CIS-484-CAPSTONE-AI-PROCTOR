# Avatar settings and exam policy checks

Manage Exam links to a dedicated **Avatar & Interaction Settings** page with separate **Save Local Draft**, **Share Preview Policy**, and **Save Exam Policy** actions. Browser sharing explicitly connects to `/student/settings-preview?examId=...&instructorId=...&policySource=local`. Saved-policy previews use `policySource=server` and require professor sign-in; there is no unauthenticated student policy endpoint. The plain `/student/settings-preview` route retains the independent fixed demonstration.

Server setup: apply `database/migrations/006_exam_avatar_policy.sql` through the project's database migration process, then restart the backend so its new router is registered. This task prepares the migration but does not apply it to the existing PostgreSQL database. The professor-only GET/PUT endpoint is `/exam/templates/{exam_id}/avatar-policy`; PUT accepts `{settings, expected_revision}`. Stale revisions return 409. Unmigrated policy storage returns 503. Browser failures never silently fall back to local rules.

Policies apply to **new attempts**, and assistance allowances apply **per question**. Open synthetic previews keep their starting snapshot until explicitly restarted. Student authentication, roster/assignment checks, live attempt snapshots, and server assistance counters are documented integration work, not completed features.

Run commands from `frontend/`. No backend or real account is needed for these tests.

```powershell
node --test tests/avatar-settings.test.mjs
node --test tests/student-settings.test.mjs tests/exam-policy.test.mjs
npm run build
```

The Node tests compile the settings model with the existing TypeScript dependency and check defaults, validation, mode availability, local image validation, response units, draft migration, and the local draft adapter. They use synthetic settings and in-memory storage.

For the browser exercise, start the existing frontend in one terminal:

```powershell
npm run dev -- --host 127.0.0.1
```

In a second terminal, run the browser script with an existing Playwright package and Chrome or Chromium. Playwright is supplied by the Codex runtime used for this task; it is not a new repository dependency. The script never installs packages or browsers. `AVATAR_NODE_MODULES_PATH` may point to another already available `node_modules` directory containing `playwright`; omit it if normal Node resolution can find Playwright.

```powershell
$env:AVATAR_NODE_MODULES_PATH = 'C:\path\to\existing\node_modules'
$env:AVATAR_CHROME_PATH = 'C:\Program Files\Google\Chrome\Application\chrome.exe'
$env:AVATAR_TEST_URL = 'http://127.0.0.1:5173'
$env:AVATAR_TEST_OUTPUT_DIR = 'C:\path\to\scratch\avatar-results'
node tests/avatar-browser.test.mjs
```

`AVATAR_TEST_URL` defaults to `http://127.0.0.1:5173`. `AVATAR_TEST_OUTPUT_DIR` defaults to `test-results/avatar` under the current directory; use a scratch path to keep generated screenshots and reports outside the repository. `AVATAR_CHROME_PATH` defaults to the standard Chrome location on Windows/macOS; on Linux, the script uses Playwright's existing Chromium unless a path is supplied. Add `--keep-open` to leave the synthetic settings page open in a headed browser after testing; Ctrl+C closes that browser.

The original browser script creates an isolated browser context and intercepts every API request. It supplies synthetic instructors and exams and blocks API writes and remote requests. Saved-policy reads deliberately return 503 in that local-draft regression fixture. The separate `exam-policy-browser.test.mjs` exercises shared previews and mocked policy saves/reads, revision conflicts, error handling, stale responses, and accessibility. Use `EXAM_POLICY_TEST_URL` and `EXAM_POLICY_TEST_OUTPUT_DIR` for its base URL and scratch outputs. The result JSON records actual passes/failures and screenshots. Expected failed reads and intentional failed identity lookups can produce 503/401 console entries. No app authentication behavior is changed.

Photo checks generate a small PNG using an in-memory canvas; they never use a person's photo or an external image. They exercise local upload, preview, save/reload, exam/instructor isolation, removal, reset, and rejection of unsupported, oversized, or undecodable files. Only PNG, JPEG, and WebP files of at most 1 MiB are accepted. Photos remain in browser-local drafts; these tests do not contact an image upload service. Clear/remove photos or reset and save to remove them from that exam's saved draft.

Drafts save in version 2. Existing version-1 drafts load through migration without an automatic storage rewrite; saving writes the current format. Removed student voice permissions and difficulty settings do not reappear in the current interface. Voice remains an instructor presentation default; question difficulty is managed in the existing Question Bank.

Reset to Defaults restores the editor. Click Save Local Draft to persist that reset for the current exam and instructor. Closing and reopening the section retains unsaved edits. Preview preferences and mode changes retain assistance counts; Start new synthetic attempt resets those counters.

These checks exercise a frontend prototype with synthetic responses. They do not verify server authorization, live exam execution, microphones/cameras, AI or voice integrations, grade accuracy, or full accessibility conformance. Browser visibility and disabled controls are not security enforcement.
