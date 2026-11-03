-- Apply before deploying the time-settings backend changes.
-- Capture existing attempts' current template limit once; their original limit
-- cannot be reconstructed if the template was changed previously.
BEGIN;
ALTER TABLE exam_sessions ADD COLUMN time_limit_minutes INTEGER;
UPDATE exam_sessions s SET time_limit_minutes = t.time_limit_minutes
FROM exam_templates t WHERE s.exam_template_id = t.id;
COMMIT;
