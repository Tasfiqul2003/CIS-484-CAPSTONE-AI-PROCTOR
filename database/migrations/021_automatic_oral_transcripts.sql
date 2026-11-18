-- Distinguish automatic speech from explicitly student-reviewed transcripts.
ALTER TABLE interactions DROP CONSTRAINT IF EXISTS interactions_answer_input_source_check;
ALTER TABLE interactions ADD CONSTRAINT interactions_answer_input_source_check
    CHECK (answer_input_source IN ('typed', 'confirmed_transcript', 'automatic_transcript', 'unanswered_voice', 'timeout'));
