# Windows developer startup menu

Open the repository's **Developer Mode** folder and double-click `Start_Developer.bat`. The [step-by-step guide](../Developer%20Mode/developer-mode-guide.docx) is in the same folder. The BAT opens a console menu before starting services. Type Y or N for each item; Enter accepts the displayed default. The launcher resolves the repository root from its own location, works from another working directory, and does not require virtual-environment activation.

Use **Windows File Explorer** or a terminal to execute the BAT. A file link inside Codex opens the file for viewing; it does not execute the launcher. The root `Start_Developer.bat` remains a forwarding entry point for existing commands. From PowerShell in the repository root, run `& '.\Developer Mode\Start_Developer.bat'`; append `--show-menu` or `--dry-run` to inspect without starting services or saving settings. The launcher prints an immediate banner while checking versions. Keep the Developer Mode folder inside the repository; its dependencies remain in the parent project.

Each item shows its runtime version and configured model separately. Ollama's server version is read from its local API, or its CLI version is shown if the server is stopped. Faster-Whisper and Piper versions come from installed package metadata without importing the audio/model libraries. A missing package displays `Not installed`; an undetectable version displays `Unknown`. Configured model names do not prove that matching weights are installed.

Each option also shows **HEAVY** or **LIGHT** as approximate relative resource guidance. HEAVY indicates higher expected RAM, CPU, or GPU demand; LIGHT indicates lower demand relative to the AI and avatar options. These labels are estimates, not measured benchmarks or guaranteed resource limits. An unavailable feature's label describes its intended workload if integrated; it does not mean that process is running.

| Menu item | Estimated load | Displayed model/provider | What this checkout can activate |
|---|---|---|---|
| Start local AI model | HEAVY; depends on the selected model and quantization | Ollama version; `cybros-v2`, configured base `qwen3:14b` by default | Reuse local Ollama, or start `ollama serve` if installed. Verify the selected model exists before starting the app. |
| Speech recognition | LIGHT relative to local AI/avatar; CPU usage can still spike | Faster-Whisper version; `base.en`, CPU INT8 | Unavailable in the web exam. The standalone voice prototype remains separate. |
| Voice playback | LIGHT | Piper version; `en_US-lessac-medium` | Unavailable in the web exam. No voice/model is loaded by this menu. |
| Animated avatar | HEAVY | SoulX-FlashHead checkout revision when configured; proposed Lite 1.3B | Unavailable: there is no FlashHead web adapter or service. |
| Camera recording | LIGHT at normal settings; depends on resolution and encoding | Browser recording; no AI model | Unavailable in the web exam. No camera is opened. |

The always-on React/Vite frontend, FastAPI backend, and PostgreSQL core are labeled LIGHT for normal development use. The first Docker build and image downloads can still be heavy.

**Recommended for light computers:** choose **N, N, N, N, N** for the five optional features. The core website still starts. This suggestion does not override saved defaults or your manual choices. Local AI set to N skips starting Ollama through this launcher; an independently running Ollama server is left running. AI functions still need a reachable configured model server. The four media options remain unavailable in this checkout.

Unavailable items require N. Typing Y explains the missing integration and repeats the prompt; the launcher never reports these features as enabled. Installing an audio package alone does not connect it to the web application. Existing Foundation/GUI launchers and Modelfiles are unchanged.

## Prerequisites

- Windows, Python, the repository `.venv`, Node.js, and Docker Desktop running Linux containers with Docker Compose v2 supporting `up --wait`.
- Frontend dependencies installed with `npm ci` in `frontend/`.
- Docker must be able to build the existing backend image and obtain `pgvector/pgvector:pg16`. The first application startup can download container images and Python dependencies. It never downloads AI weights or creates/replaces an Ollama model.
- Ports 5173 (frontend), 8000 (backend), and 55432 (developer PostgreSQL) must be free. Existing services on those ports are left alone.

The launcher checks Docker's Linux engine and these ports before asking for credentials. It can find Node, Docker, and Ollama in standard Windows installation folders when a recently opened shell has a stale PATH. Discovered tool directories are added only to child-process PATH values so Docker can also find its credential helper; the launcher does not change your system or user PATH.

If `.venv` does not exist, create it with your installed Python, as in [setup](setup.md). The launcher itself uses only Python's standard library; the backend runs in its existing Docker image. Audio packages are optional for inspecting their installed versions.

For local AI, install Ollama separately and provision the chosen model before launch. The default is the preserved CYBROS V2 configuration. After obtaining the base weights through your normal permitted setup, create a separate `cybros-v2` model from `ollama/Modelfile-cybros-v2` if it is missing. Do not replace an existing locally customized model without saving it first. The launcher performs no inference during inspection or startup and does not assert that Qwen3 14B will run acceptably on a particular laptop.

## Local settings and credentials

Saving defaults writes only the five boolean choices and a settings-format version to ignored `.developer-settings.json`. It contains no passwords, tokens, model weights, or examination data. Invalid or unsupported saved settings stop startup and are left unchanged; fix or rename the file to use defaults again. Saved defaults do not bypass the menu.

For actual startup, the launcher asks for a developer database password and an admin bootstrap token using hidden input. Reuse the database password on subsequent starts: PostgreSQL retains the original password in its persistent volume. The token must contain at least 16 characters. These values go only into child-process environment variables; the launcher does not write credential files or print them. Docker Desktop administrators can inspect container configuration, so use development credentials and synthetic records only.

These environment variables can also supply configuration before launching:

| Variable | Purpose |
|---|---|
| `DEVELOPER_POSTGRES_PASSWORD` | Password for the isolated developer database. |
| `DEVELOPER_ADMIN_BOOTSTRAP_TOKEN` | Token for the existing `/auth/admin/bootstrap` endpoint and `X-Admin-Bootstrap-Token` header. |
| `DEVELOPER_AUTH_SECRET_KEY` | Optional persistent session-signing secret. When absent, a secret is generated in memory for each launch, signing out prior sessions. |
| `DEVELOPER_OLLAMA_MODEL` | Model name, default `cybros-v2`. Known saved configurations display their Modelfile's `FROM` base. Other names show an unknown base. |
| `DEVELOPER_OLLAMA_URL` | Backend-reachable inference endpoint when local AI is N, default `http://host.docker.internal:11434`. URLs with embedded credentials, paths, query strings, or fragments are rejected. |
| `DEVELOPER_FLASHHEAD_DIR` | Optional existing FlashHead checkout used only to inspect its Git revision. It does not enable rendering or verify weights. |

Choosing N for local AI means the launcher does not start or stop an inference server. The backend still uses its configured inference endpoint for AI requests. Without a reachable server those requests fail; ordinary non-AI pages remain available. No synthetic AI replies are substituted. Choosing Y selects local Ollama and uses `host.docker.internal:11434` from the container. The launcher keeps a newly started Ollama bound to host loopback and checks connectivity from the backend; if Docker cannot reach it, use an explicitly configured reachable development endpoint with local AI set to N. Existing Ollama settings are never modified.

There are no pre-created accounts or authentication bypasses. Create an administrator through the existing bootstrap endpoint, then a synthetic professor through `/auth/admin/professors`, using the existing authenticated account workflow. All professor ownership and grading rules remain in effect.

## Services and shutdown

The standalone `compose.developer.yaml` starts an isolated `oralexam-developer` project: PostgreSQL, a one-shot migration job, and FastAPI. It has no GPU reservation or mandatory Ollama dependency. Vite runs from the existing frontend installation with hot reload. The browser opens only after backend/frontend readiness checks succeed.

The developer database uses its own named volume; the team's existing Compose configuration and `pgdata` volume are not selected. The migration runner targets only `db/oralexam_developer`, applies the preserved base schema and full-filename-ordered migrations in one transaction, and records hashes. It refuses to adopt untracked schemas or silently change previously applied migrations. Migration 007 supplies the EID/roster storage already required by existing routes. No existing database is migrated just by opening or inspecting the menu.

Keep the launcher window open. Ctrl+C stops the Vite process, developer Compose services started by this run, and an Ollama process only if this launcher started it. Pre-existing Ollama is left running. Database contents are retained. If the console is forcibly closed or Windows terminates it, use Docker Desktop to stop the `oralexam-developer` project; shutdown cleanup cannot be guaranteed in that case. A session lock prevents simultaneous launches in the same checkout; a second launcher also refuses to take over an already running developer project. The ignored `.developer-session.lock` file can remain after exit; its OS lock is released when the process exits. Metadata and cleanup commands time out after 30 seconds; initial Docker builds can take longer and remain cancellable with Ctrl+C.

This startup menu does not complete the existing rubric editor, live-policy enforcement, authenticated student attempts, media services, or real submissions/review UI. Those integrations remain separate work. Scores remain provisional for professor review.

## Inspect without starting anything

From the repository root:

```powershell
.\.venv\Scripts\python.exe -B scripts/developer_start.py --show-menu
.\.venv\Scripts\python.exe -B scripts/developer_start.py --dry-run
```

`--show-menu` detects local versions and displays defaults without prompting. `--dry-run` lets you answer the menu and prints the selected launch plan. Neither mode saves defaults, prompts for credentials, starts services, downloads models, performs inference, or opens media devices. They can read local Ollama metadata if it is already running.

Offline regression checks:

```powershell
.\.venv\Scripts\python.exe -B -m unittest discover -s tests -p 'test_*.py' -v
```

Synthetic tests exercise menu/configuration decisions, literal process arguments, startup cleanup, and migration ledger behavior. They do not establish a successful Docker build, PostgreSQL SQL execution, host-to-container inference connectivity, live speech, avatar rendering, or camera recording. Record a configured-machine startup separately from these offline checks.

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
