-- Upgrade main's 014_exam_video_recordings metadata for optional consented
-- capture. Keep existing recordings, counts, expiry and consent history.
ALTER TABLE exam_session_videos
    ALTER COLUMN content_type DROP NOT NULL,
    ALTER COLUMN expires_at DROP NOT NULL,
    ADD COLUMN IF NOT EXISTS failure_reason TEXT CHECK (length(failure_reason) <= 200),
    ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    ADD COLUMN IF NOT EXISTS transcript_status TEXT NOT NULL DEFAULT 'not_requested',
    ADD COLUMN IF NOT EXISTS generated_transcript TEXT;

ALTER TABLE exam_session_videos
    DROP CONSTRAINT IF EXISTS exam_session_videos_status_check;
ALTER TABLE exam_session_videos
    ADD CONSTRAINT exam_session_videos_status_check CHECK (status IN (
        'recording', 'completed', 'permission_denied', 'unavailable',
        'upload_failed', 'interrupted', 'expired'
    ));

ALTER TABLE exam_session_videos
    ADD CONSTRAINT exam_session_videos_transcript_status_check CHECK (
        transcript_status IN ('not_requested', 'awaiting_recording', 'unavailable',
            'completed', 'failed', 'no_recording', 'expired')
    );

CREATE INDEX IF NOT EXISTS idx_exam_session_videos_expiry
    ON exam_session_videos (expires_at) WHERE status <> 'expired';

ALTER TABLE recording_consent_notifications
    DROP CONSTRAINT IF EXISTS recording_consent_notifications_event_check;
ALTER TABLE recording_consent_notifications
    ADD CONSTRAINT recording_consent_notifications_event_check CHECK (
        event_type IN ('recording_declined', 'recording_failed')
    );
