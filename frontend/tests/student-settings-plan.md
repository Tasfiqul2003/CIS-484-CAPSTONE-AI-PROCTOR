# Student settings and exam permissions: implementation plan

**Current authorization:** the user explicitly requested all items categorized as “Change now”: shared instructor/student preview policies, professor-owned per-exam policy storage, documented permissions and lifecycle, per-question allowances, accessibility, and relevant tests. This supersedes the earlier step-1-only gate. Roster/enrollment, student authentication, real exam/attempt enforcement, and individual exceptions remain separate tasks. Do not create automations or background continuations.

Current rules and integration requirements are in `docs/avatar-permissions-integration.md`. The sections below retain the earlier step-1 scope and recorded checks as history; their earlier restrictions do not cancel the current authorization.

## Step 1 — Original standalone preview scope and review checklist

Build and test only the isolated frontend student settings preview at `/student/settings-preview`, reached through **Student Exams → Student Settings Preview → Student settings**. Its native settings dialog controls volume, text size, reduced motion, avatar, background, and speaking speed using fixed synthetic choices. Disallowed settings and assistance actions are omitted entirely, including their labels and placeholders. Voice and assessment controls are omitted. If no presentation changes are permitted, that settings section is omitted. The question, sample response, and assistance actions are synthetic; no actual answer is submitted.

Save Preferences stores presentation preferences only in the separate `oral-exam-student-preview:v1` browser namespace, scoped to fixed mock exam/student identifiers. The sample response and assistance counters are not persisted. Instructor drafts are not read or modified. Reset Preferences resets presentation preferences; it does not replenish assistance counts during the mounted preview. Restart preview begins a fresh synthetic attempt and clears its sample response; refreshing the page also creates a new synthetic attempt.

This step must not connect instructor and student policy, add a roster, implement authentication, change backend code, or affect live exams. No microphone, camera, model, or voice service is activated. Browser controls and mock counters are not security enforcement.

### Manual review before accepting step 1

1. Open `/student/exams` and follow **Student Settings Preview**. Confirm that the page clearly identifies itself as a synthetic frontend preview and does not start an exam.
2. Open **Student settings**. Try volume, all three text sizes, reduced motion, both avatar choices, both backgrounds, and speaking speed. Verify that the visible preview updates and the question wording stays unchanged. Person and Diamond are icon previews. Voice is absent from the settings panel. A reduced motion choice is omitted when motion is already forced off by the browser or sample policy; the preview still honors that requirement.
3. Save Preferences, reload the preview, and reopen the dialog. Confirm the saved presentation choices return. Enter a sample response and reload; the response should not return.
4. Confirm that explanation and correctness feedback have no row, button, label, or unavailable placeholder under the fixed practice policy. Each allowed action has a prominent badge beside its name, such as **2 of 2 remaining**, before any use. Use the exact repeat twice, clarification once, and hint once; check that the badge updates after each use. Allowed actions that have exhausted their uses stay visible with **0 of X remaining** and cannot be used again. Change/reset preferences and close/reopen settings; these actions must not replenish counts. Use Restart preview to start another synthetic attempt.
5. Use Tab/Shift+Tab inside the dialog. Check visible keyboard focus, Escape to close, and focus returning to Student settings. Check a narrow screen, including 360 px width with the largest text size. Reduced motion should also respect the browser preference.
6. Report any changes needed. **Step 1 remains pending manual acceptance; passing automated checks alone does not authorize step 2.**

### Automated checks for step 1

From `frontend/`, use the existing build check:

```powershell
npm run build
```

The focused browser script uses an already available Playwright package and Chrome/Chromium. It adds no repository dependencies and does not install packages or browsers. Start the frontend with the existing `npm run dev -- --host 127.0.0.1` command, then in another terminal set paths for the installed runtime and a scratch output folder:

```powershell
$env:AVATAR_NODE_MODULES_PATH = 'C:\path\to\existing\node_modules'
$env:AVATAR_CHROME_PATH = 'C:\Program Files\Google\Chrome\Application\chrome.exe'
$env:STUDENT_SETTINGS_TEST_URL = 'http://127.0.0.1:5173'
$env:STUDENT_SETTINGS_TEST_OUTPUT_DIR = 'C:\path\to\scratch\student-settings-results'
node tests/student-settings-browser.test.mjs --keep-open
```

Omit `AVATAR_NODE_MODULES_PATH` when normal Node module resolution finds Playwright. The browser path defaults to standard Chrome locations on Windows/macOS and existing Playwright Chromium on Linux. The script also accepts the existing `AVATAR_TEST_URL` and `AVATAR_TEST_OUTPUT_DIR` overrides; student-specific variables take precedence. Without an output override, results go to `test-results/student-settings` under the current directory. Prefer a scratch folder outside the repository.

The script intercepts and blocks all API and external requests, uses only synthetic preferences, and checks the entry link, presentation changes, save/reload/reset, assistance limits, labels/focus, reduced motion, narrow layouts, sample-response non-persistence, and separation from instructor drafts. It records actual passes/failures and screenshots. `--keep-open` leaves the Student settings dialog open for user review; Ctrl+C closes that test browser. Automated results do not establish backend authorization, real identity, live exam reliability, or full accessibility conformance. Record actual execution outcomes separately; unexecuted checks are not passes.

### Recorded results — October 15, 2026 (America/New_York)

Actual automated verification for step 1:

- Frontend TypeScript check (`tsc --noEmit`): passed, exit 0.
- Vite production build: passed, exit 0; generated files kept in the task scratch folder.
- Model tests (`node --test tests/student-settings.test.mjs`): 11 passed, 0 failed.
- Final synthetic Chrome run at `http://127.0.0.1:5174`: 9 browser check groups passed, 0 failed, completed at `2026-10-16T01:38:03.325Z`.
- Observed API requests, external requests, media calls, page errors, and console errors during the final browser run: all zero. Instructor draft sentinel remained unchanged and was not read by the preview.
- Keyboard containment, Escape/close focus return, saved preference reload/reset, assistance counters, browser reduced motion, and layouts at 390 px and 360 px with 24 px student text passed the automated checks. Desktop and mobile screenshots were visually reviewed.
- `git diff --check`: passed. No backend or live student exam files were changed for step 1.

The initial browser run caught a focus wrapping issue, which was fixed and verified in the final run. Its short navigation timeout also prevented fixture setup; the runner now waits for readiness and seeds its synthetic fixture independently.

Manual verification remains **pending**. These results do not authorize step 2. The current review link is **http://127.0.0.1:5174/student/settings-preview**; the local development server must be running to use it. Browser reports and screenshots remain in task scratch storage rather than the repository.

### Visibility revision — October 15, 2026 (America/New_York)

At the user's request, policy-disallowed settings and assistance actions now render no controls, rows, labels, or unavailable placeholders. The panel omits the entire Presentation section when all optional presentation changes are locked, and omits the reduced motion choice when reduced motion is already required. Active exam visuals still use the applicable defaults. Allowed assistance actions with exhausted allowances remain visible with 0 remaining.

Actual verification after this revision: TypeScript and Vite production build passed (exit 0); all 10 synthetic Chrome check groups passed, 0 failed, completed at `2026-10-16T01:49:59.230Z`. The added component harness tested fully locked and Avatar-only sample policies without adding an app route or connecting instructor state. The final browser report recorded zero API requests, external requests, media calls, page errors, and console errors. `git diff --check` passed. Manual acceptance and steps 2–5 remain pending.

### Remaining-use badge revision — October 15, 2026 (America/New_York)

The allowance is now a bold purple badge beside each assistance action's name, showing **X of X remaining** before first use and updating after each use. Numbers are larger than the surrounding helper text. Exhausted badges show **0 of X remaining** with a neutral background; exhausted actions stay visible. Counts remain described by each action button for assistive technology.

Actual verification: TypeScript and Vite production build passed (exit 0); all 10 synthetic Chrome check groups passed, 0 failed, completed at `2026-10-16T01:57:33.652Z`. The browser exercise checked repeat counts 2 → 1 → 0, clarification/hint counts 1 → 0, unchanged counts through settings edits/reset/close, and fresh counts after Restart preview. Desktop and 360 px screenshots were visually reviewed; 390 px and 360 px overflow checks at 24 px text passed. `git diff --check` passed. Steps 2–5 remain deferred pending the user's instruction.

## Step 2 — Shared mock exam policy: implemented under current authorization

Manage Exam can explicitly share a versioned browser policy with the connected student preview. Local drafts, shared preview policy, server policy, and personal preferences remain separate. Disallowed controls are absent; essential accessibility remains available. Preview mode is an instructor simulation. A preview pins its starting policy until Restart preview; later changes are announced without silently replacing its active rules. Professor-owned server policy storage is implemented separately through the authenticated policy API and migration 006; the project database has not been migrated by this work.

## Step 3 — Deferred: minimal assigned students and later identity integration

After the preceding step is reviewed and separately authorized, design the minimum assigned-student relationship needed to show which synthetic students may access an exam. A students table or an attempt record alone does not establish class enrollment or exam eligibility. Keep the first prototype synthetic. Actual student identity, authentication, roster/enrollment integration, and eligibility enforcement belong to an explicitly authorized later backend phase; this plan does not authorize those changes.

## Step 4 — Remaining real-attempt enforcement

Professor-owned policy saving is now implemented, with strict validation, ownership checks, and revision conflicts. When the actual student attempt flow is implemented, validate student preferences and assistance requests, verify authenticated student eligibility and attempt ownership, and persist a policy snapshot/revision at attempt start. Instructor edits apply to new attempts. Count assistance atomically per attempt/question/action and test unauthorized requests, retries, and exhausted limits. Frontend visibility, local storage, and prompt text are not authorization boundaries. These real-attempt integrations remain unimplemented.

## Step 5 — Deferred: individually approved exceptions

After the shared policy and authorization foundations are reviewed, support individually approved exceptions assigned by an authorized instructor or appropriate approving role. Define scope, approval, expiration, and precedence relative to the exam policy; students cannot grant themselves exceptions or change assessment rules. Preserve essential accessibility options and professor control of final grades. Implement and test this only after the user separately authorizes the step.

**Complete only the currently authorized Change-now scope. Related roster, student identity, assignment, real-attempt enforcement, and exception tasks require their own implementation work. No automation or automatic continuation.**
