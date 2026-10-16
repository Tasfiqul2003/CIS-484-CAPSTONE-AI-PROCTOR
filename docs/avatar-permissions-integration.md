# Avatar permissions: rules and remaining integration work

## Decisions for this part

| Control | Permission rule |
| --- | --- |
| Volume, text size, reduced motion | Student controls: volume 0–100%, text 16/20/24 px, reduced motion on/off. Browser or professor-required reduced motion takes priority. |
| Avatar, background, speaking speed | Professor selects permitted built-in/uploaded images and a speed range within 0.5×–2×. Defaults must be included when student choice is enabled. Student controls are absent when changes are disallowed. |
| Repeat, clarify, hint, explanation, correctness feedback | Professor controls practice/assessed/both modes and **1–10 uses per question** for each enabled action. Disallowed actions are absent. Allowed actions remain visible with a prominent remaining-use count when exhausted. |
| Voice, timing, follow-ups, question order, questions, rubric, grading | Professor controlled. Students have no independent voice selection. Professor materials and rubrics govern evaluation; AI scores are provisional. |

Saved exam policies and personal preferences are separate. Saving a local draft does not publish a policy. The shared browser preview is synthetic and is not an authorization boundary. Server policy saves belong to the authenticated owner of the exam.

The professor's **Preview exam mode** and preview-link mode parameter simulate practice or assessed availability. They do not configure a real exam or let students change its mode; the actual exam must supply its authoritative mode when connected.

Policy changes apply to **new attempts**. An active preview keeps its starting policy until **Restart preview**; editing or resetting preferences does not replenish assistance. Real attempts must eventually preserve this rule on the server, including across refreshes.

## Remaining tasks to include in related work

- **When creating class and roster tables,** link each class to its owning professor and each enrollment to an authenticated student. Let the portal resolve only that student's accessible classes, exams, and permission policies; reject requests based only on a supplied student or professor ID.
- **When implementing exam assignments,** connect an exam to a class or individual student and validate eligibility on the server before returning the student-facing policy or starting an attempt. Keep a professor's full configuration separate from the smaller student-facing permission response.
- **When implementing student accounts and authentication,** derive student identity from the session. Enforce professor ownership, student enrollment, and exam assignment on every relevant endpoint, including direct requests that bypass the interface.
- **When connecting the actual student exam,** load its authoritative policy before showing exam controls. Reconcile saved preferences with the permitted choices and ranges, hide restricted controls entirely, and retain volume, text size, readable state labels, and reduced motion.
- **When persisting real attempts,** save the policy revision and policy snapshot at attempt start. Apply later instructor edits to new attempts; do not silently change the rules of an active attempt. Define an explicit administrative process if an active attempt must change.
- **When implementing real assistance requests,** count uses atomically on the server by attempt, question, and action. Enforce mode, availability, allowance, and timer behavior there. Refresh, retries, concurrent requests, preference resets, and reopening the portal must not restore uses.
- **When adding individual accommodations,** store an approved, scoped override with its approver and applicable exam/student. Define how it combines with the exam policy without granting students access to professor-only rules.
- **When validating the connected workflow,** test two professors, two students, unassigned students, changed enrollment, direct unauthorized requests, stale policy revisions, restricted saved preferences, and assistance races/reloads. Record observed results separately from expected behavior.

This document does not claim that roster, student authorization, real attempt snapshots, or server-side assistance enforcement are implemented. Those belong to the integrations above. Frontend mock behavior cannot establish real exam security.
