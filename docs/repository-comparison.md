# Repository/local comparison â€” 2026-09-21

Source repository: https://github.com/Tasfiqul2003/CIS-484-CAPSTONE-AI-PROCTOR
Compared main at d150f47fbdc729ee3eb27a5f19be968f56f435b9 before edits. GitHub API reported public visibility; no visibility setting was changed. Local source: C:/Users/tasfi/Documents/AI-Oral-Examiner (no .git). The review checkout retains repository history and uses local branch prepare-team-review. The initial preparation made no push, publication, merge, or commit. Subsequent publication is recorded in Git history and the pull request.

| Before preparation | Finding | Review change |
|---|---|---|
| README.md | Extensive design vision; proposed tree differs from actual files; no measured results | Preserve original as docs/design-background.md; concise current README |
| Prompts/Ollama Version 2 Modelfile-2 | Same v2 instructions as local Modelfile-v2 after trimming whitespace | Consolidate at ollama/Modelfile-v2 using original local bytes |
| Prompts/Version 01 Examiner Prompt | Existing equivalent of discussed examiner_prompt.md | Preserve content and name under canonical prompts/ |
| Prompts/Version 01 Follow Up Prompt | Existing equivalent of discussed followup_prompt.md | Preserve content and name under canonical prompts/ |
| Prompts/Version 01 Grading Prompt | Existing equivalent of discussed grading_prompt.md; includes expected 8/10 | Preserve content and name under canonical prompts/; not a passing test result |
| Prompts/Version 2 Ollama Answers.txt | Informal conversation with coaching and role changes | Preserve as historical evidence; not course authority or controlled benchmark |
| AI Foundations/Config, Scripts, Tests; Workflows/Dify; database/Schema SQL | Empty placeholders | Unchanged; no implemented service inferred |
| ollama/Modelfile; prompts/test-exam.txt; prompts/exam-template.txt | Missing as standalone repo files | Copy original local bytes; test input extracted for use is distinct from historical grading-prompt design |
| Local v2.1 and tests | Missing in GitHub | Preserve experimental configuration, synthetic fixtures, runner, expectations and actual failed run |
| Local docs/SETUP.md, STATUS.md, NEXT-STEPS.md, TESTING.md | Overlapping preliminary docs; STATUS says no Git history because it inspected local folder only; referenced RESULTS.md absent | Consolidate into docs/setup.md, project-status.md, roadmap.md and tests/README.md; do not create case-only duplicates |
| Required requirements/architecture/contribution/agent guidance | Absent | Add concise source-qualified documents |

The strict Version 0.1 assessment designs conflict with v2's conversational coaching permissions. Both are preserved as baselines, with the conflict explicit in project-status.md. The original README and grading prompt contain example confidence/review values; these are not measured confidence or permission to skip professor grading authority.

Original local files are untouched. Only the known synthetic run was imported; credentials, auth tooling, caches, weights, installers and private recordings were excluded. New results are ignored pending review. No aliases named examiner_prompt.md, followup_prompt.md, or grading_prompt.md were created because equivalent documents already exist.
