"""Imported author order using synthetic in-memory SQLite, without file uploads."""

from fastapi import HTTPException
import pytest
from sqlalchemy import create_engine, text
from sqlalchemy.orm import sessionmaker

from backend.app.question_order import append_bank_questions


@pytest.fixture
def sessions():
    engine = create_engine("sqlite://")
    with engine.begin() as db:
        db.execute(text("CREATE TABLE exam_templates (id TEXT PRIMARY KEY, professor_id TEXT NOT NULL)"))
        db.execute(text("INSERT INTO exam_templates VALUES ('exam-a', 'professor-a'), ('exam-b', 'professor-b')"))
        db.execute(text("""CREATE TABLE questions (
            id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))), professor_id TEXT NOT NULL,
            exam_template_id TEXT NOT NULL, question_text TEXT NOT NULL,
            avatar_authored_position INTEGER NOT NULL,
            created_at TEXT NOT NULL DEFAULT '2026-01-01T00:00:00+00:00',
            UNIQUE (exam_template_id, avatar_authored_position))"""))
    yield sessionmaker(bind=engine)
    engine.dispose()


def ordered(db, exam="exam-a"):
    return db.execute(text("""SELECT question_text, avatar_authored_position, created_at FROM questions
        WHERE exam_template_id = :exam ORDER BY avatar_authored_position, created_at, id"""),
        {"exam": exam}).all()


def test_same_timestamp_batch_preserves_authored_file_order(sessions):
    questions = ["Third alphabetically?", "First alphabetically?", "Second alphabetically?"]
    with sessions.begin() as db:
        assert append_bank_questions(db, "exam-a", "professor-a", questions) == 3
    with sessions() as db:
        rows = ordered(db)
        assert [row[0] for row in rows] == questions
        assert [row[1] for row in rows] == [1, 2, 3]
        assert len({row[2] for row in rows}) == 1


def test_later_batch_appends_after_existing_positions_and_other_exam_is_independent(sessions):
    with sessions.begin() as db:
        append_bank_questions(db, "exam-a", "professor-a", ["Existing first?", "Existing second?"])
    with sessions.begin() as db:
        append_bank_questions(db, "exam-a", "professor-a", ["New first?", "New second?"])
        append_bank_questions(db, "exam-b", "professor-b", ["Other exam first?"])
    with sessions() as db:
        assert [(row[0], row[1]) for row in ordered(db)] == [
            ("Existing first?", 1), ("Existing second?", 2), ("New first?", 3), ("New second?", 4)]
        assert [(row[0], row[1]) for row in ordered(db, "exam-b")] == [("Other exam first?", 1)]


@pytest.mark.parametrize("professor,status", [("professor-b", 404), (None, 403)])
def test_unauthorized_append_does_not_insert_questions(sessions, professor, status):
    with sessions() as db, pytest.raises(HTTPException) as error:
        append_bank_questions(db, "exam-a", professor, ["Unauthorized synthetic question?"])
    assert error.value.status_code == status
    with sessions() as db:
        assert ordered(db) == []


def test_caller_rollback_discards_entire_import(sessions):
    with sessions() as db:
        append_bank_questions(db, "exam-a", "professor-a", ["Synthetic first?", "Synthetic second?"])
        db.rollback()
    with sessions() as db:
        assert ordered(db) == []
