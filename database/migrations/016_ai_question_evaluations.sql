-- A short AI evaluation of each answer, written with the AI-suggested rubric scores.
ALTER TABLE interactions ADD COLUMN IF NOT EXISTS ai_evaluation TEXT;
