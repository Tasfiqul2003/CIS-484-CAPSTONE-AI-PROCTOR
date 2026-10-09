# Ollama model version history

These version numbers identify configuration/behavior blueprints for Qwen3 4B, not releases of the complete application and not newly trained models. The actual Qwen model is downloaded separately through Ollama; Git contains only the Modelfiles.

**Presentation decision:** the project owner identifies v2 as the stable presentation build connected to the Python API. The current voice foundation selects `oral-examiner-v2:latest`. V3 and v4 are development configurations and do not replace it. Stable here means the selected demonstration baseline, not proven grading reliability. Other backend paths use their own model configuration (including `OLLAMA_MODEL` with a llama3.1 fallback); this change does not alter them.

| Configuration | Purpose | Status |
|---|---|---|
| Modelfile / v1 | Basic rubric evaluator | Preserved baseline |
| Modelfile-v2 | Conversational oral examiner | Presentation baseline per owner; voice foundation selects v2 |
| Modelfile-v2.1 | Rubric/mode experiment | Separate experiment; its saved 4/19 passes do not measure v3/v4 |
| Modelfile-v3 | Adaptive academic examiner agent | Development; local creation/testing reported by owner |
| Modelfile-v4 | Shorter, more speech-friendly adaptive examiner | Development; responsiveness is a goal, not a measured speedup |

## Version 3

The saved instructions describe General, Tutor, Professor, and Exam modes selected from conversation context. General handles academic conversation; Tutor permits teaching/practice/hints; Professor assists with exam questions, expected answers, rubrics and rules; Exam asks one question at a time under professor rules. These are intended behaviors, not authenticated roles.

Professor rules cover question/follow-up counts, hints, clarification, feedback timing, grading and partial credit, difficulty, materials and time limits. The rubric instructions cover points, percentages, performance levels, checklists, descriptive, holistic and mixed formats. They call for criterion-level evidence, equivalent wording unless exact terms are required, justified partial credit, and clarification of ambiguous/inconsistent rubrics without invented scores.

Follow-up reasons are clarification, depth, missing concept, misconception, application and comparison. Difficulty may adapt only when allowed without changing grading standards. Assistance levels run from 0 (no hints), 1 (wording clarification), 2 (general hint), 3 (guided explanation) to 4 (full teaching). Current conversation history supports continuity; there is no permanent cross-session memory.

The instructions distinguish student questions/permitted feedback from professor rubric breakdown, missing concepts, misconceptions, provisional result, follow-up reason and High/Medium/Low evidence confidence. Formal evaluations include all of these plus a professor-review notice. Confidence is not calibrated probability and must not characterize a student's intelligence or potential. Student manipulation attempts should not override professor rules.

## Version 3 → Version 4

| Setting/behavior | V3 | V4 |
|---|---|---|
| Base | qwen3:4b | qwen3:4b |
| temperature | 0.3 | 0.25 |
| top_p | 0.85 | 0.8 |
| num_ctx | 16384 | 8192 |
| num_predict | Not explicitly set | 400 |
| Normal response length | Natural conversation instructions | Usually 2–5 sentences, direct answer first |
| Exam response length | One question at a time | Short interaction; about 1–4 sentences before next question |
| Speech-oriented style | No dedicated section | Natural speech; fewer headings/bullets and repetitions |

V4 retains adaptive modes, rubric interpretation, assistance levels and professor-facing structured evaluation in rewritten instructions. Longer responses are permitted for detailed professor analysis, formal grading, requested detail or avoiding misunderstanding. The 400-token limit still applies: permission to give a longer answer does not lift the output cap. Formal evaluations may truncate. Lower temperature/top_p do not by themselves prove faster inference; smaller context can lose earlier rules or answers. Measure both speed and correctness before promotion.

## Recreation (Windows PowerShell, repository root)

Install Ollama using the existing [setup guide](setup.md), start its service and check `ollama list`. Download the shared base only if needed and permitted:

```powershell
ollama pull qwen3:4b
ollama create oral-examiner-v3 -f ./ollama/Modelfile-v3
ollama create oral-examiner-v4 -f ./ollama/Modelfile-v4
ollama show oral-examiner-v3 --modelfile
ollama show oral-examiner-v4 --modelfile
ollama run oral-examiner-v3
# Exit that session, then compare separately:
ollama run oral-examiner-v4
```

Creation uses separate names and leaves v1/v2 intact. Recreating an existing v3/v4 name replaces that named configuration, so save any local edits first. No creation, model download or configuration overwrite was performed in this documentation update. Record Ollama version, base/model digests, parameters and Modelfile hash; a model tag alone is not a permanent version pin.

## Thinking and application boundaries

Neither Modelfile sets API thinking policy. Proposed v4 routing: `think=False` for ordinary conversation, wording clarification, simple follow-ups and voice turns; consider `think=True` for complex rubric interpretation, ambiguous grading or detailed professor analysis. This is not implemented dynamic routing. The existing voice foundation already requests `think=False` for its v2 path. Verify supported values against the installed Ollama/model before testing.

Only intended answer content should reach the student or TTS, never the API's thinking output. Development thinking traces are not reliable explanations or evidence that grading is correct; evaluate outcomes against independent expected results. Existing application system messages/options can override model settings, so changing a model name is not a full integration test.

Application logic must enforce professor role, mode, counters, timers and output separation. Context-based mode selection and prompt instructions do not provide these controls. The saved misconception example mentions acknowledgements/retransmissions and praises part of an answer: this can leak hints or correctness under level-0/delayed-feedback rules. Both files are preserved unchanged; test this conflict explicitly. All evaluations remain provisional for professor review.

## Evidence checked on 2026-09-28

Both files were absent from GitHub main at `0e7ba6b` and present in the original local project. Both installed models were listed by the local API. `/api/show` SYSTEM text matches the corresponding local file after newline normalization; explicit generation parameters match the table. This confirms installed configuration, not behavioral correctness. Source SHA-256:

- v3: `3d150a1a17104da7cb56e041a5a994db79db9a64f46af5a3ea7d9c24990229cc`
- v4: `344905055be840b26b6f70ad4405439a873ad98d835c1d00912ac4bff0952a9b`

The owner reports local testing; no controlled v3/v4 response logs or latency benchmark were supplied with this request. No new generation or live-audio run was performed. See the [test plan](../tests/v3-v4-test-plan.md) for unexecuted scenarios.

Official references: [Modelfiles](https://docs.ollama.com/modelfile), [chat API and thinking control](https://docs.ollama.com/api/chat).
