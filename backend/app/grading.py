import json
import os
from uuid import UUID

import httpx
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import text
from sqlalchemy.orm import Session

from .db import get_db

router = APIRouter(prefix="/exam", tags=["grading"])

OLLAMA_URL = os.getenv("OLLAMA_URL", "http://ollama:11434")
OLLAMA_MODEL = os.getenv("OLLAMA_MODEL", "llama3.1")

GRADING_PROMPT = """You are a strict, fair grader of an oral exam. You get the rubric
criteria (each with a max_score), the required topics, and the full transcript of
questions and student answers. Score every criterion from 0 to its max_score, based only
on what the student actually said. Do not give credit for details that are missing.
Reply ONLY with JSON in exactly this shape:
{"scores": [{"criterion": "<exact criterion name>", "score": <number>,
             "rationale": "<1-3 sentences pointing to specific answers>"}]}"""


class GradeRequest(BaseModel):
    session_id: UUID


class IntegrityEventRequest(BaseModel):
    session_id: UUID
    event_type: str
    event_timestamp: float | None = None
    severity: int | None = Field(default=None, ge=1, le=5)
    notes: str | None = None


def criterion_max(c: dict) -> float:
    if c.get("max_score") is not None:
        return float(c["max_score"])
    if c.get("weight") is not None:
        return float(c["weight"]) * 100
    return 10.0


@router.post("/grade")
def grade_session(req: GradeRequest, db: Session = Depends(get_db)):
    sid = str(req.session_id)

    session = db.execute(
        text("""SELECT s.status, t.professor_id, t.rubric, t.title,
                       t.topic_coverage_required
                FROM exam_sessions s
                JOIN exam_templates t ON t.id = s.exam_template_id
                WHERE s.id = CAST(:sid AS uuid)"""),
        {"sid": sid},
    ).mappings().first()
    if not session:
        raise HTTPException(404, "Session not found")
    if session["status"] not in ("pending_grading", "flagged"):
        raise HTTPException(409, f"Session is {session['status']}, not ready for grading")

    already = db.execute(
        text("SELECT count(*) FROM grades WHERE session_id = CAST(:sid AS uuid)"),
        {"sid": sid},
    ).scalar_one()
    if already:
        raise HTTPException(409, "This session already has grades")

    criteria = (session["rubric"] or {}).get("criteria", [])
    if not criteria:
        raise HTTPException(422, "The exam template's rubric has no criteria")

    answered = [dict(r) for r in db.execute(
        text("""SELECT sequence_num, question_text AS question,
                       student_answer_transcript AS answer
                FROM interactions
                WHERE session_id = CAST(:sid AS uuid)
                  AND student_answer_transcript IS NOT NULL
                ORDER BY sequence_num"""),
        {"sid": sid},
    ).mappings().all()]
    if not answered:
        raise HTTPException(422, "No answered questions to grade")

    payload = {
        "exam_title": session["title"],
        "topics_required": session["topic_coverage_required"],
        "criteria": [{"name": c["name"], "max_score": criterion_max(c)} for c in criteria],
        "transcript": answered,
    }

    try:
        r = httpx.post(
            f"{OLLAMA_URL}/api/chat",
            json={
                "model": OLLAMA_MODEL,
                "stream": False,
                "format": "json",
                "options": {"temperature": 0.2},
                "messages": [
                    {"role": "system", "content": GRADING_PROMPT},
                    {"role": "user", "content": json.dumps(payload, default=str)},
                ],
            },
            timeout=300,
        )
        r.raise_for_status()
        result = json.loads(r.json()["message"]["content"])
    except (httpx.HTTPError, json.JSONDecodeError, KeyError) as e:
        raise HTTPException(502, f"Ollama grading call failed: {e}")

    by_name = {
        str(s.get("criterion", "")).strip().lower(): s
        for s in result.get("scores", []) if isinstance(s, dict)
    }

    graded = []
    for c in criteria:
        mx = criterion_max(c)
        s = by_name.get(c["name"].strip().lower())
        suggested, note = None, None
        if s:
            try:
                suggested = max(0.0, min(mx, float(s.get("score"))))
            except (TypeError, ValueError):
                suggested = None
            note = "[AI rationale] " + str(s.get("rationale", "")).strip()

        db.execute(
            text("""INSERT INTO grades
                    (session_id, professor_id, rubric_criterion, max_score,
                     model_suggested_score, professor_notes)
                    VALUES (CAST(:sid AS uuid), CAST(:pid AS uuid), :crit, :mx,
                            :sugg, :note)"""),
            {"sid": sid, "pid": str(session["professor_id"]), "crit": c["name"],
             "mx": mx, "sugg": suggested, "note": note},
        )
        graded.append({"criterion": c["name"], "max_score": mx,
                       "model_suggested_score": suggested, "rationale": note})

    db.commit()
    return {"session_id": sid, "grades": graded,
            "note": "Suggested scores only; a professor must confirm each one."}


@router.post("/integrity")
def log_integrity_event(req: IntegrityEventRequest, db: Session = Depends(get_db)):
    sid = str(req.session_id)
    exists = db.execute(
        text("SELECT 1 FROM exam_sessions WHERE id = CAST(:sid AS uuid)"),
        {"sid": sid},
    ).first()
    if not exists:
        raise HTTPException(404, "Session not found")

    event_id = db.execute(
        text("""INSERT INTO integrity_events
                (session_id, event_type, event_timestamp, severity, notes)
                VALUES (CAST(:sid AS uuid), :et, :ts, :sev, :notes)
                RETURNING id"""),
        {"sid": sid, "et": req.event_type, "ts": req.event_timestamp,
         "sev": req.severity, "notes": req.notes},
    ).scalar_one()
    db.commit()
    return {"event_id": str(event_id)}


@router.get("/{session_id}/report")
def session_report(session_id: UUID, db: Session = Depends(get_db)):
    sid = str(session_id)
    session = db.execute(
        text("SELECT * FROM exam_sessions WHERE id = CAST(:sid AS uuid)"),
        {"sid": sid},
    ).mappings().first()
    if not session:
        raise HTTPException(404, "Session not found")

    def rows(sql):
        return [dict(r) for r in db.execute(text(sql), {"sid": sid}).mappings().all()]

    return {
        "session": dict(session),
        "interactions": rows("""SELECT sequence_num, question_source, question_text,
                                       student_answer_transcript, model_reasoning
                                FROM interactions
                                WHERE session_id = CAST(:sid AS uuid)
                                ORDER BY sequence_num"""),
        "grades": rows("""SELECT rubric_criterion, max_score, model_suggested_score,
                                 score, professor_notes, graded_at
                          FROM grades WHERE session_id = CAST(:sid AS uuid)
                          ORDER BY created_at"""),
        "integrity_events": rows("""SELECT event_type, event_timestamp, severity, notes
                                    FROM integrity_events
                                    WHERE session_id = CAST(:sid AS uuid)
                                    ORDER BY created_at"""),
    }
