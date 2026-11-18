# Taz correction verification — November 18, 2026

## Exact source and scope

Final implementation commit: `227c65382057d94e0066db5eca5447c13192cd79` (`paulo`).
Main correction commit: `08465ba23ec2a10e3939b8889a10b796f16c24ce`.
Starting commit and freshly verified remote tip: `91c53d8158f49aa7df99712699f4cb591d2a44c2`.
The final packaging commit adds this report only; its exact SHA is recorded in the bundle `.commit` sidecar. Runtime/source/test bytes remain those of the implementation commit above.

The original working tree was clean. Recovery ref: `recovery/taz-review-20261118-91c53d8`. No stash was applied, no main merge/push/publication/SSH transfer occurred. Explicit reviewed source/test/documentation paths were staged, the staged scope and whitespace were inspected, and private data, settings, dependencies, model weights, generated media and dumps were excluded. Original prompt/Modelfile bytes and previously applied SQL files were preserved. New migration identities are 022/023/024 by complete filename, not by assuming numeric prefixes are unique.

The implemented contract map, profile settings, limitations and concrete deployment prerequisites are in [the deployment plan](taz-correction-deployment-2026-11-18.md).

## Measured results

Environment: Windows, existing repository `.venv` (Python 3.12), installed Node 26.13.1, existing frontend dependencies, cached Playwright and installed Chrome. Nothing was installed. Browser suites use bundled real components with intercepted synthetic APIs/media; they do not visit the running application backend or acquire human devices.

| Check | Actual result | Scope |
|---|---|---|
| Final committed Python regression | **1,074 passed, 24 skipped, 143 subtests passed**, 240 dependency deprecation warnings | `backend/tests tests`; synthetic fixtures unless explicitly described below |
| Frontend unit checks | **116 passed**, zero failed/skipped | Explicit non-browser `.test.mjs` files; includes two new progressive-order/cancellation checks |
| TypeScript / production build | Passed | Final committed frontend; Vite retains a nonfatal large-chunk warning |
| Automatic examiner browser | **12 reported groups passed** | Synthetic speech/capture/playback; retained asset fixtures; captions, assistance, interruption, timing and autoplay recovery |
| StudentExam recording browser | **17 scenarios passed** | Existing child-widget mocks; synthetic recording/network/streams, no human devices |
| Real AutomaticOralExam inside real StudentExam | **1 scenario passed** | `CYBROS_TEST_REAL_AUTOMATIC=1`; real child/orchestration and timeline callbacks, mocked capture/provider/media/network; one automatic answer and recording completion |
| Retained question-audio browser | **14 passed**, zero failed | Generated muted synthetic PCM; real player/shared integrity loader, exact bytes/hash, replay, failures, cancellation and URL cleanup |
| Professor assessment browser | **7 reported groups passed** | Explicit manual/provisional confirmation, ownership-denial fixture, draft preservation and stale async responses |
| Historical navigation browser | **11/11 passed** | Current sidebar/tabs, ownership denial, unsaved-change guards, mobile layout, simple preview/storage |
| Historical policy browser | **14/14 passed** | Synthetic policy revisions, conflicts, namespace isolation, preview restrictions and pending-request recovery |
| Historical avatar browser | **21/21 passed** | Current navigation/tabs plus existing detailed instructor simulator; explicit fixture mode selects that supported component variant. Current simple preview remains covered separately by navigation suite. Retired avatar-photo upload/collapse checks were adapted to legacy draft loading/reset and identity reload; substantive persistence/isolation/validation/focus assertions remain. |
| Isolated PostgreSQL | **5 validation groups passed** | Fresh task-owned PostgreSQL 16.15 cluster; new additive upgrade on synthetic pre-existing rows, historical grade preservation, NULL legacy snapshots, ordered MP4 metadata, complete actual **29-entry** catalog and empty repeat plans; owned cluster stopped |
| Packaging/startup process tests | **2 passed** | Actual Bash scripts with synthetic executables and unrelated TCP listeners; occupied packaging port refuses before installation, renderer timeout returns nonzero, no app start, unrelated listener survives |
| Linux-provider/security contracts | Passed within Python counts | MockTransport HTTP, safe configuration failures, protected assistance lookup, media capability rejection, real service-route code with a synthetic renderer/profile reservation; no actual Linux/CUDA service |
| Diff validation | Passed | Final staged/source whitespace; new migration bytes normalized before final isolated validation and protected by Git attributes |

The 24 skips are opt-in PostgreSQL/native-speech/Ollama contracts; validation URL and model/device opt-ins were not supplied implicitly. The separate new isolated PostgreSQL runner above does not use the live application database or those private settings. No real native speech or real Ollama inference was run for this correction. An overly broad intermediate `node --test frontend/tests/*.test.mjs` invocation included browser entry points without their runtime environment and was interrupted; it is not counted as a passing suite. Its existing isolated real-backend/generated-canvas harness completed 2/2 checks before interruption, but that is separate from speech/avatar/human acceptance. Subsequent frontend unit checks used an explicit browser-excluding file list. Initial failures and fixture mismatches were retained in local logs, repaired and rechecked; final counts above do not relabel those earlier runs as passing.

## Reproducible commands

Run from the repository root, with existing prerequisites only:

```powershell
$env:PYTHONPATH = "$PWD\backend;$PWD"
.\.venv\Scripts\python.exe -m pytest backend/tests tests -q --tb=short
$unitFiles = @(Get-ChildItem frontend/tests -Filter '*.test.mjs' |
  Where-Object { $_.Name -notmatch 'browser' } | ForEach-Object FullName)
node --test @unitFiles
node frontend/node_modules/typescript/bin/tsc --noEmit -p frontend/tsconfig.json
node frontend/node_modules/vite/bin/vite.js build frontend --outDir ../.cache/taz-correction/build
$env:AVATAR_NODE_MODULES_PATH = "$PWD\.cache\browser-tools\node_modules"
node frontend/tests/automatic-oral-exam-browser.test.mjs
node frontend/tests/student-recording-browser.test.mjs
$env:CYBROS_TEST_REAL_AUTOMATIC = '1'
node frontend/tests/student-recording-browser.test.mjs
Remove-Item Env:CYBROS_TEST_REAL_AUTOMATIC
node frontend/tests/question-audio-browser.test.mjs
node frontend/tests/assessment-browser.test.mjs
node frontend/tests/manage-exam-browser.test.mjs
node frontend/tests/exam-policy-browser.test.mjs
node frontend/tests/avatar-browser.test.mjs
.\.venv\Scripts\python.exe scripts/verify_correction_schema.py --postgres-bin .cache/postgres/Library/bin --output .cache/taz-correction/isolated-postgres
.\.venv\Scripts\python.exe scripts/avatar_source_manifest.py .cache/taz-correction/avatar-source-manifest.json
git diff --check
```

Actual logs/reports are ignored under `.cache/taz-correction/`: `python-final-commit.log`, `frontend-unit-commit.log`, `build-final-commit.log`, `automatic-browser-final.log`, `recording-browser-final.log`, `real-child-browser.log`, `question-audio-browser.log`, `assessment-browser.log`, the three legacy browser report directories, and `isolated-postgres/schema-results.json`. These contain synthetic test evidence, not source deployment approval. Browser output-directory variables were set explicitly to those ignored directories during verification.

## Remaining limits and activation boundary

No Ubuntu/Podman/NVIDIA/CDI deployment, GPU rendering, real Linux speech service, human camera/microphone/display capture, full human assessed exam or seven-type rubric acceptance occurred. The tested concurrency boundary uses real service-route code and a synthetic renderer; actual multi-professor GPU stress remains unverified. MP4 persistence fixtures validate exact synthetic container bytes and metadata, not actual FlashHead visual quality/codec output. Speech-only Chatterbox synthesis and profile-bound FlashHead must be exercised against the installed Ubuntu environment before claiming Linux automatic-exam support. The rootless profile reuses external services and does not pretend their uninspected GPU allocation is verified.

Live application migrations 022/023/024 were **not applied**. The application was **not restarted** to activate these changes; no secrets, private settings, recording files, retention deadline or shared services were changed. The new source requires its additive schema before activation. Preserve the existing running version until the separately authorized backup/isolated restore/no-active-attempt/migrate/restart procedure is approved and performed. Unknown historical attempts deliberately remain blocked from invented new rubric assessment; existing grades stay historical and visible.

The bundle exposes only `refs/heads/paulo`; it does not expose other ref names or include uncommitted files/external assets. Verify its `.sha256`, `.commit`, `bundle verify` and `list-heads` artifacts before any authorized transfer. The source-only avatar manifest binds committed Git blob bytes to its exact source SHA; it does not deploy separately copied avatar files or transfer private profiles/models. Final bundle SHA/reference listing is delivered with the local transfer artifacts and in the chat result.
