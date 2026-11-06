# Developer demo substitutes — November 5, 2026

Implemented on `developer-mode`. These are labeled substitutes for optional
AI/media services and missing exam content. Core database, schema, sign-in,
professor ownership, publication and student roster checks remain required.

## Implemented behavior

- Only the exact backend environment value `DEVELOPER_DEMO_MODE=1` enables
  substitutes. The dedicated developer Compose backend supplies it. Other Compose
  configurations do not enable it. `/developer/capabilities` reports availability
  without model generation or downloads; the frontend keeps demo controls off if
  this request fails or an older backend does not support it.
- Migration `012_developer_demo_sessions.sql` adds a durable boolean marker,
  defaulting existing attempts to false. Every new attempt started while the flag
  is enabled snapshots true. Existing unmarked attempts cannot gain substitutes
  from a later flag change. The marker stays visible after the flag is disabled;
  new substitute generation requires the flag and the saved marker.
- Demo questioning uses remaining professor-authored questions first. When none
  are available, it tries the configured model if installed and reachable. Missing
  or unusable model output can become fixed `[Developer demo]` sample questions.
  Saved follow-up limits, question ordering, timing and maximum question counts
  still apply. Streaming output still waits for the turn to commit.
- Permitted assistance can use labeled, non-assessing sample text when AI is
  unavailable. Mode permissions, quotas, request identity and bounded timer pauses
  are unchanged. Disabled help remains disabled. Repeat reads the exact question.
- A sample answer button fills only an empty answer field in a marked demo
  attempt while demo mode is enabled. The inserted text identifies itself as a
  typed sample, not a recording. Camera messaging explicitly describes a static
  placeholder with no capture or identity matching. The existing on-screen
  examiner and optional standard browser speech remain available; readable text
  is the voice fallback. External transcription, avatar video, voice cloning and
  recording providers are not represented as connected.
- Start/resume, submission/progress and report responses expose the saved marker.
  The exam and completion screens label demos; professor progress labels them and
  excludes them from the awaiting-review count. Both grade generation and grade
  confirmation reject demo attempts, even after the runtime flag is disabled.
- Real cached material summaries take precedence. An unavailable AI summary can
  return a labeled source excerpt with `demo:true,persisted:false`. The preview
  attaches it only to the matching material, and no substitute is stored in the
  course-material summary used for exam context.
- The developer launcher warns and continues after optional Ollama startup,
  model-availability or connectivity failures. An owned AI process exiting no
  longer stops core services. Core startup failures remain errors. No model is
  downloaded. The original Word startup guide is preserved; current behavior is
  described in the Markdown startup reference.
- Completion feedback now sends the existing session-scoped token. Display marker
  and current token keys are cleared when the student ends or changes identity.

All backend deployments using this code need migration 012, including backends
with demo mode disabled. The dedicated developer migration runner applies it
automatically. This verification did not modify the user's existing database.

## Measured checks

Final checks on November 5, 2026:

| Check | Actual result |
| --- | --- |
| Full synthetic backend pytest suite | 402 passed; 117 dependency deprecation warnings |
| Root Python unittest discovery | 87 passed, including 48 developer-launcher regressions |
| Frontend non-browser Node tests | 82 passed, including capability failure handling and transient preview isolation |
| TypeScript and Vite production build | Passed |
| Git whitespace check | Passed |
| Fresh in-memory PGlite/PostgreSQL-compatible schema | All 16 SQL files applied successfully, including migration 012 |

The browser used the actual frontend and FastAPI backend against a separate,
in-memory database containing only synthetic professor/student/exam records. No
existing local account, exam data or database settings were opened or changed.
Ollama and external media providers were unavailable.

Observed browser flow: synthetic roster lookup; explicitly labeled camera
placeholder; published exam with an empty question bank; two labeled sample
questions bounded by the saved follow-up rule; clarification sample with its use
consumed; reload retaining demo status, remaining allowance and countdown; labeled
sample answer; completion marked no grading; authenticated feedback saved; return
home. Keyboard Tab reached the sample-answer button with a visible focus outline
and a measured 44px minimum height.

Camera, live-demo and submission views were checked at 320, 375, 768, 1024, 1440
and 1920 CSS px with 900px height. All 18 final page/width combinations had no
page-level horizontal overflow. The initial camera check exposed a fixed-width
preview at 320/375; it was changed to fit its container and rechecked at all six
widths. Demo notice text measured 16px with the existing purple theme. Temporary
viewport changes were reset and the QA tab was closed afterward.

Separate API checks against this same synthetic database confirmed unauthenticated
progress returned 401, authenticated progress/report retained the demo marker,
both grading endpoints returned 409, zero grade records existed, two question
records existed, feedback was saved, and the demo excerpt left the saved summary
empty. The initial upload assertion was corrected to the existing endpoint's
201 Created contract; the completed API check passed.

## Limits of this evidence

These results do not establish live model quality, real audio output,
transcription, avatar video, camera recording, identity verification, PostgreSQL
request concurrency or production reliability. Native 200% browser zoom and a
complete accessibility audit were not measured in this run. The professor's
transient material preview and progress labels were verified through API/helper
checks and source review, not a signed-in professor browser walkthrough. Normal
runtime behavior and durable flag-off isolation were checked with synthetic
backend regressions; no ordinary live deployment was changed. Test services were
stopped after verification; no push, publication or branch merge was performed.
