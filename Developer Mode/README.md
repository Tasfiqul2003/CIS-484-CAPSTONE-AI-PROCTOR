# Developer Mode

Open this folder in Windows File Explorer and double-click **Start_Developer.bat** to start the developer menu. The launcher uses the repository's existing Python environment, frontend installation, scripts, and separate developer Compose configuration from the parent folder. Keep this folder inside the repository.

Read the [step-by-step developer guide](developer-mode-guide.docx) for server and database startup, demo account creation, student rosters, optional AI, feature limits, and shutdown. The Word guide records earlier startup behavior; the current labeled-demo fallback rules are described here and in the [technical startup reference](../docs/developer-startup.md). The original guide is preserved.

For a light computer, choose **N, N, N, N, N** for the five optional features. The core website still starts. The dedicated developer Compose backend explicitly enables `DEVELOPER_DEMO_MODE=1`: it uses real providers when available and clearly labeled synthetic substitutes when optional AI/media or exam content is unavailable. Missing/stopped Ollama or an absent selected model no longer blocks core startup, and no model is downloaded. If a launcher-owned Ollama process exits later, the core website remains running.

The five choices still describe real providers. Unavailable media providers stay **N**; a placeholder does not enable them. Demo-marked attempts remain demo across reloads and provider recovery. Demo results are not student grades or evidence of real identity/media verification, and temporary substitute material summaries are not saved as authoritative summaries. Use synthetic accounts and content.

Authentication, professor ownership, student roster eligibility, PostgreSQL, migrations, credentials, Docker, Node, and free ports remain required. Ordinary Compose does not enable the demo flag; a separately started backend must opt in explicitly with the exact value `1`.

To inspect the menu without starting services or saving settings, open PowerShell in the repository root and run:

```powershell
& '.\Developer Mode\Start_Developer.bat' --show-menu
& '.\Developer Mode\Start_Developer.bat' --dry-run
```

The root `Start_Developer.bat` remains a forwarding entry point for existing commands. A file link inside Codex opens a viewer; execute the BAT in File Explorer or a terminal.
