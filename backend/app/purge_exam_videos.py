"""Explicit recording maintenance; never scheduled or run at application startup."""

import argparse
import json
from dataclasses import asdict, dataclass, field
from pathlib import Path
from uuid import UUID

from sqlalchemy import text
from sqlalchemy.exc import SQLAlchemyError

from .db import open_session
from .exam_video import _recording_root


@dataclass
class PurgeReport:
    dry_run: bool
    eligible: int = 0
    removed: int = 0
    failed: list[str] = field(default_factory=list)
    question_audio_assets_expired: int = 0
    question_audio_files_removed: int = 0
    orphan_files_removed: int = 0


def _audio_inventory(root: Path, session_id: UUID) -> list[Path]:
    """Inspect only canonical UUID WAVs, without following links or junctions."""
    root = root.resolve()
    base = root / "question-audio"
    directory = base / str(session_id)
    if (base.is_symlink() or base.resolve().parent != root
            or directory.is_symlink() or directory.resolve().parent != base.resolve()):
        raise OSError("Unexpected question audio directory redirection.")
    if base.exists() and not base.is_dir():
        raise OSError("Invalid question audio root.")
    if not directory.exists():
        return []
    if not directory.is_dir():
        raise OSError("Invalid question audio attempt directory.")
    paths = list(directory.iterdir())
    for path in paths:
        if (path.is_symlink() or not path.is_file()
                or path.resolve().parent != directory.resolve() or path.suffix not in (".wav", ".mp4")):
            raise OSError("Unexpected question audio file.")
        try:
            if str(UUID(path.stem)) != path.stem:
                raise ValueError("Noncanonical asset name")
        except ValueError:
            raise OSError("Unexpected question audio asset name.") from None
    return paths


def _remove_audio_files(root: Path, session_id: UUID, paths: list[Path]) -> None:
    for path in paths:
        path.unlink(missing_ok=True)
    directory = root / "question-audio" / str(session_id)
    if directory.is_dir() and not any(directory.iterdir()):
        directory.rmdir()


def _remove_recording_files(root: Path, session_id: UUID) -> None:
    """Validate the complete inventory before unlinking any files for this attempt."""
    session_dir = root / str(session_id)
    chunks_dir = session_dir / "chunks"
    if session_dir.is_symlink() or chunks_dir.is_symlink():
        raise OSError("Unexpected link in recording storage.")
    if session_dir.resolve().parent != root.resolve():
        raise OSError("Recording directory leaves configured storage.")
    if chunks_dir.resolve().parent != session_dir.resolve():
        raise OSError("Chunk directory leaves recording storage.")

    paths = [root / f"{session_id}.webm", root / f".{session_id}.webm.tmp"]
    if session_dir.exists():
        if not session_dir.is_dir() or any(p.name != "chunks" for p in session_dir.iterdir()):
            raise OSError("Unexpected recording directory contents.")
    if chunks_dir.exists():
        if not chunks_dir.is_dir():
            raise OSError("Invalid chunk directory.")
        for path in chunks_dir.iterdir():
            if not path.name.endswith(".chunk") or not path.name[:-6].isdigit():
                raise OSError("Unexpected recording chunk name.")
            paths.append(path)

    for path in paths:
        if path.is_symlink() or (path.exists() and not path.is_file()):
            raise OSError("Unexpected recording file type.")
    for path in paths:
        path.unlink(missing_ok=True)
    if chunks_dir.exists():
        chunks_dir.rmdir()
    if session_dir.exists():
        session_dir.rmdir()


def purge_expired_video_report(*, dry_run: bool = False) -> PurgeReport:
    """Delete only expired recording assets; report partial failures for a later retry.

    Playback independently rejects elapsed deadlines. Failed cleanup retains its
    metadata and is selected again; successful cleanup is idempotently skipped.
    A live-storage purge does not remove copies from any backup.
    """
    root = _recording_root(write_required=False)
    db = open_session()
    report = PurgeReport(dry_run=dry_run)
    try:
        try:
            # Check the complete new schema before deleting ANY files. An older
            # deployment must not report a full purge while ignoring question WAVs.
            db.execute(text("SELECT id FROM exam_question_audio LIMIT 0"))
            db.execute(text("SELECT asset_id FROM exam_question_audio_requests LIMIT 0"))
        except SQLAlchemyError:
            raise RuntimeError("Question audio cleanup requires the reviewed media migrations before use.") from None
        suffix = " FOR UPDATE OF s, v SKIP LOCKED" if db.get_bind().dialect.name == "postgresql" else ""
        expired = db.execute(text("""SELECT v.session_id, v.status,
                v.expires_at <= CURRENT_TIMESTAMP AS recording_expired
            FROM exam_session_videos v JOIN exam_sessions s ON s.id = v.session_id
            WHERE v.expires_at <= CURRENT_TIMESTAMP OR EXISTS (
                SELECT 1 FROM exam_question_audio a WHERE a.session_id = v.session_id
                AND a.expires_at <= CURRENT_TIMESTAMP)""" + suffix)).mappings().all()
        for attempt in expired:
            session_id = UUID(str(attempt["session_id"]))
            recording_expired = bool(attempt["recording_expired"])
            assets = db.execute(text("""SELECT id, status,
                expires_at <= CURRENT_TIMESTAMP AS asset_expired
                FROM exam_question_audio WHERE session_id = :sid"""),
                {"sid": str(session_id)}).mappings().all()
            expired_assets = [asset for asset in assets if recording_expired or asset["asset_expired"]]
            expired_ids = {str(asset["id"]) for asset in expired_assets}
            all_asset_ids = {str(asset["id"]) for asset in assets}
            metadata_pending = [asset for asset in expired_assets if asset["status"] != "expired"]
            try:
                inventory = _audio_inventory(root, session_id)
                selected = [path for path in inventory if recording_expired or path.stem in expired_ids]
                recording_paths = (root / f"{session_id}.webm", root / f".{session_id}.webm.tmp", root / str(session_id))
                recording_pending = recording_expired and (attempt["status"] != "expired"
                    or any(path.exists() or path.is_symlink() for path in recording_paths))
                if not recording_pending and not metadata_pending and not selected:
                    continue
                report.eligible += 1
                if dry_run:
                    continue
                if recording_expired:
                    _remove_recording_files(root, session_id)
                _remove_audio_files(root, session_id, selected)
            except OSError:
                # Avoid exposing paths or OS diagnostics containing private data.
                report.failed.append(str(session_id))
                continue
            if recording_expired:
                db.execute(text("""UPDATE exam_session_videos
                        SET status = 'expired', file_name = NULL,
                            total_bytes = 0, next_chunk_index = 0
                        WHERE session_id = :sid"""), {"sid": str(session_id)})
            for asset in metadata_pending:
                db.execute(text("UPDATE exam_question_audio SET status = 'expired' WHERE id = :aid AND session_id = :sid"),
                           {"aid": str(asset["id"]), "sid": str(session_id)})
            report.question_audio_assets_expired += len(metadata_pending)
            report.question_audio_files_removed += len(selected)
            report.orphan_files_removed += sum(path.stem not in all_asset_ids for path in selected)
            report.removed += 1
        if dry_run:
            db.rollback()
        else:
            db.commit()
        return report
    except Exception:
        db.rollback()
        raise
    finally:
        db.close()


def purge_expired_videos() -> int:
    """Compatibility entry point; partial cleanup must not appear successful."""
    report = purge_expired_video_report()
    if report.failed:
        raise RuntimeError(
            f"Recording cleanup incomplete: {report.removed} removed, {len(report.failed)} failed."
        )
    return report.removed


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dry-run", action="store_true", help="Count eligible metadata without deleting assets.")
    result = purge_expired_video_report(dry_run=parser.parse_args().dry_run)
    print(json.dumps(asdict(result), sort_keys=True))
    raise SystemExit(1 if result.failed else 0)
