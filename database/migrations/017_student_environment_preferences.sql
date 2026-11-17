-- Personal presentation preferences only. No attempt, timing, media, or grading state.
CREATE TABLE student_environment_preferences (
    exam_template_id UUID NOT NULL REFERENCES exam_templates(id) ON DELETE CASCADE,
    student_id UUID NOT NULL REFERENCES students(id) ON DELETE CASCADE,
    policy_revision INTEGER NOT NULL CHECK (policy_revision >= 0),
    preferences JSONB NOT NULL CHECK (jsonb_typeof(preferences) = 'object'),
    PRIMARY KEY (exam_template_id, student_id)
);
