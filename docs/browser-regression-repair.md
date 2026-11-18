# Historical browser regression repair

Measured November 16, 2026 on P3, local `paulo` checkout. This work changes tests
and their synthetic harness, not production UI, database state or services.

## Final measured results

| Existing suite | Passed | Failed |
|---|---:|---:|
| `avatar-browser.test.mjs` | 21 | 0 |
| `exam-policy-browser.test.mjs` | 14 | 0 |
| `manage-exam-browser.test.mjs` | 11 | 0 |
| `student-settings-browser.test.mjs` | 10 | 0 |
| Total scenario checks | 56 | 0 |

All four runners exited 0. Browser: installed Chrome 157.0.8103.51 on Windows.
Each suite still asserts no unexpected API request or runtime exception. The
student-settings suite still asserts no API, exam-start, device, speech, external
request or instructor-draft access at all. Every harness explicitly blocks real
camera/microphone capture and browser speech playback.

## What failed and what changed

The first runs against the offline bundle exposed the historical contract drift:

- Avatar: 14/20 passed initially. The custom-photo check expected a removed image
  alternative text, while the actual accessible image is now the portrait region
  named `Professor-selected avatar photo`. The check now verifies that region's
  actual image source. This failed cleanup also contaminated later photo/migration
  fixtures; the invalid-photo check now explicitly establishes its own baseline.
  The old background label included `(preview)` and assumed a two-option catalog;
  the intended single permitted choice now explicitly deselects all four other
  catalog choices. Dashboard navigation now verifies the actual `Your examinations`
  heading. No assertions or scenarios were skipped.
- Exam policy: the first run aborted when its mock rejected the current required
  `exam_mode` PUT field. The mock now validates and round-trips that field alongside
  settings and expected revision. It still checks stale revisions, ownership,
  unavailability, late results, local/server separation and pinned preview policies.
  A later 13/14 run found smooth-scroll automation races on a long form; pointer
  activation now explicitly scrolls the target into view immediately before click.
- Manage exam: 7/11 passed initially. The suite expected browser toggles named
  `Record Video`, `Record Audio` and `Generate Transcript`, but current source makes
  assessed recording mandatory and displays server policy instead. The repaired
  checks assert those controls are absent, the policy notice is present, and legacy
  recording draft values remain preserved. Category navigation/refresh/back/forward
  now waits for that real policy notice. The cross-tab category merge test uses the
  existing editable AI-results field, retaining its time-setting and unrelated-data
  preservation assertions.
- Student settings: all 10 checks pass with the offline harness. The original
  isolated-policy test depended on Vite's optimized module URL filenames. It now
  mounts the same actual components from test-only exports in the in-memory bundle,
  sharing the same React runtime. Restricted-field absence, native-dialog focus,
  policy separation, persistence, counters, reduced motion and narrow layouts are
  still asserted.

`offline-browser-app.mjs` bundles the real App and CSS using the existing esbuild
dependency, preserving the application's CSS import order. Playwright fulfills the
document, JavaScript and CSS directly in memory. Every API response remains an
explicit per-suite synthetic fixture. The standalone student preview is mounted
directly to preserve its stricter no-API contract. Its test-only exports never enter
the application bundle or production source.

This needs no Vite server or temporary listening test server. The URL is a virtual
same-origin address intercepted inside Playwright. No CYBROS, database or Ollama
service was started or stopped; no package, browser, model or weights were installed.

## Reproduce

From `frontend` in a checkout with its existing dependencies, set the package path
only if Playwright is provided by the installed Codex runtime rather than locally:

```powershell
$env:AVATAR_NODE_MODULES_PATH = 'C:\Users\Paulo\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\node_modules'
foreach ($suite in @('avatar', 'exam-policy', 'manage-exam', 'student-settings')) {
    & 'C:\Program Files\nodejs\node.exe' "tests\$suite-browser.test.mjs"
    if ($LASTEXITCODE -ne 0) { throw "Browser suite failed: $suite" }
}
```

The runners write JSON evidence and synthetic UI screenshots under their configured
output directories. For the measured final run, these were under the context
workspace's `outputs/browser-repair/{avatar,exam-policy,manage-exam,student-settings}`.
Override `AVATAR_TEST_OUTPUT_DIR`, `EXAM_POLICY_TEST_OUTPUT_DIR`,
`MANAGE_EXAM_TEST_OUTPUT_DIR` and `STUDENT_SETTINGS_TEST_OUTPUT_DIR` to choose output
locations. No screenshot contains real student/account/media data.

These tests establish frontend behavior with mocked API contracts in the measured
desktop Chrome, including simulated narrow viewports. They do not establish real
backend authorization, applied PostgreSQL migrations, live WebRTC, real transcription,
provider latency, real devices, actual mobile browsers or an assessed end-to-end exam.

## Saved audio and enhanced professor review

Two additional browser suites verify the new delivery/replay UI against intercepted
APIs using generated PCM WAV fixtures. Chrome actually decodes and plays those bytes;
HTML media methods and events are not mocked. `--mute-audio` prevents speaker output,
and real device capture remains blocked. The two question fixtures have distinguishable
440 Hz and 660 Hz tones, with no human/student speech.

| Additional suite | Passed | Failed |
|---|---:|---:|
| `question-audio-browser.test.mjs` | 14 | 0 |
| `saved-review-browser.test.mjs` | 12 | 0 |
| `review-browser.test.mjs` | 2 | 0 |
| `live-presentation-browser.test.mjs` | 2 | 0 |

The question-audio suite verifies authenticated exact-byte retrieval, SHA-256 before
playback, trusted native playing/ended events and correlated asset/sequence observations,
replay without repeated synthesis, unavailable provider, malformed metadata, wrong hash,
retained request identity on retry, stopped and stale generation/byte responses,
question-change interruption association, blob revocation and unmount cleanup.

It also exposed a production recovery defect: temporarily disabling the player while
capabilities were loading invalidated the lookup through the playback generation. The
play button could remain disabled for the same question after re-enabling. Capability
lookup now has its own abort lifecycle. The regression waits for the real disabled
effect before releasing the delayed response and verifies playback recovers.

The review suite verifies ordered question/answer pairing, confirmed/typed/timeout/legacy
transcript labels, original draft disclosure, exact exchange-specific audio URLs,
generated-only versus started/ended browser evidence, active audio/video mutual exclusion,
speed changes, exchange seeking and stop bounds, explicit continuity boundaries and
missing offsets, expired/unsupported assets, denied review, expired recording and a
390px viewport. No playback or delivery inference is invented for missing observations.

```powershell
& 'C:\Program Files\nodejs\node.exe' tests\question-audio-browser.test.mjs
& 'C:\Program Files\nodejs\node.exe' tests\saved-review-browser.test.mjs
& 'C:\Program Files\nodejs\node.exe' tests\review-browser.test.mjs
& 'C:\Program Files\nodejs\node.exe' tests\live-presentation-browser.test.mjs
& 'C:\Program Files\nodejs\node.exe' node_modules\typescript\bin\tsc --noEmit
```

All four additional runners exited 0 and the final TypeScript check passed. The same
`AVATAR_NODE_MODULES_PATH` above locates the already-installed Playwright package.
These 30 additional scenario checks establish browser handling of mocked stored media;
they do not establish a real synthesis provider or production recording/backup storage.
The older `review-browser` smoke uses explicitly mocked media methods; its two
scenarios cover review routing, callback-based seek/stop/speed and the distinction
between unavailable login service and incorrect credentials. The question-audio
and saved-review suites use actual browser media decoding and trusted native events.
The integrated presentation suite uses real muted saved WAV playback with a
deterministic browser-speech mock; it verifies that normal/retry browser speech
cannot overlap saved playback and that muted controls remain disabled.

The final lifecycle audit reproduced and repaired capability timeout remaining in
Checking state, late observation errors replacing a newer playback status, exchange
ends beyond a shortened recording, stale play-promise rejections and abandoned
segment bounds after switching to question audio. Timeout now exposes unavailable
status with an explicit bounded retry, stale callbacks are ignored, complete bounds
are checked against media duration, and playback ownership/cleanup follows the
current operation. Regression cases exercise real muted fixtures and controlled
delayed responses/play promises; no real device or service was involved.

After integrating Professor assessment, the two review runners were rerun with
explicit professor identity and private report GET fixtures. They verify the
assessment section and score field load while preserving media, denied-review,
unexpected-API and no-mutation assertions. No grading mutation fixture was added;
assessment-generation/confirmation behavior is tested separately.

The standalone `assessment-browser.test.mjs` separately passed seven scenarios:
manual confirmation without a model call; private provisional suggestions and
explicit acceptance/editing; score bounds/provider timeout with preserved drafts;
inaccessible-report isolation; suggestions remaining unaccepted until an explicit
action; late report isolation after selecting another session; and late generation,
confirmation or provider-error isolation. These are mocked browser/API checks,
including regressions for stale async operations, rather than real grading evidence.

A rerun after adding the professor question-draft UI again passed all four
historical suites (20/14/11/10 scenario checks). The navigation fixtures explicitly
provide the new authenticated `question-drafts` GET shape: empty pending drafts,
approved topics and edit availability. They verify the draft panel and its explicit
approval notice while preserving the assertions that no backend mutation or unknown
API request occurred. Generation/approval remains outside these navigation suites.

The final rerun after the assessment-context editor and shared professor-preview
renderer passed 21/14/11/10 scenario checks (56 total). The explicit context GET
fixtures include approved topics, rubric criteria, context hash and edit availability;
navigation verifies the actual fields load without allowing new writes in these
historical suites. Professor previews now use `ExamStageAvatar`, the actual exam
renderer, and a new browser scenario proves all five catalog backgrounds have
distinct computed styles while preserving custom-image and narrow-screen checks.

## Actual localhost UI smoke

After the approved local migration/start/restart work, `scripts/smoke_p3_browser.mjs
--create-synthetic-exam` passed seven actual browser checks with real localhost
authentication and API responses. It read the protected test professor credentials
internally, created one unpublished synthetic exam, and removed only that new UUID
in cleanup. It filled and saved Computer Science topics and an Accuracy rubric with
maximum score 10 through the real UI, reloaded, verified persistence and that draft
generation controls became enabled, and deliberately did not generate questions.
The smoke also verified the dashboard/exam pages, real draft/context reads, five
visually distinct shared-renderer backgrounds and a 390px preview.

The final normal run reported 7 passed, 0 failed, with its new synthetic exam
confirmed deleted. No model/provider calls, real capture, screenshots, runtime/API
errors or credential values appeared in output. Detailed sanitized reports remain
inside protected `private-data/p3-local/verification/browser-smoke-*/report.json`.
`--exam-id` stays read-only; context PUT is permitted only for this run's newly
created synthetic UUID. `--expect-backend-unavailable` uses dummy input and no
credential file or request interception to test real proxy/service-error messaging;
service lifecycle is controlled separately by the reviewed launcher.

## Final frontend validation

The final integrated source passed `tsc --noEmit` and all 107 Node unit tests
across 12 nonbrowser test files (0 failed, 0 skipped). The eight tabulated mocked
browser runners above total 86 passing scenario checks: 56 historical-menu checks
and 30 review/audio/presentation checks. The standalone assessment runner separately
passed seven scenarios. The final environment browser rerun passed three groups,
including the actual StudentExam mocked-demo lost-response retry path after recording
lifecycle fixes. The actual localhost UI smoke separately passed 7/7.

Vite 7.3.6 built 2,017 modules successfully into the verified untracked
`.cache/implementation-frontend-build` directory. Tracked `frontend/dist` was
untouched. After the lifecycle fixes, the final rebuild took 3.25
seconds and output was a 521.49 kB JavaScript bundle (147.74 kB gzip) and
191.43 kB CSS (29.57 kB gzip). Vite reported its nonfatal JavaScript chunk-size
warning above 500 kB. No chunk limit was relaxed and no production code changed
during this final validation. These checks started/stopped no application services.
