# Exam permissions: verification and setup

## Implemented scope

- A shared validated policy model connects the instructor editor and student preview.
- Local drafts, browser-shared preview policies, server policies, and personal preferences use separate save paths.
- The professor-only policy API validates ownership and all settings, persists per exam, and rejects stale revisions.
- All five assistance actions have configurable 1–10 allowances per question when enabled.
- Policy changes apply to new attempts. Synthetic previews pin their starting revision until Restart preview; new starts reconcile personal preferences with the latest rules.
- Essential accessibility controls remain available; policy-disallowed controls are omitted entirely.

Review through **Manage Exam → Avatar & Interaction Settings → Share Preview Policy → Open shared student preview**. The plain student preview URL remains an independent fixed demonstration.

## Database setup

Apply `database/migrations/006_exam_avatar_policy.sql` through the normal project migration process and restart the backend. This implementation did not modify the existing project database. The migration and PostgreSQL-specific JSONB statement branch still require validation against PostgreSQL.

`GET /exam/templates/{exam_id}/avatar-policy` returns the authenticated professor's policy or revision-0 defaults without creating a row. `PUT` accepts `{settings, expected_revision}` and returns the incremented revision. Ownership is checked on both routes. Stale writes return 409; missing policy storage returns 503 with setup guidance. Metadata is fixed to `new_attempts` and `per_question`.

## Actual checks

- Frontend TypeScript (`tsc --noEmit`): passed.
- Production Vite build: passed; generated output kept in task scratch storage.
- Frontend model tests: **42 passed** (20 existing avatar, 11 student preference, 11 shared policy).
- Isolated backend API tests: **56 passed**, 14 installed dependency deprecation warnings; SQLite only, no application database connection.
- Instructor browser regression: **20 groups passed**. All requests intercepted; unavailable saved-policy storage is deliberately mocked as 503 in this local-draft suite.
- Standalone student browser regression: **10 groups passed**, zero API calls.
- Connected policy browser exercise: **14 groups passed**, API reads/writes mocked. Includes namespace isolation, mode availability, immutable active preview, restricted saved preferences, stale revisions, failed reads/writes, late responses, accessibility, and 360 px layout.
- `git diff --check`: passed.

The first regression run found an outdated heading assertion; it was updated to check the new permissions heading and explicit live-exam limitation. An independent source review also identified stale shared-save and delayed-load races; fixes were verified by added browser checks.

From `frontend/`, run the three `.test.mjs` model files with `node --test`. Browser runners are `avatar-browser.test.mjs`, `student-settings-browser.test.mjs`, and `exam-policy-browser.test.mjs`; environment overrides are documented in `README-avatar-settings.md`. They use an already installed Playwright runtime and Chrome; no repository packages were added.

Backend tests run from the repository root with `.venv/Scripts/python.exe -m pytest backend/tests/test_avatar_policy.py -q`. If sandbox temporary paths or event-loop local sockets are restricted, use an approved execution context and an explicit scratch `--basetemp` / `cache_dir`. Tests create only synthetic SQLite databases.

These results do not establish real student authentication, enrollment eligibility, real attempt snapshots, server assistance counters, live AI/voice behavior, or full accessibility conformance. Related integration requirements are in `docs/avatar-permissions-remaining-tasks.md`.
