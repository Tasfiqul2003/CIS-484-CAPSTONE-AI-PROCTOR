# Python integration progress — September 21, 2026

## Preserved milestones

The source scripts came from `C:\Users\tasfi\Documents\AI-Oral-Examiner-Python`. Both that development folder and the separate `AI-Oral-Examiner` folder lack Git metadata. The shared GitHub repository was cloned and inspected before making changes, starting from main commit `bcbe74b`. Existing team files and history are retained.

Both scripts were copied without edits into `python/`. V1 sends a fixed introduction prompt to `oral-examiner-v2:latest`. V2 accepts repeated questions, sends each as a single independent user message, and exits when `question.lower() == "exit"`. It deliberately preserves blank-input submission, no conversation memory, no input trimming, and no exception handling. Script versions are separate from model versions.

The user reported successful introduction, arithmetic, and TCP/UDP explanation runs. The earlier unsaved empty V1 file and filename typo were already resolved. The accidental `test_ollam_V2.py` was not recreated. Original development folders, their virtual environment, and the separate local base-Qwen test were left intact.

## Verification for this increment

- SHA-256 checks confirm both copied scripts are byte-identical to their original local source files before Git line-ending normalization.
- Original `.venv/pyvenv.cfg` records Python 3.13.15; installed package metadata records ollama 0.6.2. `requirements.txt` pins that direct dependency.
- All six existing deterministic harness tests passed using the bundled Python runtime. These include baseline file integrity and professor/student output separation checks.
- `git diff --check` passed. Existing `.gitignore` excludes `.venv/`, Python caches, `.env`, and `.vscode/`; no change to it was needed.
- No fresh live model generation was performed. The sandbox could not launch the original virtual environment's Python executable. Environment metadata and historical user reports are not a fresh inference result.

## Team integration

CONTRIBUTING.md requires a branch per task. This increment uses `python/ollama-integration-v1-v2`, based on the fetched main branch. See Git history for commit/publication state. No pull request or merge is automatically created. Existing prompts, models, synthetic evidence, database files, and other team contributions remain unchanged.

## Next work

Add blank/whitespace-input handling and connection-error messages in a future version, then agree on session history and examination behavior. Microphone, speech-to-text, text-to-speech, and avatar integration remain planned. These scripts implement only Python-to-Ollama text interaction, not an integrated grading application.
