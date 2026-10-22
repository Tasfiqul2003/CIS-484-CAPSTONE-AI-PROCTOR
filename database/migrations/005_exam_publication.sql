ALTER TABLE exam_templates
    ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'draft';

ALTER TABLE exam_templates
    DROP CONSTRAINT IF EXISTS exam_templates_status_check;

ALTER TABLE exam_templates
    ADD CONSTRAINT exam_templates_status_check
    CHECK (status IN ('draft', 'published'));
