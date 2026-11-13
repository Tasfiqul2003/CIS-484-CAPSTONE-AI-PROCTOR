from datetime import datetime, timezone
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import text
from sqlalchemy.orm import Session

from .db import get_db
from .auth import require_professor

router = APIRouter(prefix="/exam", tags=["review"])


class GradeUpdate(BaseModel):
    rubric_criterion: str
    score: float | None = None          # omit to accept the AI-suggested score
    professor_notes: str | None = None


class ReviewRequest(BaseModel):
    professor_id: UUID
    grades: list[GradeUpdate]


@router.put("/{session_id}/grades")
def confirm_grades(
    session_id: UUID,
    req: ReviewRequest,
    account: dict = Depends(require_professor),
    db: Session = Depends(get_db),
):
    sid = str(session_id)

    session = db.execute(
        text("""
            SELECT s.status, s.developer_demo, t.professor_id AS exam_professor_id
            FROM exam_sessions AS s
            JOIN exam_templates AS t ON t.id = s.exam_template_id
            WHERE s.id = CAST(:sid AS uuid)
        """),
        {"sid": sid},
    ).mappings().first()
    if not session:
        raise HTTPException(404, "Session not found")

    professor_id = account.get("professor_id")
    if (
        not professor_id
        or str(session["exam_professor_id"]) != str(professor_id)
    ):
        raise HTTPException(404, "Session not found")
    if session.get("developer_demo", False):
        raise HTTPException(409, "Developer demo attempts cannot receive assessment grades.")
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
        if str(row["professor_id"]) != str(professor_id):
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


@router.get("/sessions/{session_id}/review")
def get_submission_review(
    session_id: UUID,
    account: dict = Depends(require_professor),
    db: Session = Depends(get_db),
):
    professor_id = account.get("professor_id")
    if not professor_id:
        raise HTTPException(403, "Professor account required.")

    session = db.execute(
        text("""SELECT s.status, s.developer_demo, st.name AS student_name,
                       st.eid, t.title AS exam_title, t.course, t.professor_id,
                       v.status AS video_status, v.expires_at
                FROM exam_sessions AS s
                JOIN students AS st ON st.id = s.student_id
                JOIN exam_templates AS t ON t.id = s.exam_template_id
                LEFT JOIN exam_session_videos AS v ON v.session_id = s.id
                WHERE s.id = CAST(:sid AS uuid)"""),
        {"sid": str(session_id)},
    ).mappings().first()
    if not session or str(session["professor_id"]) != str(professor_id):
        raise HTTPException(404, "Session not found.")
    if session.get("developer_demo", False):
        raise HTTPException(404, "Session not found.")
    if session["status"] not in ("pending_grading", "flagged", "graded"):
        raise HTTPException(409, "Exam review is available only after submission.")
    if session.get("video_status") == "expired":
        raise HTTPException(410, "The exam video has passed its retention deadline.")
    if (
        session.get("video_status") != "completed"
        or session.get("expires_at") is None
        or session["expires_at"] <= datetime.now(timezone.utc)
    ):
        raise HTTPException(409, "The completed exam video is not available yet.")

    answers = db.execute(
        text("""SELECT sequence_num, question_text AS question,
                       student_answer_transcript AS answer
                FROM interactions
                WHERE session_id = CAST(:sid AS uuid)
                ORDER BY sequence_num"""),
        {"sid": str(session_id)},
    ).mappings().all()
    return {
        "session_id": str(session_id),
        "student_name": session["student_name"],
        "student_eid": session["eid"],
        "exam_title": session["exam_title"],
        "course": session["course"],
        "status": session["status"],
        "video_url": f"/api/exam/sessions/{session_id}/video",
        "answers": [dict(answer) for answer in answers],
    }
