# Developer Mode

Open this folder in Windows File Explorer and double-click **Start_Developer.bat** to start the developer menu. The launcher uses the repository's existing Python environment, frontend installation, scripts, and separate developer Compose configuration from the parent folder. Keep this folder inside the repository.

Read the [step-by-step developer guide](developer-mode-guide.docx) for server and database startup, demo account creation, student rosters, optional AI, feature limits, and shutdown. The [technical startup reference](../docs/developer-startup.md) has configuration and verification details.

For a light computer, choose **N, N, N, N, N** for the five optional features. The core website still starts. AI functions require a reachable configured model server.

To inspect the menu without starting services or saving settings, open PowerShell in the repository root and run:

```powershell
& '.\Developer Mode\Start_Developer.bat' --show-menu
& '.\Developer Mode\Start_Developer.bat' --dry-run
```

The root `Start_Developer.bat` remains a forwarding entry point for existing commands. A file link inside Codex opens a viewer; execute the BAT in File Explorer or a terminal.
