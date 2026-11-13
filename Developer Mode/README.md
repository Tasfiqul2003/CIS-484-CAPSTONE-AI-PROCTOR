# Developer Mode tool controls

Double-click **Start_Developer.bat** here or in the repository root. It opens a menu for activating and deactivating optional tools. It does not start the website, backend, migrations or database, request credentials, or require Docker/Node. The repository `.venv` must already exist.

| Control | Implemented behavior |
|---|---|
| Local Ollama | Starts a local `ollama serve` process on `127.0.0.1:11434`; select again to stop that process. No model download, loading or inference is requested. |
| Performance tracking | Starts the live monitor; select again to stop collection and display a report. Measures host/GPU and menu-owned Ollama where supported. No Docker calls or website-process attribution. Defaults to off each session. |
| Speech recognition, voice playback, animated avatar, camera recording | Marked unavailable with the missing integration explained. Selecting these entries does not enable a substitute or media capture. |

Keep the menu open while using its tools. Select **0**, press **Ctrl+C**, or close input normally to stop tools owned by this session. An independently running Ollama service is shown as external and left under its original controls. A forced window close or power loss cannot guarantee cleanup or a final report. The menu does not save tool defaults or credentials; older ignored settings files are left unchanged.

Tool activation does not change application feature flags. In particular, the separate minimal website stack still keeps AI and media off even when Ollama is running. No changes are made to the shared Ubuntu server.

Inspect without tool discovery, processes, input or file writes:

```powershell
& '.\Developer Mode\Start_Developer.bat' --show-menu
& '.\Developer Mode\Start_Developer.bat' --dry-run
```

`--performance-tracking on` starts monitoring immediately for one interactive session; `off` keeps it off initially. Both still allow toggling in the menu. See [measurement dependencies and limitations](../docs/developer-performance-tracking.md).

The previous full application launcher is preserved as a separate explicit command:

```powershell
.\.venv\Scripts\python.exe -B scripts/developer_start.py
```

That command retains its Docker, Node, free-port, database-password and bootstrap-token requirements. See [application startup](../docs/developer-startup.md). The preserved [Word guide](developer-mode-guide.docx) describes historical behavior, not this tool menu. Run the BAT in File Explorer or a terminal; a file link in Codex opens a viewer.
