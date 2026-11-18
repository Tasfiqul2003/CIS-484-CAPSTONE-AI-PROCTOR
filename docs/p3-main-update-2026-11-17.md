# P3 local main integration — November 17, 2026

Local source integration and runtime verification are complete. Verification is **not entirely green**: three historical UI browser suites still use pre-main navigation/control assumptions. Their failures are retained, not suppressed. Current-main live navigation, tabs and relevant local feature checks passed separately.

Checkout: `C:\Users\Paulo\CIS-484-CAPSTONE-AI-PROCTOR`, branch `paulo`.
Remote: `https://github.com/Tasfiqul2003/CIS-484-CAPSTONE-AI-PROCTOR.git`.
Fetched/integrated main: `b307f36703eec3d2a234e403d12c1aeeaffe09f1`.
Merge: `e35081757413edbd86c4d25ba1fcf1edeaee0f49`.
Its two parents are original `0085b8d1e2e4994977fb4ce6232e0cbad519d3fe` and that exact main SHA. Main ancestry passed. No history rewrite, reset, clean, clone, push or shared deployment occurred.

The original checkout had 14 unstaged modified files, nine untracked source/test/doc files, an empty staging area, no stashes, no submodules and no unfinished Git operation. The original uncommitted work was excluded from the merge commit. It was restored with `stash apply` using an exact recorded object, resolved and returned to unstaged status. Integration follow-ups and this report also remain uncommitted. The final status is intentionally dirty; nothing is staged or unresolved.

## Preserved and reconciled behavior

Preserved original committed history, prompt/Modelfile baselines, question draft approval/context and request scoping, speech draft provenance, saved question audio/replay, delivery/interruption timelines, live video, recording interruption/partial-save safeguards, private provisional score validation and explicit professor confirmation. Preserved the original uncommitted synthetic developer photo bypass, identity-review labels and launcher setting. The bypass remains a distinct temporary synthetic authorization; it creates no photo-match claim and retains recording/roster/timing/assessment gates.

Retained main's new layouts/sidebar/tabs, exam completion restrictions, greetings/reactions, rubric editor/default rubric, automatic provisional assessment and per-answer evaluations. Adapted idempotent answer receipts to include main's reactions, extended strict evaluation validation to accept main's question evaluations, restored local media controls inside main's layouts and made manual confirmation work with main's default rubric. The shared preview renderer remains inside main's new simple preview tab.

The committed merge had nine textual conflict files (31 recorded hunks): `backend/app/exam.py`, `grading.py`, `main.py`, `review.py`; `frontend/src/App.tsx`, `components/avatar/LiveExamPresentation.tsx`, `pages/professor/ExamSessionReview.tsx`, `QuestionBank.tsx`, `pages/student/StudentExam.tsx`. No rename, deletion, binary or add/add conflict occurred. Independent imports/routes/fields were combined. Overlaps selected main, then compatible interfaces were adapted.

The materially displaced local behavior was: the HTTP assessed-exam ban on generated live follow-ups (main permits saved-policy-limited follow-ups); the 90-second question-model call timeout (main uses 45 seconds); manual-only assessment initiation/no default rubric (main automatically generates provisional suggestions and supplies a default rubric); and the older review/student/navigation layouts and always-visible avatar question presentation (main supplies the new layouts and question reveal control). Existing streaming-turn restrictions were unchanged because main did not modify that path. The local score schema/completion validation was adapted to main's per-question output instead of discarded. Main's raw approximate question timestamp seeking coexists with locally retained bounded exchange playback and provenance warnings.

Stash restoration had six conflict files/ten hunks. Main's completed-exam guard, title/timing fields, camera layout and review layout were retained. Compatible bypass authorization, identity fields/notices, imports and frozen-frame clearing were combined. No original source file was discarded wholesale. Full hunk-by-hunk local/main text and decisions are in the protected recovery directory described below; its original file snapshots preserve every displaced byte. Historical browser expectations displaced by main are explicitly listed under verification.

## Environment and database

Dependency manifests/lockfiles were unchanged by fetched main and remain unchanged; no independent package upgrades were needed. `pip check` passed. Final TypeScript and production Vite build passed; generated output is `.cache/main-update-build/`. Historical tracked `frontend/dist` remains unchanged. The build has a nonfatal large-JS-bundle advisory (589.09 kB before gzip). No lint script/configuration is declared; syntax, type, whitespace and relevant tests were run.

Applied only main's additive `migrations/016_ai_question_evaluations.sql`. Duplicate numeric migration prefixes were retained. All 24 previously applied filenames/hashes matched before upgrade; source ledger now has 25 matching catalog entries with zero pending. Original applied migration bytes were unchanged. Protected custom-format backup, restore listing, isolated restore/migration/idempotence and actual SQL contracts passed before source application. A final post-upgrade backup/isolated restore also passed.

Pre-existing source exam sessions: one before, one after, identical session IDs; zero active attempts. The comparison read the original protected dump internally without exposing rows. Synthetic scratch exams were removed by their own test cleanup. Existing private settings, account configuration, recording/assets and model baseline copies were verified unchanged (18 protected files). No primary data reset or applied-history rewrite occurred.

Local launcher now explicitly clears avatar service URL/token even if a parent shell supplied them. SoulX/FlashHead remains excluded; main's optional source is present but no service, installation, download or GPU work was activated. Existing Ollama model selection and weights remain unchanged. Retention remains the existing November 15, 2027 fixed deadline. No secret rotation or shared infrastructure change occurred.

Final running services bind only `127.0.0.1`: frontend 5173, backend 8000, owned PostgreSQL 55432 and externally managed Ollama 11434. Frontend/backend/proxy/model readiness passed. External Ollama ownership was not adopted. Start/status/stop remain `Start_CYBROS_Local.bat`, `Start_CYBROS_Local.bat status`, `Start_CYBROS_Local.bat stop`.

## Actual verification

| Check | Result |
|---|---|
| Complete final Python regression | 980 passed, 10 gated skips, 143 subtests; 230 warnings; 51.74 s |
| Focused combined assessment/default-rubric checks | 28 passed |
| Frontend unit tests | 113 passed |
| TypeScript, Python compile, Git whitespace | Passed |
| Final production Vite build; Python dependency consistency | Passed; nonfatal bundle advisory |
| StudentExam synthetic recording lifecycle | 11 passed |
| Saved review/media browser checks | 12 passed |
| Review/login browser checks | 2 passed |
| Question audio browser checks | 14 passed |
| Reviewed-speech browser checks | 6 groups passed |
| Private assessment browser checks | 7 groups passed |
| Question drafts/context browser checks | 5 groups passed |
| Question request race checks | 5 groups passed |
| Environment browser checks | 3 groups passed |
| Integrated audio/speech presentation | 2 passed |
| Developer bypass browser scenarios | 20 passed |
| Student settings browser suite | 10 passed |
| Real backend/auth/native generated-canvas WebRTC and stored WebM | 2 passed |
| Actual localhost UI/navigation/tabs/context/five backgrounds/narrow screen | 8/8 passed |
| Actual localhost bypass checks, three synthetic IDs | 3/3 passed; no exam starts/capture |
| Owned recovery/full restart/cookie/database persistence | 23/23 passed |
| Final isolated PostgreSQL contracts, including actual local Ollama assessment and professor confirmation | 16 passed; 27.71 s |

The three historical browser suites remain failing: `manage-exam-browser.test.mjs` (2 passed/9 failed), `exam-policy-browser.test.mjs` (0/14), and `avatar-browser.test.mjs` (failed/terminated with locator timeout). They expect old cards, `Manage Exam`/`Avatar & Interaction Settings` links, untabbed visible fields and old save/share/preview controls, and lack the new optional professor-avatar capability fixture. Their failures were not marked skipped or hidden. Updating these legacy suites is remaining verification work; this update does not claim an all-green browser matrix. Actual current-main sidebar destinations and all seven avatar tabs passed the new live acceptance check. Existing frontend/backend unit and focused media/security tests remain independently passing.

Real human camera/microphone/display capture, human speech quality and a full human assessed exam remain unverified. Synthetic recording/identity fixtures do not establish real biometric accuracy or human exam acceptance. The local generated-clip/model tests establish only their recorded scopes.

Evidence is under ignored `.cache/main-update-*.txt`, `.cache/main-update-legacy-browser-evidence/`, `.cache/browser-results/` and protected `private-data/p3-local/verification/`. Exact final state is `private-data/p3-local/backups/main-update-20261117/final-verification.json`.

## Recovery checkpoints and instructions

Protected recovery directory: `private-data/p3-local/backups/main-update-20261117/`. It has a verified `history.bundle`, original index, separate binary `staged.patch` (empty) and `unstaged.patch`, original working-file snapshots and hashes, separately protected private assets/models, fetched SHA, exact task stash SHA and both full conflict decision JSON files. It is ignored and ACL-restricted; do not publish or copy its contents into Git.

Original-history recovery branch: `recovery/paulo-before-main-20261117`.
Retained task stash: `a5754f3f1faf1e3c47ef5495bf34f2aa3d0740c8`, message `CYBROS main update 20261117 original uncommitted work`.
No unrelated stash existed or was removed. Use the exact object, not an assumed stash index. Keep it available.

To inspect the original work without changing the integrated checkout, create a separate recovery worktree from the recovery branch in a new unused directory, then run `git stash apply --index a5754f3f1faf1e3c47ef5495bf34f2aa3d0740c8` in that worktree. This restores the original empty staging/unstaged distinction and untracked source. Do not apply it again over this integrated dirty checkout. The original byte-for-byte snapshots and index remain available for comparison. The verified bundle can recover committed refs if needed; a branch/bundle alone does not recover uncommitted or private data.

Original pre-update protected DB backup: `private-data/p3-local/backups/upgrade_20261117_212209_2a180444/before_upgrade.dump` (isolated restore tested). Reviewed application backup: `upgrade_20261117_213149_490fa669/before_upgrade.dump`. Final post-upgrade tested backup: `upgrade_20261117_213933_c10ed9d1/before_upgrade.dump`. First restore any backup into a new isolated local database; never overwrite the live cluster or reverse applied migrations automatically. Media/private asset copies are separate from those logical DB backups.

Before any later rollback, preserve the current integrated dirty work too. This task also retains an integrated-history bundle and final source snapshots/patch for that purpose. No rollback command was executed.
