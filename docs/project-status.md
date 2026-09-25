# Project status — 2026-09-25

## Saved implementation

Original Modelfile: qwen3:4b, temperature 0.2, num_ctx 8192. V2: qwen3:4b, temperature 0.4, top_p 0.85, num_ctx 16384. V2.1 keeps v2 settings and adds rubric/mode instructions. These are prompt configurations, not model training or an application version.

The standard-library Python runner makes local Ollama chat requests with v2.1 system instructions, separate trusted professor configuration and untrusted student answers, JSON output, seed 42, thinking disabled, and 1800 output-token limit. Its assessment student view returns only a fixed receipt; follow-ups require review. This is a test utility, not authentication or a full exam session engine.

## Verified evidence

The saved 2026-09-17 run `tests/results/20260917T192156856386Z` contains environment metadata, 19 raw responses with requests and actual/expected comparisons, and summary.json. Four passed: incorrect, explicit_partial, percentages, mapped_levels. Fifteen failed. Some failures concern output conventions; others show serious scoring-rule violations. Results are not a reliability estimate.

Six harness tests previously passed; preparation checks and any fresh rerun are recorded in the review report. Original local baselines are checked using SHA-256. No new model generation is implied by replaying saved results.

The existing `prompts/Version 2 Ollama Answers.txt` is an informal historical conversation, not a controlled benchmark. It includes coaching, role switching, and displayed thinking. Do not use its claims about TCP or its grading behavior as approved course material. The historical grading prompt's 8/10 and confidence 0.95 are expected/example values, not measured performance.

## Foundation V1 — Core Voice + LLM Interaction Engine

Added `backend/ai_oral_examiner_foundation_v1.py` as the unchanged local reference snapshot. It is byte-identical to the latest root `test_voice_ollama_ttsV2.py`, so a second copy is not included. Six distinct earlier prototypes are preserved under `tests/development/`; duplicated copies from the local `Python_Ollama_VoiceInput` folder are not imported. Earlier Python text V1/V2 work remains on its existing contribution branch.

Implemented: sounddevice microphone capture at 44100 Hz, mono/int16; RMS amplitude threshold 500; five-second silence buffer after speech starts; 60-second recording cap; temporary WAV; Faster-Whisper base.en on CPU/int8 with technical vocabulary prompt; Ollama V2 with `think=False`, `format=response_schema`, temperature 0, `num_predict=120`, and `keep_alive="30m"`; JSON extraction of `spoken_response`; cleanup and suspicious-phrase screening; Piper synthesis and sounddevice playback. One invocation is one turn.

The developer reports successful microphone, transcription, voice-to-Ollama, Piper, and complete spoken interaction tests on Windows/Python 3.13.15. These reports are distinct from the safe automated checks performed during repository integration. No new microphone capture, speaker playback, model download, live inference, or clean dependency installation is implied by syntax/unit checks.

Important implementation limits:

- Only the parsed `spoken_response` value is offered to Piper. Parse/key/type failures prevent speech through the existing exception path; known suspicious phrases block playback. The schema is requested from Ollama, not independently validated in full, and extra JSON keys are ignored.
- Cleanup runs before phrase detection. It removes closed think blocks, code blocks, selected Markdown/symbols, and whitespace; it is not a complete Markdown parser. Phrase screening is heuristic and can miss paraphrased reasoning or block benign quotations. It cannot guarantee that all internal commentary is suppressed.
- Silence detection uses a fixed amplitude threshold, not semantic voice activity detection. Ambient noise may prolong capture; quiet speech can be missed. If no speech crosses the threshold, recording lasts until the 60-second cap and is still transcribed. Overflow flags are read but not handled.
- The earlier voice-input V2 prototype starts recording before its speak prompt; the current Foundation snapshot prints the prompt before opening InputStream. No pre-roll guarantee is claimed for the snapshot.
- The simple Piper V1 test writes a WAV only; speaker playback is implemented in the full pipeline scripts. Earlier full-pipeline V1 speaks the raw model response and should not be confused with the screened Foundation reference.
- No conversation loop/history, streaming audio, professor question/rubric controller, controlled follow-up engine, or validated scoring is implemented in this voice script. Its conversational coaching is not an assessment policy.

## Team application work and remaining integration

Current main also contains FastAPI exam/grading/review/stream modules, frontend pages/components, a database schema, and Docker configuration from teammates. They are preserved unchanged and were not validated as a deployed system during this increment. The standalone voice foundation is not yet wired to those interfaces, authentication, storage, or deployment paths.

Remaining voice work: continuous conversation, latency measurement/optimization, streaming audio, improved voice quality, professor-created questions, rubric-aware grading, controlled follow-ups, session management, transcripts and scores/results, professor/student interface integration, authentication, database/storage integration, avatar, and Ubuntu deployment.

## Earlier design proposals

Earlier discussions included separate examiner/evaluator, FastAPI, React/Next.js, Whisper/faster-whisper, Kokoro, PostgreSQL/Supabase, optional RAG/pgvector, MuseTalk/LivePortrait, identity verification, Docker, and CIS Ubuntu deployment. Foundation V1 concretely uses Faster-Whisper and Piper; this does not finalize the whole team's technology choices. Dify/AI Foundations remain placeholders; application and database code now exists as described above.

## Unknown / awaiting decisions

Client-approved CIS 454 requirements baseline is not supplied. Follow-up limits, grading after clarification, partial-credit rules, accommodations, role authentication, retention/access policy, hardware, latency, concurrency, licenses, and offline provisioning are unresolved. Supabase/cloud proposals may conflict with air-gapped deployment. No privacy-compliance or security assessment exists.

## Conflict to resolve

Version 0.1 examiner/follow-up designs prohibit hints and grading during assessment. V2 allows explanations, correction, and adaptation. Preserve both for comparison; do not use v2's conversational behavior as enforcement of assessment rules. V2.1's intended rules also failed several synthetic cases. Human review and application controls remain necessary.
