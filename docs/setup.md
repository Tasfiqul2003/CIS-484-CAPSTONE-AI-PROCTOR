# Reproducible Windows setup

## Prerequisites

Windows, Python 3.10+ from https://www.python.org/downloads/windows/, Git from https://git-scm.com/downloads/win (or GitHub Desktop), and Ollama from https://ollama.com/download/windows. Install these outside the repository. No Python packages beyond the standard library are required for current tests. This preparation does not install or download model weights.

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

## Future Ubuntu / offline work (not completed)

Select CIS hardware and supported runtime versions; prepare approved installers, Python, model weights, checksums and licenses before isolation. On Ubuntu use python3 and the platform's approved Ollama installation procedure. Recreate the models and repeat tests on actual hardware. Disconnect networking and verify all required functions, logs, dependencies, and recovery paths locally. Localhost requests alone do not prove air-gapped operation. Cloud database/auth proposals need client reconciliation before implementation.

References: https://docs.ollama.com/modelfile and https://docs.ollama.com/api/chat.

## Python integration prototypes

The scripts in `python/` require the official Ollama Python package, unlike the standard-library rubric tests above. The original environment metadata records Python 3.13.15 and ollama 0.6.2. Install Python 3.13 and Ollama separately, then run these commands from the repository root:

```powershell
py -3.13 -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install -r requirements.txt
ollama list
```

If PowerShell blocks activation, temporarily allow scripts for this process and retry:

```powershell
Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass
.\.venv\Scripts\Activate.ps1
```

Activation is optional. You can instead use `.\.venv\Scripts\python.exe` wherever these instructions use `python`, including dependency installation.

Ollama must be running with `oral-examiner-v2:latest` installed. Models are not included in a Git clone. If the base model is missing, run `ollama pull qwen3:4b` (requires network access and disk space). If the custom V2 model is missing, run `ollama create oral-examiner-v2 -f ollama/Modelfile-v2`, then check `ollama list` again. Do not recreate an existing customized model unless you intend to replace its local definition.

```powershell
python python/test_ollama.py
python python/test_ollama_v2.py
```

V1 prints one response and exits. V2 waits at `You:`; ask multiple questions and type `exit` to stop. It accepts case-insensitive `exit` without surrounding spaces. Blank input is sent as-is, each request is independent, and connection errors are not caught. These are preserved prototypes, not an exam session or a grading service.

For team updates, first save unfinished changes on your own branch. In a clean checkout, fetch and switch to the published contribution branch:

```powershell
git fetch origin
git switch python/ollama-integration-v1-v2
git pull --ff-only
```

Then create/activate the environment, install requirements, verify the model, and run the scripts above. If Git cannot switch or fast-forward, stop and coordinate instead of discarding changes. Follow CONTRIBUTING.md for review and eventual maintainer merge; this branch is not automatically merged into main.
