from uuid import UUID

from sqlalchemy import text

from .db import open_session
from .exam_video import _recording_root


def purge_expired_videos() -> int:
    root = _recording_root()
    db = open_session()
    try:
        expired = db.execute(
            text("""SELECT session_id
                    FROM exam_session_videos
                    WHERE status != 'expired' AND expires_at <= now()
                    FOR UPDATE""")
        ).scalars().all()
        for raw_session_id in expired:
            session_id = UUID(str(raw_session_id))
            final_path = root / f"{session_id}.webm"
            temp_path = root / f".{session_id}.webm.tmp"
            for path in (final_path, temp_path):
                if path.is_file() or path.is_symlink():
                    path.unlink()

            session_dir = root / str(session_id)
            chunks_dir = session_dir / "chunks"
            if chunks_dir.is_dir() and not chunks_dir.is_symlink():
                for chunk_path in chunks_dir.iterdir():
                    if not chunk_path.is_file() or chunk_path.is_symlink():
                        raise RuntimeError(
                            f"Unexpected item in recording directory for {session_id}."
                        )
                    if not chunk_path.name.endswith(".chunk"):
                        raise RuntimeError(
                            f"Unexpected recording chunk name for {session_id}."
                        )
                    chunk_path.unlink()
                chunks_dir.rmdir()
            if session_dir.is_dir() and not session_dir.is_symlink():
                session_dir.rmdir()

            db.execute(
                text("""UPDATE exam_session_videos
                        SET status = 'expired', file_name = NULL,
                            total_bytes = 0, next_chunk_index = 0
                        WHERE session_id = CAST(:sid AS uuid)"""),
                {"sid": str(session_id)},
            )
        db.commit()
        return len(expired)
    finally:
        db.close()


if __name__ == "__main__":
    print(f"Expired exam recordings removed: {purge_expired_videos()}")
