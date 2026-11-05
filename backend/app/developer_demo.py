"""Explicit developer-only substitutes; never a source of assessment results."""

import os

import httpx
from fastapi import APIRouter

router = APIRouter(prefix="/developer", tags=["developer"])


def demo_enabled() -> bool:
    return os.getenv("DEVELOPER_DEMO_MODE") == "1"


def demo_for_session(session) -> bool:
    """A runtime switch can never convert an existing assessed attempt."""
    return demo_enabled() and bool(session.get("developer_demo", False))


def ai_available(url=None, model=None) -> bool:
    """Probe installed model metadata only; never generate or download a model."""
    url = url or os.getenv("OLLAMA_URL", "http://ollama:11434")
    model = model or os.getenv("OLLAMA_MODEL", "llama3.1")
    wanted = model if ":" in model else f"{model}:latest"
    try:
        response = httpx.get(f"{url.rstrip('/')}/api/tags",
                            timeout=httpx.Timeout(1.5, connect=0.5))
        response.raise_for_status()
        models = response.json().get("models", [])
        return any(isinstance(item, dict) and
                   (item.get("name") or item.get("model")) in (model, wanted)
                   for item in models)
    except (httpx.HTTPError, ValueError, TypeError, AttributeError):
        return False


def demo_question(sequence) -> str:
    samples = (
        "Describe one concept you would like to practice and give an example.",
        "What steps would you use to explain that example to another learner?",
        "What additional information would help you examine your explanation?",
        "How could you compare two approaches to the concept you selected?",
        "What assumptions would you check before applying your example?",
        "How would you describe a limitation of the approach you discussed?",
        "What change to your example would help you practice a different case?",
        "Which part of your explanation would you revisit with your professor?",
    )
    return "[Developer demo] " + samples[(max(1, sequence) - 1) % len(samples)]


def demo_assistance(action, question) -> str:
    samples = {
        "clarification": "Read the current question one part at a time and describe what it asks you to explain.",
        "hint": "Try stating a concept, then adding a concrete example and the steps that connect them.",
        "explanation": "This sample demonstrates the help panel only. Refer to your professor's materials for the course explanation.",
        "correctness": "This sample does not assess correctness or assign a grade. A professor must evaluate the answer using the actual rubric.",
    }
    return "[Developer demo] " + samples[action]


def demo_summary(extracted_text) -> str:
    excerpt = " ".join(extracted_text.split())[:600]
    return "[Developer demo] Source excerpt only — not an AI summary: " + excerpt


@router.get("/capabilities")
def capabilities():
    if not demo_enabled():
        return {"enabled": False}
    return {"enabled": True, "ai_available": ai_available(),
            "substitutes": {"questions": True, "assistance": True, "material_summary": True}}
