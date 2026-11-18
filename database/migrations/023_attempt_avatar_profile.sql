-- Explicit selection identity, not a claim about legacy deliveries.
ALTER TABLE exam_sessions ADD COLUMN IF NOT EXISTS examiner_profile_snapshot jsonb;
