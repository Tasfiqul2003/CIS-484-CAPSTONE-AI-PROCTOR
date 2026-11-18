# Local publication preparation - November 17, 2026

The user requested publishing all current local application work to GitHub branch
paulo. This includes the existing compatible main merge plus automatic oral turns,
Windows speech fallback independent of FlashHead, captions/recognized-speech panels,
End exam and playback recovery, synthetic developer admission, exam-start repairs,
student environment selection, and student/professor replay layout polish. The
synthetic roster CSV is an example only; no live roster, session, media or database
is included. Existing source changes and historical prompt baselines were preserved.

Pre-publication checks: full offline Python regression 1046 passed, 24 gated skips,
143 subtests passed. Frontend units 114 passed. Saved replay browser suite 12/12;
automatic oral controller/layout, live-presentation audio/environment, and environment
preview/StudentExam retry browser suites passed. TypeScript and production build
passed. Existing bundle-size advisory remains. Recording lifecycle 17/17 passed in
the preceding unchanged-layout verification. These tests use synthetic fixtures;
real microphone/speaker/full human-exam acceptance remains separate. Historical
main-navigation browser-matrix limits remain recorded in p3-main-update-2026-11-17.md.

Publication file audit excluded protected settings, credentials, database/backups,
recordings, dependencies and models. No matching configured local credential was
found in candidate source/docs/tests. Migration021 has an explicit Git byte-preserving
attribute because the application uses hashed migrations. Publication does not
start/restart services, apply migrations, activate FlashHead or deploy shared servers.

Professor replay polish uses scoped exam-review.css for settings-style cards,
icons, control spacing and responsive recording/transcript placement. Synthetic
screenshot evidence was captured in the separate context workspace; it is not
real-student acceptance evidence and is not needed by the application runtime.
