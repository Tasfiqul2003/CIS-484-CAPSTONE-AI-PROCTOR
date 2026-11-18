"""Synthetic submission checks across consented capture and retained assessment."""
import pytest
from fastapi import HTTPException
from backend.app import exam
from backend.tests.test_question_time_limits import TurnDB, prepare_turn, SESSION, Result


class ConsentDB(TurnDB):
    def __init__(self, choice):
        super().__init__(question_limit=None, question_elapsed=0)
        self.choice = choice
        self.media_reads = 0

    def execute(self, statement, params=None):
        if 'FROM exam_session_videos' in str(statement):
            self.media_reads += 1
            return Result()
        result = super().execute(statement, params)
        if 'FROM exam_sessions s' in str(statement):
            result.row['recording_consent_status'] = self.choice
        return result


@pytest.mark.parametrize('choice', ['declined', 'not_required', 'consented'])
def test_typed_submission_survives_missing_media(monkeypatch, choice):
    db = ConsentDB(choice)
    prepare_turn(monkeypatch, db)
    response = exam.submit_answer(exam.AnswerRequest(session_id=SESSION,
        answer_transcript='Synthetic typed response', question_sequence_num=1),
        authorization='Bearer synthetic', db=db)
    assert response['sequence_num'] == 2
    assert db.saved['a'] == 'Synthetic typed response' and db.committed
    assert db.media_reads == 0


def test_pending_consent_is_decided_before_answer_submission(monkeypatch):
    db = ConsentDB('pending')
    prepare_turn(monkeypatch, db)
    with pytest.raises(HTTPException) as error:
        exam.submit_answer(exam.AnswerRequest(session_id=SESSION,
            answer_transcript='Synthetic response', question_sequence_num=1),
            authorization='Bearer synthetic', db=db)
    assert error.value.status_code == 409
    assert db.saved is None and db.writes == [] and not db.committed
