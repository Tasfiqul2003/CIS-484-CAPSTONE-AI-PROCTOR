# AI Oral Examiner — CIS 484

James Madison University capstone exploring oral assessment with professor-controlled questions and rubrics. CIS 454 contributes requirements, analysis, and design; CIS 484 implements the MVP. Professors decide final grades.

## Current capabilities

Saved Qwen3 4B Ollama configurations, separate examiner/follow-up/grading prompt designs, synthetic text fixtures, and a Python rubric experiment. This configures an existing model; it does not train one. **Version 2.0 names a model configuration, not a completed application release.** V2.1 is an experimental rubric prompt, not a reliable grading service.

**AI Oral Examiner Foundation V1 — Core Voice + LLM Interaction Engine** adds a standalone spoken interaction prototype: microphone → dynamic silence detection → Faster-Whisper → Ollama/Qwen3 → structured `spoken_response` → speech cleanup and reasoning-phrase check → Piper TTS → speakers. The developer reports successful end-to-end Windows testing. This is the basic AI foundation, not the final examination product or a validated grading service.

The reference is `backend/ai_oral_examiner_foundation_v1.py`. It processes **one spoken turn per launch**, using `base.en` on CPU/int8, `oral-examiner-v2:latest`, and Piper `en_US-lessac-medium`. It stops recording after about five seconds of silence following detected speech, or at the 60-second limit. Read [voice setup](docs/setup.md#foundation-v1-voice-setup) before running it; Python 3.13.15 and the recorded dependency versions were used locally. Only parsed `spoken_response` text reaches speech cleanup and the phrase filter. These checks reduce unwanted output but do not guarantee reasoning suppression.

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
- `tests/development/`: preserved manual voice prototypes; excluded from normal test discovery by their `manual_` filenames.
- `backend/`: existing FastAPI application and the standalone Foundation V1 voice script; their dependencies remain separate.
- `frontend/`, `database/`, Docker files: existing team implementation work, not validated or connected to the standalone voice script by this increment.
- `AI Foundations/`, `Workflows/`: existing placeholders, retained unchanged.

## Limitations and next milestone

The standalone voice pipeline is implemented, but its integration with team interfaces, authentication, database, avatar, and server deployment remains unfinished. Existing frontend/backend/Docker code is preserved; its end-to-end behavior was not tested in this increment. Prompt rules and phrase filtering are not access controls. The rubric harness keeps assessment output from its student view; the voice prototype is a conversational demo and does not inherit that grading boundary. No privacy compliance, air-gap operation, grading reliability, or confidence calibration has been established.

Next for the voice foundation: a continuous conversation loop, measured latency improvements, streaming audio, voice quality, professor-created questions, rubric-aware grading, controlled follow-ups, session management, transcripts and results, interface/authentication/storage integration, avatar, and Ubuntu deployment. See [status and limitations](docs/project-status.md) and [safe checks/manual history](tests/README.md). Earlier text V1/V2 work remains on `python/ollama-integration-v1-v2`; it is not duplicated here.

Next: have the professor approve rubric interpretation and partial-credit policies, investigate failed cases, and repeat reviewed text tests before incremental integration. See [roadmap](docs/roadmap.md), [requirements](docs/requirements.md), and [CONTRIBUTING](CONTRIBUTING.md).

The original README is preserved in [design background](docs/design-background.md). Its diagrams, example scores/confidence values, file tree, and technology choices are proposals, not implementation evidence. Historical prompts also contain illustrative confidence values and review flags; all grades still require professor authority.
