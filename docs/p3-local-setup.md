> Current hardening results: see [P3 hardening verification](p3-hardening-verification.md) for terminal recording interruption, async/audio recovery, final regression totals and actual backend/native-video acceptance. Earlier dated results below remain historical evidence.

# CYBROS on P3

Configured November 15, 2026 from branch `paulo`, commit `18f6a1c`.
The native Windows stack runs the supported full website with both demo and
minimal mode disabled. SoulX/FlashHead is excluded. No shared Ubuntu services
were accessed. No source changes were committed or pushed.

## Start and stop

From PowerShell in `C:\Users\Paulo\CIS-484-CAPSTONE-AI-PROCTOR`:

```powershell
.\Start_CYBROS_Local.bat
.\Start_CYBROS_Local.bat status
.\Start_CYBROS_Local.bat stop
```

Start again after stopping with the first command. Double-clicking the BAT
also starts the website services. Open <http://127.0.0.1:5173>.
The BAT exits after starting background services. It does not need to stay open.
The separate `Start_Developer.bat` remains the optional tool menu, not this launcher.

| Component | Local address | Runtime |
|---|---|---|
| Website | http://127.0.0.1:5173 | Node 26.13.1 / Vite |
| Backend | http://127.0.0.1:8000 | Python 3.12.10 / Uvicorn |
| PostgreSQL | 127.0.0.1:55432 | PostgreSQL 16.15 with pgvector 0.8.6 and uuid-ossp |
| Ollama | http://127.0.0.1:11434 | Ollama 0.40.16 |

All four listeners bind to loopback. The launcher reuses the desktop Ollama
service and leaves that external service running on stop. It stops only its
recorded frontend/backend process trees and its own P3 database cluster.
Do not launch the separate minimal Docker stack on these same ports.

## Configuration and persistence

The private `private-data/p3-local/` directory contains `settings.json`,
`local-accounts.json`, database cluster `pgdata/`, recording storage `recordings/`,
logs, verification results and protected backups. It is ignored by Git and its
Windows ACL is limited to the current user, SYSTEM and Administrators.
Never commit or share that directory. Preserve it across restarts.

`local-accounts.json` contains randomly generated passwords for synthetic local
accounts `p3-admin`, `p3-professor`, and `p3-other-professor`. Use `p3-professor`
in the professor portal for local exploration. These are synthetic setup accounts,
not institutional identities. Open the credentials file privately; do not paste it
into chat, screenshots, source control or shared documents.

The configured database is `cybros_p3`. Initialization uses the existing migration
loader/transaction logic and its full-filename/hash ledger. The original schema
and migrations are unchanged. The launcher does not adopt an untracked existing
schema. `init` is for initialization or a reviewed upgrade, not normal startup.

Python 3.8's old `.venv` was preserved at `.cache/legacy-venv-python38/`.
The new `.venv` uses 64-bit Python 3.12 and declared backend/developer requirements.
The native PostgreSQL runtime is in `.cache/postgres/`; its missing uuid-ossp
files came from the matching PostgreSQL 16.15 EDB Windows binary archive.

The P3 model is `cybros-p3-qwen3-4b`, derived locally from a copy of
`ollama/Modelfile-cybros-v2`. It uses Qwen3 4B, a 4096-token context and a
512-token output limit for this PC's 16 GB RAM. Original prompt/model baselines
are unchanged. The local derived Modelfile is `.cache/Modelfile-cybros-p3`.
Model weights remain in Ollama's normal local model storage, outside Git.
Model selection is explicit in the private settings. No 14B performance claim
is made for this PC.

YuNet and SFace weights are in ignored `models/`, downloaded from OpenCV Zoo.
They load in OpenCV and reject blank synthetic images. This does not validate
biometric accuracy, liveness, fairness or real identity decisions.

The user selected one year of recording retention. This setup uses the fixed
deadline **November 15, 2027 at 11:59:59 PM America/New_York**
(`2027-11-15T23:59:59-05:00`). It is a fixed deadline, not a rolling one-year
period for every future recording. After that deadline assessed starts will
block until an approved policy is configured. Real camera/microphone capture
has not been exercised. Browser permissions remain under the user's control.
The existing purge module must be run through a reviewed maintenance procedure;
no automatic deletion schedule was created.

## Verification and limits

- TypeScript check and production build passed; output went to `.cache/frontend-build/`
  so tracked historical frontend output stayed unchanged.
- Backend synthetic suite: 447 passed. Root suite: 140 passed.
- Frontend Node unit tests: 83 passed. Four historical browser suites fail:
  avatar, exam policy, manage exam and student settings. The observed mismatches
  include missing `/developer/capabilities` mocks, an added `exam_mode` payload
  key, changed recording controls and older avatar expectations. These suites
  intercept APIs and do not establish live integration. Results are in
  `.cache/frontend-test-results.txt` and `.cache/browser-results/`.
- Actual browser homepage and professor login page loaded successfully.
- Live proxy/API authentication, cookie persistence, exam create/retrieve/delete,
  ownership isolation and full backend/database restart passed using synthetic data.
- Required extensions and all 19 migration ledger entries were verified.
- Both face models loaded; blank synthetic inputs were rejected.
- Recording directory write/space and approved deadline preflight passed.
- Real backend-to-Ollama material summarization and persisted summary caching
  passed in 49.06 seconds. Synthetic exam/material records were then deleted.
- A protected custom-format `pg_dump` backup restored successfully into a new
  temporary validation database, with 19 migrations and 3 synthetic accounts
  verified. Only that temporary validation database was removed afterward.
- The actual developer menu recognized external Ollama and exited normally;
  the Tkinter window create/update/destroy lifecycle passed.
- Configured-model inference passed; the measured first synthetic request took
  47.08 seconds for 64 tokens. Ollama reported 3.2 GB, 100% GPU, 4096 context.
  This does not establish acceptable latency for all exam workloads; some backend
  AI operations have a 45-second timeout.

Typed answers remain the transcript. The standalone desktop voice prototype is
not web transcription or Piper integration. A complete real student exam/face
capture/recording walkthrough was not performed, and no face check was bypassed.

## November 16 developer implementation update

Local feature changes and synthetic verification are documented in
`docs/developer-prompts-implementation.md`. The original setup results above
remain dated November 15 evidence. Two additive migrations (016 and 017) are now
prepared but were not applied. The new `/health/ready` check requires their schema
before use; normal startup does not migrate. The launcher `status` is read-only
and distinguishes readiness from socket/process presence. Its earlier lifecycle
source is preserved in the context workspace `work/cybros_local.before.py`.

The main exam provider request timeout is now 90 seconds. Speech adapters and a
student draft/review flow exist, with providers explicitly unavailable until a
verified adapter is configured; no real speech latency was measured. Original
question audio remains unavailable in recorded review. No services or real
camera/microphone devices were started for this work. A read-only status check
found an external Ollama listener, which was left under its existing controls.

### Later November16 continuation

See `docs/developer-prompts-continuation.md` for current native Windows offline
speech, stored question WAVs, durable media events, explicit professor draft
approval and repaired historical browser suites. The earlier note that providers
are absent is superseded for this P3 launcher: it selects the verified installed
Windows System.Speech provider unless private `speech_provider` is `disabled`.
No install or weights are needed; other deployments remain opt-in.

Migrations016–020 (five additive files) remain unapplied. Local startup/migration
approval is pending because CYBROS was intentionally shut down. Do not use init
or start just to review this documentation. `scripts/validate_p3_upgrade.py plan`
is read-only; its explicit validate/apply modes perform protected backup and an
isolated restore/SQL test before any optional primary upgrade. Native lifecycle
commands and maintenance are serialized; no permanent service was installed.
