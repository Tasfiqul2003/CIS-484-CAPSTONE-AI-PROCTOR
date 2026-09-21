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
