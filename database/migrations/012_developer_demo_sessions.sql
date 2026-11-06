-- New attempts explicitly opt into developer substitutes. Existing attempts remain assessed.
-- This marker is durable even when the developer runtime flag is later disabled.
ALTER TABLE exam_sessions ADD COLUMN developer_demo BOOLEAN NOT NULL DEFAULT FALSE;
