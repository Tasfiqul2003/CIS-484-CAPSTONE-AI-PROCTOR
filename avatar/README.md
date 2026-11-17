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

## Blackwell (verified)

The stack runs unchanged on Blackwell, so nothing needs rebuilding for a Blackwell box. Checked on a RunPod
RTX 5090 (32 GB, driver 595.91.07) against the same `/workspace/avatar` folder the Ada pod uses:

| Piece | Result |
| --- | --- |
| PyTorch in both conda envs | `2.7.1+cu128`, device capability `(12, 0)`, a matmul runs |
| FlashHead render worker | Loads, and renders a clip |
| Chatterbox | Synthesises speech |
| faster-whisper (CTranslate2, its own CUDA kernels, not PyTorch's) | Transcribes |

What this does **not** establish: the 5090 has 32 GB. On a 16 GB card the stack peaks around 13.8 GB with
everything resident, so fitting beside another team's job is a separate question. Timings from a 5090 say
nothing about a 70 W card either.

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

## Timing log

Every step is written to `logs/timings.csv` in the avatar folder (`/workspace/avatar/logs/timings.csv` on the Pod;
set `TIMING_LOG` to move it). The exam backend writes its model calls to the same file when its `TIMING_LOG` points
there, which `pod_exam_stack.sh` does. Columns: time (UTC on the Pod), service, component, seconds, GPU memory used
and total in MiB (whole GPU, from `nvidia-smi`), and a short note.

| Component | What it measures |
| --- | --- |
| `speech-to-text (Whisper)` | Transcribing one spoken answer. The note has the word count only, never the words. |
| `model: follow-up question` | The one model call after an answer. |
| `voice (Chatterbox)` / `video (FlashHead)` | Making one sentence's audio and video. |
| `clip made ahead of time` | A sentence that needed no work because its clip already existed. |
| `wait until the examiner starts` | From the speak request to the first clip: what the student feels. |
| `whole spoken turn` | From the speak request to the last clip. |
| `made ahead of time` | A question or stock line rendered in the background before it was needed. |
| `avatar loaded` | Switching to a professor's avatar. |
| `model: AI assessment`, `model: clarify help` | The other model calls. |

Exam questions and the stock lines are rendered ahead of time when a professor chooses their avatar and when a
student starts an exam, one sentence at a time while no student is waiting on a live clip. Only follow-up questions,
which depend on the student's answer, are rendered live.

## What is kept on disk

| Path | Holds | Kept for |
| --- | --- | --- |
| `profiles/<id>/photo.jpg`, `voice.wav` | The professor's photo and voice sample | Until the profile is deleted |
| `avatar_media/pre_<id>_*.mp4`, `idle_<id>_*.mp4` | Lines and the idle loop made ahead of time | Until the profile is deleted |
| `avatar_media/*.mp4` (anything else) | One-off clips: follow-ups, assistance replies, previews | 60 minutes (`MEDIA_TTL_MINUTES`) |
| Student audio | — | Never written; deleted as soon as Whisper has read it |

The examiner loops a clip of the professor saying nothing between questions. It is rendered from silence, so
anything the model does once comes round every loop: `IDLE_SECONDS` (default 14) sets how long it is, and
`IDLE_TRIM_SECONDS` (default 1.5) drops the opening, where FlashHead is still settling. The length is in the
file name, so changing either value makes a new clip and deletes the old one. Raise `IDLE_SECONDS` if a
movement still reads as a tic.

The raw voice upload (`voice_in.bin`) is deleted once ffmpeg has converted it, and the conversion drops any
video track, so a professor who uploads an MP4 leaves only audio behind. One-off clips are swept every ten
minutes and at startup; the lines made ahead of time are reused every exam, so they stay.

## Licenses of the pieces

- faster-whisper (MIT) and its Systran small model (MIT)
- Qwen3 (Apache-2.0)
- Chatterbox (MIT). It adds a PerTh watermark to generated audio.
- SoulX-FlashHead code (Apache-2.0)

**Open question: FlashHead Lite.** Its weights include the LTX-Video 0.9 VAE, which the authors list
under Open-RAIL-M and say must not be relicensed. The LTX 0.9 license text we read limits use to
academic or research purposes, and it prohibits publishing AI-generated content without a
disclaimer that it is machine-generated. Whether classroom use at JMU fits has not been decided.
FlashHead Pro uses a different encoder (Wan 2.1) and is described as fully Apache-2.0. We have not
tested whether Pro fits on a 16 GB GPU. Get Dr. Babik's or JMU's confirmation before relying on Lite.
