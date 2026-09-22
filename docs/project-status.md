# Project status — 2026-09-21

## Saved implementation

Original Modelfile: qwen3:4b, temperature 0.2, num_ctx 8192. V2: qwen3:4b, temperature 0.4, top_p 0.85, num_ctx 16384. V2.1 keeps v2 settings and adds rubric/mode instructions. These are prompt configurations, not model training or an application version.

The standard-library Python runner makes local Ollama chat requests with v2.1 system instructions, separate trusted professor configuration and untrusted student answers, JSON output, seed 42, thinking disabled, and 1800 output-token limit. Its assessment student view returns only a fixed receipt; follow-ups require review. This is a test utility, not authentication or a full exam session engine.

## Verified evidence

The saved 2026-09-17 run `tests/results/20260917T192156856386Z` contains environment metadata, 19 raw responses with requests and actual/expected comparisons, and summary.json. Four passed: incorrect, explicit_partial, percentages, mapped_levels. Fifteen failed. Some failures concern output conventions; others show serious scoring-rule violations. Results are not a reliability estimate.

Six harness tests previously passed; preparation checks and any fresh rerun are recorded in the review report. Original local baselines are checked using SHA-256. No new model generation is implied by replaying saved results.

The existing `prompts/Version 2 Ollama Answers.txt` is an informal historical conversation, not a controlled benchmark. It includes coaching, role switching, and displayed thinking. Do not use its claims about TCP or its grading behavior as approved course material. The historical grading prompt's 8/10 and confidence 0.95 are expected/example values, not measured performance.

## Discussed plans

Separate examiner/evaluator, Python application layer (FastAPI proposed), React/Next.js interfaces, Whisper/faster-whisper, separate TTS (Kokoro proposed), storage (PostgreSQL/Supabase proposed), optional RAG/pgvector, avatar (MuseTalk/LivePortrait proposed), identity verification, Docker, and local CIS Ubuntu deployment. None is integrated here. Empty SQL/Dify/AI Foundations files are placeholders.

## Unknown / awaiting decisions

Client-approved CIS 454 requirements baseline is not supplied. Follow-up limits, grading after clarification, partial-credit rules, accommodations, role authentication, retention/access policy, hardware, latency, concurrency, licenses, and offline provisioning are unresolved. Supabase/cloud proposals may conflict with air-gapped deployment. No privacy-compliance or security assessment exists.

## Conflict to resolve

Version 0.1 examiner/follow-up designs prohibit hints and grading during assessment. V2 allows explanations, correction, and adaptation. Preserve both for comparison; do not use v2's conversational behavior as enforcement of assessment rules. V2.1's intended rules also failed several synthetic cases. Human review and application controls remain necessary.

## Python text integration increment — September 21

Added preserved one-shot and interactive Python milestones under `python/`, both using `oral-examiner-v2:latest` through ollama 0.6.2. Development environment metadata records Python 3.13.15. V2 supports repeated typed questions but retains no conversation history and sends blank input unchanged. User-reported successful runs covered an introduction, arithmetic, and TCP/UDP explanations. See [Python progress](python-progress.md) for current verification evidence. This adds a text client, not the proposed FastAPI application or voice/avatar system.
