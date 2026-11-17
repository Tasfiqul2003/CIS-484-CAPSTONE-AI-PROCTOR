UPDATE student_face_verifications
SET status = 'no_match'
WHERE status = 'review_override';

ALTER TABLE student_face_verifications
    DROP CONSTRAINT IF EXISTS student_face_verifications_status_check;

ALTER TABLE student_face_verifications
    ADD CONSTRAINT student_face_verifications_status_check
    CHECK (status IN ('no_match', 'matched'));
