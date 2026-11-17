from datetime import datetime, timezone
import math
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator
from sqlalchemy import text
from sqlalchemy.orm import Session

from .db import get_db
from .auth import require_professor
from .media_timeline import read_timeline
from .question_audio import review_assets
from .assessment_contracts import session_lock_clause,rubric_criteria,require_retained_recording

router = APIRouter(prefix="/exam", tags=["review"])


def _valid_exchange_offsets(answer):
    try:
        start = float(answer["answer_timestamp_start"])
        end = float(answer["answer_timestamp_end"])
        return math.isfinite(start) and math.isfinite(end) and 0 <= start <= end <= 86400
    except (KeyError, ValueError, TypeError, OverflowError):
        return False


class GradeUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    rubric_criterion: str = Field(strict=True, min_length=1, max_length=120)
    score: float | None = Field(default=None, strict=True, allow_inf_nan=False)
    professor_notes: str | None = Field(default=None, strict=True, max_length=4000)

    @field_validator("rubric_criterion")
    @classmethod
    def nonblank(cls, value):
        if not value.strip():
            raise ValueError("Criterion must not be blank")
        return value.strip()


class ReviewRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    professor_id: UUID
    grades: list[GradeUpdate] = Field(min_length=1, max_length=20)

    @model_validator(mode="after")
    def unique_criteria(self):
        names = [value.rubric_criterion.casefold() for value in self.grades]
        if len(names) != len(set(names)):
            raise ValueError("Each rubric criterion can be confirmed only once")
        return self


@router.put("/{session_id}/grades")
def confirm_grades(
    session_id: UUID,
    req: ReviewRequest,
    account: dict = Depends(require_professor),
    db: Session = Depends(get_db),
):
    sid = str(session_id)
    session = db.execute(text("""SELECT s.status, s.developer_demo,
        t.professor_id AS exam_professor_id, t.rubric,
        v.status AS video_status, v.expires_at AS video_expires_at
        FROM exam_sessions AS s JOIN exam_templates AS t ON t.id=s.exam_template_id
        LEFT JOIN exam_session_videos AS v ON v.session_id=s.id
        WHERE s.id=CAST(:sid AS uuid)""" + session_lock_clause(db)), {"sid":sid}).mappings().first()
    if not session:
        raise HTTPException(404,"Session not found")
    professor_id=account.get("professor_id")
    if not professor_id or str(session["exam_professor_id"]) != str(professor_id):
        raise HTTPException(404,"Session not found")
    if str(req.professor_id) != str(professor_id):
        raise HTTPException(403,"The confirmation professor must match the signed-in account.")
    if session.get("developer_demo",False):
        raise HTTPException(409,"Developer demo attempts cannot receive assessment grades.")
    if session["status"] not in ("pending_grading","flagged","graded"):
        raise HTTPException(409,"This attempt is not ready for professor assessment.")
    require_retained_recording(session)
    rows=db.execute(text("""SELECT id,rubric_criterion,max_score,model_suggested_score,
        professor_notes,professor_id FROM grades WHERE session_id=CAST(:sid AS uuid)"""),{"sid":sid}).mappings().all()
    if not rows:
        # A professor may assess without an AI provider. Only an explicit complete
        # set of manually supplied scores can create these initial grade rows.
        criteria=rubric_criteria(session["rubric"])
        by_name={value["name"].casefold():value for value in criteria}
        if {value.rubric_criterion.casefold() for value in req.grades} != set(by_name):
            raise HTTPException(422,"Manual assessment must explicitly score every saved rubric criterion exactly once.")
        for value in req.grades:
            maximum=by_name[value.rubric_criterion.casefold()]["max_score"]
            if value.score is None or not 0 <= value.score <= maximum:
                raise HTTPException(422,"Every manual score must be finite and within its saved rubric bound.")
        for value in req.grades:
            criterion=by_name[value.rubric_criterion.casefold()]
            db.execute(text("""INSERT INTO grades
                (session_id,professor_id,rubric_criterion,max_score,score,model_suggested_score,professor_notes,graded_at)
                VALUES (CAST(:sid AS uuid),CAST(:pid AS uuid),:criterion,:maximum,:score,NULL,:notes,now())"""),
                {"sid":sid,"pid":str(professor_id),"criterion":criterion["name"],"maximum":criterion["max_score"],
                 "score":value.score,"notes":(value.professor_notes or "").strip()})
    else:
        by_name={value["rubric_criterion"].strip().casefold():value for value in rows}
        if len(by_name) != len(rows):
            raise HTTPException(409,"Existing assessment has duplicate rubric criteria and needs review.")
        updates=[]
        for value in req.grades:
            row=by_name.get(value.rubric_criterion.casefold())
            if row is None:
                raise HTTPException(422,"The confirmation contains an unknown rubric criterion.")
            if str(row["professor_id"]) != str(professor_id):
                raise HTTPException(403,"Not the professor who owns this exam")
            score=value.score if value.score is not None else row["model_suggested_score"]
            try:
                maximum=float(row["max_score"])
                score=float(score)
            except (ValueError,TypeError,OverflowError):
                raise HTTPException(422,"An explicit bounded score is required for every confirmation.") from None
            if not math.isfinite(score) or not math.isfinite(maximum) or maximum <= 0 or not 0 <= score <= maximum:
                raise HTTPException(422,"Confirmed scores must be finite and within the saved rubric bounds.")
            notes=row["professor_notes"]
            if value.professor_notes is not None:
                ai_lines=[line for line in (notes or "").splitlines() if line.startswith("[AI rationale]")]
                notes="\n".join([value.professor_notes.strip()]+ai_lines)
            updates.append({"score":score,"notes":notes,"id":row["id"]})
        # Validate the entire request before changing any score.
        for update in updates:
            db.execute(text("UPDATE grades SET score=:score,professor_notes=:notes,graded_at=now() WHERE id=:id"),update)
    unscored=db.execute(text("SELECT count(*) FROM grades WHERE session_id=CAST(:sid AS uuid) AND score IS NULL"),{"sid":sid}).scalar_one()
    if unscored == 0:
        db.execute(text("UPDATE exam_sessions SET status='graded' WHERE id=CAST(:sid AS uuid)"),{"sid":sid})
    db.commit()
    final=[dict(value) for value in db.execute(text("""SELECT rubric_criterion,max_score,model_suggested_score,
        score,professor_notes,graded_at FROM grades WHERE session_id=CAST(:sid AS uuid) ORDER BY created_at"""),{"sid":sid}).mappings().all()]
    return {"session_status":"graded" if unscored == 0 else session["status"],"unscored_criteria":unscored,
        "total":sum(float(value["score"]) for value in final if value["score"] is not None),
        "max_total":sum(float(value["max_score"]) for value in final),"grades":final}


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
        text("""SELECT s.status, s.developer_demo, s.exam_template_id, st.name AS student_name,
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
    if session.get("video_status") == "expired" or (session.get("expires_at") is not None and session["expires_at"] <= datetime.now(timezone.utc)):
        raise HTTPException(410, "The exam video has passed its retention deadline.")
    if (
        session.get("video_status") != "completed"
        or session.get("expires_at") is None
    ):
        raise HTTPException(409, "The completed exam video is not available yet.")

    answers = db.execute(
        text("""SELECT id AS interaction_id, sequence_num, question_text AS question,
                       student_answer_transcript AS answer, answer_timestamp_start,
                       answer_timestamp_end, answer_input_source, answer_revision_id,
                       transcript_draft_id, machine_transcript_draft
                FROM interactions
                WHERE session_id = CAST(:sid AS uuid)
                ORDER BY sequence_num"""),
        {"sid": str(session_id)},
    ).mappings().all()
    events = read_timeline(db, str(session_id))
    audio = review_assets(db, str(session_id), events)
    exchanges = []
    for answer in answers:
        assets = audio.get(str(answer.get('interaction_id')), [])
        has_played = any(item['status'] == 'ready' and item['playback_status'] != 'not_reported' for item in assets)
        exchanges.append({**dict(answer), 'question_audio_assets': assets,
            'question_audio_status': 'available' if has_played else 'generated_only' if assets else 'unavailable',
            'question_audio_notice': ('Playback observations are browser-reported; they do not prove what was heard.'
                if assets else 'Original delivered-question audio was not saved.'),
            'transcript_source': answer.get('answer_input_source') or 'unknown',
            'response_media_status': 'available' if _valid_exchange_offsets(answer) else 'offsets_unavailable'})
    return {
        "session_id": str(session_id),
        "student_name": session["student_name"],
        "student_eid": session["eid"],
        "exam_title": session["exam_title"],
        "course": session["course"],
        "status": session["status"],
        "recording_expires_at": session["expires_at"].isoformat(),
        "exam_template_id": str(session["exam_template_id"]) if session.get("exam_template_id") else None,
        "video_url": f"/api/exam/sessions/{session_id}/video",
        "timeline_basis": "client_reported_approximate_recording_seconds",
        'media_events': events,
        "answers": exchanges,
    }
