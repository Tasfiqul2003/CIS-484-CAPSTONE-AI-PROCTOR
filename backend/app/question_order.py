"""Append imported bank questions in file order inside the caller's transaction."""

from fastapi import HTTPException
from sqlalchemy import text


def append_bank_questions(db, exam_id, professor_id, questions) -> int:
    if not professor_id:
        raise HTTPException(403, "This account is not linked to a professor.")
    if isinstance(questions, (str, bytes)):
        raise HTTPException(400, "Questions must be a list of nonempty text entries.")
    entries = list(questions)
    if not entries or any(not isinstance(value, str) or not value.strip() for value in entries):
        raise HTTPException(400, "Questions must be a list of nonempty text entries.")
    # Serializing appends on the owning exam prevents concurrent batches sharing positions.
    lock = " FOR UPDATE" if db.get_bind().dialect.name == "postgresql" else ""
    owner = db.execute(text("""SELECT id FROM exam_templates
        WHERE id = :exam_id AND professor_id = :professor_id""" + lock),
        {"exam_id": str(exam_id), "professor_id": str(professor_id)}).first()
    if owner is None:
        raise HTTPException(404, "Exam not found or you do not have permission to edit it.")
    position = db.execute(text("""SELECT COALESCE(MAX(avatar_authored_position), 0)
        FROM questions WHERE exam_template_id = :exam_id"""), {"exam_id": str(exam_id)}).scalar_one()
    db.execute(text("""INSERT INTO questions
        (professor_id, exam_template_id, question_text, avatar_authored_position)
        VALUES (:professor_id, :exam_id, :question_text, :position)"""), [
        {"professor_id": str(professor_id), "exam_id": str(exam_id),
         "question_text": question.strip(), "position": int(position) + offset}
        for offset, question in enumerate(entries, 1)
    ])
    return len(entries)
