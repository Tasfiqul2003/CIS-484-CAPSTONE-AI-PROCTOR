# AI Oral Examiner — CIS 484

James Madison University capstone exploring oral assessment with professor-controlled questions and rubrics. CIS 454 contributes requirements, analysis, and design; CIS 484 implements the MVP. Professors decide final grades.

## Current capabilities

Saved Qwen3 4B Ollama configurations, separate examiner/follow-up/grading prompt designs, synthetic text fixtures, and a Python rubric experiment. This configures an existing model; it does not train one. **Version 2.0 names a model configuration, not a completed application release.** V2.1 is an experimental rubric prompt, not a reliable grading service.

The preserved September 17 run has **4/19 automated passes and 15/19 failures**. Failures include invented numeric scales, incorrect totals, missed equivalent wording, and paraphrased evidence. See [status](docs/project-status.md) and [test instructions](tests/README.md).

## Quick start (Windows)

Install Python 3.10+ and Ollama from their official sites, then open PowerShell in this checkout. Full instructions, prerequisites, and recreation commands: [setup](docs/setup.md).

```powershell
py -3 -m unittest discover -s tests -p "test_*.py" -v
ollama list
# Only if the base model is missing and downloads are permitted:
ollama pull qwen3:4b
ollama create oral-examiner-v2 -f ollama/Modelfile-v2
py -3 tests/run_rubrics.py --case explicit_partial
```

The runner explicitly supplies v2.1 SYSTEM instructions to local qwen3:4b. It is not testing the installed v2 model. A nonzero test exit is expected when model behavior fails checks.

## Folder layout

- `ollama/`: original, v2, and experimental v2.1 configurations.
- `prompts/`: preserved Version 0.1 prompt designs, historical transcript, reusable inputs.
- `docs/`: setup, status, requirements, architecture, roadmap, comparison, and original design background.
- `tests/`: synthetic fixtures, expected outputs, harness, conversation specifications, actual-results template, and one preserved synthetic run.
- `AI Foundations/`, `Workflows/`, `database/`: existing empty placeholders, not working components.

## Limitations and next milestone

No integrated speech, avatar, database, authentication, UI, or deployment exists in this checkout. Prompt rules are not access controls. The harness keeps assessment output from its student view; it is not a production exam service. No privacy compliance, air-gap operation, grading reliability, or confidence calibration has been established.

Next: have the professor approve rubric interpretation and partial-credit policies, investigate failed cases, and repeat reviewed text tests before incremental integration. See [roadmap](docs/roadmap.md), [requirements](docs/requirements.md), and [CONTRIBUTING](CONTRIBUTING.md).

The original README is preserved in [design background](docs/design-background.md). Its diagrams, example scores/confidence values, file tree, and technology choices are proposals, not implementation evidence. Historical prompts also contain illustrative confidence values and review flags; all grades still require professor authority.

## Python integration milestones (September 21)

Python now connects typed text to `oral-examiner-v2:latest` through the official Ollama Python client. The original development scripts are preserved without edits:

| Script | Behavior |
|---|---|
| `python/test_ollama.py` (Python V1) | Sends one fixed introduction prompt, prints a response, then exits. |
| `python/test_ollama_v2.py` (Python V2) | Accepts repeated questions in a text loop until `exit`. |

Both Python milestones use the **V2 model**; script versions are independent of model configuration versions. V2 sends each question independently, without conversation history. Blank or whitespace-only input is still sent to Ollama and may produce a generic greeting. These historical behaviors are preserved; improvements belong in a future version.

Development used **Python 3.13.15** and **ollama 0.6.2**. Ollama must be installed and running separately; the Python package does not include its server or models. From the repository root in Windows PowerShell:

```powershell
py -3.13 -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install -r requirements.txt
ollama list
python python/test_ollama.py
python python/test_ollama_v2.py
```

Ensure `ollama list` includes `oral-examiner-v2:latest`. See [setup](docs/setup.md#python-integration-prototypes) for model setup, activation troubleshooting, and running without activation. Type `exit` to stop V2. The developer reported successful introduction, arithmetic, and TCP/UDP explanation runs; these demonstrate integration, not grading reliability.

See [Python progress](docs/python-progress.md) for verification and limitations. Microphone input, speech-to-text, text-to-speech, and avatar integration remain future work. Preserve these milestones while improving input/error handling and agreeing on session behavior before adding voice.
