# Developer Mode performance tracking

Performance tracking measures one **Developer Mode launcher run**, from startup until normal shutdown. It is a local workstation tool for the professor, developer or administrator operating the launcher. It does not add a student dashboard or a remotely accessible monitoring endpoint.

## Turn tracking on or off

Start `Developer Mode/Start_Developer.bat` and answer the **Performance tracking** Y/N question. Tracking defaults to off; the selected default is saved separately in ignored `.developer-performance.json`. The five older provider choices in `.developer-settings.json` are preserved. Tracking does not enable AI, voice, avatars or recording.

For a single run, override the saved choice without changing it:

```powershell
& '.\Developer Mode\Start_Developer.bat' --performance-tracking on
& '.\Developer Mode\Start_Developer.bat' --performance-tracking off
```

`--show-menu` and `--dry-run` display the effective tracking choice without sampling, opening a monitor, requesting input or saving settings. They can be combined with the override.

Host and process measurements need `psutil` in the launcher's Python environment. Install the declared optional dependency from the repository root:

```powershell
.\.venv\Scripts\python.exe -m pip install -r scripts/requirements-developer.txt
```

The launcher does not install packages automatically. The monitor requires Python's Tkinter support. NVIDIA device measurements additionally require an available `nvidia-smi`; unsupported measurements are labeled unavailable.

## Live measurements

When enabled, a separate window shows elapsed time and current measurements. Closing that window while the run is active hides it; the final report brings it back. Sampling runs approximately every three seconds plus collection time, with bounded external commands.

| Measurement | Scope and interpretation |
|---|---|
| Host CPU and memory | The machine running the launcher, including other applications. Host CPU is a percentage of total CPU capacity. |
| Frontend CPU and memory | The launcher-owned Node development server and its descendants. Browser resource use is not included. |
| Backend and database CPU and memory | Services in the separate `oralexam-developer` Docker project, identified through Compose. These are container totals rather than individual Python or PostgreSQL worker measurements. |
| Owned local AI | Only a process explicitly started and registered by this launcher. Current minimal startup keeps AI off. Independently running models are not attributed to this run. |
| GPU utilization and memory | Supported NVIDIA devices, at device level. This is not per-service GPU attribution. |

Service CPU uses a one-core basis and can exceed 100% on multicore machines. Do not add it directly to normalized host CPU percentages. Memory is shown in MiB. Container memory, process resident memory and whole-machine memory have different accounting boundaries; their totals are not an exact breakdown of host usage. Docker VM overhead, the browser and other shared processes are not separately attributed.

Unavailable, inaccessible or stopped services remain distinguishable from a measured zero. First CPU readings may be unavailable while the collector establishes an interval. A short startup or migration can complete between samples.

## Shutdown report

Use **Ctrl+C in the launcher** to stop the run. After owned-service cleanup, a popup displays the run's performance report. A failure after tracking starts also produces a report when normal cleanup can complete. The report includes duration, stop reason, measurement counts, average and peak available readings, and limitations.

Reports are saved locally as uniquely named JSON and text files in ignored `.developer-reports/`. The popup identifies the saved location. Reports contain resource measurements, not exam questions, answers, audio, credentials, command arguments or environment variables. No report is sent to another person or service. Reports can still describe workstation usage; review them before sharing.

Tracking off starts no collector or monitor and creates no report for that run. Closing a browser tab, signing out or submitting an exam does not end the launcher session. A forced process termination, power loss or forced console close cannot guarantee cleanup or a final report. If the monitor cannot open or a report cannot be saved, the launcher reports that limitation without preventing service cleanup.

## Verification scope

Automated synthetic checks and any recorded local smoke tests establish only the paths they exercise. They do not establish monitoring accuracy across every operating system, GPU or Docker configuration. Compare readings with a trusted system monitor under a controlled synthetic workload before using them for capacity decisions.

### Actual checks — November 12, 2026

- Root regression suite: **126 passed**, including 18 collector tests, 12 toggle/lifecycle/delivery tests and 5 native-window formatter/state tests. Existing launcher and migration tests also passed. Lifecycle tests simulate Ctrl+C and partial startup failure and verify report delivery after service cleanup; they do not launch Docker.
- Actual `--show-menu --performance-tracking on` and `--dry-run --performance-tracking off` completed successfully without starting services or saving a tracking default. `git diff --check` passed.
- Installed the declared optional dependency, psutil 7.2.2, in the existing project Python environment.
- A local smoke harness ran the actual Vite server on temporary port 55173, registered its process with the collector, and opened the actual native monitor. The roughly 71-second run completed 24 samples. Host and frontend readings were visible; the final popup and JSON/text reports were observed after the harness stopped Vite. The test popup was then closed.
- No database, exam attempt, recording, model, or Docker stack was started for that smoke check. Container and GPU measurements displayed unavailable. Real Docker/GPU sampling, comparison with a trusted system monitor, full launcher startup/shutdown with Docker, and forced console-close behavior were not established by this check.

