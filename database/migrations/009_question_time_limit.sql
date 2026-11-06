-- Optional professor-configured limit for each question, copied at attempt start.
-- Existing templates and attempts keep NULL (no per-question limit).
-- The migration runner owns the transaction; preserve previous migration files.
ALTER TABLE exam_templates ADD COLUMN question_time_limit_minutes INTEGER
    CHECK (question_time_limit_minutes BETWEEN 1 AND 240);
ALTER TABLE exam_sessions ADD COLUMN question_time_limit_minutes INTEGER
    CHECK (question_time_limit_minutes BETWEEN 1 AND 240);
