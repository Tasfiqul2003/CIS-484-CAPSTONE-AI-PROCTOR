import json

import httpx
from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse
from sqlalchemy import text

from .db import open_session
from .exam import (
    MAX_QUESTIONS,
    OLLAMA_MODEL,
    OLLAMA_URL,
    AnswerRequest,
    end_session,
    insert_question,
)

router = APIRouter(prefix="/exam", tags=["streaming"])

DECISION_PROMPT = """You are an oral exam proctor. Given the rubric, required topics,
the conversation so far, and the unused bank questions, decide what happens next.
Reply ONLY with JSON in exactly this shape:
{"reasoning": "<1-2 sentences: is the student's last answer correct, partially correct,
               or wrong, and why; then why you chose the next step>",
 "action": "end" | "bank" | "follow_up",
 "bank_question_id": "<id from the list, only when action is bank>",
 "follow_up_focus": "<what the follow-up should probe, only when action is follow_up>"}
Use "bank" when an unused bank question fits the required topics. Use "follow_up" to
dig into a weak or vague answer. Use "end" once required topics are covered or the
student has clearly shown their level."""

QUESTION_PROMPT = """You are an oral exam proctor speaking to a student. Ask exactly ONE
question, phrased so it can be read aloud. Output only the question text: no preamble,
no quotation marks, no numbering."""


def sse(event: str, data: dict) -> str:
    return f"event: {event}\ndata: {json.dumps(data)}\n\n"


def decide(plan, bank_remaining):
    payload = {
        "topics_required": plan["topics"],
        "difficulty_curve": plan["curve"],
        "history": plan["history"],
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
                    {"role": "system", "content": DECISION_PROMPT},
                    {"role": "user", "content": json.dumps(payload, default=str)},
                ],
            },
            timeout=180,
        )
        r.raise_for_status()
        return json.loads(r.json()["message"]["content"])
    except (httpx.HTTPError, json.JSONDecodeError, KeyError) as e:
        raise HTTPException(502, f"Ollama decision call failed: {e}")


def plan_turn(req: AnswerRequest) -> dict:
    """Validate and decide. Writes nothing; HTTP errors are raised before streaming starts."""
    sid = str(req.session_id)
    db = open_session()
    try:
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
        for h in history:  # include the answer we haven't saved yet
            if h["sequence_num"] == pending["sequence_num"]:
                h["answer"] = req.answer_transcript

        plan = {
            "sid": sid,
            "pending_id": pending["id"],
            "seq": pending["sequence_num"] + 1,
            "answer": req.answer_transcript,
            "ts": req.answer_timestamp_start,
            "te": req.answer_timestamp_end,
            "history": history,
            "topics": template["topic_coverage_required"],
            "curve": template["difficulty_curve"],
        }

        out_of_time = (template["time_limit_minutes"] is not None
                       and session["elapsed_min"] >= template["time_limit_minutes"])
        if out_of_time or len(history) >= MAX_QUESTIONS:
            return {**plan, "kind": "done", "reason": "time or question limit reached"}

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
    finally:
        db.close()

    decision = decide(plan, bank_remaining)
    plan["reasoning"] = decision.get("reasoning")
    action = decision.get("action")
    bank_by_id = {b["id"]: b for b in bank_remaining}
    chosen = bank_by_id.get(str(decision.get("bank_question_id")))

    if action == "end":
        return {**plan, "kind": "done", "reason": plan["reasoning"]}
    if action == "bank" and chosen:
        return {**plan, "kind": "bank", "question": chosen["text"], "source_id": chosen["id"]}
    if decision.get("follow_up_focus"):
        return {**plan, "kind": "generate", "focus": decision["follow_up_focus"]}
    if bank_remaining:  # model gave nothing usable: fall back to the next bank question
        b = bank_remaining[0]
        return {**plan, "kind": "bank", "question": b["text"], "source_id": b["id"]}
    return {**plan, "kind": "done", "reason": "No further questions available"}


def save_answer(db, plan):
    db.execute(
        text("""UPDATE interactions
                SET student_answer_transcript = :a,
                    answer_timestamp_start = :ts, answer_timestamp_end = :te
                WHERE id = :id"""),
        {"a": plan["answer"], "ts": plan["ts"], "te": plan["te"], "id": plan["pending_id"]},
    )


def finish_done(plan):
    db = open_session()
    try:
        save_answer(db, plan)
        end_session(db, plan["sid"])
        db.commit()
    finally:
        db.close()


def finish_question(plan, question, source, source_id):
    db = open_session()
    try:
        save_answer(db, plan)
        insert_question(db, plan["sid"], plan["seq"], question, source, source_id,
                        plan["reasoning"])
        db.commit()
    finally:
        db.close()


def event_stream(plan):
    kind = plan["kind"]

    if kind == "done":
        finish_done(plan)
        yield sse("done", {"reason": plan["reason"]})
        return

    if kind == "bank":
        finish_question(plan, plan["question"], "bank", plan["source_id"])
        yield sse("token", {"text": plan["question"]})
        yield sse("complete", {"sequence_num": plan["seq"], "question": plan["question"],
                               "source": "bank"})
        return

    # kind == "generate": stream the follow-up question as the model writes it
    payload = {"focus": plan["focus"], "topics_required": plan["topics"],
               "difficulty_curve": plan["curve"], "history": plan["history"]}
    parts = []
    try:
        with httpx.stream(
            "POST",
            f"{OLLAMA_URL}/api/chat",
            json={
                "model": OLLAMA_MODEL,
                "stream": True,
                "options": {"temperature": 0.5},
                "messages": [
                    {"role": "system", "content": QUESTION_PROMPT},
                    {"role": "user", "content": json.dumps(payload, default=str)},
                ],
            },
            timeout=httpx.Timeout(300, connect=10),
        ) as r:
            r.raise_for_status()
            for line in r.iter_lines():
                if not line:
                    continue
                chunk = json.loads(line)
                token = chunk.get("message", {}).get("content", "")
                if token:
                    parts.append(token)
                    yield sse("token", {"text": token})
                if chunk.get("done"):
                    break
    except (httpx.HTTPError, json.JSONDecodeError) as e:
        yield sse("error", {"detail": f"Ollama streaming failed: {e}"})
        return

    question = "".join(parts).strip()
    if not question:
        yield sse("error", {"detail": "Model returned an empty question"})
        return

    finish_question(plan, question, "generated", None)
    yield sse("complete", {"sequence_num": plan["seq"], "question": question,
                           "source": "generated"})


@router.post("/answer/stream")
def answer_stream(req: AnswerRequest):
    plan = plan_turn(req)  # 404/409/502 come back as normal HTTP errors
    return StreamingResponse(
        event_stream(plan),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )
