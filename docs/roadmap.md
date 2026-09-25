# Four-sprint roadmap (proposed; three weeks each)

| Sprint | Priority and deliverable | Evidence to exit |
|---|---|---|
| 1 | Professor-approved rubric rules, failure analysis, paraphrase/ambiguity cases, practice/assessment boundaries | Reviewed expectations and actual outputs; repeated seeds/subjects; agreed acceptance threshold, no silent invented scales |
| 2 | Small text session controller, professor review and exam-record storage, minimal interfaces | End-to-end synthetic exam with question/answer/follow-up provenance and professor override; role-boundary tests |
| 3 | Speech recognition and separate TTS after text gate; text fallback | Audio/transcript comparisons, correction workflow, measured latency, accessibility review |
| 4 | CIS Ubuntu integration, recovery and demo; isolation validation if required | Reproducible setup, tested synthetic demo, recorded hardware/offline limitations and handoff |

Pair six teammates across rubric/evaluation, application/session, and tests/deployment/docs; rotate reviewers. Exact ownership and sprint dates need team agreement. Keep work in small branches and review changes together.

Immediate work: investigate invalid percentage normalization and invented numeric grades for qualitative rubrics; preserve failing runs; resolve whether nullable maxima are required on unclear answers; test equivalent wording and OR conditions without invented requirements. A professor-approved structured rubric plus deterministic arithmetic is a possible next increment, not implemented here.

Avoid widening scope until the text acceptance gate is met. Avatar, RAG and identity approaches remain pending client scope decisions; defer optional work if integration slips. Do not equate prompt version 2.0 with sprint completion or an application release.

## Foundation V1 update — September 25, 2026

A standalone single-turn voice foundation now exists using sounddevice, Faster-Whisper, Ollama/Qwen3, and Piper. Local end-to-end success is developer-reported; safe integration checks do not measure speech quality or latency. Existing team API/frontend/database/Docker work is preserved but is not connected to this voice script yet.

Next voice increments: continuous back-and-forth conversation and session state; measured latency and model-loading improvements; streaming audio and improved voice quality; professor-created questions and rubric-aware evaluation; controlled follow-ups; transcript and score/result handling; professor/student interface, authentication and database integration; then avatar and Ubuntu deployment. The rubric acceptance and professor-review gates above still apply. A working spoken demo does not resolve grading or assessment-policy failures.
