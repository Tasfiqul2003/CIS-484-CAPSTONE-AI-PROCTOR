# Saved roster photo previews

## Implemented behavior

The saved roster and post-upload review show a 48 × 64 px reference-photo thumbnail.
CSV-only students show “No photo”; failed image requests show “No preview”.
Photos load when the preview opens. The post-upload review reads the refreshed
saved roster, including after ZIP uploads, rather than the CSV-only local parser.

The photo endpoint requires a professor session, ownership of the requested exam,
and the student's membership in that exam's roster. It produces an upright JPEG
bounded to 128 × 160 px, strips source metadata, and uses `private, no-store`.
Existing stored photos are preserved. Migration 013 is required for photo storage.

## Checks and measured results — 2026-11-19

- `python -m pytest backend/tests/test_roster_photo_preview.py backend/tests/test_roster_photos.py backend/tests/test_student_roster_access.py -q`: **21 passed**, one Starlette/httpx deprecation warning.
- Frontend TypeScript check: **passed**.
- Vite production build: **passed**, with the existing large JavaScript chunk warning (~645 kB). Output is in ignored `tests/results/roster-photo-preview-20261119/build`.
- `node frontend/tests/roster-photo-preview-browser.test.mjs`: **8 scenarios passed**, no JavaScript errors or unexpected API/external requests. Includes saved thumbnails, missing/failed photos, deferred loading, thumbnail size, dark theme text, mobile containment, and review immediately after a mocked ZIP upload.
- The running localhost frontend proxy returned **401** for an anonymous thumbnail request.

The browser script requires Playwright (optionally resolved using
`AVATAR_NODE_MODULES_PATH`) and Chrome (`AVATAR_CHROME_PATH` optional), plus the
frontend at `ROSTER_PREVIEW_TEST_URL` (default `http://localhost:5173`).
It writes synthetic screenshots/results to `tests/results/roster-photo-preview`
or `ROSTER_PREVIEW_OUTPUT_DIR`.

Tests use synthetic images/records and mocked database/API responses. They do not
upload, inspect, or copy a private student photo, exercise a real ZIP through the
live database, or verify face matching. Live authenticated photo display remains
to be confirmed by reopening the user's saved roster preview.
