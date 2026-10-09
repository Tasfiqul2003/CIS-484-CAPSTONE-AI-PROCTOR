-- Authentication accounts for system administrators and professors.
-- This migration preserves all existing professor and exam records.

CREATE TABLE IF NOT EXISTS user_accounts (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    username TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL
        CHECK (role IN ('admin', 'professor')),
    professor_id UUID REFERENCES professors(id),
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT user_accounts_role_professor_check
        CHECK (
            (role = 'admin' AND professor_id IS NULL)
            OR
            (role = 'professor' AND professor_id IS NOT NULL)
        )
);

-- Usernames are unique regardless of capitalization.
CREATE UNIQUE INDEX IF NOT EXISTS idx_user_accounts_username_lower
    ON user_accounts (LOWER(username));

-- Each professor record can have at most one login account.
CREATE UNIQUE INDEX IF NOT EXISTS idx_user_accounts_professor_id
    ON user_accounts (professor_id)
    WHERE professor_id IS NOT NULL;
