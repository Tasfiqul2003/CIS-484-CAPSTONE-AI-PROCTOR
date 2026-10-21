# Local avatar oral-exam prototype

A standalone, locally hosted prototype of the spoken exam: the student answers out loud in a browser, and an avatar
speaks the next question in the professor's voice with a lip-synced face made from the professor's photo.
It is separate from the rest of the repository (no shared code, no changes to other folders) and does not grade.

## What it does (implemented)

```
browser mic -> faster-whisper small (speech to text)
            -> Qwen3 via Ollama (writes one short follow-up question)
            -> Chatterbox TTS (speaks it in the professor's cloned voice)
            -> SoulX-FlashHead Lite (lip-synced video from the professor's photo)
            -> clips streamed back to the browser
```

- The exam script is fixed (see `QUESTIONS` in `avatar_app.py`). The model only writes one follow-up per question and a
  short reaction; stock lines are used when its output is unusable. It never grades or scores.
- A professor is added on the web page: name, a cropped photo, a 15-30 s voice sample (recorded or uploaded) and a
  consent tick. Nothing is hardcoded to one person. Each professor gets a folder under `profiles/`.
- Student audio is deleted right after transcription. Only the transcript and timings are written to `sessions/`.
- Fixed lines (greeting, questions, closing, stock lines) are pre-rendered per professor and reused after a restart.

## Measured so far (RunPod RTX 2000 Ada, 16 GB; one student, one exam run each)

- Qwen3 8B with everything resident: peak GPU memory 15,759 MiB of about 16,400 MiB. Follow-up turns took about
  9 s from the end of the answer to the first clip on the server; pre-rendered lines about 2 s.
- Qwen3 4B Instruct (`qwen3:4b-instruct`): 16 of 18 follow-ups written by the model on the six sample answers in
  `test_followups.py` (the rest fell back to stock lines). **Memory and timing for the 4B in a full exam are not yet measured.**
- The default `qwen3:4b` tag is a thinking-only model and writes its reasoning aloud; do not use it here.

## Not done / known limits

- No login or access control: anyone who can reach the page can add or delete a professor.
- Consent is a checkbox stored in `profile.json`; there is no audit trail, retention policy or FERPA review.
- Microphone access needs HTTPS. The RunPod proxy provides it; a plain LAN `http://` address does not.
- Fully offline operation (no network after install) has not been tested.
- Student video recording and integration with this repository's backend and database are not built.
- Accent fidelity of the voice clone (for example a non-native accent) is untested.
- Tested on Linux (RunPod, Ubuntu). Not tested on Windows.

## Run it

The scripts expect their files in `/workspace` (copy this folder's contents there on the Pod). `runpod_setup.sh` builds two conda environments (`chatterbox` and `flashhead`), installs Ollama and downloads the models
(about 45 GB free disk needed). Then:

```bash
ollama pull qwen3:4b-instruct
LLM=qwen3:4b-instruct nohup bash start_avatar_chat.sh > app.log 2>&1 &
```

Open the printed URL. Without a GPU, `AVATAR_MOCK=1 WORK=/tmp/avatar python3 avatar_app.py` runs the web flow with
placeholder audio and video. `python test_followups.py qwen3:4b-instruct` checks follow-up quality.

## Licenses of the pieces

faster-whisper (MIT), Qwen3 (Apache-2.0), Chatterbox (MIT), SoulX-FlashHead (Apache-2.0 as published by its authors;
confirm before redistributing). Confirm each license yourself before the team relies on this list.
