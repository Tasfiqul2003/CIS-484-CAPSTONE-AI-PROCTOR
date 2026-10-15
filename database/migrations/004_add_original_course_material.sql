ALTER TABLE course_materials
ADD COLUMN IF NOT EXISTS original_content BYTEA;
