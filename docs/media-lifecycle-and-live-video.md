# Media lifecycle and local live video

Implementation notes, November 16, 2026. All verification below uses synthetic
fixtures. Initial checks left the P3 stack stopped; subsequent authorized P3
maintenance/startup is recorded in [P3 hardening verification](p3-hardening-verification.md).
The browser fixtures below use generated canvas media and isolated test apps.
No camera, microphone, private recording or shared host is used by those fixtures.

## Current media inventory

| Asset | Scope and location | Lifecycle and retention |
|---|---|---|
| Assessed recording and upload chunks | One `exam_session_videos` row per attempt; configured `EXAM_VIDEO_DIR`; student session token uploads, owning professor cookie playback | Recording, completed, expired. Per-row fixed `expires_at`; completion/upload/playback reject elapsed deadlines. |
| Live connection | One publisher and owning-professor viewer for an active assessed recording | Transient direct WebRTC connection; no server media copy. Signaling expires separately. It does not replace the assessed recording. |
| WebRTC signaling | Bounded process memory; attempt, random room UUID and peer IDs | 15-second participant lease, 30-second signal lifetime, 128 signals per room, 256 rooms, 256 KiB per room and 16 MiB globally. Process restart loses signaling. Not stored in the DB or backups. |
| Submitted transcript | Existing interaction rows | Separate from recording expiration. No transcript deletion policy is invented by this implementation. |
| Delivered-question audio | Approved backend-generated WAVs under `question-audio/{attempt}/{asset}.wav`, with scoped metadata and hashes | Retention follows the recording deadline. Saved bytes and browser playback observations are distinct; browser read-aloud does not provide an original saved asset or proof of hearing. |
| Reference photos and short face-check frames | Separate identity subsystem | Not covered by recording cleanup or live transport. Existing identity gates remain required. |
| Database/media backups | Existing protected local maintenance workflow | Database metadata backups and physical recording files require separate coverage. Live-storage cleanup is not deletion from every backup. |

P3's existing policy remains the fixed deadline **November 15, 2027, 23:59:59
America/New_York**, stored as a timezone-aware timestamp. It is not a rolling year
per recording or a default for another deployment. Successful assessed preflight
returns `retention_until`; date-only legacy configuration still means UTC end of
date. Missing or elapsed policy blocks assessed recording. No policy was changed.

## Recording hardening

Chunk ordering, identical retry detection, aggregate/chunk size bounds, and
student/attempt token binding reuse the existing recorder. Upload and completion
now enforce the recorded retention deadline. Every assembled/read/written media
leaf is checked against symlinks and its expected directory. Upload and final
assembly also check available space. These checks assume only the backend account
can modify the storage directory; they are not a substitute for restricted OS
permissions against a concurrent local filesystem attacker.

Read-only playback and cleanup inspection no longer create missing storage
directories. Authenticated playback uses `private, no-store`; its existing
FileResponse retains browser range support and rechecks ownership/deadline for
each new request. It also checks stored byte count before full or range delivery
and sends `nosniff`; truncated files fail instead of appearing as complete media.
Initial recorder creation locks the existing attempt row, preventing two first
starts from racing an absent recording row. Upload/finalization recheck current
student authorization after storage-row waits.

An acknowledged terminal recording event flags an active attempt and stops its
academic progression; ordinary playback observations do not advance questions.
Remaining owned chunks can still be uploaded and explicitly finalized for partial
professor review. This does not resume the attempt or label it normally completed.

Cleanup validates one attempt's inventory before unlinking it, rejects links and
unexpected entries, and continues to other eligible attempts after filesystem
failure. Failures preserve retryable metadata and produce a nonzero CLI exit.
Playback independently rejects expired assets even when deletion fails. Successful
cleanup marks metadata expired and clears its storage counters. Repeating cleanup
revisits elapsed attempts for orphan WAVs but does not count fully clean scopes
again. Rows are locked with `SKIP LOCKED` during a
maintenance transaction; no background scheduler is installed.

In the configured backend environment, inspect eligibility with:

```powershell
.\.venv\Scripts\python.exe -m backend.app.purge_exam_videos --dry-run
```

That command requires the correct existing database/storage environment. It was
not run against P3's real storage. Deletion remains a separately authorized
maintenance action; after authorization, use the same command without `--dry-run`.
Do not infer transcript, reference-photo or backup deletion from this command.

## Live topology and authorization

The student controller reuses the stream owned by the existing assessed recorder.
It never calls `getUserMedia`, starts another recorder or stops device tracks.
The owning professor opens the progress page's **View live video** action.

Both clients use same-origin `GET/POST /exam/sessions/{id}/live-video` for signaling.
Students use the existing session bearer token; professors use the existing
HttpOnly account cookie. Every request reads current DB attempt ownership,
active/recording state and recording expiration. A wrong professor receives 404;
student/attempt mismatches are rejected. A role may hold only one active tab.
Credentials are revalidated after database scope reads, so a wait cannot renew a
lease using an expired token or deactivated account. A random `room_id` UUID binds
every signal and its cursor to one room lifetime, alongside connection epochs.
Recreated rooms reset old cursors; old-room signals and late ICE callbacks cannot
attach to a replacement peer. Offers
come only from the student; answers come only from the professor. Payloads,
candidate size, room count and queue count are bounded, including UTF-8 byte
budgets (64 KiB per SDP signal, 8 KiB per candidate, 256 KiB per room, 16 MiB total).
Malformed Unicode is rejected safely before validation error rendering. No token is placed in a
URL and no transcript/media/secret is logged by this module.

The peer connection uses `iceServers: []`: **no public STUN/TURN or installed
relay**. Supported topology is one backend process and a direct path between
browsers on the same machine or compatible local network. A multi-worker backend,
remote NAT traversal, Internet access, or a network requiring TURN is unsupported.
No broader listener binding or firewall change is made. TLS/localhost secure
context requirements for capture remain unchanged.

Clients poll every two seconds, bound an HTTP request to five seconds and
negotiation to fifteen seconds, and close the peer on auth/service/attempt loss.
The student closes a peer when the viewer lease disappears; if a viewer stops
polling without sending leave, this takes up to the 15-second lease plus the next
student poll. This is a browser-enforced shutdown of direct P2P media, not a
server-relayed stream with immediate central packet revocation. A disconnected
connection gets at most eight seconds to recover. The professor UI labels video
live only when fresh decoded frames are observed; it hides stale pictures after
six seconds and closes the peer after twelve seconds without fresh frames.
It initially plays muted, with standard controls to enable audio.

Leaving releases the signaling lease and closes the peer without affecting the
recorder's ownership. A live failure does not claim recording continuity or safe
assessed resume. Refreshing an assessed recording keeps the existing fail-closed
rules; reconnecting live video alone does not bypass them.

## Verification and support matrix

| Configuration | Evidence | Remaining validation |
|---|---|---|
| Backend route auth/lifecycle | Synthetic FastAPI requests; no network listener | Real DB transaction/race and browser integration |
| Chrome / Edge desktop, local path | TypeScript check and simulated peer-controller tests | Actual camera permission, peer/codec/ICE interoperability and narrow layouts |
| Firefox / Safari | No live-media evidence | Unsupported until WebM recorder, codecs and frame-stat checks are verified |
| Mobile / narrow screens | Responsive native video controls/page layout implemented | Actual browser/device and keyboard/zoom validation |
| Multi-worker or relay-required network | Explicitly unsupported | Requires a reviewed signaling/relay topology and authorization |

Measured commands:

```powershell
.\.venv\Scripts\python.exe -m pytest backend\tests\test_exam_video.py backend\tests\test_media_lifecycle.py backend\tests\test_live_video.py
```

29 passed in 1.22 seconds (one existing Starlette/httpx deprecation warning).
The tests cover owner/cross-attempt isolation, expired credentials and recording
deadlines, completed attempts, two tabs, stale epochs, leases, queue limits,
ordered/duplicate chunks, storage exhaustion, path traversal, dry-run cleanup,
idempotence and partial cleanup retry. Filesystem link refusal is simulated in a
test rather than requiring privileged Windows symlink creation.

From `frontend/`:

```powershell
node node_modules/typescript/bin/tsc --noEmit
node --test tests/live-video.test.mjs
```

TypeScript passed; seven controller tests passed. These simulate peer behavior and
prove stream reuse, no owned-track stop, stale-frame failure, bounded negotiation,
attempt end and auth loss handling. They do not establish a working real live
stream. No real media, provider integration, runtime performance or full assessed
exam success is claimed.

## Subsequent native canvas transport verification

On November 16, 2026, `frontend/tests/live-video-browser.test.mjs` passed **four
actual Chromium WebRTC scenarios** using the production live controller and the
production professor live-view component. Chrome was `157.0.8103.51`; the installed
Node runtime was `26.13.1`. The measured run took approximately 61 seconds.

The sender generated animated 320×180 canvas frames via `canvas.captureStream(0)`
and explicit frame requests. The receiver used native `RTCPeerConnection` and
rendered the real remote video. Its decoded-frame count rose from 2 to 5 and its
sampled rendered pixels changed between observations, establishing transport and
rendering rather than a mocked peer. Both peers used `iceServers: []`; Chrome
ran headless with `--mute-audio`, and the receiving video remained muted.

The four passing scenarios established:

- Fresh changing remote frames; freezing the generated source hid the stale
  picture and then closed the receiver.
- Closing the native sender peer cleared the professor view while leaving the
  fixture-owned source track live.
- A mocked expired-professor authorization response closed the native receiver
  and removed its video source.
- A mocked ended-attempt response closed both native peers.

All page resources and signaling/authentication responses were fulfilled in
memory by Playwright. No HTTP application server, database, Ollama, speech provider
or real camera/microphone was started. `getUserMedia` and `getDisplayMedia` were
instrumented to fail and recorded **zero calls**. No STUN/TURN relay, installer,
model weights or real recording was used. Temporary canvas tracks and browser
processes were cleaned up after each scenario. No screenshot or recorded media
artifact was needed.

To repeat using already installed dependencies, from `frontend/`:

```powershell
node tests/live-video-browser.test.mjs
```

`AVATAR_NODE_MODULES_PATH` and `AVATAR_CHROME_PATH` can identify existing Playwright
and Chrome installations. `LIVE_VIDEO_TEST_OUTPUT_DIR` changes the JSON report
location; the default is `.cache/browser-results/live-transport/results.json` in
the repository. The report stores counts, dimensions, status and sampled synthetic
pixels, without raw signaling SDP, credentials or media.

This adds native **local synthetic transport** evidence to the earlier simulated
controller checks. Authentication, attempt state and signaling were mocked here;
their backend checks remain separate. It does not validate a real CYBROS backend,
real devices/audio, remote networks/NAT, mobile browsers, Firefox/Safari, multi-worker
deployment, physical recording continuity or a complete assessed student exam.

## Actual HTTP backend with generated media

`frontend/tests/live-video-backend-browser.test.mjs` subsequently passed **2/2**
scenarios on Chrome `157.0.8103.51` in approximately 24 seconds. Unlike the earlier
transport fixture, signaling/auth responses were actual HTTP requests to production
routers in an owned child FastAPI app bound to a random loopback port. Its SQLite
database contained only declared synthetic account/attempt/interaction rows.
PostgreSQL UUID/lock syntax was adapted for this fixture; actual PostgreSQL lock
and transaction semantics are covered by the separate isolated database checks.

The first scenario performed real synthetic-professor password login/cookie auth,
native WebRTC frame decoding, room recreation with a new nonce, wrong-professor
and expired-student-token denials, then an authenticated recording interruption.
That event flagged the attempt and revoked live viewing. Native MediaRecorder
produced a 296,796-byte canvas-only WebM: the actual recording routes accepted an
identical chunk retry, rejected out-of-order/changed/cross-attempt uploads, and
finalized the flagged partial recording. Authenticated full/range reads preserved
its exact hash and bytes, and Chromium decoded the saved video at 320×180.

The second scenario replaced the fixture professor's cookie with a legitimately
signed short-lived fixture JWT. Actual backend expiration checks closed the native
receiver, hid/cleared its video, and preserved the separately owned canvas track.
Both scenarios recorded zero device-acquisition calls. Only fixture processes and
temporary synthetic storage were controlled; final process/directory checks found
none left. No P3 application service, source database, model or real device was
controlled by this harness. No `exam/start` or identity gate was invoked or claimed.

From the repository root, using existing installed dependencies:

```powershell
node frontend/tests/live-video-backend-browser.test.mjs
```

Evidence is `.cache/browser-results/live-backend/results.json`. This verifies a
synthetic HTTP/media contract, not a complete assessed exam or real camera,
microphone, identity, audio, browser-fleet or network deployment validation.
