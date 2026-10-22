-- Professor-owned configuration only. This does not change exam sessions,
-- student permissions, assistance usage, or the live examiner/model behavior.
-- Attempt creation must snapshot the saved revision when integrated later.
CREATE TABLE IF NOT EXISTS exam_avatar_policies (
    exam_template_id UUID PRIMARY KEY REFERENCES exam_templates(id) ON DELETE CASCADE,
    settings JSONB NOT NULL CHECK (jsonb_typeof(settings) = 'object'),
    revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
