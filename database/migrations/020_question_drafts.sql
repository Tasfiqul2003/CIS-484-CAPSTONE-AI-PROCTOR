-- AI-generated proposals are isolated from the approved question bank.
CREATE TABLE IF NOT EXISTS question_generation_requests (
    exam_template_id UUID NOT NULL REFERENCES exam_templates(id) ON DELETE CASCADE,
    request_id UUID NOT NULL,
    professor_id UUID NOT NULL REFERENCES professors(id),
    input_hash TEXT NOT NULL CHECK (length(input_hash) = 64),
    context_hash TEXT NOT NULL CHECK (length(context_hash) = 64),
    status TEXT NOT NULL CHECK (status IN ('generating', 'ready', 'failed')),
    error_code TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    lease_expires_at TIMESTAMPTZ NOT NULL,
    completed_at TIMESTAMPTZ,
    PRIMARY KEY (exam_template_id, request_id)
);

CREATE TABLE IF NOT EXISTS question_drafts (
    id UUID PRIMARY KEY,
    exam_template_id UUID NOT NULL REFERENCES exam_templates(id) ON DELETE CASCADE,
    request_id UUID NOT NULL,
    professor_id UUID NOT NULL REFERENCES professors(id),
    question_text TEXT NOT NULL CHECK (length(question_text) BETWEEN 1 AND 4000),
    topic TEXT NOT NULL CHECK (length(topic) BETWEEN 1 AND 200),
    difficulty SMALLINT NOT NULL CHECK (difficulty BETWEEN 1 AND 5),
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
    approved_question_id UUID REFERENCES questions(id) ON DELETE SET NULL,
    approval_hash TEXT CHECK (approval_hash IS NULL OR length(approval_hash) = 64),
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    reviewed_at TIMESTAMPTZ,
    FOREIGN KEY (exam_template_id, request_id)
        REFERENCES question_generation_requests(exam_template_id, request_id) ON DELETE CASCADE,
    CHECK ((status = 'approved' AND approval_hash IS NOT NULL)
        OR (status != 'approved' AND approval_hash IS NULL AND approved_question_id IS NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS question_drafts_approved_question
    ON question_drafts(approved_question_id) WHERE approved_question_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS question_drafts_exam_status ON question_drafts(exam_template_id, status, created_at);
