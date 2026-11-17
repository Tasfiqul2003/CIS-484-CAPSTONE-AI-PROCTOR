"""Remove expired media only. Run using the backend's volume and database."""
from pathlib import Path
import re
from uuid import UUID

from sqlalchemy import text

from .db import open_session
from .exam_video import _recording_root, _safe_path


def _remove_media(root: Path, sid: UUID):
    # Never recurse, follow links, or delete arbitrary DB/client-supplied paths.
    directory = _safe_path(root / str(sid))
    chunks = _safe_path(directory / 'chunks')
    candidates = [root / f'{sid}.webm', root / f'{sid}.assembling']
    if chunks.exists():
        for path in chunks.iterdir():
            _safe_path(path)
            if not re.fullmatch(r'\d{8}\.(chunk|tmp)', path.name) or not path.is_file():
                raise RuntimeError('Unexpected recording storage entry; cleanup stopped.')
            candidates.append(path)
    for path in candidates:
        _safe_path(path)
        if path.exists():
            if not path.is_file():
                raise RuntimeError('Unexpected recording storage entry; cleanup stopped.')
            path.unlink()
    if chunks.exists():
        chunks.rmdir()
    if directory.exists():
        directory.rmdir()


def purge_expired_videos():
    root = _recording_root()
    db = open_session()
    try:
        # Include expired rows so an interrupted earlier cleanup is retryable.
        rows = db.execute(text('''SELECT session_id FROM exam_session_videos
            WHERE expires_at <= now() FOR UPDATE''')).scalars().all()
        for raw_sid in rows:
            sid = UUID(str(raw_sid))
            _remove_media(root, sid)
            db.execute(text('''UPDATE exam_session_videos SET status = 'expired',
                generated_transcript = NULL,
                transcript_status = CASE WHEN transcript_status = 'not_requested'
                    THEN 'not_requested' ELSE 'expired' END, updated_at = now()
                WHERE session_id = CAST(:sid AS uuid)'''), {'sid': str(sid)})
        db.commit()
        return len(rows)
    except Exception:
        db.rollback()
        raise
    finally:
        db.close()


if __name__ == '__main__':
    print(f'Expired recording entries processed: {purge_expired_videos()}')
