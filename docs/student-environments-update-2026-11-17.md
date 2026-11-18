# Student environments with and without FlashHead

November 17, 2026, P3 local working tree. Existing unrelated edits preserved.

The automatic spoken exam now loads the authorized session presentation independently
of avatar capability and offers an Exam environment selector for professor-permitted
backgrounds. Selection saves through the existing authenticated presentation PUT;
the acknowledged server preferences become the displayed selection and survive reload.
Failed saves preserve the previous selection. Locked policies remain locked. The
selector is also available while the oral interaction is paused. A presentation load
failure offers reload without restarting speech or changing exam progress.

ExamStageAvatar now provides a shared environment viewport around either the static
portrait or supplied video content. Keyboard mode uses this same wrapper for the
FlashHead stage. Changing only a background does not stop browser speech. Automatic
mode retains its media element and oral-loop identity across changes, so it does not
restart the question, acquire devices, submit answers, or begin listening early.
Custom background data and visible failed-image fallback use the existing renderer.

FlashHead clips remain opaque where their generated pixels are opaque. The selected
environment surrounds the video; this change does not perform segmentation or replace
the background inside generated footage. FlashHead remains disabled on P3.

## Measured verification

- Automatic oral browser suite passed, including five distinct backgrounds with
  FlashHead capability on/off, persistence after reload, failed save preservation,
  professor locks, mobile bounds, static portrait visibility, retained media element,
  and unchanged play-call counts during selection. Existing controller checks passed.
- Live presentation browser suite passed: saved-audio/browser speech controls plus
  all five backgrounds in keyboard mode with static and supplied synthetic video
  stages, and persistence after reload.
- Environment browser suite passed all three groups: preview, policy/custom fallback,
  and actual StudentExam mocked demo answer retry isolation. Its historical fixture
  now explicitly opens accessibility recovery and selects keyboard controls.
- 114 frontend unit tests passed; TypeScript, production build and git diff --check
  passed. Build retains its existing bundle-size advisory.
- Readonly local readiness: frontend, backend, database and externally owned Ollama
  ready. GET of the running Vite automatic-exam module returned 200 and contained
  the new selector. No service restart, migration, device capture, real student exam,
  FlashHead service activation, push or shared deployment was performed.

Synthetic screenshots: .cache/environment-captions.png and
.cache/environment-captions-flashhead.png. The latter uses mocked clips and establishes
layout/controller behavior only; no real FlashHead rendering is claimed.
