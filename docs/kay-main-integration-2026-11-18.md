# Kay recording integration into main — 2026-11-18

Integration parents: main `3ec541da501a73205fae14067ed6da64b537370f`
and kay `cbd4a156d18ab011c89078af4de7eecfa1d17d0a`.

## Resulting behavior

- Preserve main's automatic oral workflow, answer receipts, delivered-question
  audio, media timeline, live video, frozen rubric/profile snapshots and strict
  professor ownership/confirmation checks.
- Add the consented recording lifecycle, separate offline saved speech
  transcripts, low-resource worker configuration, recording notifications,
  private range playback and streamed Download all ZIPs.
- Declined or unavailable initial capture permits typed submission. Pending
  consent must first be decided. Existing main assessment still requires a
  completed unexpired recording. Spoken-provider routes require active capture.
- Once a recorded attempt is interrupted, preserve main's terminal boundary and
  explicit technical restart workflow; never silently restart the recorder.
- Keep both raw PUT and existing multipart POST chunk clients under the same
  consent/identity/order/size checks. Retention cleanup clears whole-recording
  speech text and worker leases while retaining main's question-audio cleanup,
  dry-run reporting and retryable failures.
- Close the avatar streaming producer explicitly on cancellation so its profile
  reservation is released after the awaited renderer completes.
- Keep the developer launcher's frontend at 8100 with performance registration.
  Maintenance checks include both 5173 and 8100. Its read-only plan lists all
  relevant new recording and assessment migrations, including duplicate numeric
  prefixes by their full filenames.

## Measured checks

| Check | Result |
| --- | --- |
| Python backend and source/helper suites | 1,257 passed; 26 skipped; 240 dependency warnings; 68.25 seconds |
| Frontend unit suites, serialized to limit laptop load | 136 passed; no failures/skips |
| TypeScript | Passed |
| Vite production build | Passed; existing large-chunk advisory; output outside the checkout |
| Synthetic recording browser suite | Not validated: local browser launch/runner failed before scenarios completed |

Tests used synthetic records, devices/providers or isolated metadata fixtures.
The skipped environment-specific checks, live camera/microphone flow on the
combined source, live PostgreSQL upgrade, actual speech model and Ubuntu/CUDA
services were not validated during this merge. Earlier kay live checks do not
establish that this combined main source has been deployed or tested live.
Historical tracked frontend/dist stays at the main baseline; deployment must
build the current frontend source.

## Activation boundary

Publishing source does not activate it. No application services were restarted,
no database migrations were applied and no recordings, grades, open attempts,
private environment settings or model files were changed. Source Git history does
not back up those runtime assets.

Before activation, inspect the target's actual migration ledger, back up the
existing database and media, validate the missing full-filename migrations on an
isolated restore and schedule the existing controlled maintenance procedure.
Main's 016–024 schema and the recording settings/lifecycle/transcript prerequisites
must be present. Do not rerun a historical source-update package against the
integrated checkout or force a migration digest to match.
