-- Store only approved question-output WAVs, never provider payloads or credentials.
CREATE UNIQUE INDEX IF NOT EXISTS interactions_session_identity
    ON interactions(session_id, id);
CREATE TABLE exam_question_audio (
    id UUID PRIMARY KEY,
    session_id UUID NOT NULL REFERENCES exam_sessions(id) ON DELETE CASCADE,
    interaction_id UUID NOT NULL,
    request_id UUID NOT NULL,
    input_hash TEXT NOT NULL CHECK (length(input_hash) = 64),
    text_hash TEXT NOT NULL CHECK (length(text_hash) = 64),
    content_hash TEXT NOT NULL CHECK (length(content_hash) = 64),
    voice TEXT NOT NULL CHECK (voice IN ('calm', 'clear')),
    speed NUMERIC NOT NULL CHECK (speed BETWEEN 0.5 AND 2),
    duration_seconds NUMERIC NOT NULL CHECK (duration_seconds > 0 AND duration_seconds <= 120),
    byte_count INTEGER NOT NULL CHECK (byte_count > 0 AND byte_count <= 10485760),
    status TEXT NOT NULL CHECK (status IN ('ready', 'expired')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    expires_at TIMESTAMPTZ NOT NULL,
    FOREIGN KEY (session_id, interaction_id) REFERENCES interactions(session_id, id) ON DELETE CASCADE,
    UNIQUE (session_id, request_id),
    UNIQUE (session_id, interaction_id, voice, speed)
);
CREATE INDEX exam_question_audio_expiration ON exam_question_audio(expires_at) WHERE status = 'ready';
CREATE TABLE exam_question_audio_requests (
    session_id UUID NOT NULL REFERENCES exam_sessions(id) ON DELETE CASCADE,
    request_id UUID NOT NULL,
    input_hash TEXT NOT NULL CHECK (length(input_hash) = 64),
    asset_id UUID NOT NULL REFERENCES exam_question_audio(id) ON DELETE CASCADE,
    PRIMARY KEY(session_id, request_id)
);
