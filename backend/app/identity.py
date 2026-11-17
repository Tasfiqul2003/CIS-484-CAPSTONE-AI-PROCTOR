import secrets
import time

from fastapi import APIRouter, File, Form, HTTPException, UploadFile

router = APIRouter(
    prefix="/identity",
    tags=["Identity Verification"]
)

CHALLENGES = {}
MAX_VIDEO_SIZE = 50 * 1024 * 1024


@router.post("/challenge")
def create_challenge():
    now = time.monotonic()

    for key, (_, expiry) in list(CHALLENGES.items()):
        if expiry <= now:
            del CHALLENGES[key]

    challenge_id = secrets.token_urlsafe(24)
    code = f"{secrets.randbelow(1_000_000):06d}"

    CHALLENGES[challenge_id] = (code, now + 300)

    return {
        "challenge_id": challenge_id,
        "code": code,
        "expires_in_seconds": 300
    }


@router.post("/verify")
async def verify_identity(
    video: UploadFile = File(...),
    challenge_id: str = Form(...)
):
    try:
        challenge = CHALLENGES.pop(challenge_id, None)

        if challenge is None:
            raise HTTPException(
                status_code=400,
                detail="Invalid or already-used challenge."
            )

        expected_code, expiry = challenge

        if time.monotonic() > expiry:
            raise HTTPException(
                status_code=400,
                detail="Verification challenge expired."
            )

        content_type = (
            video.content_type or ""
        ).split(";")[0].lower()

        if content_type not in {"video/webm", "video/mp4"}:
            raise HTTPException(
                status_code=415,
                detail="Unsupported video format."
            )

        total_bytes = 0

        while True:
            chunk = await video.read(1024 * 1024)

            if not chunk:
                break

            total_bytes += len(chunk)

            if total_bytes > MAX_VIDEO_SIZE:
                raise HTTPException(
                    status_code=413,
                    detail="Recording exceeds 50 MB."
                )

        if total_bytes == 0:
            raise HTTPException(
                status_code=400,
                detail="Recording is empty."
            )

        return {
            "verified": False,
            "message": (
                "Recording and challenge received. "
                "Identity verification is not implemented yet."
            )
        }

    finally:
        await video.close()
