-- Immutable presentation policy for new attempts; legacy NULL uses frozen v0 defaults.
-- Personal preferences are separate from policy, exam timers, ODS, and assistance use.
-- The migration runner owns the transaction; preserve previous migration files.
ALTER TABLE exam_sessions ADD COLUMN avatar_policy_snapshot JSONB
    CHECK (avatar_policy_snapshot IS NULL OR jsonb_typeof(avatar_policy_snapshot) = 'object');
ALTER TABLE exam_sessions ADD COLUMN avatar_policy_revision INTEGER NOT NULL DEFAULT 0
    CHECK (avatar_policy_revision >= 0);
ALTER TABLE exam_sessions ADD COLUMN avatar_preferences JSONB NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(avatar_preferences) = 'object');
ALTER TABLE exam_avatar_policies ADD COLUMN exam_mode TEXT NOT NULL DEFAULT 'assessed'
    CHECK (exam_mode IN ('practice', 'assessed'));
ALTER TABLE exam_sessions ADD COLUMN avatar_exam_mode TEXT NOT NULL DEFAULT 'assessed'
    CHECK (avatar_exam_mode IN ('practice', 'assessed'));
ALTER TABLE interactions ADD COLUMN avatar_root_sequence INTEGER
    CHECK (avatar_root_sequence IS NULL OR avatar_root_sequence >= 1);
ALTER TABLE interactions ADD COLUMN avatar_followup_index INTEGER NOT NULL DEFAULT 0
    CHECK (avatar_followup_index BETWEEN 0 AND 5);

-- Reservations and results survive reloads; the session row serializes grants.
-- Pauses are bounded processing plus reading windows, ended early by completion.
CREATE TABLE avatar_assistance_requests (
    session_id UUID NOT NULL REFERENCES exam_sessions(id) ON DELETE CASCADE,
    interaction_id UUID NOT NULL REFERENCES interactions(id) ON DELETE CASCADE,
    request_id UUID NOT NULL,
    action TEXT NOT NULL CHECK (action IN ('repeat', 'clarification', 'hint', 'explanation', 'correctness')),
    input_hash TEXT NOT NULL CHECK (length(input_hash) = 64),
    status TEXT NOT NULL CHECK (status IN ('reserved', 'succeeded', 'failed')),
    response JSONB CHECK (response IS NULL OR jsonb_typeof(response) = 'object'),
    error_text TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    pause_started_at TIMESTAMPTZ,
    pause_until TIMESTAMPTZ,
    pause_ended_at TIMESTAMPTZ,
    PRIMARY KEY (session_id, request_id),
    CHECK ((pause_started_at IS NULL AND pause_until IS NULL AND pause_ended_at IS NULL)
        OR (pause_started_at IS NOT NULL AND pause_until IS NOT NULL
            AND pause_until >= pause_started_at
            AND pause_until <= pause_started_at + INTERVAL '120 seconds'
            AND (pause_ended_at IS NULL OR pause_ended_at BETWEEN pause_started_at AND pause_until)))
);
CREATE INDEX idx_avatar_assistance_question ON avatar_assistance_requests (session_id, interaction_id, action, status);

-- Future imports preserve file order even when a batch shares one created_at.
-- Original legacy batch order cannot be recovered; this backfill is deterministic.
ALTER TABLE questions ADD COLUMN avatar_authored_position BIGINT
    CHECK (avatar_authored_position IS NULL OR avatar_authored_position >= 1);
WITH ranked AS (
    SELECT id, ROW_NUMBER() OVER (PARTITION BY exam_template_id ORDER BY created_at, id) AS authored_position
    FROM questions
)
UPDATE questions SET avatar_authored_position = ranked.authored_position
FROM ranked WHERE questions.id = ranked.id;
CREATE UNIQUE INDEX idx_questions_avatar_authored_position
    ON questions (exam_template_id, avatar_authored_position);
