-- Durable, bounded offline transcription jobs. Preserve media and consent.
ALTER TABLE exam_session_videos
    ADD COLUMN IF NOT EXISTS transcript_attempts INTEGER NOT NULL DEFAULT 0
        CHECK (transcript_attempts >= 0),
    ADD COLUMN IF NOT EXISTS transcript_job_token UUID,
    ADD COLUMN IF NOT EXISTS transcript_lease_until TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS transcript_error TEXT CHECK (length(transcript_error) <= 200),
    ADD COLUMN IF NOT EXISTS transcript_completed_at TIMESTAMPTZ;

ALTER TABLE exam_session_videos
    DROP CONSTRAINT IF EXISTS exam_session_videos_transcript_status_check;
ALTER TABLE exam_session_videos
    ADD CONSTRAINT exam_session_videos_transcript_status_check CHECK (
        transcript_status IN ('not_requested', 'awaiting_recording', 'unavailable',
            'queued', 'processing', 'completed', 'failed', 'no_recording', 'expired')
    );

CREATE INDEX IF NOT EXISTS idx_exam_speech_transcript_queue
    ON exam_session_videos (transcript_status, transcript_lease_until, completed_at)
    WHERE status = 'completed';
