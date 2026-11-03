-- Prerequisites used by the existing student verification and roster routes.
-- Existing students retain NULL EIDs until explicitly assigned.
BEGIN;
ALTER TABLE students ADD COLUMN IF NOT EXISTS eid TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS students_eid_unique ON students (eid);
CREATE TABLE IF NOT EXISTS exam_roster (
    student_id UUID NOT NULL REFERENCES students(id) ON DELETE CASCADE,
    exam_template_id UUID NOT NULL REFERENCES exam_templates(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (student_id, exam_template_id)
);
COMMIT;
