-- Persist recording configuration on exam templates.
ALTER TABLE exam_templates
    ADD COLUMN IF NOT EXISTS record_examination BOOLEAN NOT NULL DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS generate_transcript BOOLEAN NOT NULL DEFAULT TRUE;

-- New exam templates default to recording enabled.
-- Existing templates remain disabled until a professor configures them.
ALTER TABLE exam_templates
    ALTER COLUMN record_examination SET DEFAULT TRUE;

-- Snapshot settings and consent state per exam attempt.
-- Existing sessions are marked not_required so they are not prompted retroactively.
ALTER TABLE exam_sessions
    ADD COLUMN IF NOT EXISTS record_examination BOOLEAN NOT NULL DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS generate_transcript BOOLEAN NOT NULL DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS recording_consent_status TEXT NOT NULL DEFAULT 'not_required',
    ADD COLUMN IF NOT EXISTS recording_consent_decided_at TIMESTAMPTZ;

-- Restrict consent state to the supported lifecycle values.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'exam_sessions_recording_consent_status_check'
    ) THEN
        ALTER TABLE exam_sessions
            ADD CONSTRAINT exam_sessions_recording_consent_status_check
            CHECK (
                recording_consent_status IN (
                    'not_required',
                    'pending',
                    'consented',
                    'declined'
                )
            );
    END IF;
END $$;

-- Persistent professor notification when a student declines recording.
-- A unique session constraint prevents duplicate notifications on retries.
CREATE TABLE IF NOT EXISTS recording_consent_notifications (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    professor_id UUID NOT NULL,
    exam_template_id UUID NOT NULL
        REFERENCES exam_templates(id) ON DELETE CASCADE,
    exam_session_id UUID NOT NULL
        REFERENCES exam_sessions(id) ON DELETE CASCADE,
    student_id UUID NOT NULL
        REFERENCES students(id) ON DELETE CASCADE,
    event_type TEXT NOT NULL DEFAULT 'recording_declined',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT recording_consent_notifications_event_check
        CHECK (event_type = 'recording_declined'),
    CONSTRAINT recording_consent_notifications_session_event_unique
        UNIQUE (exam_session_id, event_type)
);

CREATE INDEX IF NOT EXISTS
    idx_recording_consent_notifications_professor_created
ON recording_consent_notifications (professor_id, created_at DESC);
