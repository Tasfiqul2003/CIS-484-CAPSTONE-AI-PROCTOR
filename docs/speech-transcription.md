# Local examination speech transcripts

The existing consent and recording implementation stores one combined camera /
microphone WebM in the private `exam_videos` volume. Typed answers remain saved
in `interactions.student_answer_transcript`. The new worker transcribes actual
recorded audio and saves separate timestamped text in
`exam_session_videos.generated_transcript`; it never copies typed answers or
changes grades. Audio can include the examiner and student. No speaker
attribution is claimed. Empty engine output stays empty and is shown as no
speech detected. Machine-generated text needs review against the recording.

## Before starting services

Apply source changes first. Inspect the real schema and migration ledger,
create/verify a fresh database backup, then apply only missing prerequisites
in their correct full-filename order. This feature requires main's 014 media
table, kay's 014 recording settings, 017 recording lifecycle upgrade and new
`018_exam_speech_transcripts.sql`, along with the existing application schema.
Duplicate numeric prefixes exist. Never rerun or edit historical files to
force a migration ledger match. A prepared source package does not apply SQL.

Use the existing backend database, not another development database. Do not
recreate/delete PostgreSQL or recording volumes. Consent/snapshot settings,
grades, typed answers and existing media must be preserved.

Set `EXAM_VIDEO_RETENTION_UNTIL` in your private `.env` to the institution's
approved date or timestamp before recording. Blank retention intentionally
leaves capture unavailable while exams continue. This implementation does not
invent an approved retention period. See [exam-video-review.md](exam-video-review.md).

## Provision a local model on Windows

These explicit setup commands need internet access and download public model
weights. They are separate from the offline transcription process. Model
weights stay outside the checkout and are not included in source control.
Run in PowerShell at the checkout root:

```powershell
$env:EXAM_TRANSCRIPTION_MODELS_DIR = Join-Path $env:USERPROFILE 'CYBROS-models\faster-whisper-base.en'
New-Item -ItemType Directory -Path $env:EXAM_TRANSCRIPTION_MODELS_DIR -Force | Out-Null
docker compose -f docker-compose.yml -f compose.transcription.yaml build transcription-worker
```

Stop if the image build fails. Provision the model with a one-off container:

```powershell
docker compose -f docker-compose.yml -f compose.transcription.yaml run --rm --no-deps `
  -e HF_HUB_OFFLINE=0 -e TRANSFORMERS_OFFLINE=0 -e HF_HOME=/tmp/huggingface `
  -v "${env:EXAM_TRANSCRIPTION_MODELS_DIR}:/model-output" --entrypoint python transcription-worker `
  -c "from huggingface_hub import snapshot_download; snapshot_download(repo_id='Systran/faster-whisper-base.en', local_dir='/model-output', allow_patterns=['model.bin','config.json','tokenizer.json','vocabulary.*','preprocessor_config.json'])"
```

For an offline host, provision/verify that directory on a connected machine,
then transfer it through the approved process. The worker accepts only an
absolute local model directory with `model.bin`, `config.json` and
`tokenizer.json`; additional engine files such as vocabulary must also be
present. It refuses a model identifier instead of silently fetching one.

Save the absolute host path in private `.env` as `EXAM_TRANSCRIPTION_MODELS_DIR`
so it survives a new terminal. Do not commit `.env`. Supported configuration:

| Setting | Default | Meaning |
| --- | --- | --- |
| `EXAM_TRANSCRIPTION_MODELS_DIR` | required | Host model directory for Compose |
| `EXAM_TRANSCRIPTION_MODEL_DIR` | `/models/transcription` in Compose | Local directory inside the worker |
| `EXAM_TRANSCRIPTION_LANGUAGE` | `en` | Speech language code, or `auto` |
| `EXAM_TRANSCRIPTION_CPU_THREADS` | `1` | 1 through 8 CPU engine threads, within the container CPU cap |
| `EXAM_TRANSCRIPTION_TIMEOUT_SECONDS` | `900` | 30 through 7200 seconds per job |
| `EXAM_TRANSCRIPTION_MEMORY_LIMIT` | `1g` | Compose worker memory limit |

The example uses an English `base.en` model, CPU int8 and one CPU core. This
does not require GPU/CUDA or change Ollama. Larger models need their own
resource validation. Non-Compose runs install
`backend/requirements-transcription.txt` in an isolated environment and supply
the same backend DB and private volume configuration; they do not inherit
Compose memory/CPU limits.

## Validate and start

After schema/configuration/model setup, validate synthetic WAV decoding and the
model without reading any private recording:

```powershell
docker compose -f docker-compose.yml -f compose.transcription.yaml run --rm --no-deps transcription-worker python -m app.transcription_worker --check
```

After that succeeds, start only the new worker:

```powershell
docker compose -f docker-compose.yml -f compose.transcription.yaml up -d --no-deps transcription-worker
docker compose -f docker-compose.yml -f compose.transcription.yaml logs --tail 40 transcription-worker
```

Ensure the API/frontend have also loaded the updated source and the base
backend has its persistent video-volume mount. This guide does not select or
change your existing frontend launcher.

On Windows, `scripts/Setup_Speech_Model.ps1 -Apply` performs the guarded
dependency repair, reuses a complete existing model, checks real synthetic
audio, backs up private settings, and starts only the worker. Use
`-NoStartWorker` to provision and test without starting the queue loop. Private
settings select one model thread and a 1 GB memory ceiling. The Compose file
also caps the container at one CPU core; this is a ceiling, not a claim about
measured RAM use. The worker loads the model only for a queued recording and
releases it when that job process exits. No GPU is reserved. The dedicated
worker requirements omit OpenCV and document parsers used by the web backend.

To release the worker's resources when it is not needed:

```powershell
docker compose -f docker-compose.yml -f compose.transcription.yaml stop transcription-worker
```

Start it again with the `up -d --no-deps transcription-worker` command above.
Queued recordings stay in PostgreSQL while it is stopped. A stopped in-flight
job can be reclaimed after its saved lease expires. Playback and typed answers
do not depend on the worker running.

Faster-Whisper 1.2.1 is paired with `av==18.1.0`. PyAV 19 removed the
`metadata_errors` argument used by that Faster-Whisper release; see the
[upstream issue](https://github.com/SYSTRAN/faster-whisper/issues/1589).
Loading model weights alone does not exercise audio decoding. The worker's
`--check` now decodes a synthetic WAV before loading the local model, and the
setup script runs that codec check before model provisioning as well.

The worker uses a PostgreSQL queue, locks each claimed row with `SKIP LOCKED`,
commits a unique lease before processing, and runs at most one decoder job per
worker container. Its child process has a hard wall-clock timeout. Failed jobs
retry after 30 seconds, up to three attempts; crashed workers are reclaimed
after lease expiry. Save operations check the token, expiry and saved consent
again. Text is limited to two million characters and audio to four hours;
Compose additionally limits memory, processes and CPU. Decoding occurs inside
the constrained child; excessive/malformed media may fail or be killed rather
than produce text. These are operational bounds, not codec certification.

Eligible older recordings marked `unavailable` are automatically picked up.
To deliberately retry exhausted failed jobs after fixing their cause:

```powershell
docker compose -f docker-compose.yml -f compose.transcription.yaml run --rm --no-deps transcription-worker python -m app.transcription_worker --retry-failed
```

This only requeues submitted, consented, unexpired recordings with transcription
enabled. It does not alter completed transcripts, grades or consent decisions.

## Verify with synthetic data

Use a synthetic student/exam. Enable Record Examination and Generate Transcript,
start the exam, and verify that recording consent is requested before capture.
Allow capture and speak a known synthetic sentence. Submit the exam. In the
professor's student review, verify private playback, queued/processing/completed
speech status, saved timestamped text, and the `.txt` download. Refresh and
confirm the text persists. Separately decline recording and confirm answers
still save, consent is retained, and no video/speech text is captured. Confirm
another professor and anonymous requests cannot retrieve either artifact.

Whisper package/model/real-codec execution, Docker build/start, PostgreSQL
concurrency and live browser recording need testing on the intended host. Unit
tests with mocked devices, DB and speech engine do not prove those runtime
properties or transcription accuracy.

Primary dependency documentation: [Faster-Whisper 1.2.1](https://pypi.org/project/faster-whisper/1.2.1/)
and [WhisperModel implementation](https://github.com/SYSTRAN/faster-whisper/blob/v1.2.1/faster_whisper/transcribe.py).
