# Architecture: current foundation and proposed connections

## Implemented experiment

```mermaid
flowchart LR
 P[Trusted synthetic professor JSON] --> H[Python test harness]
 S[Untrusted synthetic student answer] --> H
 M[Saved v2.1 SYSTEM instructions] --> H
 H --> O[Local Ollama / Qwen3 4B]
 O --> V[Checks and saved raw result]
 V --> R[Professor/reviewer inspection]
 H --> A[Assessment student view: fixed receipt]
```

V1/v2 are preserved baseline configurations. Version 0.1 examiner/follow-up/grading documents express a separated design but are not wired into a service. The harness grades single answers in fresh conversations. It neither authenticates users nor implements multi-turn sessions. JSON output and rubric instructions do not establish grading correctness.

## Proposed application (not built)

```mermaid
flowchart TD
 PI[Professor interface] --> AUTH[Authentication and authorization]
 AUTH --> APP[Python session/application logic]
 SI[Student interface / microphone] --> STT[Speech recognition]
 STT --> APP
 APP --> EX[Examiner and controlled follow-up]
 EX --> TTS[Separate text-to-speech]
 TTS --> SI
 TTS -. optional .-> AV[Authorized avatar]
 APP --> EV[Rubric evaluator]
 EV --> PI
 APP --> DB[Exam records / transcript / audit storage]
 PI --> DB
```

Application logic should own question state, mode, limits and permissions. Only authenticated professors configure materials/rubrics; student text is data. Do not send grading material to the student-facing response path. Evaluate original and follow-up answers under an agreed policy, preserve provenance, and require professor final approval. A model's instruction to change mode must not mutate session state.

Python/FastAPI, React/Next.js, faster-whisper, Kokoro, PostgreSQL/Supabase, pgvector and MuseTalk/LivePortrait are existing proposals, not final decisions. Dify is an empty placeholder. Choose the smallest integrations after the text gate. An air-gap requirement would constrain cloud-backed choices. This diagram preserves the original separation concept without claiming a new deployed architecture.
