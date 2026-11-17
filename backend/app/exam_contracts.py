"""Shared answer identity and durable replay; the caller holds the attempt row lock.

The receipt is committed in the SAME transaction as the answer and next question.
No transcript or private model output is stored in a receipt fingerprint.
"""
import hashlib
import json
from enum import Enum

from fastapi import HTTPException
from sqlalchemy import text


class MediaState(str, Enum):
    acquiring_permission = "acquiring_permission"
    ready = "ready"
    capturing = "capturing"
    uploading = "uploading"
    interrupted = "interrupted"
    reconnecting = "reconnecting"
    processing = "processing"
    complete = "complete"
    failed = "failed"
    expired = "expired"


def answer_fingerprint(request):
    payload = request.model_dump(mode="json", exclude={"request_id"})
    return hashlib.sha256(json.dumps(payload, sort_keys=True, ensure_ascii=False,
                                    separators=(",", ":")).encode("utf-8")).hexdigest()


def replay_answer(db, request):
    if request.request_id is None:
        return None
    row = db.execute(text("""SELECT input_hash, response FROM exam_answer_operations
        WHERE session_id = CAST(:sid AS uuid) AND request_id = CAST(:rid AS uuid)"""),
        {"sid": str(request.session_id), "rid": str(request.request_id)}).mappings().first()
    if row is None:
        return None
    if row["input_hash"] != answer_fingerprint(request):
        raise HTTPException(409, "This request ID was already used for a different answer.")
    response = row["response"]
    return json.loads(response) if isinstance(response, str) else dict(response)


def remember_answer(db, request, response):
    if request.request_id is not None:
        db.execute(text("""INSERT INTO exam_answer_operations
            (session_id, request_id, question_sequence_num, input_hash, response)
            VALUES (CAST(:sid AS uuid), CAST(:rid AS uuid), :seq, :hash, CAST(:response AS jsonb))"""),
            {"sid": str(request.session_id), "rid": str(request.request_id),
             "seq": request.question_sequence_num, "hash": answer_fingerprint(request),
             "response": json.dumps(response)})
    return response


def answer_metadata(request, accepted):
    # Timeout placeholders are server events, never confirmed speech or typed text.
    return {"input_source": request.input_source if accepted == request.answer_transcript else "timeout",
            "answer_revision": str(request.request_id) if request.request_id else None}
