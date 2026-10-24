# Manage Exam navigation checks

The instructor overview links to Question Bank, Course Materials, and six category pages under `/professor/exams/:id/settings/`. Avatar & Interaction Settings keeps all its existing subsections and separate local draft, shared preview, and server policy actions. The other categories retain their existing browser-local draft controls and use the original `oralExamSettings-/professor/exams/:id` storage key. Saving a category merges that category into the latest stored exam draft.

The legacy `/professor/exams/:id#avatar-settings` and `/professor/exams/:id/avatar-settings` links redirect to the dedicated avatar page. Navigation uses the existing full-page anchors and browser history. Dirty settings pages use the browser's unsaved-change prompt; accepting navigation discards the unsaved edits, while canceling retains the editor.

Run the frontend with the normal Vite development command. From `frontend/`, run the synthetic browser exercise using an already installed Playwright runtime and Chrome:

```powershell
$env:AVATAR_NODE_MODULES_PATH = 'C:\path\to\existing\node_modules'
$env:AVATAR_CHROME_PATH = 'C:\Program Files\Google\Chrome\Application\chrome.exe'
$env:MANAGE_EXAM_TEST_URL = 'http://127.0.0.1:5173'
$env:MANAGE_EXAM_TEST_OUTPUT_DIR = 'C:\path\to\scratch\manage-exam-results'
node tests/manage-exam-browser.test.mjs
```

The suite intercepts every API request with synthetic exam and professor responses, returns an empty roster, and blocks external requests and unconfigured writes. It checks all navigation cards, category isolation, direct links, reloads, back/forward navigation, original draft keys, category saves, simultaneous category pages, unsaved-change prompts, old avatar links, instructor/student previews, owned-exam denial, and 360px layouts. It writes actual pass/fail results and screenshots to the selected output directory. Its server-policy fixture deliberately returns 503; server policy reads/writes and stale revisions are exercised separately by `exam-policy-browser.test.mjs`.

Also run the existing model and browser regressions documented in [README-avatar-settings.md](README-avatar-settings.md). Those suites retain the prior avatar, preference, and policy behavior checks; the avatar suite now opens the dedicated page through its overview card.

These are frontend checks with synthetic responses. They do not establish real backend authorization, roster eligibility, live exam enforcement, media recording, grading accuracy, model behavior, or full accessibility conformance.

## Changed files

- `src/App.tsx`: specific category routes and compatibility redirects before the general Manage Exam route.
- `src/pages/professor/ManageExam.tsx`: exam overview, existing content links, six settings cards, and the existing roster component.
- `src/pages/professor/ExamManagementLayout.tsx`: shared exam context, header/back navigation, and the existing professor owned-exam check before mounting settings.
- `src/pages/professor/ExamSettingsPage.tsx`, `examSettingsNavigation.ts`, and `exam-management.css`: category destinations, navigation metadata, and scoped responsive styling.
- `src/components/avatar/AvatarSettings.tsx`: open the reused editor on its dedicated page and update its reference to the other categories.
- `src/components/exam-settings/ExamCategorySettings.tsx` and `examSettings.ts`: extracted original controls, canonical draft storage, category-specific merge/save, and unsaved-change handling.
- `tests/exam-category-settings.test.mjs` and `manage-exam-browser.test.mjs`: synthetic persistence and navigation regressions. Existing avatar/policy/student browser suites use the current routes and merged roster/verification fixtures.
- `tests/README-avatar-settings.md` and `../../docs/avatar-settings-menu-guide.md`: updated navigation guidance. This document records the new checks.

## Actual verification — October 24, 2026

The initial working tree was clean on `Paulo` at `9203a8a`, also the cached `origin/main` commit. Git history contains PR #20's merge `c81360e`, and `git merge-base --is-ancestor c81360e HEAD` returned 0. Local `main` still points to that merge. This inspection used local history and cached remote references; it did not fetch or change branches.

- `node node_modules/typescript/bin/tsc --noEmit`: passed.
- `node node_modules/vite/bin/vite.js build --outDir <task-scratch>`: passed, 61 modules transformed. Build output stayed outside the repository.
- `node --test tests/avatar-settings.test.mjs tests/student-settings.test.mjs tests/exam-policy.test.mjs tests/exam-category-settings.test.mjs`: **55 passed, 0 failed** (42 existing plus 13 category-persistence checks).
- `.venv/Scripts/python.exe -m pytest backend/tests/test_avatar_policy.py -q` with scratch `basetemp` and cache: **56 passed**, 14 installed-dependency deprecation warnings. Only synthetic SQLite databases were used.
- Existing browser suites: avatar **20 groups passed**, connected policy **14 passed**, standalone student settings **10 passed**. API behavior was intercepted with synthetic responses.
- New navigation browser suite: **11 groups passed, 0 failed** after the fragment fix, including all six category pages, direct/reload/back/forward navigation, cross-category and cross-tab saves, unsaved navigation cancellation/discard, preview storage separation, ownership denial, and all six 360px pages. Across all four browser suites: **55 groups passed**, zero runtime errors. JSON reports and screenshots were saved in task scratch storage.
- `git diff --check`: passed.

Initial sandboxed browser requests could not reach localhost; restarting the isolated preview and tests with local socket access resolved that environment failure. The new browser test's first selectors assumed whitespace around the preserved time-limit label; adjusting the selectors matched its actual accessible name. The standalone student regression's old entry link was already absent after the merged verification flow, so it now opens the existing `/student/settings-preview` route directly. Student application behavior was not changed.

The navigation regression also found a real compatibility issue: following the old avatar fragment while the overview was already open changed only the hash, leaving this pathname-based app mounted. A scoped `hashchange` listener now redirects that case with history replacement; the test explicitly enters through the overview before following the old fragment.

The manual review uses an isolated local Vite fixture with a visibly synthetic exam and an empty roster. Its API middleware never forwards to the application backend; mock policy saves last only for that fixture's process. It is separate from production source and does not change authentication. Production hosting fallback for deep links, the real PostgreSQL migration, and real end-to-end account/attempt behavior remain unverified.
