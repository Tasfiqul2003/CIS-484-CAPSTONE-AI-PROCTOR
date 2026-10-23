from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import text
from sqlalchemy.orm import Session

from .db import get_db

router = APIRouter(prefix="/exam", tags=["review"])


class GradeUpdate(BaseModel):
    rubric_criterion: str
    score: float | None = None          # omit to accept the AI-suggested score
    professor_notes: str | None = None


class ReviewRequest(BaseModel):
    professor_id: UUID
    grades: list[GradeUpdate]


@router.put("/{session_id}/grades")
def confirm_grades(session_id: UUID, req: ReviewRequest, db: Session = Depends(get_db)):
    sid = str(session_id)

    session = db.execute(
        text("SELECT status FROM exam_sessions WHERE id = CAST(:sid AS uuid)"),
        {"sid": sid},
    ).mappings().first()
    if not session:
        raise HTTPException(404, "Session not found")
    if session["status"] not in ("pending_grading", "flagged", "graded"):
        raise HTTPException(409, f"Session is {session['status']}, not ready for review")

    rows = db.execute(
        text("""SELECT id, rubric_criterion, max_score, model_suggested_score,
                       professor_notes, professor_id
                FROM grades WHERE session_id = CAST(:sid AS uuid)"""),
        {"sid": sid},
    ).mappings().all()
    if not rows:
        raise HTTPException(404, "No grades yet; run POST /exam/grade first")

    by_name = {r["rubric_criterion"].strip().lower(): r for r in rows}

    for u in req.grades:
        row = by_name.get(u.rubric_criterion.strip().lower())
        if not row:
            raise HTTPException(422, f"Unknown criterion: {u.rubric_criterion}")
        if str(row["professor_id"]) != str(req.professor_id):
            raise HTTPException(403, "Not the professor who owns this exam")

        score = u.score
        if score is None and row["model_suggested_score"] is not None:
            score = float(row["model_suggested_score"])
        if score is None:
            raise HTTPException(422, f"No score given and no suggestion for {u.rubric_criterion}")
        if not 0 <= score <= float(row["max_score"]):
            raise HTTPException(
                422, f"Score for {u.rubric_criterion} must be between 0 and {float(row['max_score'])}"
            )

        notes = row["professor_notes"]
        if u.professor_notes is not None:
            ai_lines = [
                line for line in (row["professor_notes"] or "").splitlines()
                if line.startswith("[AI rationale]")
            ]
            notes = "\n".join([u.professor_notes.strip()] + ai_lines)

        db.execute(
            text("""UPDATE grades
                    SET score = :score, professor_notes = :notes, graded_at = now()
                    WHERE id = :id"""),
            {"score": score, "notes": notes, "id": row["id"]},
        )

    unscored = db.execute(
        text("""SELECT count(*) FROM grades
                WHERE session_id = CAST(:sid AS uuid) AND score IS NULL"""),
        {"sid": sid},
    ).scalar_one()
    if unscored == 0:
        db.execute(
            text("UPDATE exam_sessions SET status = 'graded' WHERE id = CAST(:sid AS uuid)"),
            {"sid": sid},
        )
    db.commit()

    final = [dict(r) for r in db.execute(
        text("""SELECT rubric_criterion, max_score, model_suggested_score, score,
                       professor_notes, graded_at
                FROM grades WHERE session_id = CAST(:sid AS uuid)
                ORDER BY created_at"""),
        {"sid": sid},
    ).mappings().all()]

    total = sum(float(g["score"]) for g in final if g["score"] is not None)
    max_total = sum(float(g["max_score"]) for g in final)
    return {
        "session_status": "graded" if unscored == 0 else session["status"],
        "unscored_criteria": unscored,
        "total": total,
        "max_total": max_total,
        "grades": final,
    }
