CREATE TABLE IF NOT EXISTS exam_session_videos (
    session_id UUID PRIMARY KEY REFERENCES exam_sessions(id) ON DELETE CASCADE,
    status TEXT NOT NULL
        CHECK (status IN ('recording', 'completed', 'expired')),
    content_type TEXT NOT NULL,
    next_chunk_index INTEGER NOT NULL DEFAULT 0
        CHECK (next_chunk_index >= 0),
    total_bytes BIGINT NOT NULL DEFAULT 0
        CHECK (total_bytes >= 0),
    file_name TEXT,
    started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    completed_at TIMESTAMPTZ,
    expires_at TIMESTAMPTZ NOT NULL
);
