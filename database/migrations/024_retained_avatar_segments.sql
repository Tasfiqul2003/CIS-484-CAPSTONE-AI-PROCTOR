-- Extend retained delivery assets with explicit type and ordering; preserve all WAV rows.
ALTER TABLE exam_question_audio ADD COLUMN media_type text NOT NULL DEFAULT 'audio/wav'
    CHECK (media_type IN ('audio/wav', 'video/mp4'));
ALTER TABLE exam_question_audio ADD COLUMN profile_id text;
ALTER TABLE exam_question_audio ADD COLUMN segment_index integer NOT NULL DEFAULT 0 CHECK (segment_index BETWEEN 0 AND 63);
ALTER TABLE exam_question_audio ADD COLUMN delivery_kind text NOT NULL DEFAULT 'question';
ALTER TABLE exam_question_audio DROP CONSTRAINT exam_question_audio_session_id_interaction_id_voice_speed_key;
CREATE UNIQUE INDEX retained_wav_configuration ON exam_question_audio(session_id, interaction_id, voice, speed)
    WHERE media_type = 'audio/wav';
ALTER TABLE exam_question_audio ADD COLUMN delivery_id uuid;
ALTER TABLE exam_question_audio ADD COLUMN delivery_complete boolean NOT NULL DEFAULT false;
CREATE INDEX retained_avatar_delivery ON exam_question_audio(session_id, interaction_id, delivery_id, segment_index)
    WHERE media_type = 'video/mp4';
