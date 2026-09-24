import json
import os
from uuid import UUID

import httpx
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import text
from sqlalchemy.orm import Session

from .db import get_db

router = APIRouter(prefix="/exam", tags=["exam"])

OLLAMA_URL = os.getenv("OLLAMA_URL", "http://ollama:11434")
OLLAMA_MODEL = os.getenv("OLLAMA_MODEL", "llama3.1")
MAX_QUESTIONS = int(os.getenv("MAX_QUESTIONS", "8"))

SYSTEM_PROMPT = """You are an oral exam proctor. Given the exam rubric, required topics,
the conversation so far, and the unused bank questions, decide what happens next.
Reply ONLY with JSON in exactly this shape:
{"reasoning": "<brief evaluation of the last answer and why you chose the next step>",
 "end_exam": false,
 "bank_question_id": null,
 "question": "<the next question to ask, if not using a bank question>"}
Rules: use a bank_question_id from the provided list when one fits the required topics;
otherwise write a follow-up question yourself. Set end_exam to true once the required
topics are covered or the student has clearly shown their level."""


class StartRequest(BaseModel):
    student_id: UUID
    exam_template_id: UUID


class AnswerRequest(BaseModel):
    session_id: UUID
    answer_transcript: str
    answer_timestamp_start: float | None = None
    answer_timestamp_end: float | None = None


def ask_model(template, history, bank_remaining):
    payload = {
        "rubric": template["rubric"],
        "topics_required": template["topic_coverage_required"],
        "difficulty_curve": template["difficulty_curve"],
        "history": history,
        "unused_bank_questions": bank_remaining,
    }
    try:
        r = httpx.post(
            f"{OLLAMA_URL}/api/chat",
            json={
                "model": OLLAMA_MODEL,
                "stream": False,
                "format": "json",
                "options": {"temperature": 0.3},
                "messages": [
                    {"role": "system", "content": SYSTEM_PROMPT},
                    {"role": "user", "content": json.dumps(payload, default=str)},
                ],
            },
            timeout=180,
        )
        r.raise_for_status()
        return json.loads(r.json()["message"]["content"])
    except (httpx.HTTPError, json.JSONDecodeError, KeyError) as e:
        raise HTTPException(502, f"Ollama call failed: {e}")


def end_session(db: Session, session_id: str):
    db.execute(
        text("""UPDATE exam_sessions
                SET status = 'pending_grading', ended_at = now()
                WHERE id = CAST(:sid AS uuid)"""),
        {"sid": session_id},
    )


def insert_question(db, session_id, seq, question_text, source, source_id, reasoning):
    db.execute(
        text("""INSERT INTO interactions
                (session_id, sequence_num, question_text, question_source,
                 source_question_id, model_reasoning)
                VALUES (CAST(:sid AS uuid), :seq, :q, :src,
                        CAST(:qid AS uuid), :why)"""),
        {"sid": session_id, "seq": seq, "q": question_text,
         "src": source, "qid": source_id, "why": reasoning},
    )


@router.post("/start")
def start_exam(req: StartRequest, db: Session = Depends(get_db)):
    template = db.execute(
        text("SELECT * FROM exam_templates WHERE id = CAST(:t AS uuid)"),
        {"t": str(req.exam_template_id)},
    ).mappings().first()
    if not template:
        raise HTTPException(404, "Exam template not found")

    student = db.execute(
        text("SELECT id FROM students WHERE id = CAST(:s AS uuid)"),
        {"s": str(req.student_id)},
    ).first()
    if not student:
        raise HTTPException(404, "Student not found")

    session_id = str(db.execute(
        text("""INSERT INTO exam_sessions (student_id, exam_template_id)
                VALUES (CAST(:s AS uuid), CAST(:t AS uuid)) RETURNING id"""),
        {"s": str(req.student_id), "t": str(req.exam_template_id)},
    ).scalar_one())

    # First question: easiest bank question for this template
    first = db.execute(
        text("""SELECT id, question_text FROM questions
                WHERE exam_template_id = CAST(:t AS uuid)
                ORDER BY difficulty NULLS LAST, random() LIMIT 1"""),
        {"t": str(req.exam_template_id)},
    ).mappings().first()

    if first:
        insert_question(db, session_id, 1, first["question_text"], "bank",
                        str(first["id"]), "Opening question from the bank.")
        question = first["question_text"]
    else:
        decision = ask_model(template, [], [])
        question = decision.get("question")
        if not question:
            db.rollback()
            raise HTTPException(502, "Model did not return a first question")
        insert_question(db, session_id, 1, question, "generated", None,
                        decision.get("reasoning"))

    db.commit()
    return {"session_id": session_id, "sequence_num": 1, "question": question}


@router.post("/answer")
def submit_answer(req: AnswerRequest, db: Session = Depends(get_db)):
    sid = str(req.session_id)

    session = db.execute(
        text("""SELECT s.status, s.exam_template_id,
                       EXTRACT(EPOCH FROM (now() - s.started_at)) / 60 AS elapsed_min
                FROM exam_sessions s WHERE s.id = CAST(:sid AS uuid)"""),
        {"sid": sid},
    ).mappings().first()
    if not session:
        raise HTTPException(404, "Session not found")
    if session["status"] != "in_progress":
        raise HTTPException(409, f"Session is {session['status']}")

    pending = db.execute(
        text("""SELECT id, sequence_num FROM interactions
                WHERE session_id = CAST(:sid AS uuid)
                  AND student_answer_transcript IS NULL
                ORDER BY sequence_num DESC LIMIT 1"""),
        {"sid": sid},
    ).mappings().first()
    if not pending:
        raise HTTPException(409, "No question is waiting for an answer")

    db.execute(
        text("""UPDATE interactions
                SET student_answer_transcript = :a,
                    answer_timestamp_start = :ts, answer_timestamp_end = :te
                WHERE id = :id"""),
        {"a": req.answer_transcript, "ts": req.answer_timestamp_start,
         "te": req.answer_timestamp_end, "id": pending["id"]},
    )

    template = db.execute(
        text("SELECT * FROM exam_templates WHERE id = :t"),
        {"t": session["exam_template_id"]},
    ).mappings().first()

    history = [dict(r) for r in db.execute(
        text("""SELECT sequence_num, question_text AS question,
                       student_answer_transcript AS answer
                FROM interactions WHERE session_id = CAST(:sid AS uuid)
                ORDER BY sequence_num"""),
        {"sid": sid},
    ).mappings().all()]

    out_of_time = (template["time_limit_minutes"] is not None
                   and session["elapsed_min"] >= template["time_limit_minutes"])
    if out_of_time or len(history) >= MAX_QUESTIONS:
        end_session(db, sid)
        db.commit()
        return {"done": True, "reason": "time or question limit reached"}

    bank_remaining = [
        {"id": str(r["id"]), "text": r["question_text"],
         "topic": r["topic"], "difficulty": r["difficulty"]}
        for r in db.execute(
            text("""SELECT id, question_text, topic, difficulty FROM questions
                    WHERE exam_template_id = :t
                      AND id NOT IN (SELECT source_question_id FROM interactions
                                     WHERE session_id = CAST(:sid AS uuid)
                                       AND source_question_id IS NOT NULL)"""),
            {"t": session["exam_template_id"], "sid": sid},
        ).mappings().all()
    ]

    decision = ask_model(template, history, bank_remaining)

    if decision.get("end_exam"):
        end_session(db, sid)
        db.commit()
        return {"done": True, "reason": decision.get("reasoning")}

    bank_by_id = {b["id"]: b for b in bank_remaining}
    chosen = bank_by_id.get(str(decision.get("bank_question_id")))
    if chosen:
        question, source, source_id = chosen["text"], "bank", chosen["id"]
    elif decision.get("question"):
        question, source, source_id = decision["question"], "generated", None
    else:
        end_session(db, sid)
        db.commit()
        return {"done": True, "reason": "Model returned no next question"}

    seq = pending["sequence_num"] + 1
    insert_question(db, sid, seq, question, source, source_id,
                    decision.get("reasoning"))
    db.commit()
    return {"done": False, "sequence_num": seq, "question": question}
