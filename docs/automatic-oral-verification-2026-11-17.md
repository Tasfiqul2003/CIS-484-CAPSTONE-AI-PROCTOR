# Automatic oral workflow verification — November 17, 2026

Current activation status: migration and restart are now complete after explicit user approval; see `automatic-oral-activation-2026-11-17.md`. The pending-activation section below records the earlier state, not the current deployment.

## Scope and delivery

Local, uncommitted source edits on existing `paulo`, retaining the checkout's earlier uncommitted work. No fetch, merge, commit, push, shared deployment, dependency installation, real device acquisition, real exam start or grading confirmation occurred in this task. Implementation contract: `automatic-oral-workflow.md`.

New files: `frontend/src/components/exam/AutomaticOralExam.tsx`, `oralCapture.ts`, `automatic-oral-exam.css`, migration021 and the dedicated automatic-exam/backend/capture browser tests. Existing student orchestration, speech routes, answer validation, developer capability display, professor provenance labels and readiness were extended.

## Measured checks

| Check | Result and limits |
| --- | --- |
| Complete offline Python suite | 993 passed,13 gated skips,143 subtests passed in43.69seconds. Real PostgreSQL/model opt-in tests are gated; no source DB test rows are inserted. |
| Frontend unit suite |113 passed,0 failed,0 skipped across14 Node unit files. |
| Automatic controller browser |8 groups passed: placeholder audio; question/follow-up loops; unclear retries; silent/explicit skip; spoken assistance/limits/pause completion; provider/device error; cancellation/late result; matching FlashHead clip playback. All network, media playback and capture are synthetic. |
| Actual capture helper in browser | Passed speech/pause capture,20-second silence, abort and muted-track failure with generated levels/fake tracks. All4 owned clones/audio contexts released, original assessed track remained live, zero device requests. |
| StudentExam recording browser |12 synthetic scenarios passed, including the new automatic answer -> existing idempotent submit -> recording finalization handoff without typing or Submit click. Earlier interruption/late-start/upload protections remain covered. Child automatic controller is mocked in this orchestration suite; tested separately above. |
| TypeScript |`tsc --noEmit` passed on final source. |
| Production Vite build | Passed into ignored `.cache/automatic-oral-build`; existing tracked `frontend/dist` preserved. Existing nonfatal bundle-size advisory remains. |
| Whitespace and migration plan |`git diff --check` passed; migration plan parsed26 catalog files, including new021, without starting services or applying anything. |
| Native Windows audio independent of avatar | Actual generated WAV synthesis passed:116,366 bytes,3.63 seconds. Native transcription of that generated WAV returned nonempty text. This checks provider availability/codec flow, not human recognition accuracy or voice cloning. No real microphone used. |
| Actual local Ollama intelligibility | Clear synthetic answer -> clear; generated nonsense -> unclear. Initial uncertainty case was wrongly classified unclear; added explicit recognition of common admissions of uncertainty. Actual post-fix "I do not know" -> clear. Ollama was still called. No avatar service used. |
| Visual check | Generated placeholder/listening screenshot inspected at ignored `.cache/automatic-oral-placeholder.png`. This is a synthetic component view, not a live authenticated exam walkthrough. |

The complete historical browser matrix is not claimed green. Known older pre-main navigation/avatar-policy fixture failures described in `p3-main-update-2026-11-17.md` were not rewritten as part of this task.

## Pending activation and important limitations

The live source ledger had25 entries and zero active attempts at the read-only pre-activation check. Backend/frontend/database and external Ollama were ready. The proposed owned-service stop -> protected backup -> isolated restore/migration/contracts -> local migration -> restart was rejected by automatic approval review before command execution, because local source-edit authorization did not explicitly include service interruption and durable database changes. No workaround/retry was attempted.

Migration021 remains unapplied. The newly extended real PostgreSQL provenance/replay contract cases are prepared but not executed here; they run in the isolated upgrade check after approval. The source readiness guard now refuses the old transcript constraint after a future backend restart, preventing an incomplete upgrade from being advertised ready. Existing running processes were not restarted by this task. Activation remains the concrete approval step.

Full mode with FlashHead off uses the installed system speech voice, not a clone of a professor's uploaded sample. The avatar branch uses the optional service's synchronized clips; its real facial movement, performance and professor-cloned voice were not tested. Real student camera/microphone use, speaker/room-noise quality, autoplay behavior on student devices and a complete human assessed attempt still need acceptance testing. The short RMS quiet detector can confuse ambient speech with an answer and cannot verify speaker identity. No change claims reliable proctoring or automatic final grades.

Browser permission prompts, recording/identity prerequisites and error recovery still require explicit interaction. Normal successful full-mode turns need no typing or button presses. The settling countdown and local provider processing do not extend the authoritative exam deadlines. Explicit minimal offline mode intentionally remains separate from FlashHead-off full mode.
