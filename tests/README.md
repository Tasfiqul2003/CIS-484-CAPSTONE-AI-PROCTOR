# Test design and limitations

`tests/cases.json` contains synthetic professor configurations and student answers. `tests/expected.json` contains independently authored expectations; expectations are never sent to the model. `tests/results/<UTC>/` holds actual requests/responses and automated comparisons. Retain unsuccessful runs; do not rewrite expected scores merely to make a run pass.

Coverage: correct, semantically equivalent, partially correct, incorrect, unclear, manipulative, mixed valid/attack, delimiter/role impersonation; explicit and unspecified partial credit; valid/invalid percentages; mapped/unmapped performance levels; checklist; narrative; conflicting totals; vague criteria; and practice mode.

The synthetic point rubric explicitly uses 2-or-0 per criterion. Thus the original sample answer earns an expected 8/10 in this synthetic fixture. This is not proof the original rubric authorized every partial-credit decision. Whole-criterion credit and within-criterion partial credit are different. Missing an entire criterion can yield a lower total without inventing an intermediate point rule.

The checker compares status, score, scale, selected qualitative judgments, evidence quotes, score arithmetic, and required fields. It does NOT reliably assess every semantic judgment, detect all leading questions, or prove prompt-injection resistance. Every response needs human review. Null scores indicate unresolved or qualitative assessment, not zero.

Human review checklist for each run:
1. Is each criterion faithful to the professor rubric, with no added requirements?
2. Do evidence and points match what the student actually said?
3. Are paraphrases accepted and unstated ideas excluded?
4. Are ambiguities named specifically instead of silently resolved?
5. Is any follow-up neutral, appropriate, and permitted?
6. Is practice coaching grounded in professor materials?
7. Record reviewer, date, agreement/disagreement, and correction in a separate review file.

## Authority and release boundary

Only the test operator controls professor JSON and mode. The entire student answer is serialized in a separate user message; text claiming to be a professor cannot change Python's configured mode. In assessment, `student_view()` always returns a fixed receipt, so neither model feedback nor a model-written follow-up is automatically shown. Proposed follow-ups and grading remain in the professor record for review. Practice can release explanations. This conservative first increment postpones automatic conversational follow-up delivery.

This is not authentication: anyone with filesystem access can edit fixtures or code. A future application must authenticate professors, protect rules, validate results, separate student/professor endpoints, and authorize follow-up delivery. Prompt instructions alone cannot enforce these controls. Raw result files contain professor material and must never be served to students.

Six unit tests cover original file integrity, trusted/untrusted message separation, fixed assessment release, practice release, invalid modes, and detection of fabricated quotes/incorrect arithmetic. They verify harness behavior, not model intelligence.

No baseline model comparison, repeat-seed reliability estimate, speech evaluation, database persistence, real-user study, or production security assessment is claimed. These JSON experiment records are not the intended production examination-record system.


Conversation cases in conversation-cases.json are manual specifications, not executed by run_rubrics.py. Copy actual-results-template.md for each future reviewed run. The preserved raw run is synthetic; future result folders are ignored until reviewed.

## Foundation V1 voice checks and manual history

The voice reference is `backend/ai_oral_examiner_foundation_v1.py`. It was copied unchanged from the local Foundation V1 snapshot; the latest root `test_voice_ollama_ttsV2.py` is identical and is not duplicated. Earlier text-only Python V1/V2 files remain on their existing contribution branch.

The following preserved files are manual development programs, not automated unit tests. Their `manual_` names prevent normal unittest/pytest discovery from opening microphones or loading models. Do not import these programs; run them explicitly from the repository root after the [voice setup](../docs/setup.md#foundation-v1-voice-setup).

| Original local filename | Repository location | Purpose |
|---|---|---|
| `test_microphoneV1.py` | `tests/development/manual_microphone_v1.py` | Records five seconds to microphone_test.wav |
| `test_speech_to_textV1.py` | `tests/development/manual_speech_to_text_v1.py` | Transcribes the preceding microphone_test.wav |
| `test_voice_inputV2.py` | `tests/development/manual_voice_input_v2.py` | Seven-second capture, early recording start, technical vocabulary prompt |
| `test_voice_ollamaV1.py` | `tests/development/manual_voice_ollama_v1.py` | Voice transcription to an Ollama text response |
| `test_text_to_speechV1.py` | `tests/development/manual_text_to_speech_v1.py` | Synthesizes ai_voice_test.wav; does not itself play it |
| `test_voice_ollama_ttsV1.py` | `tests/development/manual_voice_ollama_tts_v1.py` | Earlier complete pipeline; speaks unfiltered model text |
| `test_voice_ollama_ttsV2.py` / Foundation snapshot | `backend/ai_oral_examiner_foundation_v1.py` | Current single-turn reference with silence detection, JSON extraction, cleanup and phrase filtering |

All seven copied program files retain their source bytes. There is no second copy of the current V2 script or of identical files from the local Python_Ollama_VoiceInput folder. The older, differing V2 copy in that local folder is not the selected reference and remains untouched locally.

`tests/test_voice_foundation.py` uses the standard library to extract the actual cleanup functions and response-to-speech code through Python's AST. It executes those parts with synthetic text and mocked Ollama, file, Piper, and playback calls. It never imports the live voice script. Checks cover: only spoken_response reaching synthesis, cleanup, known reasoning phrases, malformed JSON, missing fields, wrong value types, empty/removed output, and empty transcription. These checks do not prove universal reasoning suppression or audio quality.

Run safe checks:

```powershell
py -3 -B -m unittest discover -s tests -p "test_*.py" -v
```

Actual integration checks on September 25, 2026: **14/14 tests passed** (six existing harness tests and eight new voice checks); all seven copied voice programs passed AST syntax parsing. Source SHA-256 comparison confirmed all seven programs are unchanged. The dependency freeze was converted from UTF-16 to UTF-8 for pip/Git portability; package pins are unchanged. No fresh audio capture, playback, inference, dependency installation, or model download was performed. The end-to-end Windows success is developer-reported, not a result of these mocked tests. No student recordings are included.

For a later manual synthetic demo, run the reference from the root and compare the spoken words, transcription, text reply, and audible reply. Try a pause shorter than five seconds, a five-second pause after speech, quiet input, background noise, and no initial speech. Record observed timing/hardware and failures separately; the configured thresholds alone do not prove timing or transcription accuracy. Keep WAV recordings and model/cache files out of Git. The current script overwrites its WAV filenames and does not manage retention automatically.
