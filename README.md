# AI Oral Examiner â€” CIS 484

James Madison University capstone exploring oral assessment with professor-controlled questions and rubrics. CIS 454 contributes requirements, analysis, and design; CIS 484 implements the MVP. Professors decide final grades.

## Current capabilities

Saved Qwen3 4B Ollama configurations, separate examiner/follow-up/grading prompt designs, synthetic text fixtures, and a Python rubric experiment. This configures an existing model; it does not train one. **Version 2.0 names a model configuration, not a completed application release.** V2.1 is an experimental rubric prompt, not a reliable grading service.

**AI Oral Examiner Foundation V1 â€” Core Voice + LLM Interaction Engine** adds a standalone spoken interaction prototype: microphone â†’ dynamic silence detection â†’ Faster-Whisper â†’ Ollama/Qwen3 â†’ structured `spoken_response` â†’ speech cleanup and reasoning-phrase check â†’ Piper TTS â†’ speakers. The developer reports successful end-to-end Windows testing. This is the basic AI foundation, not the final examination product or a validated grading service.

The reference is `backend/ai_oral_examiner_foundation_v1.py`. It processes **one spoken turn per launch**, using `base.en` on CPU/int8, `oral-examiner-v2:latest`, and Piper `en_US-lessac-medium`. It stops recording after about five seconds of silence following detected speech, or at the 60-second limit. Read [voice setup](docs/setup.md#foundation-v1-voice-setup) before running it; Python 3.13.15 and the recorded dependency versions were used locally. Only parsed `spoken_response` text reaches speech cleanup and the phrase filter. These checks reduce unwanted output but do not guarantee reasoning suppression.

The preserved September 17 run has **4/19 automated passes and 15/19 failures**. Failures include invented numeric scales, incorrect totals, missed equivalent wording, and paraphrased evidence. See [status](docs/project-status.md) and [test instructions](tests/README.md).

## Model configuration history

V2 remains the project owner's **stable presentation build** and the model selected by the current voice foundation. V3/v4 are separate development models; this update does not switch any application model selection.

| Version | Focus | Role |
|---|---|---|
| 1 | Basic rubric evaluator | Preserved baseline |
| 2 | Conversational oral examiner | Presentation baseline |
| 2.1 | Rubric/mode experiment | Separate experimental fixture suite |
| 3 | Adaptive examiner: modes, professor rules, flexible rubrics and purposeful follow-ups | Development |
| 4 | Adaptive examiner with shorter, more speech-friendly responses and tighter generation settings | Development; speedup not yet measured |

These are Ollama configuration versions, not releases of the whole application. See [model history, v3→v4 comparison and recreation](docs/model-version-history.md) and [v3/v4 test plan](tests/v3-v4-test-plan.md). Qwen3 weights are downloaded separately; the Modelfiles are behavior blueprints.

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

## Foundation V1 Launcher and GUI Avatar Prototype

Foundation V1 remains the unchanged fallback voice engine. Two Windows launchers and two standalone Tkinter programs now sit alongside it in `backend/`:

- `ai_oral_examiner_gui_v1.py`: preserved GUI-only checkpoint with Idle, Listening, Thinking, and Speaking buttons and simple mouth animation.
- `ai_oral_examiner_gui_integrated_v1.py`: starts Foundation V1 as a subprocess on a worker thread, sends console messages through a queue, displays a Session Log, and updates avatar states on the Tkinter thread. Mouth animation runs during the reported Speaking state and stops on Idle.
- `Start_AI_Oral_Examiner.bat`: runs the original voice foundation.
- `Start_AI_Oral_Examiner_GUI_Integrated.bat`: opens the integrated avatar; click **Start Voice Interaction** for one spoken turn.

After the existing voice setup, double-click the integrated BAT file in `backend/`. Both launchers use the repository's `.venv` directly and require no PowerShell activation or execution-policy change. Keep the Piper voice and JSON configuration together at the repository root. See [GUI startup](docs/setup.md#gui-avatar-and-windows-launchers).

The developer reports successful original launcher, GUI-only, and full GUI-plus-voice testing. Repository checks are offline and do not re-establish live audio success. This is a desktop prototype, separate from the team's web frontend. The mouth motion is a timed visual indication of speech, not phoneme lip-sync; repeated clicks start fresh processes, not a continuous conversation.

## Folder layout

- `ollama/`: original, v2, experimental v2.1, and development v3/v4 configurations.
- `prompts/`: preserved Version 0.1 prompt designs, historical transcript, reusable inputs.
- `docs/`: setup, status, requirements, architecture, roadmap, comparison, and original design background.
- `tests/`: synthetic fixtures, expected outputs, harness, conversation specifications, actual-results template, and one preserved synthetic run.
- `tests/development/`: preserved manual voice prototypes; excluded from normal test discovery by their `manual_` filenames.
- `backend/`: existing FastAPI application, unchanged Foundation V1 voice script, desktop GUI checkpoints, and Windows launchers; the voice and FastAPI dependencies remain separate.
- `frontend/`, `database/`, Docker files: existing team implementation work, not validated or connected to the standalone voice script by this increment.
- `AI Foundations/`, `Workflows/`: existing placeholders, retained unchanged.

## Limitations and next milestone

The standalone voice pipeline is implemented, but a basic Tkinter avatar now wraps it; integration with team web interfaces, authentication, database, and server deployment remains unfinished. Existing frontend/backend/Docker code is preserved; its end-to-end behavior was not tested in this increment. Prompt rules and phrase filtering are not access controls. The rubric harness keeps assessment output from its student view; the voice prototype is a conversational demo and does not inherit that grading boundary. No privacy compliance, air-gap operation, grading reliability, or confidence calibration has been established.

Next for the voice foundation: a continuous conversation loop, measured latency improvements, streaming audio, voice quality, professor-created questions, rubric-aware grading, controlled follow-ups, session management, transcripts and results, interface/authentication/storage integration, further avatar work, and Ubuntu deployment. See [status and limitations](docs/project-status.md) and [safe checks/manual history](tests/README.md). Earlier text V1/V2 work remains on `python/ollama-integration-v1-v2`; it is not duplicated here.

Next: have the professor approve rubric interpretation and partial-credit policies, investigate failed cases, and repeat reviewed text tests before incremental integration. See [roadmap](docs/roadmap.md), [requirements](docs/requirements.md), and [CONTRIBUTING](CONTRIBUTING.md).

The original README is preserved in [design background](docs/design-background.md). Its diagrams, example scores/confidence values, file tree, and technology choices are proposals, not implementation evidence. Historical prompts also contain illustrative confidence values and review flags; all grades still require professor authority.
