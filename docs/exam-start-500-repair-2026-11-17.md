# Local exam-start500 repair — November17,2026

The user's screenshot showed `Unable to start your exam` after recording consent. The local backend traceback identified a PostgreSQL syntax error in `start_exam`.

## Cause and fix

The earlier authorized-technical-retry edit accidentally inserted the computed `technical_restart_allowed` SELECT expression into the exam-session INSERT column list. This expression is now confined to the session-state SELECT where it belongs. An unused accidental output field was also removed from the submission-list serializer.

A new actual PostgreSQL HTTP startup regression then exposed a second issue: omitted optional presentation preferences were explicitly bound as SQLNULL even though `avatar_preferences` is NOTNULL. The INSERT now binds an empty JSON object in that case, matching the existing policy-aware default-preference loader. Valid explicitly supplied preferences are unchanged. No migration, old-answer rewrite, permission bypass or face-match record was added.

## Measured verification

- Existing focused admission/start/answer/session-clock checks:41 passed.
- New restored-PostgreSQL HTTP cases execute the real `/exam/start` route, snapshot INSERT, bank opening-question insertion and session-state response. All4 combinations passed:matched or developer-bypass identity flags, with or without explicitly supplied presentation preferences. Authentication/token validation and actual SQL are exercised; identity capture alone is stubbed and recording storage points at a test temp directory. No real device is acquired and no source database exam is created by these checks.
- Protected backup and isolated restore validation on final code:24 passed,2 unchanged opt-in skips,3.84seconds. No source migration applied; source ledger remains26. The initially failed isolated copy was retained for diagnosis, rechecked successfully, then removed using the owned validation namespace. Final successful validation copy was also removed. Protected failure/recheck reports remain available.
- Final offline suite:1046 passed,20 gated skips,143 subtests in41.46seconds. The additional skips are the4 opt-in real-PostgreSQL startup cases. Existing deprecation warnings remain.
- Whitespace check passed. No frontend source change in this repair, so the preceding type/build results remain applicable without another build.
- The launcher-owned local website/backend/database were restarted only after a zero-active-attempt check. Readiness passed for backend/frontend/database and external Ollama. The model daemon was left under its existing ownership; FlashHead remains off.
- Final read-only data check:50 new demo EIDs retained, migration ledger26, zero active attempts. No source student attempt, answer, recording or roster was deleted/reset by this repair.

## Recovery evidence and continuation

Protected reports: `private-data/p3-local/backups/upgrade_20261117_230232_51ef3f62/` (failed validation and successful recheck) and `upgrade_20261117_230513_f69c54cd/` (final passing backup/restore/contracts). Offline regression output is ignored `.cache/exam-start-fix-tests.log`. Private reports/backups must not be published.

The local website is ready at http://127.0.0.1:5173/ . Refresh or return to the exam list and retry starting. A full human spoken exam and real device/playback acceptance are still not claimed. This repair specifically verifies the previously failing startup SQL and response. All source edits remain local/uncommitted; no push or shared deployment occurred.
