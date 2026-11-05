# Developer Mode

Open this folder in Windows File Explorer and double-click **Start_Developer.bat** to start the **core-only minimal developer workspace**. Keep the folder inside the repository: the launcher uses the existing Python environment, frontend dependencies, scripts and separate developer Compose configuration in the parent folder.

The dedicated launcher starts React/Vite, FastAPI, migrations and isolated PostgreSQL. **AI, FlashHead, voice, microphone and camera are off.** It does not inspect optional providers, query AI metadata, start Ollama, download models or generate AI content for marked minimal demo attempts. Existing independently started providers are left alone.

The exam view has a static examiner stage above a **blue question-and-response panel** with typed answers. The default is a **static faceless SVG illustration**, not FlashHead video or a live animated face. Minimal mode shows the microphone as off and does not display a pretend listening state. Media services are not connected by these placeholders.

The five older provider choices may remain saved in ignored `.developer-settings.json`, including local AI set to true. They are inactive during minimal startup and are not rewritten. Valid optional model/endpoint configuration is retained without being activated. `--show-menu` and `--dry-run` display the core-only state without prompting for optional choices or saving defaults.

The developer Compose backend sets **both** `DEVELOPER_DEMO_MODE=1` and `DEVELOPER_MINIMAL_MODE=1`; only exact `1` values enable minimal mode. New attempts are durably marked as demos. Real authored bank questions come first, followed by labeled sample questions when saved limits permit. Allowed assistance uses labeled samples within the existing permissions, quotas and timers. Cached real summaries are preserved; temporary source excerpts are not saved as authoritative summaries. Demo attempts cannot receive grades, even after the flags are turned off. Use synthetic accounts and content.

Authentication, professor ownership, student roster eligibility, PostgreSQL, migrations, credentials, Docker, Node and free ports remain required. Existing unmarked attempts never become synthetic because a flag changes; their real-provider requirements remain in effect. Demo content is not proof of student identity, microphone/camera capture or assessment quality.

The launcher has **no minimal-mode opt-out switch**. The dedicated Compose file sets both flags directly, so a caller's shell override alone does not disable them. Ordinary Compose enables neither flag. A separately configured backend with minimal mode unset or `0` retains normal behavior; enabling only `DEVELOPER_DEMO_MODE=1` prefers available real providers before using labeled fallbacks. See the [technical startup reference](../docs/developer-startup.md) for prerequisites, account setup, flag boundaries and shutdown.

The preserved [Word guide](developer-mode-guide.docx) describes earlier menu/startup behavior. Use this README and the technical reference for the current minimal runtime; dated verification records retain their original scope.

To inspect without starting services or saving settings, run from PowerShell in the repository root:

```powershell
& '.\Developer Mode\Start_Developer.bat' --show-menu
& '.\Developer Mode\Start_Developer.bat' --dry-run
```

The root `Start_Developer.bat` remains a forwarding entry point. A file link inside Codex opens a viewer; execute the BAT in File Explorer or a terminal.
