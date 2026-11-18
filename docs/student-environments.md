# Student examiner environments

Implemented November 16, 2026 for the existing web application. The environment
means the examiner's background. It does not transform the student's camera feed.

The built-in catalog contains neutral room, library, classroom, office and nature.
The backgrounds use bundled CSS gradients and require no image service, provider,
model, new dependency, network image or animation. Professor policy still controls
which choices students may use. A locked policy shows its chosen environment only;
existing saved policies and immutable active-attempt snapshots are preserved.

An authorized student reaches `EnvironmentPreview` before the recording notice.
The preview uses the same `ExamStageAvatar` renderer as the active exam. Native radio
controls provide keyboard selection, and the selected state remains visible. The
preview creates no attempt, clock, question, device stream or graded interaction.
Continuing saves personal preferences and opens the recording notice. The existing
explicit start action, roster eligibility, photo-check, recording/storage checks
and server exam rules still govern actual attempt creation.

`GET/PUT /exam/templates/{exam_id}/student-presentation` require a student-exam
token scoped to that student/exam, a published exam, roster membership and the
existing recent-photo-check gate. Responses contain only presentation information.
PUT accepts a presentation revision and validated preference fields. Preferences
are saved in `student_environment_preferences`, keyed by exam/student. Reload
revalidates saved preferences against the current policy; disallowed values visibly
fall back to current professor defaults. A stale PUT returns 409. Attempt creation
validates the chosen preferences again and saves them alongside its existing policy
snapshot. Later professor edits do not rewrite an active attempt.

Migration `017_student_environment_preferences.sql` creates only the new preference
table. No existing migration was rewritten. This implementation did not apply it to
the P3 database. Apply it through the established migration runner as part of an
authorized upgrade after checking the ledger and protecting existing data. A code
rollback can leave the unused table in place; dropping it loses saved preferences.

Custom professor backgrounds remain bounded raster data URLs. An image that fails
to decode displays a neutral environment and a visible unavailable message. Built-in
choices need no assets and therefore have no image-download dependency. The live
renderer stays static and does not require SoulX/FlashHead.

## Measured synthetic checks

Run from the application root with the existing Python environment:

```powershell
.\.venv\Scripts\python.exe -m pytest backend\tests\test_environment_preview.py backend\tests\test_avatar_policy.py backend\tests\test_avatar_session.py -q
```

Observed result: 121 passed. Tests use in-memory SQLite and synthetic tokens; the
existing photo gate is substituted with a deterministic checker and separately
tested for rejection. They exercise scoped access, five choices, saved preference
reload, changed/locked policy, strict input validation and unavailable storage. No
P3 database, real photo, recording or provider is accessed.

From `frontend`, using the installed Node executable:

```powershell
node --test tests/environment.test.mjs tests/avatar-settings.test.mjs tests/exam-policy.test.mjs tests/live-avatar.test.mjs tests/student-settings.test.mjs
node node_modules/typescript/bin/tsc --noEmit
```

Observed result: the initial combined run passed 55 unit tests and the TypeScript
check passed. The focused environment suite subsequently passed six checks,
including two added regressions for receipt/bounds preservation across retries
and provider metadata isolation from attempt, question and request identifiers.

The standalone browser test bundles the UI in memory and intercepts every request;
it starts no HTTP server, CYBROS service or Ollama process:

```powershell
# Set AVATAR_NODE_MODULES_PATH only if Playwright is installed outside frontend.
node tests/environment-browser.test.mjs
```

Observed synthetic browser results: five distinct CSS previews, shared live renderer,
keyboard arrow selection, 390px viewport and 150% CSS zoom, preference refresh,
locked policy, failed custom asset fallback, and no preview attempt/device calls.
The same harness also verifies stable answer request IDs/payloads after a dropped
response and isolation when the next question is shown. It explicitly blocks camera,
microphone and browser speech. These results establish the mocked UI behavior in the
installed desktop Chrome only. Other browsers, actual mobile devices, real provider
latency and complete assessed recording remain separate validation work.
