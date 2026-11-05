"""Exam-owned extended time assignments; only future whole-exam clocks use them."""

import csv
import io
from uuid import UUID

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from pydantic import BaseModel, ConfigDict, Field, field_validator
from sqlalchemy import text
from sqlalchemy.orm import Session

from .auth import require_professor
from .db import get_db
from .time_settings import owned_time


router = APIRouter(prefix="/exam/templates", tags=["exam"])
ALLOWED_MULTIPLIERS = (1.25, 1.5, 2.0, 3.0)
FORM_MULTIPLIERS = {"1.25": 1.25, "1.5": 1.5, "2": 2.0, "3": 3.0}
MAX_UPLOAD_BYTES = 1_048_576
MAX_UPLOAD_ROWS = 5_000
MAX_EID_LENGTH = 200


def normalize_eid(value: str) -> str:
    value = value.strip()
    if not value or len(value) > MAX_EID_LENGTH or any(ord(char) < 32 for char in value):
        raise ValueError("EID must contain 1–200 characters without control characters.")
    return value.casefold()


class AccommodationAssignment(BaseModel):
    model_config = ConfigDict(extra="forbid")
    eid: str = Field(strict=True, min_length=1, max_length=MAX_EID_LENGTH)
    extended_time_multiplier: float = Field(strict=True)

    @field_validator("eid")
    @classmethod
    def valid_eid(cls, value):
        normalize_eid(value)
        return value.strip()

    @field_validator("extended_time_multiplier")
    @classmethod
    def valid_multiplier(cls, value):
        if value not in ALLOWED_MULTIPLIERS:
            raise ValueError("Extended time multiplier must be 1.25, 1.5, 2, or 3.")
        return value


def _validate_csv_quotes(content: str) -> None:
    """Reject bare or trailing quotes that Python's CSV reader can otherwise accept."""
    quoted = False
    field_start = True
    closed_quote = False
    position = 0
    while position < len(content):
        char = content[position]
        if quoted:
            if char == '"':
                if position + 1 < len(content) and content[position + 1] == '"':
                    position += 1
                else:
                    quoted = False
                    closed_quote = True
        elif char in ",\r\n":
            field_start = True
            closed_quote = False
        elif char == '"' and field_start:
            quoted = True
            field_start = False
        elif char == '"' or closed_quote:
            raise HTTPException(400, "The CSV contains malformed quoting.")
        else:
            field_start = False
        position += 1
    if quoted:
        raise HTTPException(400, "The CSV contains malformed quoting.")


def parse_eid_csv(content: bytes) -> list[str]:
    """Validate an EID-only file fully, before looking up or changing identities."""
    if len(content) > MAX_UPLOAD_BYTES:
        raise HTTPException(413, "The CSV must be no larger than 1 MiB.")
    try:
        decoded = content.decode("utf-8-sig")
    except UnicodeDecodeError:
        raise HTTPException(400, "The CSV must use UTF-8 encoding.")
    _validate_csv_quotes(decoded)
    reader = csv.reader(io.StringIO(decoded, newline=""), strict=True)
    try:
        headers = next(reader, None)
        if headers is None or [header.strip().casefold() for header in headers] != ["eid"]:
            raise HTTPException(400, "The CSV must contain exactly one column with the header eid.")
        eids = []
        seen = set()
        for row in reader:
            if len(eids) >= MAX_UPLOAD_ROWS:
                raise HTTPException(400, "The CSV must contain no more than 5000 EIDs.")
            if len(row) != 1:
                raise HTTPException(400, f"CSV row {reader.line_num} must contain exactly one EID.")
            try:
                normalized = normalize_eid(row[0])
            except ValueError as error:
                raise HTTPException(400, f"CSV row {reader.line_num}: {error}")
            if normalized in seen:
                raise HTTPException(400, f"CSV row {reader.line_num} repeats an EID.")
            seen.add(normalized)
            eids.append(row[0].strip())
    except csv.Error:
        raise HTTPException(400, "The CSV contains a malformed row.")
    if not eids:
        raise HTTPException(400, "The CSV contains no EIDs.")
    return eids


def _payload(db, exam_id, account):
    limits = owned_time(db, exam_id, account)
    rows = db.execute(text("""SELECT s.id AS student_id, s.eid, s.name,
            r.extended_time_multiplier
        FROM exam_roster r JOIN students s ON s.id = r.student_id
        WHERE r.exam_template_id = :exam_id AND r.extended_time_multiplier IS NOT NULL
        ORDER BY lower(s.name), s.id"""), {"exam_id": str(exam_id)}).mappings().all()
    assignments = []
    for row in rows:
        multiplier = float(row["extended_time_multiplier"])
        assignments.append({
            "student_id": str(row["student_id"]), "eid": row["eid"], "name": row["name"],
            "extended_time_multiplier": multiplier,
            "effective_time_limit_minutes": (limits["time_limit_minutes"] * multiplier
                                             if limits["time_limit_minutes"] is not None else None),
        })
    return {**limits, "assignments": assignments}


def _resolve_roster_eids(db, exam_id, eids):
    rows = db.execute(text("""SELECT s.id AS student_id, s.eid
        FROM exam_roster r JOIN students s ON s.id = r.student_id
        WHERE r.exam_template_id = :exam_id"""), {"exam_id": str(exam_id)}).mappings().all()
    matches = {}
    for row in rows:
        try:
            key = normalize_eid(row["eid"]) if row["eid"] is not None else None
        except ValueError:
            continue
        if key is not None:
            matches.setdefault(key, []).append(str(row["student_id"]))
    resolved = []
    for eid in eids:
        students = matches.get(normalize_eid(eid), [])
        if not students:
            raise HTTPException(404, f"EID {eid} is not on this exam roster.")
        if len(students) != 1:
            raise HTTPException(409, f"EID {eid} matches multiple roster students. Correct the roster first.")
        resolved.append(students[0])
    return resolved


def _save_assignments(db, exam_id, account, eids, multiplier):
    try:
        # Resolve every identity before the first UPDATE, including the last CSV row.
        student_ids = _resolve_roster_eids(db, exam_id, eids)
        for student_id in student_ids:
            result = db.execute(text("""UPDATE exam_roster SET extended_time_multiplier = :multiplier
                WHERE exam_template_id = :exam_id AND student_id = :student_id
                  AND EXISTS (SELECT 1 FROM exam_templates
                    WHERE id = :exam_id AND professor_id = :professor_id)"""),
                {"multiplier": multiplier, "exam_id": str(exam_id), "student_id": student_id,
                 "professor_id": str(account["professor_id"])})
            if result.rowcount != 1:
                raise HTTPException(409, "The exam roster changed. Reload and try again.")
        response = _payload(db, exam_id, account)
        db.commit()
        return response
    except HTTPException:
        db.rollback()
        raise
    except Exception:
        db.rollback()
        raise HTTPException(500, "Unable to save accommodations. No changes were saved.")


@router.get("/{exam_id}/ods-accommodations")
def get_accommodations(exam_id: UUID, account: dict = Depends(require_professor), db: Session = Depends(get_db)):
    return _payload(db, exam_id, account)


@router.put("/{exam_id}/ods-accommodations")
def assign_accommodation(exam_id: UUID, body: AccommodationAssignment,
                         account: dict = Depends(require_professor), db: Session = Depends(get_db)):
    owned_time(db, exam_id, account)
    return _save_assignments(db, exam_id, account, [body.eid], body.extended_time_multiplier)


@router.post("/{exam_id}/ods-accommodations/upload")
async def upload_accommodations(exam_id: UUID, file: UploadFile = File(...),
                                 extended_time_multiplier: str = Form(...),
                                 account: dict = Depends(require_professor), db: Session = Depends(get_db)):
    owned_time(db, exam_id, account)
    multiplier = FORM_MULTIPLIERS.get(extended_time_multiplier.strip())
    if multiplier is None:
        raise HTTPException(400, "Extended time multiplier must be 1.25, 1.5, 2, or 3.")
    if not file.filename or not file.filename.lower().endswith(".csv"):
        raise HTTPException(400, "Upload a CSV file.")
    eids = parse_eid_csv(await file.read(MAX_UPLOAD_BYTES + 1))
    return _save_assignments(db, exam_id, account, eids, multiplier)


@router.delete("/{exam_id}/ods-accommodations/{student_id}")
def remove_accommodation(exam_id: UUID, student_id: UUID,
                         account: dict = Depends(require_professor), db: Session = Depends(get_db)):
    owned_time(db, exam_id, account)
    try:
        result = db.execute(text("""UPDATE exam_roster SET extended_time_multiplier = NULL
            WHERE exam_template_id = :exam_id AND student_id = :student_id
              AND EXISTS (SELECT 1 FROM exam_templates
                WHERE id = :exam_id AND professor_id = :professor_id)"""),
            {"exam_id": str(exam_id), "student_id": str(student_id),
             "professor_id": str(account["professor_id"])})
        if result.rowcount != 1:
            raise HTTPException(404, "Student not found on this exam roster.")
        response = _payload(db, exam_id, account)
        db.commit()
        return response
    except HTTPException:
        db.rollback()
        raise
    except Exception:
        db.rollback()
        raise HTTPException(500, "Unable to remove the accommodation. No changes were saved.")
