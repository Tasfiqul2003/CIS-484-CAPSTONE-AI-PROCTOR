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
