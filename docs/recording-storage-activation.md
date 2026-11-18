# Recording storage activation on Kay's laptop

The supplied container inspection shows that the backend currently mounts
only `backend/app` at `/app/app`. The worker already has the persistent
`exam_videos` volume. The speech model, PyAV decoder and synthetic speech
test passed in the user's terminal; that source is committed as `9085393`.

`scripts/activate_recording_storage.py` inspects the actual backend and worker
before preparing a change. It preserves the running backend's complete
environment, image, command, entrypoint, port bindings, existing code bind,
restart policy, logging and project network. Both activation and rollback pin
the existing image ID so a concurrently changed local tag cannot switch images.
The recording volume is reused
from the worker and mounted writable in the backend. Custom host settings,
different existing recording volumes and unmounted recording files require
review rather than being silently discarded or hidden.

The helper validates the rendered Compose configuration before applying it.
Private overrides use `!override` so newer default mounts, ports and model
settings cannot accidentally replace the running setup. The existing network
and volume are declared external. The application command targets only the
backend with `--no-deps --no-build --pull never`; DB, Ollama, the speech worker
and avatar services are not recreated, rebuilt or downloaded.

Before restarting the backend, the default check blocks saved assessed exam
sessions still marked in progress. It also refuses to replace
a changed container or image tag. It saves private configuration, the original
inspection and private environment bytes outside the checkout. Those files
contain credentials and must remain local. A failed health, settings or shared
storage check attempts to restore the prior backend configuration.

Verification checks backend database health, the resulting environment and
mounts, and a tiny synthetic file written by the backend and read by the
worker. The temporary probe is then removed. Existing recordings, typed
answers, grades and consent records are not changed by the helper. No SQL
migration is run.

The PowerShell entry point first applies and commits the reviewed public
source files using the existing guarded installer. It then runs storage
inspection/activation. Existing staged work, source edits or a changed HEAD
are preserved and block this source update. Runtime-only private overrides
stay in `CYBROS-backups`, and credentials/actual recordings stay out of Git.

Run the delivered `Activate_Recording_Storage.ps1 -Apply` from the existing
PowerShell terminal. `-RetentionUntil YYYY-MM-DD` can be supplied when an
expiry date has been selected. Omitting it preserves the runtime deadline;
blank retention continues to disable capture while the mount is prepared.
A retention choice and a live synthetic consent/capture/submission/review
test remain necessary before recording can be considered activated.

## Explicit maintenance window

The timing report found four attempts past their total deadline and two with
no total time limit. That report alone does not establish whether a browser is
currently using an untimed attempt. Finishing or deleting saved attempts is
unnecessary for attaching the recording volume.

When the operator confirms nobody is currently taking an exam, use
`-MaintenanceWindow -ExpectedOpenSessions 6` with the delivered activation
command. This keeps all saved attempts, answers, consent and grades unchanged.
It requires the expected count and compares a read-only activity fingerprint
again before restarting. A new attempt, changed question/answer counts,
consent, avatar-action or upload metadata stops the restart. Recent recording
uploads block both normal and maintenance restarts, including uploads still
finishing after submission. The default mode continues to block open attempts.
The explicit window and aggregate activity fingerprint are recorded only in
the private rollback folder. Student identities and answer text are not
printed or changed. The activity checks support the operator's maintenance
window; they cannot prove that a browser has no in-flight request.

## Verification on 2026-11-18

All 121 repository checks pass. Twenty-one synthetic activation tests pass, including a real local parse with
Docker Compose 5.1.4. The parser check starts no containers and verifies exact
replacement of extra mounts/ports and preservation of literal dollar signs
in private values. Tests cover the active-exam guard, image changes, differing
databases, existing volumes, custom resource limits, unmounted recordings,
source-external private backups, settings preservation, rollback and repeated
use. Maintenance tests cover unchanged saved attempts, expected-count checks,
activity changes and uploads still finishing after submission. The activity
snapshot test executes its backend program against synthetic database results
and verifies that only read-only queries run and identifiers are not printed.
The Docker Engine activation itself remains untested in this session
because access to its named pipe is denied. This is setup code with tests,
not a claim of successful live backend recreation.

Docker references: [Compose replacement rules](https://docs.docker.com/reference/compose-file/merge/)
and [service startup flags](https://docs.docker.com/reference/cli/docker/compose/up/).
