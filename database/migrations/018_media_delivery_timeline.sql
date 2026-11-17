-- Durable observations, separate from academic attempt progression. Additive only.
CREATE UNIQUE INDEX IF NOT EXISTS interactions_session_identity
    ON interactions(session_id, id);
CREATE TABLE IF NOT EXISTS exam_media_events (
    session_id UUID NOT NULL REFERENCES exam_sessions(id) ON DELETE CASCADE,
    event_id UUID NOT NULL,
    event_order BIGINT GENERATED ALWAYS AS IDENTITY NOT NULL,
    interaction_id UUID NOT NULL,
    question_sequence_num INTEGER NOT NULL CHECK (question_sequence_num >= 1),
    kind TEXT NOT NULL CHECK (kind IN (
        'question_presented', 'question_audio_started', 'question_audio_ended',
        'question_audio_failed', 'student_response_submitted',
        'recording_interrupted', 'recording_ended')),
    source TEXT NOT NULL CHECK (source IN ('student', 'server')),
    asset_id UUID,
    media_offset_seconds DOUBLE PRECISION,
    reported_media_offset_seconds DOUBLE PRECISION,
    offset_status TEXT NOT NULL CHECK (offset_status IN ('reported', 'missing', 'out_of_order')),
    offset_basis TEXT NOT NULL DEFAULT 'client_recording_elapsed_seconds'
        CHECK (offset_basis = 'client_recording_elapsed_seconds'),
    payload_hash TEXT NOT NULL CHECK (length(payload_hash) = 64),
    received_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (session_id, event_id),
    FOREIGN KEY (session_id, interaction_id) REFERENCES interactions(session_id, id) ON DELETE CASCADE,
    CHECK (media_offset_seconds IS NULL OR (media_offset_seconds >= 0 AND media_offset_seconds <= 86400)),
    CHECK (reported_media_offset_seconds IS NULL OR (reported_media_offset_seconds >= 0 AND reported_media_offset_seconds <= 86400)),
    CHECK (kind = 'student_response_submitted' OR source = 'student'),
    CHECK (kind != 'student_response_submitted' OR source = 'server'),
    CHECK (asset_id IS NULL OR kind IN ('question_audio_started', 'question_audio_ended', 'question_audio_failed'))
);
CREATE INDEX IF NOT EXISTS exam_media_events_attempt_order
    ON exam_media_events(session_id, event_order);

