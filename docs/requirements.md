# Consolidated requirements — draft for client review

Sources: project-owner instructions in this task (CIS 454 analysis/design, CIS 484 implementation, six members, four three-week sprints); repository design-background.md; preserved Version 0.1 prompts; local Modelfiles/test inputs. No approved CIS 454 requirements document, interview transcript, or signed acceptance baseline was provided. The table records available intent, not client approval.

| ID | Requirement / source | Current evidence | Acceptance / clarification needed |
|---|---|---|---|
| R01 | Ask professor-provided questions one at a time (owner, examiner prompt) | Prompt instructions | Session state tests; question order and time limits |
| R02 | Accept spoken responses (owner) | Planned only | Transcription accuracy, correction and accessibility policy |
| R03 | Neutral contextual follow-ups (owner, follow-up prompt) | Prompt designs; no integrated controller | Maximum count; permitted triggers; whether new evidence changes score |
| R04 | Apply professor materials/rubrics; final professor authority (all sources) | Text runner and failing synthetic results | Professor-reviewed expected judgments; no automatic final grades |
| R05 | Support points, percentages, levels, checklists, narrative; equivalent wording/partial credit (owner) | 19 synthetic cases, 4 passes | Define conversions/partial credit; unresolved rules return clarification |
| R06 | Separate assessment from practice (owner, strict prompts) | Harness fixed assessment receipt | Authenticated professor selects rules; student cannot change mode |
| R07 | Preserve examination record (owner, README) | Synthetic experiment files only | Schema, transcript versions, audit events, retention and deletion policy |
| R08 | Instructor/student interfaces and review (README) | Proposed | Workflow/accessibility; who may view rubric, scores and feedback |
| R09 | CIS-controlled Ubuntu; air gap discussed (owner) | Unverified | Is isolation mandatory? hardware, provisioning and external services |
| R10 | Identity verification/authentication (owner, README) | Proposed | Necessary MVP scope, institutional login and approved data handling |
| R11 | TTS / optional avatar (owner, README) | Proposed | Voice needs, consent for likeness, accessibility; avatar deferrable |
| R12 | Four three-week sprints, six teammates (owner) | Planning constraint | Actual dates, responsibilities and client acceptance thresholds |

Additional unresolved decisions: grading agreement targets, workload/concurrency and latency limits; treatment of uncertainty, ambiguous rubrics and student silence; exam interruption/restart; privacy/access policies and approvals. Historical confidence examples are not calibrated and must not drive automatic decisions.

Priority: R04–R06 text foundation first, then R01/R03/R07/R08 session integration, then R02/TTS and deployment validation. Client must confirm final MVP priorities and any mandatory identity/air-gap requirement.
