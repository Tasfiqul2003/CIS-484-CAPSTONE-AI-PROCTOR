"""Signed machine-draft provenance; confirmation and answer submission stay separate."""

from datetime import datetime, timedelta, timezone
import hashlib

from fastapi import HTTPException
import jwt

from .auth import get_secret


def issue_transcript_receipt(*, student_id, session_id, interaction_id, sequence_num,
                             draft_id, machine_draft, student_token_exp):
    expires = min(datetime.now(timezone.utc) + timedelta(hours=1),
                  datetime.fromtimestamp(student_token_exp, timezone.utc))
    return jwt.encode({"sub": str(student_id), "session_id": str(session_id),
        "interaction_id": str(interaction_id), "sequence_num": sequence_num,
        "draft_id": str(draft_id), "machine_draft_hash": hashlib.sha256(machine_draft.encode("utf-8")).hexdigest(),
        "purpose": "transcript_draft", "exp": expires}, get_secret(), algorithm="HS256")


def verify_transcript_receipt(receipt, *, student_id, session_id, interaction_id,
                              sequence_num, draft_id, machine_draft):
    """Validate trusted draft provenance against the currently authorized interaction.

    Student corrections belong to answer_transcript; machine_draft must remain
    identical to the provider draft attested here. Never log receipt or draft.
    """
    try:
        if not isinstance(receipt, str) or not 1 <= len(receipt) <= 4096:
            raise ValueError("Missing receipt")
        if not isinstance(machine_draft, str) or not 1 <= len(machine_draft) <= 8000:
            raise ValueError("Missing draft")
        claims = jwt.decode(receipt, get_secret(), algorithms=["HS256"],
            options={"require": ["sub", "session_id", "interaction_id", "sequence_num",
                                 "draft_id", "machine_draft_hash", "purpose", "exp"]})
        expected = {"sub": str(student_id), "session_id": str(session_id),
            "interaction_id": str(interaction_id), "sequence_num": sequence_num,
            "draft_id": str(draft_id), "machine_draft_hash": hashlib.sha256(machine_draft.encode("utf-8")).hexdigest(),
            "purpose": "transcript_draft"}
        if (type(claims["sequence_num"]) is not int or
                any(claims.get(key) != value for key, value in expected.items())):
            raise ValueError("Wrong draft context")
    except (jwt.InvalidTokenError, ValueError, TypeError, OverflowError):
        raise HTTPException(422, "Transcript draft provenance is invalid or expired. Transcribe again or type your answer.") from None
