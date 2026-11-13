ALTER TABLE students
    ADD COLUMN IF NOT EXISTS official_photo BYTEA;

CREATE TABLE IF NOT EXISTS student_face_verifications (
    student_id UUID PRIMARY KEY REFERENCES students(id) ON DELETE CASCADE,
    attempt_count SMALLINT NOT NULL DEFAULT 0
        CHECK (attempt_count BETWEEN 0 AND 3),
    status TEXT NOT NULL
        CHECK (status IN ('no_match', 'matched')),
    last_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE exam_sessions
    ADD COLUMN IF NOT EXISTS identity_check_completed BOOLEAN NOT NULL DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS identity_review_required BOOLEAN NOT NULL DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS identity_verification_attempts SMALLINT NOT NULL DEFAULT 0
        CHECK (identity_verification_attempts BETWEEN 0 AND 3);
