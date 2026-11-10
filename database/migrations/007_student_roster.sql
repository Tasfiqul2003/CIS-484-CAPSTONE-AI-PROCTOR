-- Storage already required by the existing roster and student lookup routes.
-- Existing students without a roster identity remain valid; uploads supply EID.
ALTER TABLE students
    ADD COLUMN IF NOT EXISTS eid TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_students_eid
    ON students (eid)
    WHERE eid IS NOT NULL;

CREATE TABLE IF NOT EXISTS exam_roster (
    exam_template_id UUID NOT NULL REFERENCES exam_templates(id) ON DELETE CASCADE,
    student_id UUID NOT NULL REFERENCES students(id) ON DELETE CASCADE,
    PRIMARY KEY (exam_template_id, student_id)
);

CREATE INDEX IF NOT EXISTS idx_exam_roster_student
    ON exam_roster (student_id);
