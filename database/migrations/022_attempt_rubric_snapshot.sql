-- Additive: NULL means the historical rubric is unknown, never backfilled from a mutable template.
ALTER TABLE exam_sessions ADD COLUMN IF NOT EXISTS assessment_rubric_snapshot jsonb;
ALTER TABLE exam_sessions ADD COLUMN IF NOT EXISTS assessment_rubric_version text;
