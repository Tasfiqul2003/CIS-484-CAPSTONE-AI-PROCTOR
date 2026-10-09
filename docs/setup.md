# Reproducible Windows setup

## Prerequisites

Windows, Python 3.10+ from https://www.python.org/downloads/windows/, Git from https://git-scm.com/downloads/win (or GitHub Desktop), and Ollama from https://ollama.com/download/windows. Install these outside the repository. The deterministic rubric and voice checks use only the standard library; running the voice application requires the separate dependencies below. This preparation does not install or download model weights.

Open a new PowerShell after installation. Check:

```powershell
py -3 --version
git --version
ollama --version
ollama list
Invoke-RestMethod http://127.0.0.1:11434/api/version
```

If the API is unavailable, start Ollama. Use `ollama serve` in a separate terminal only if the desktop app is not already serving. Do not expose port 11434 to students or the public network. Available RAM/VRAM and usable context capacity must be measured on target hardware; num_ctx is not a performance guarantee.

## Recreate saved model configurations

Run from the repository root. If qwen3:4b is absent, obtain approval for downloading it in your environment, then run `ollama pull qwen3:4b`. Model weights stay in Ollama storage, not Git.

```powershell
ollama create oral-examiner-v1 -f ollama/Modelfile
ollama create oral-examiner-v2 -f ollama/Modelfile-v2
ollama create oral-examiner-v2-1 -f ollama/Modelfile-v2.1
ollama show oral-examiner-v2 --modelfile
```

These commands recreate the named configurations; confirm before replacing a model with local customizations under the same name. V1/v2 interactive exploration: `ollama run oral-examiner-v2`; paste the synthetic `prompts/test-exam.txt`. This mixes exam materials in a single message and is a manual baseline experiment only. V2.1 should be tested through the runner's trusted-professor message separation, not by claiming professor authority in student text.

## Reproduce text checks

```powershell
py -3 -m unittest discover -s tests -p "test_*.py" -v
py -3 tests/run_rubrics.py
py -3 tests/run_rubrics.py --seed 43 --case equivalent
```

Results go to a new UTC directory under tests/results. The default runner uses qwen3:4b plus v2.1 SYSTEM instructions and explicit parameters, so `--model oral-examiner-v2` would NOT be a baseline v2-prompt comparison. `--model oral-examiner-v2-1` uses that installed model but still supplies the same system instructions. API errors are recorded, not counted as passes; requests time out after 180 seconds. Review every raw response and separate failures from blocked runs. Current saved evidence used Ollama 0.34.1; version and model digest are recorded in environment.json. Recreation/installation on a clean Windows machine has not been verified.

## Foundation V1 voice setup

Use a microphone and speakers on Windows with Python 3.13 (the source environment records **3.13.15**). Run every command below from the **repository root**, not from `backend/`. The snapshot intentionally preserves relative file paths: it reads the Piper model from the current working directory and writes temporary WAV files there. Do not import the script as a library: it runs its microphone/model workflow at module level.

```powershell
py -3.13 -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install -r backend/requirements-voice.txt
python -m pip check
```

If PowerShell blocks activation, use `Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass`, then activate again. Alternatively, replace `python` in these commands with `.\.venv\Scripts\python.exe`; activation is optional.

`backend/requirements-voice.txt` preserves the provided environment freeze, including transitive packages; only its encoding was converted from UTF-16 to UTF-8 for pip/Git portability. Direct imports use numpy 2.5.3, sounddevice 0.5.6, scipy 1.18.1, faster-whisper 1.2.1, ollama 0.6.2, and piper-tts 1.8.0. These versions match local installed metadata; a fresh installation on another machine has not been verified. The existing `backend/requirements.txt` belongs to the FastAPI service and is unchanged; the standalone voice script does not require starting that service or Docker.

Install/start Ollama separately and check the model:

```powershell
ollama list
# Only when the base model is missing:
ollama pull qwen3:4b
# Only when the custom V2 model is missing or intentionally being recreated:
ollama create oral-examiner-v2 -f ollama/Modelfile-v2
```

The required model is `oral-examiner-v2:latest`. Local inventory also recorded V1, V3, V4, and qwen3:4b, but V3/V4 are not needed by this snapshot. No duplicate inventory file or new Modelfile is added.

Download Piper's **en_US-lessac-medium** voice into the repository root:

```powershell
python -m piper.download_voices en_US-lessac-medium
Test-Path .\en_US-lessac-medium.onnx
Test-Path .\en_US-lessac-medium.onnx.json
```

Both checks should return `True`. The roughly 63 MB ONNX model and its companion JSON are intentionally ignored; download them together instead of committing them. Faster-Whisper loads **base.en** with `device="cpu"` and `compute_type="int8"`; the first load may download model weights into the Hugging Face cache. Initial model downloads need network access and disk space. Configure any custom `HF_HOME` outside Git or under the ignored `.cache/` folder. Offline setup and target-hardware performance remain unverified.

```powershell
python backend/ai_oral_examiner_foundation_v1.py
```

Wait for model loading and the countdown, then speak. After detected speech, about five continuous seconds below the amplitude threshold ends recording; otherwise recording ends at 60 seconds. The script transcribes, requests one AI reply, filters it, plays approved text, and exits. Launch it again for another turn; no history is retained. `keep_alive="30m"` requests model retention to reduce reload latency, but latency has not been benchmarked.

Temporary `voice_ollama_input.wav` and `ai_response.wav` are written in the repository root and overwritten on later runs. Git ignores WAV files but does not delete them. Use synthetic demo answers and remove recordings locally when no longer needed. If microphone selection, model lookup, or a package import fails, check the active environment, working directory, Windows audio permissions/default device, and Ollama availability. Runtime errors outside response parsing are not handled by this preserved prototype.

## Future Ubuntu / offline work (not completed)

Select CIS hardware and supported runtime versions; prepare approved installers, Python, model weights, checksums and licenses before isolation. On Ubuntu use python3 and the platform's approved Ollama installation procedure. Recreate the models and repeat tests on actual hardware. Disconnect networking and verify all required functions, logs, dependencies, and recovery paths locally. Localhost requests alone do not prove air-gapped operation. Cloud database/auth proposals need client reconciliation before implementation.

References: https://docs.ollama.com/modelfile and https://docs.ollama.com/api/chat.

## GUI avatar and Windows launchers

First complete the Foundation V1 setup above. Reuse the repository-root `.venv`; do not create another environment for the GUI. Tkinter must be available in that Python installation (it is not a pip requirement). From the repository root, check without opening a window:

```powershell
.\.venv\Scripts\python.exe -c "import tkinter; print(tkinter.TkVersion)"
```

If tkinter is unavailable, modify the Windows Python installation to include Tcl/Tk. No GUI-specific pip packages or changes to either requirements file are needed.

Double-click **backend/Start_AI_Oral_Examiner_GUI_Integrated.bat**, then click **Start Voice Interaction** in the window. To use the known-good console-only fallback, double-click **backend/Start_AI_Oral_Examiner.bat**. Both resolve the repository root from their own location, check for `.venv` and the two Piper files, and invoke the environment's Python directly. They do not activate PowerShell, alter execution policy, install packages, download models, or start Ollama. Keep Ollama running with `oral-examiner-v2:latest` available.

Required local layout (models and environment remain ignored):

```text
repository-root/
  .venv/Scripts/python.exe
  en_US-lessac-medium.onnx
  en_US-lessac-medium.onnx.json
  backend/ai_oral_examiner_foundation_v1.py
  backend/ai_oral_examiner_gui_v1.py
  backend/ai_oral_examiner_gui_integrated_v1.py
  backend/Start_AI_Oral_Examiner.bat
  backend/Start_AI_Oral_Examiner_GUI_Integrated.bat
```

Download the Piper pair once into this root using the earlier command. Do not copy another voice model into backend or a GUI folder. The child process runs with the root as its working directory, so unchanged Foundation V1 still finds the voice model and writes its ignored temporary WAV files there. Moving the checkout to a different Windows path does not require editing the GUI or BAT files. Keep the launchers in backend; create a shortcut if you want one elsewhere.

Alternatively, run from PowerShell at the repository root without activation:

```powershell
# GUI-only checkpoint: no models or microphone are used.
.\.venv\Scripts\python.exe backend/ai_oral_examiner_gui_v1.py
# Integrated checkpoint: same interpreter is used for Foundation V1.
.\.venv\Scripts\python.exe backend/ai_oral_examiner_gui_integrated_v1.py
```

Loading/Get Ready/Listening/Thinking/Speaking/Idle states follow Foundation's printed messages. The Session Log contains its combined stdout/stderr, including transcripts and responses, in memory; it is not a saved exam record or a filtered student-facing view. Start is disabled during a run and re-enabled when the process ends. Each start is an independent spoken turn.

This preserved prototype does not cancel its child when the window closes, and a child exiting with an error can still produce the generic completion message; inspect the Session Log for errors. Wait for a turn to finish before closing the GUI, and do not run multiple copies against the same WAV filenames. State detection matches console text and may be confused by matching words in a transcript or response. Robust process cancellation, exit-code handling, structured events, and synchronized lip animation are follow-up work.
