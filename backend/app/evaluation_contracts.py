"""Validate all private provisional scores before inserting any grade."""
import math
import json
from fastapi import HTTPException


def evaluation_output_schema(criteria):
    """Constrain provider output shape; validation below still enforces each bound.

    JSON mode alone permits any JSON object, including an echo of the exam input.
    Per-criterion completeness, uniqueness and exact score bounds remain server
    checks, independent of whether a provider honors its decoding schema.
    """
    return {"type": "object", "additionalProperties": False, "required": ["scores"],
        "properties": {"scores": {"type": "array", "minItems": len(criteria), "maxItems": len(criteria),
            "items": {"type": "object", "additionalProperties": False,
                "required": ["criterion", "score", "rationale"], "properties": {
                    "criterion": {"type": "string", "enum": [item["name"] for item in criteria]},
                    "score": {"type": "number", "minimum": 0, "maximum": max(item["max_score"] for item in criteria)},
                    "rationale": {"type": "string", "maxLength": 4000}}}}}}


def completed_evaluation(envelope, criteria):
    """Reject incomplete, echoed or malformed output before saving any grades."""
    if (not isinstance(envelope, dict) or envelope.get("done") is not True
            or envelope.get("done_reason") != "stop"):
        raise HTTPException(502, "The evaluation provider did not finish a complete assessment. No grades were saved.")
    message = envelope.get("message")
    content = message.get("content") if isinstance(message, dict) else None
    if not isinstance(content, str) or not 1 <= len(content) <= 100000:
        raise HTTPException(502, "The evaluation provider returned an invalid assessment. No grades were saved.")
    try:
        result = json.loads(content)
    except (ValueError, TypeError):
        raise HTTPException(502, "The evaluation provider returned an invalid assessment. No grades were saved.") from None
    return validate_evaluation(result, criteria)


def validate_evaluation(result, criteria):
    def invalid():
        raise HTTPException(502, "The evaluation provider returned invalid provisional scores. No grades were saved.")

    expected = {item['name'].strip().lower(): item['max_score'] for item in criteria}
    if len(expected) != len(criteria) or any(not math.isfinite(v) or v <= 0 for v in expected.values()):
        raise HTTPException(422, "The professor rubric needs unique criteria and finite positive score bounds.")
    if not isinstance(result, dict) or not {'scores'} <= set(result) <= {'scores', 'questions'} or not isinstance(result['scores'], list):
        invalid()
    scores = {}
    for item in result['scores']:
        if not isinstance(item, dict) or set(item) != {'criterion', 'score', 'rationale'}:
            invalid()
        if not isinstance(item['criterion'], str) or not isinstance(item['rationale'], str) or len(item['rationale']) > 4000:
            invalid()
        name, score = item['criterion'].strip().lower(), item['score']
        if name not in expected or name in scores or isinstance(score, bool) or not isinstance(score, (int, float)):
            invalid()
        if not math.isfinite(score) or not 0 <= score <= expected[name]:
            invalid()
        scores[name] = item
    if scores.keys() != expected.keys():
        invalid()
    return scores
