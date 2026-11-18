BEGIN;

-- Overall and per-question timing.
ALTER TABLE exam_sessions
    ADD COLUMN IF NOT EXISTS time_limit_minutes INTEGER;

UPDATE exam_sessions s
SET time_limit_minutes = t.time_limit_minutes
FROM exam_templates t
WHERE s.exam_template_id = t.id
  AND s.time_limit_minutes IS NULL
  AND t.time_limit_minutes IS NOT NULL;

ALTER TABLE exam_templates
    ADD COLUMN IF NOT EXISTS question_time_limit_minutes INTEGER;

ALTER TABLE exam_sessions
    ADD COLUMN IF NOT EXISTS question_time_limit_minutes INTEGER;

-- Extended-time accommodations.
ALTER TABLE exam_roster
    ADD COLUMN IF NOT EXISTS extended_time_multiplier NUMERIC(3,2);

ALTER TABLE exam_sessions
    ADD COLUMN IF NOT EXISTS extended_time_multiplier NUMERIC(3,2)
    NOT NULL DEFAULT 1;

-- Avatar policy configuration.
CREATE TABLE IF NOT EXISTS exam_avatar_policies (
    exam_template_id UUID PRIMARY KEY
        REFERENCES exam_templates(id) ON DELETE CASCADE,
    settings JSONB NOT NULL
        CHECK (jsonb_typeof(settings) = 'object'),
    revision INTEGER NOT NULL DEFAULT 1
        CHECK (revision >= 1),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE exam_avatar_policies
    ADD COLUMN IF NOT EXISTS exam_mode TEXT NOT NULL DEFAULT 'assessed';

ALTER TABLE exam_sessions
    ADD COLUMN IF NOT EXISTS avatar_policy_snapshot JSONB,
    ADD COLUMN IF NOT EXISTS avatar_policy_revision INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS avatar_preferences JSONB NOT NULL DEFAULT '{}'::jsonb,
    ADD COLUMN IF NOT EXISTS avatar_exam_mode TEXT NOT NULL DEFAULT 'assessed';

-- Interaction presentation tracking.
ALTER TABLE interactions
    ADD COLUMN IF NOT EXISTS avatar_root_sequence BIGINT,
    ADD COLUMN IF NOT EXISTS avatar_followup_index INTEGER NOT NULL DEFAULT 0;

-- Persisted avatar assistance requests.
CREATE TABLE IF NOT EXISTS avatar_assistance_requests (
    session_id UUID NOT NULL REFERENCES exam_sessions(id) ON DELETE CASCADE,
    interaction_id UUID NOT NULL REFERENCES interactions(id) ON DELETE CASCADE,
    request_id UUID NOT NULL,
    action TEXT NOT NULL CHECK (
        action IN ('repeat', 'clarification', 'hint', 'explanation', 'correctness')
    ),
    input_hash TEXT NOT NULL CHECK (length(input_hash) = 64),
    status TEXT NOT NULL CHECK (status IN ('reserved', 'succeeded', 'failed')),
    response JSONB CHECK (
        response IS NULL OR jsonb_typeof(response) = 'object'
    ),
    error_text TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    pause_started_at TIMESTAMPTZ,
    pause_until TIMESTAMPTZ,
    pause_ended_at TIMESTAMPTZ,
    PRIMARY KEY (session_id, request_id),
    CHECK (
        (pause_started_at IS NULL AND pause_until IS NULL AND pause_ended_at IS NULL)
        OR (
            pause_started_at IS NOT NULL
            AND pause_until IS NOT NULL
            AND pause_until >= pause_started_at
            AND pause_until <= pause_started_at + INTERVAL '120 seconds'
            AND (
                pause_ended_at IS NULL
                OR pause_ended_at BETWEEN pause_started_at AND pause_until
            )
        )
    )
);

CREATE INDEX IF NOT EXISTS idx_avatar_assistance_question
    ON avatar_assistance_requests (session_id, interaction_id, action, status);

-- Deterministic authored question ordering.
ALTER TABLE questions
    ADD COLUMN IF NOT EXISTS avatar_authored_position BIGINT;

WITH ranked AS (
    SELECT
        id,
        ROW_NUMBER() OVER (
            PARTITION BY exam_template_id
            ORDER BY created_at, id
        ) AS authored_position
    FROM questions
)
UPDATE questions q
SET avatar_authored_position = ranked.authored_position
FROM ranked
WHERE q.id = ranked.id
  AND q.avatar_authored_position IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_questions_avatar_authored_position
    ON questions (exam_template_id, avatar_authored_position);

-- Developer demo marker. All existing attempts remain assessed.
ALTER TABLE exam_sessions
    ADD COLUMN IF NOT EXISTS developer_demo BOOLEAN NOT NULL DEFAULT FALSE;

-- Timing constraints.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'exam_templates'::regclass
          AND conname = 'exam_templates_question_time_limit_check'
    ) THEN
        ALTER TABLE exam_templates
            ADD CONSTRAINT exam_templates_question_time_limit_check
            CHECK (
                question_time_limit_minutes IS NULL
                OR question_time_limit_minutes BETWEEN 1 AND 240
            );
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'exam_sessions'::regclass
          AND conname = 'exam_sessions_question_time_limit_check'
    ) THEN
        ALTER TABLE exam_sessions
            ADD CONSTRAINT exam_sessions_question_time_limit_check
            CHECK (
                question_time_limit_minutes IS NULL
                OR question_time_limit_minutes BETWEEN 1 AND 240
            );
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'exam_roster'::regclass
          AND conname = 'exam_roster_extended_time_check'
    ) THEN
        ALTER TABLE exam_roster
            ADD CONSTRAINT exam_roster_extended_time_check
            CHECK (
                extended_time_multiplier IS NULL
                OR extended_time_multiplier IN (1.25, 1.5, 2, 3)
            );
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'exam_sessions'::regclass
          AND conname = 'exam_sessions_extended_time_check'
    ) THEN
        ALTER TABLE exam_sessions
            ADD CONSTRAINT exam_sessions_extended_time_check
            CHECK (extended_time_multiplier IN (1, 1.25, 1.5, 2, 3));
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'exam_sessions'::regclass
          AND conname = 'exam_sessions_avatar_policy_snapshot_check'
    ) THEN
        ALTER TABLE exam_sessions
            ADD CONSTRAINT exam_sessions_avatar_policy_snapshot_check
            CHECK (
                avatar_policy_snapshot IS NULL
                OR jsonb_typeof(avatar_policy_snapshot) = 'object'
            );
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'exam_sessions'::regclass
          AND conname = 'exam_sessions_avatar_policy_revision_check'
    ) THEN
        ALTER TABLE exam_sessions
            ADD CONSTRAINT exam_sessions_avatar_policy_revision_check
            CHECK (avatar_policy_revision >= 0);
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'exam_sessions'::regclass
          AND conname = 'exam_sessions_avatar_preferences_check'
    ) THEN
        ALTER TABLE exam_sessions
            ADD CONSTRAINT exam_sessions_avatar_preferences_check
            CHECK (jsonb_typeof(avatar_preferences) = 'object');
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'exam_sessions'::regclass
          AND conname = 'exam_sessions_avatar_exam_mode_check'
    ) THEN
        ALTER TABLE exam_sessions
            ADD CONSTRAINT exam_sessions_avatar_exam_mode_check
            CHECK (avatar_exam_mode IN ('practice', 'assessed'));
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'exam_avatar_policies'::regclass
          AND conname = 'exam_avatar_policies_exam_mode_check'
    ) THEN
        ALTER TABLE exam_avatar_policies
            ADD CONSTRAINT exam_avatar_policies_exam_mode_check
            CHECK (exam_mode IN ('practice', 'assessed'));
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'interactions'::regclass
          AND conname = 'interactions_avatar_root_sequence_check'
    ) THEN
        ALTER TABLE interactions
            ADD CONSTRAINT interactions_avatar_root_sequence_check
            CHECK (
                avatar_root_sequence IS NULL OR avatar_root_sequence >= 1
            );
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'interactions'::regclass
          AND conname = 'interactions_avatar_followup_index_check'
    ) THEN
        ALTER TABLE interactions
            ADD CONSTRAINT interactions_avatar_followup_index_check
            CHECK (avatar_followup_index BETWEEN 0 AND 5);
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'questions'::regclass
          AND conname = 'questions_avatar_authored_position_check'
    ) THEN
        ALTER TABLE questions
            ADD CONSTRAINT questions_avatar_authored_position_check
            CHECK (
                avatar_authored_position IS NULL
                OR avatar_authored_position >= 1
            );
    END IF;
END $$;

COMMIT;
