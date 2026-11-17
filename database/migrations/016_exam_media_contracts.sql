-- Additive only. Apply through the existing reviewed migration/backup procedure.
-- Receipt and academic progression are committed atomically under exam_sessions' lock.
CREATE TABLE IF NOT EXISTS exam_answer_operations (
    session_id UUID NOT NULL REFERENCES exam_sessions(id) ON DELETE CASCADE,
    request_id UUID NOT NULL,
    question_sequence_num INTEGER NOT NULL CHECK (question_sequence_num >= 1),
    input_hash TEXT NOT NULL CHECK (length(input_hash) = 64),
    response JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (session_id, request_id)
);
ALTER TABLE interactions ADD COLUMN IF NOT EXISTS answer_input_source TEXT
    CHECK (answer_input_source IN ('typed', 'confirmed_transcript', 'timeout'));
ALTER TABLE interactions ADD COLUMN IF NOT EXISTS answer_revision_id UUID;
ALTER TABLE interactions ADD COLUMN IF NOT EXISTS transcript_draft_id UUID;
ALTER TABLE interactions ADD COLUMN IF NOT EXISTS machine_transcript_draft TEXT;
-- Existing interaction.id identifies the immutable delivered question snapshot.
-- Existing question_text is the delivered text, not a reference to a mutable bank row.
-- Legacy rows keep null provenance and must be labeled unknown.
