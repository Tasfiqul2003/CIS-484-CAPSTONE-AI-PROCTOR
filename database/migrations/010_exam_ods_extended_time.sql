-- Professor-assigned extended time for roster members of this exam only.
-- NULL means no assignment. Existing attempts retain a 1x multiplier.
-- Future attempts snapshot this factor for the whole-exam timer only.
-- The migration runner owns the transaction; preserve earlier migration files.
ALTER TABLE exam_roster ADD COLUMN extended_time_multiplier NUMERIC(3,2)
    CHECK (extended_time_multiplier IN (1.25, 1.5, 2, 3));
ALTER TABLE exam_sessions ADD COLUMN extended_time_multiplier NUMERIC(3,2) NOT NULL DEFAULT 1
    CHECK (extended_time_multiplier IN (1, 1.25, 1.5, 2, 3));
