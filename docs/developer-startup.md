# Windows developer startup

Open the repository's **Developer Mode** folder in Windows File Explorer and double-click `Start_Developer.bat`. The launcher starts the **core-only minimal developer workspace**: React/Vite, FastAPI, migrations and the isolated PostgreSQL database. AI, FlashHead, voice, microphone and camera services stay off. The launcher resolves paths from its own location and does not require virtual-environment activation. Keep the folder inside the repository.

A file link inside Codex opens a viewer; execute the BAT in File Explorer or a terminal. The root `Start_Developer.bat` remains a forwarding entry point. The [Word guide](../Developer%20Mode/developer-mode-guide.docx) is preserved but describes earlier startup behavior. This reference and the [Developer Mode README](../Developer%20Mode/README.md) describe the current runtime. Dated verification sections below retain their historical results.

## Minimal runtime and optional services

The dedicated `compose.developer.yaml` explicitly sets **both** `DEVELOPER_DEMO_MODE=1` and `DEVELOPER_MINIMAL_MODE=1`. Only the exact string `1` enables either flag, and minimal behavior also requires the demo flag. Neither flag is enabled by ordinary Compose.

In minimal mode, the launcher does not inspect optional package versions, query Ollama metadata, start an inference process or download a model. New demo-marked attempts use authored bank questions first, then clearly labeled fixed sample questions when permitted by the saved follow-up and question limits. They do not probe or generate through AI, even if a provider is installed or already running. Permitted assistance uses labeled sample text within the existing mode, quota, idempotency and timer rules. Real cached material summaries are preserved; uncached processing returns a labeled, temporary source excerpt without saving it as an authoritative summary.

The five older provider choices can remain in ignored `.developer-settings.json`. They are inactive in this launcher, including a saved `local_ai: true`; minimal startup neither prompts for new choices nor rewrites those defaults. Valid configured model and endpoint values are retained without activating them. Pre-existing independently started providers are left alone.

| Saved provider choice | Current minimal runtime |
|---|---|
| Local AI / Ollama | Off; no metadata, startup or inference for marked demo attempts. |
| Speech recognition / Faster-Whisper | Off; no microphone or transcription connection. |
| Voice playback / Piper | Off; no voice provider or browser read-aloud in the minimal exam view. |
| Animated avatar / FlashHead | Off; the static examiner illustration is a presentation substitute. |
| Camera recording | Off; no camera capture or recording connection. |

The frontend obtains this state from `/developer/capabilities`. Enabled minimal mode reports `minimal: true`, `ai_available: false` and `services` with `ai`, `flashhead`, `voice`, `microphone` and `camera` all false, without checking an AI provider. A backend without demo opt-in returns only `enabled: false`.

## Exam workspace

The live exam places the examiner stage above a **blue question-and-response panel**. Students type their response below the question. The default stage uses a **static faceless SVG examiner**, not FlashHead video, facial animation or an AI-generated likeness. A permitted professor-selected image or geometric presentation remains a static presentation choice.

Minimal mode shows a microphone-off status and keeps voice and media controls inactive. It does not display a pretend listening state or imply that text input was transcribed from a microphone. Sample questions, answers and assistance are visibly labeled developer content. Existing exam policy, student preference permissions, ownership, roster checks, question/exam timing and ODS rules remain enforced.

## Normal and nonminimal behavior

The dedicated BAT/launcher has **no minimal-mode opt-out switch**. Its Compose file sets both flags directly, so setting `DEVELOPER_MINIMAL_MODE=0` in the caller's shell alone does not override that stack.

For a separately configured backend, leave `DEVELOPER_MINIMAL_MODE` unset or set it to `0` to retain nonminimal behavior. With `DEVELOPER_DEMO_MODE=1`, that runtime prefers available real providers and uses labeled fallbacks when optional AI or content is unavailable. Without the demo flag, normal runtime behavior is unchanged. Use the existing [setup workflow](setup.md) for a separately configured application rather than expecting the core-only launcher to activate providers.

Demo status is saved on every attempt created while demo mode is enabled. A marked attempt remains a demo after reload, provider recovery or either flag being disabled, and both grading and grade confirmation reject it. Existing unmarked attempts never acquire synthetic substitutes when flags change; their original real-provider behavior remains in effect. Resume such attempts through an appropriately configured runtime if they require AI. There are no fake numeric grades or authentication/roster substitutes.

## Prerequisites

- Windows, Python, the repository `.venv`, Node.js and Docker Desktop running Linux containers with Docker Compose v2 supporting `up --wait`.
- Frontend dependencies installed with `npm ci` in `frontend/`.
- Docker must be able to build the existing backend image and obtain `pgvector/pgvector:pg16`. Initial container-image and Python dependency downloads can be substantial. The launcher never downloads AI weights or creates/replaces an Ollama model.
- Ports 5173 (frontend), 8000 (backend) and 55432 (developer PostgreSQL) must be free. Existing services on those ports are left alone.

The launcher checks Docker's Linux engine and these ports before requesting credentials. It can find Node and Docker in standard Windows installation folders when the inherited PATH is stale. Discovered tool directories are added only to child-process PATH values, including Docker's credential helper; the launcher does not modify system or user PATH.

If `.venv` does not exist, create it with installed Python as described in [setup](setup.md). The launcher uses Python's standard library; the backend runs in its existing Docker image. Ollama, audio packages, FlashHead and model weights are not prerequisites for minimal startup. Original Foundation/GUI launchers and Modelfiles are preserved.

## Local settings and credentials

The older settings format contains only the five boolean provider choices and a version. Minimal startup reads but does not rewrite it. Invalid or unsupported saved settings still stop startup and remain unchanged; fix or rename that file to return to defaults.

For actual startup, the launcher requests a developer database password and an admin bootstrap token using hidden input. Reuse the database password on subsequent starts because PostgreSQL retains the original password in its persistent volume. The bootstrap token must contain at least 16 characters. Values go into child-process environment variables; the launcher does not print them or write credential files. Docker Desktop administrators can inspect container configuration, so use development credentials and synthetic records only.

These environment variables can supply configuration before launching:

| Variable | Purpose |
|---|---|
| `DEVELOPER_POSTGRES_PASSWORD` | Password for the isolated developer database. |
| `DEVELOPER_ADMIN_BOOTSTRAP_TOKEN` | Token for the existing `/auth/admin/bootstrap` endpoint and `X-Admin-Bootstrap-Token` header. |
| `DEVELOPER_AUTH_SECRET_KEY` | Optional persistent signing secret. When absent, a secret is generated in memory for each launch, signing out prior sessions. |
| `DEVELOPER_OLLAMA_MODEL` | Preserved optional model selection, default `cybros-v2`; not loaded or inspected in minimal startup. |
| `DEVELOPER_OLLAMA_URL` | Preserved valid optional backend endpoint, default `http://host.docker.internal:11434`; not contacted for marked minimal attempts. |
| `DEVELOPER_DEMO_MODE` | Backend opt-in, enabled only by exact `1`. Dedicated developer Compose sets `1`; ordinary Compose does not. Not a saved provider choice. |
| `DEVELOPER_MINIMAL_MODE` | Minimal backend opt-in, active only with both flags exactly `1`. Dedicated developer Compose sets `1`; the launcher forces a core-only plan. Not a saved provider choice. |

There are no pre-created accounts or authentication bypasses. Create an administrator through the existing bootstrap endpoint, then a synthetic professor through `/auth/admin/professors`, using the authenticated account workflow. Professor ownership, student roster eligibility, safe authentication configuration, the database, migrations and core startup errors remain real requirements.

## Developer demo boundaries

Demo text and presentation substitutes do not establish student grades, identity verification, microphone/camera capture, voice cloning, FlashHead rendering or a functioning unavailable provider. Use synthetic accounts, rosters, uploads and answers. Temporary material excerpts are not saved as authoritative course summaries.

The earlier [developer-demo verification](developer-demo-verification-2026-11-05.md) records fallback behavior and its measured checks. It does not establish new browser results for the minimal layout described here. Actual avatar/time/ODS implementation and verification are documented separately in [Live avatar integration](avatar-live-integration.md).

## Services and shutdown

The standalone `compose.developer.yaml` starts the separate `oralexam-developer` project: PostgreSQL, a one-shot migration job and FastAPI. It has no GPU reservation or Ollama dependency. Vite uses the existing frontend installation with hot reload. The browser opens only after backend/frontend readiness checks succeed.

The developer database uses its own named volume; the team's existing Compose configuration and `pgdata` volume are not selected. The migration runner targets only `db/oralexam_developer`, applies the preserved base schema and full-filename-ordered migrations in one transaction, and records hashes. It refuses to adopt untracked schemas or silently change applied migrations. Opening or inspecting the launcher does not migrate an existing database.

Keep the launcher window open. Ctrl+C stops the Vite process and developer Compose services started by this run. Minimal startup owns no Ollama process, and pre-existing providers remain untouched. Database contents are retained. If Windows or a forced console close prevents cleanup, stop the `oralexam-developer` project through Docker Desktop. A session lock prevents simultaneous launches in the same checkout, and a second launcher refuses to take over a running developer project. The ignored `.developer-session.lock` file can remain after exit; its OS lock is released when the process exits. Metadata and cleanup commands time out after 30 seconds; initial Docker builds can take longer and remain cancellable with Ctrl+C.

## Inspect without starting anything

From the repository root:

```powershell
& '.\Developer Mode\Start_Developer.bat' --show-menu
& '.\Developer Mode\Start_Developer.bat' --dry-run
```

`--show-menu` displays the core-only minimal notice. `--dry-run` prints that launch plan without asking optional-provider or save-default questions. Neither command saves settings, requests credentials, starts services, probes optional providers, downloads models, performs inference or opens media devices.

Offline regression checks:

```powershell
.\.venv\Scripts\python.exe -B -m unittest discover -s tests -p 'test_*.py' -v
```

Synthetic tests cover configuration decisions, literal process arguments, startup cleanup and migration ledger behavior. They do not establish a successful live stack, PostgreSQL execution, inference quality, speech or camera capture. Dated results below describe the versions tested at those times, including menus and optional-provider behavior that preceded minimal mode.

## Actual verification - October 27, 2026

- Standard-library unittest discovery: **62 passed, 0 failed**. This includes the preserved 20 prototype/harness tests, 32 new launcher checks, and 10 migration checks. The migration checks used the installed SQLAlchemy dependency and synthetic connection doubles.
- Actual `--show-menu` and interactive all-N `--dry-run`: passed, including detected Faster-Whisper 1.2.1 and Piper 1.8.0 metadata. No settings were saved by these inspection commands.
- Actual BAT launcher invoked from a different working directory with `--show-menu` and closed stdin: exit 0, correct repository-relative paths.
- Developer Compose YAML parse, CPU-only service configuration, selected-model/endpoint variable mapping, ignore rules, and `git diff --check`: passed.
- Docker and local Ollama were not detected in this execution environment. Full Docker startup, real PostgreSQL migration execution, inference connectivity, and a configured-machine shutdown remain unverified. No container image build, model download, inference, microphone capture, playback, or camera recording was performed.

An initial launcher-test run encountered test-fixture issues with Windows temporary-directory access and a mocked context manager. The fixtures were corrected, then the complete suite above passed. These were offline test setup failures, not successful application startup evidence.

## Actual environment preparation and verification - October 29, 2026

- Installed Windows Node.js 26.13.0 with npm 11.20.0, Ollama 0.40.13, per-user Docker Desktop 4.97.0, and WSL 3.0.3. Docker reports Linux containers, Docker Engine 29.9.2, and Compose 5.6.1. WSL reports default version 2. No restart was requested by the completed WSL setup.
- Preserved the existing repository `.venv` and frontend dependencies. Node dependency inspection, TypeScript checking, and a production build passed under the installed Node version; build output stayed in task scratch storage.
- All **73 standard-library regression tests passed**. The separate synthetic backend API suite passed **67 tests** with 14 installed-dependency deprecation warnings when run outside the Windows AppContainer. No application database was used by those API tests.
- A first live stack check failed because the fresh Docker install's credential-helper directory was absent from the inherited PATH. After adding discovered tool directories to child environments, the isolated check passed.
- The successful live check used a unique temporary Compose project and alternate ports 55173, 58000, and 55433. PostgreSQL and backend health passed; all 10 tracked SQL files applied, including roster/EID and avatar-policy storage. Container-to-host Ollama metadata access, Vite startup, and the frontend API proxy passed.
- Only the temporary test project's containers and empty database volume were removed afterward. The backend and PostgreSQL images remain cached for normal startup. Existing services on ports 5173 and 8000 were preserved; those ports must be freed through their normal shutdown workflow before an actual developer session can start.
- Ollama's model inventory was empty. No model weights, inference, microphone capture, playback, avatar rendering, or camera recording were performed. A selected local model still needs separate provisioning before local AI can be used.
- Docker's installer logged success and the installed CLI and Linux engine were verified. Its idle setup invocation did not exit normally and was closed after successful installation checks; Docker remained running.

## Actual folder and launcher verification - November 1, 2026

- The canonical BAT is now `Developer Mode/Start_Developer.bat`; the root BAT forwards to it so existing commands keep working. The step-by-step guide is beside the canonical launcher, while scripts, Compose configuration, and dependencies remain in the repository root.
- Both BAT entry points completed `--show-menu` from a different working directory with closed stdin: exit 0, exactly five feature choices, and one final pause. Both use ASCII text with CRLF line endings. The preview left saved settings unchanged and started no services.
- All **43 existing launcher tests passed**, and `git diff --check` passed. These checks verify launcher paths and menu behavior; they do not repeat a live server or database startup.
- The relocated guide has a populated native Word table of contents with 10 linked workflows. All link targets and page numbers were checked against the 12-page render, and every page was visually reviewed. Internal page references and launcher-location instructions were updated.

## Actual migration and local website verification - November 4, 2026

All **82 root regression tests passed**, including **19 migration runner checks**.
The runner now safely handles preserved outer transaction wrappers and rejects
other transaction controls before executing any migrations. An isolated
PostgreSQL 16.15 run applied all 15 SQL files, applied zero on restart, and
verified rollback of a deliberately failing synthetic migration and its ledger
entry. The existing local PGlite database was separately backed up and updated;
its existing professor login and the three new settings pages were verified in
the browser. The configured local AI service remains offline. See
[the measured results and remaining limits](local-update-verification-2026-11-04.md).

## Actual developer demo-launcher checks - November 5, 2026

- All **48 launcher regression tests passed**. Synthetic process fixtures cover
  absent Ollama, spawn/readiness failures, missing models, unreachable
  container-to-host metadata and owned-AI exit while core startup continues.
  Existing checks still reject Docker-engine, credential, occupied-port and
  core-startup failures and preserve service ownership and cleanup behavior.
- `--show-menu` returned exit 0 with exactly five provider choices, the explicit
  developer-demo notice and unavailable media status. It started no services,
  saved no settings and requested no inference or downloads.
- The dedicated developer Compose flag and its absence from ordinary Compose
  were checked by the regression suite. These launcher tests do not execute
  backend content substitution or establish live AI/media availability.

No Docker stack, model, microphone, camera or real student workflow was started
for these launcher checks. Backend/API verification belongs to its separate
synthetic checks and any later explicitly recorded application run.

## Actual minimal-mode checks before publication - November 5, 2026

- Root standard-library suite: **91 passed**.
- Synthetic backend suite: **426 passed**, with 125 dependency deprecation warnings.
  The completed run used the repository root and `backend` on `PYTHONPATH` and
  host access. An initial collection lacked the `app` import path; a restricted
  rerun stalled in the test client and was interrupted before the host run.
- Frontend non-browser Node suite: **83 passed**, with no failures or skips.
- `npm --prefix frontend run build`: TypeScript and Vite passed; the tracked
  `frontend/dist` assets were rebuilt and their HTML references verified.
- Launcher `--show-menu` and `--dry-run`: exit 0, with minimal mode active and
  optional providers off. `git diff --check` passed.
- The existing local PGlite database restarted with zero pending migrations.
  The local frontend, proxied backend health and database health returned HTTP
  200. Capabilities reported demo and minimal mode enabled, with AI, FlashHead,
  voice, microphone and camera all false.

These checks do not establish a new Docker startup, student browser walkthrough,
live inference, media capture, speech output or grading reliability. Local
settings, accounts, database files, backups and logs remain Git-ignored.
