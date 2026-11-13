# Exam recording and professor review

Assessed exam sessions require camera video and microphone audio. Students see
a recording notice and must grant both permissions before the first question is
shown. Submitted typed answers remain the transcript; microphone transcription
is not currently connected. Developer demo attempts are not recorded.

The browser uploads ordered WebM chunks while the exam is in progress. The
backend writes them to a dedicated local directory and assembles the completed
recording only after the exam ends. A student cannot submit answers while
recording is stopped or its uploads have failed. A professor can review video,
audio, and the saved answer transcript from the owning exam's Student Progress
page; another professor cannot access that session's media.

## Air-gapped server configuration

Apply database migrations `013_student_photo_verification.sql`,
`014_exam_video_recordings.sql`, and `015_block_face_check_overrides.sql` in
numeric order. Mount a **dedicated persistent host volume**
into the backend container and configure:

```text
EXAM_VIDEO_DIR=/var/lib/oral-exam/recordings
EXAM_VIDEO_RETENTION_UNTIL=YYYY-MM-DD
```

Set `EXAM_VIDEO_DIR` to the mounted path and grant write access only to the
backend service account. Do not use a container's writable layer; it is not
durable across container replacement. The retention value must be the
institution-approved semester end date. Date-only values are retained through
23:59:59 UTC on that date. Missing, invalid, or expired configuration, an
unwritable volume, or less than 512 MB free space blocks an assessed exam from
starting.

The repository's Compose file mounts the persistent Docker volume `exam_videos`
at `/var/lib/oral-exam/recordings`. Set `EXAM_VIDEO_RETENTION_UNTIL` in the
Compose environment (for example, in the untracked `.env` file) to the approved
date. Do not run `docker compose down -v` while recordings must be retained;
that command deletes the named volume. The current Compose backend also bind
mounts source code and enables reload, so it is a development stack, not a
hardened production deployment.

Each recording is limited to 512 MB; browser uploads are limited to 10 MB per
chunk. The browser requires a trusted HTTPS origin for camera and microphone
access. The frontend and backend must be served from the same origin (or use
the repository's configured API proxy) so professor cookies protect playback.

Run the cleanup job daily in the backend environment:

```text
python -m app.purge_exam_videos
```

For the repository Compose stack, run the command in a one-off backend
container, with the database running:

```text
docker compose run --rm --no-deps backend python -m app.purge_exam_videos
```

The job removes expired recording files and marks their metadata expired. The
playback endpoint independently refuses access after the configured deadline.
Transcript rows remain in the database; transcript retention is separate and
must follow the institution's policy. Configure the Ubuntu systemd timer or
cron job to use the same mounted volume and database environment as the
backend.

## Limitations

- The exam UI currently records camera and microphone media, but student
  answers are typed. A speech-to-text transcript is not generated; professors
  review the submitted text transcript alongside the audio/video.
- A page refresh or interrupted recording cannot be safely resumed. The attempt
  remains blocked from grading and the student must contact the professor.
- This feature has not been validated on the air-gapped Ubuntu deployment.
  Container volume permissions, disk capacity, certificate trust, migrations,
  backup controls, and scheduled cleanup must be verified there before use.
- Recordings contain sensitive student media. Do not place real recordings in
  source control, test fixtures, or unprotected backups.
