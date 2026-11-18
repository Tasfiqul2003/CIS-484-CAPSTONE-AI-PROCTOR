# Browser audio playback repair — November17,2026

The user reported repeated indefinite "preparing to speak" screens. Read-only backend checks found successful speech synthesis HTTP200, ready services, an idle database with no query/lock wait and one active unanswered synthetic attempt. The UI previously used the same preparing state for generation and waiting for `HTMLMediaElement.play()`, with a150second playback timeout. The real browser's exact internal state was not directly inspected because no connected Chrome browser automation surface was available. Suspended/blocked playback and a suspended recording-mix AudioContext were reproducible failure modes.

## Repair

- `playExaminerAudio.ts` separates generated audio from browser playback. Automatic playback remains the first action. A visible **Play examiner audio** recovery action invokes both media.play() and the recording mix's resume() synchronously in the same browser gesture. It reuses the same generated clip, retaining its blob URL until completion/cancellation; no second synthesis/model request is made just to recover autoplay.
- The status now distinguishes **Generating examiner audio** from **Audio ready — waiting for browser playback**. Native synthesis fetch/body waits are bounded at45seconds. Browser start is bounded at30seconds, with clear recovery errors, followed by a150second maximum playback watchdog for long clips. Rejected/never-settling play promises cannot start a listening turn or fabricate an answer.
- The recording mixer delays connecting a media element until its AudioContext is running, exposes an explicit gesture resume, and routes examiner audio to both speakers and the recording destination. Cleanup does not stop the original camera/microphone tracks. Listening starts only after playback completion; a clip ending before output readiness fails rather than claiming successful examiner delivery.
- Independent captions, the What the examiner heard panel, existing End exam control, auth/identity/recording/retention gates and professor grading rules remain.

## Safe activation

The repair was initially staged under ignored `.cache/playback-fix/`, including a full virtual-source TypeScript check and browser tests, to avoid hot-reloading the active recording. An attempted combined deployment was rejected by automatic approval review because closing the active attempt had not been explicitly authorized for that occurrence. It did not execute. The user then explicitly approved ending that stalled demo, preserving its available recording and activating the fix.

Only the identified unanswered synthetic attempt was closed, with an administrative authorized-technical-restart event, flagged/incomplete status and normal fresh-attempt eligibility.498 uploaded recording files /40,577,309bytes were copied into protected backup; originals were retained. This is preservation of server-uploaded bytes, not a claim to recover all browser-buffered final frames. A protected database backup and pre-edit source copies were retained. No source migration, student/roster deletion, fabricated answer, fake completion, password change, push or shared deployment occurred.

Protected recovery evidence:`private-data/p3-local/backups/playback_repair_20261117_234334_e227add3/` contains `before_repair.dump`, retained media, `source-before/` and `repair.json`. Keep this ignored/private.

## Measured checks

- Staged full frontend TypeScript check passed before activation; installed `tsc --noEmit` passed afterward.
- New playback recovery browser checks passed: a never-resolving play promise times out without listening; blocked autoplay resumes the same clip once after a real button gesture; a real generated PCM WAV decodes and non-silent examiner audio reaches the actual WebAudio recording mix after unlocking a suspended context. Real device calls0; Chrome audio output muted for the verification.
- Automatic examiner browser:10 groups passed, including blocked playback/no re-synthesis, hung generation timeout, hung playback timeout, caption/recognized-text behavior and existing oral/assistance/cancellation flow.
- StudentExam recording lifecycle:17 synthetic scenarios passed, including normal/early completion and interrupted/late-start protections with the updated mixer API.
- Frontend units:114 passed. Production build and whitespace passed. Existing nonfatal bundle-size advisory remains. Backend code did not change in this repair, so the preceding1046-pass Python/28-pass isolated SQL results remain dated evidence rather than a new run.
- The owned app/backend/database were restarted after the explicitly approved closure. Current readiness passed for backend/frontend/database and external Ollama. FlashHead remains off. Actual proxy source exposes the new recovery action/status. Final read-only state:zero active attempts,53 roster students and26 migration ledger entries.

## User continuation

Start afresh from http://127.0.0.1:5173/student/exams . The old stalled attempt cannot resume and its original available recording remains retained. Normal allowed playback is automatic. If the browser pauses audio, select **Play examiner audio**. Browser gesture recovery cannot universally be eliminated by application code.

Real user speaker output, microphone quality and a complete human exam remain acceptance items. The actual browser engine/codec/mix path was exercised with generated audio and no real microphone/camera capture. No claim is made that every possible browser playback failure is fixed or that the exact previous Chrome state was observed.
