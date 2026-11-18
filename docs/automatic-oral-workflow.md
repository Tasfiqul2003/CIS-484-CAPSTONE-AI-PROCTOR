# Automatic local oral exam workflow

Local source implementation, November 17, 2026. Nothing committed or pushed.

## Student flow

Existing identity verification, environment selection, recording notice and initial browser permissions remain prerequisites. In full mode the active exam then runs without typing or Submit clicks:

1. Five-second countdown: relax, breathe, answer naturally in your own words.
2. Examiner asks the current delivered question. Listen mode starts only after all speech playback finishes.
3. Microphone capture reuses owned clones of the assessed recording's microphone. Three seconds of silence after speech ends a turn; no speech waits twenty seconds. Capture is capped at110 seconds and10MiB.
4. The configured local speech provider transcribes the audio. Ollama checks intelligibility, separately from academic correctness. A short, incorrect or uncertain answer is still an answer; common admissions such as "I do not know" remain intelligible even if the model disagrees.
5. An unclear or empty turn gets a spoken retry prompt followed by another listening turn. Two retries are allowed; a third unsuccessful turn receives a spoken move-on prompt and records an explicitly unanswered response. Provider, playback and device failures stop for recovery rather than pretending the student was silent.
6. A clear answer submits automatically through the existing idempotent answer transaction. The backend decides whether to ask a follow-up before the next main question, using the professor's saved follow-up limits and remaining exam/question time. Follow-ups run through the same speak/listen loop. Unanswered voice and timeout placeholders do not trigger academic follow-ups.
7. Spoken repeat and clarification commands use saved server assistance allowances and release the reading pause after speech. "Move on", "skip this question" and "next question" move forward without fabricating an academic answer.
8. The existing recording finalization completes the attempt. Keyboard controls remain available under Accessibility and recovery, and error recovery can require interaction.

The countdown does not pause or extend server deadlines. Initial permission prompts and recovery after blocked autoplay still need student interaction. Headphones can reduce speaker-to-microphone bleed. Speech-to-text and RMS silence detection are not speaker verification.

## FlashHead off

FlashHead is only a presentation dependency. When the optional avatar bridge is disabled, the existing static examiner stays visible and authenticated `/speech/utterance` uses the configured native speech provider. Transcription, intelligibility and existing Ollama academic progression continue independently. This native fallback uses installed system voices; it does not clone a professor's uploaded voice.

When the avatar bridge is enabled, the controller plays the service's matching audio/video clips and uses the optional muted idle clip between speaking turns. Real facial-motion quality is not verified in this task. Explicit minimal/offline demo mode retains its existing all-services-off contract; FlashHead-off full mode is independent of that setting. The P3 full launcher already selects full mode with FlashHead excluded.

## Provenance and gates

`automatic_transcript` is a signed machine transcript that has not been student reviewed. It must exactly match its original signed draft. `confirmed_transcript` retains explicit student review. `unanswered_voice` accepts only a fixed server-defined placeholder. Professor review labels each distinctly; original machine drafts remain available.

Migration `021_automatic_oral_transcripts.sql` expands only the interaction source constraint; it does not rewrite answers or existing migration bytes. Readiness requires the new constraint. Existing authentication, current-question correlation, recording admission/retention, deadlines, assistance limits, provisional grading and professor confirmation remain in force. Cancellation discards late results and stops only owned microphone clones.

## Activation status

Activated locally after explicit user approval. Migration021 is applied, the source ledger has26 entries, and the restarted backend exposes both new speech routes. Protected backup/isolated restore/SQL and native speech HTTP checks passed. The blocked attempt and uploaded recording were preserved; only its explicitly authorized technical interruption permits a fresh attempt. Ordinary completion and recording protections remain in force.

Read `automatic-oral-activation-2026-11-17.md` for current measured results, protected recovery locations and the original frontend/backend-version mismatch. Earlier automatic approval rejections are historical and superseded by the user's later explicit approval and completed activation. This record is not permission for future maintenance.

## Verification

Measured results and scope are recorded separately in `automatic-oral-verification-2026-11-17.md`. Synthetic tests exercise no real student devices. Real local provider checks use generated audio and synthetic answers only. A complete human assessed exam and the optional talking-avatar service remain unverified.

## Student controls added November17

See `oral-exam-controls-2026-11-17.md` for the What the examiner heard panel, independent caption overlay/toggle and confirmed End exam action. Captions and ending are optional student controls; normal successful turns still advance automatically. Ending early preserves submitted answers/available recording and leaves the unfinished response unsubmitted.
