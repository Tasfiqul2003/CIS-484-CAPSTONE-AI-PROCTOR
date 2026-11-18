# Examiner workspace visual polish

November 17, 2026. Local implementation from the user-provided examiner-screen reference.

Active student exams now use a centered single-column workspace (960px maximum),
a slim header with centered exam title and compact timer chips, rounded examiner
stage with captions control, a clear listening/status region, compact transcript
card, environment settings, camera/live-view disclosure, recovery disclosure and
an End exam action beneath them. Camera and recovery panels remain native details.
Keyboard and FlashHead modes retain their existing controls. The layout has scoped
styles in frontend/src/pages/student/examiner-workspace.css, so admission/recording
consent and professor pages retain their existing layouts. StudentExam DOM order
places the examiner before camera controls; no exam/recording rules were changed.

Verification: automatic spoken-controller suite passed, including environment and
captions/playback checks, plus desktop/390px/760px overflow and stage/transcript
geometry checks. Visual screenshots use the real AutomaticOralExam component with
mocked media/network and a synthetic header/support-panel scaffold; they are not
screenshots of a real student attempt. Desktop and 390px images were inspected.
All 17 actual StudentExam synthetic recording lifecycle scenarios passed, including
interruption, partial save, late startup, automatic completion, early-end cancel,
retry and finalization. All three environment browser groups passed. TypeScript,
production build and whitespace checks passed. Existing bundle-size advisory remains.

Readonly readiness: backend/frontend/Ollama ready, database listening; running Vite
returns 200 for the new stylesheet and avatar status reports enabled=false.
No restart, migration, real exam start, real device capture, FlashHead activation,
commit, push or shared deployment was performed. Existing unrelated local edits
were preserved. User may refresh the local page to see the new layout.
