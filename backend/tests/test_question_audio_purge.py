"""Real isolated SQLite metadata and generated fixture files, never real media."""
from datetime import datetime, timedelta, timezone
from uuid import uuid4

import pytest
from sqlalchemy import create_engine, text
from sqlalchemy.orm import Session

from backend.app import purge_exam_videos as purge


@pytest.fixture
def assets(monkeypatch, tmp_path):
    engine = create_engine("sqlite://")
    db = Session(engine)
    for sql in [
        "CREATE TABLE exam_sessions(id TEXT PRIMARY KEY)",
        "CREATE TABLE exam_session_videos(session_id TEXT PRIMARY KEY, status TEXT, expires_at TEXT, file_name TEXT, total_bytes INTEGER, next_chunk_index INTEGER, generated_transcript TEXT, transcript_error TEXT, transcript_job_token TEXT, transcript_lease_until TEXT, transcript_status TEXT DEFAULT 'queued', updated_at TEXT)",
        "CREATE TABLE exam_question_audio(id TEXT PRIMARY KEY, session_id TEXT, status TEXT, expires_at TEXT)",
        "CREATE TABLE exam_question_audio_requests(session_id TEXT, request_id TEXT, asset_id TEXT REFERENCES exam_question_audio(id))",
    ]:
        db.execute(text(sql))
    monkeypatch.setattr(purge, "_recording_root", lambda **kwargs: tmp_path)
    monkeypatch.setattr(purge, "open_session", lambda: db)
    yield db, tmp_path
    db.close()
    engine.dispose()


def create_attempt(db, root, *, expired=True, status="completed", orphan=False):
    sid, aid = uuid4(), uuid4()
    expiry = datetime.now(timezone.utc) + timedelta(days=-1 if expired else 1)
    db.execute(text("INSERT INTO exam_sessions VALUES (:sid)"), {"sid": str(sid)})
    db.execute(text("INSERT INTO exam_session_videos(session_id,status,expires_at,file_name,total_bytes,next_chunk_index) VALUES (:sid,:status,:expiry,:file,9,1)"),
               {"sid": str(sid), "status": status, "expiry": expiry.isoformat(), "file": f"{sid}.webm"})
    db.execute(text("INSERT INTO exam_question_audio VALUES (:aid,:sid,'ready',:expiry)"),
               {"aid": str(aid), "sid": str(sid), "expiry": expiry.isoformat()})
    db.execute(text("INSERT INTO exam_question_audio_requests VALUES (:sid,:request,:aid)"),
               {"sid": str(sid), "request": str(uuid4()), "aid": str(aid)})
    db.commit()
    directory = root / "question-audio" / str(sid)
    directory.mkdir(parents=True)
    asset = directory / f"{aid}.wav"
    asset.write_bytes(b"synthetic-WAV-fixture")
    video = root / f"{sid}.webm"
    video.write_bytes(b"synthetic-recording")
    orphan_path = directory / f"{uuid4()}.wav"
    if orphan:
        orphan_path.write_bytes(b"synthetic-uncommitted-asset")
    return sid, aid, asset, video, orphan_path


def test_expired_attempt_removes_question_audio_orphans_and_marks_metadata_after_success(assets):
    db, root = assets
    sid, aid, asset, video, orphan = create_attempt(db, root, orphan=True)
    db.execute(text("UPDATE exam_session_videos SET generated_transcript='Synthetic private text', transcript_error='Synthetic error', transcript_job_token='synthetic-job', transcript_lease_until='2099-01-01'"))
    db.commit()
    assembly = root / f"{sid}.assembling"
    assembly.write_bytes(b'synthetic unfinished assembly')
    report = purge.purge_expired_video_report()
    assert not assembly.exists()
    cleared = db.execute(text("SELECT generated_transcript, transcript_error, transcript_job_token, transcript_lease_until, transcript_status FROM exam_session_videos")).one()
    assert tuple(cleared) == (None, None, None, None, 'expired')
    assert report.removed == 1 and report.failed == []
    assert report.question_audio_assets_expired == 1
    assert report.question_audio_files_removed == 2 and report.orphan_files_removed == 1
    assert not asset.exists() and not video.exists() and not orphan.exists()
    assert db.execute(text("SELECT status FROM exam_question_audio WHERE id=:aid"), {"aid": str(aid)}).scalar_one() == "expired"
    assert db.execute(text("SELECT status FROM exam_session_videos WHERE session_id=:sid"), {"sid": str(sid)}).scalar_one() == "expired"
    assert db.execute(text("SELECT count(*) FROM exam_question_audio_requests")).scalar_one() == 1
    db.rollback()
    second = purge.purge_expired_video_report()
    assert second.eligible == 0 and second.removed == 0 and second.question_audio_files_removed == 0


def test_dry_run_preserves_assets_recording_receipts_and_ready_metadata(assets):
    db, root = assets
    sid, aid, asset, video, orphan = create_attempt(db, root, orphan=True)
    report = purge.purge_expired_video_report(dry_run=True)
    assert report.eligible == 1 and report.removed == 0
    assert asset.exists() and video.exists() and orphan.exists()
    assert db.execute(text("SELECT status FROM exam_question_audio")).scalar_one() == "ready"
    assert db.execute(text("SELECT status FROM exam_session_videos")).scalar_one() == "completed"


def test_partial_audio_delete_failure_preserves_retryable_metadata(assets, monkeypatch):
    db, root = assets
    sid, aid, asset, video, orphan = create_attempt(db, root, orphan=True)
    original = type(asset).unlink
    def unlink(path, *args, **kwargs):
        if path == asset:
            raise PermissionError("Synthetic denied asset")
        return original(path, *args, **kwargs)
    monkeypatch.setattr(type(asset), "unlink", unlink)
    failed = purge.purge_expired_video_report()
    assert failed.failed == [str(sid)] and failed.removed == 0
    assert db.execute(text("SELECT status FROM exam_question_audio")).scalar_one() == "ready"
    assert db.execute(text("SELECT status FROM exam_session_videos")).scalar_one() == "completed"
    db.rollback()
    monkeypatch.setattr(type(asset), "unlink", original)
    retried = purge.purge_expired_video_report()
    assert retried.removed == 1 and retried.failed == [] and not asset.exists()


def test_unknown_filename_or_redirected_directory_never_deleted(assets, monkeypatch):
    db, root = assets
    sid, aid, asset, video, _ = create_attempt(db, root)
    unexpected = asset.parent / "do-not-delete.txt"
    unexpected.write_text("synthetic unrelated file")
    report = purge.purge_expired_video_report()
    assert report.failed == [str(sid)] and video.exists() and asset.exists() and unexpected.exists()
    unexpected.unlink()
    directory = asset.parent
    original = type(directory).resolve
    def resolve(path, *args, **kwargs):
        if path == directory:
            return root.parent / "synthetic-outside-audio"
        return original(path, *args, **kwargs)
    monkeypatch.setattr(type(directory), "resolve", resolve)
    failed = purge.purge_expired_video_report()
    assert failed.failed == [str(sid)] and asset.exists() and video.exists()


def test_independently_expired_question_asset_does_not_delete_active_recording_or_other_assets(assets):
    db, root = assets
    sid, aid, asset, video, orphan = create_attempt(db, root, expired=False, status="recording", orphan=True)
    db.execute(text("UPDATE exam_question_audio SET expires_at=:expiry"),
               {"expiry": (datetime.now(timezone.utc) - timedelta(days=1)).isoformat()})
    db.commit()
    report = purge.purge_expired_video_report()
    assert report.question_audio_assets_expired == 1 and report.question_audio_files_removed == 1
    assert not asset.exists() and video.exists() and orphan.exists()
    assert db.execute(text("SELECT status FROM exam_session_videos")).scalar_one() == "recording"


def test_missing_audio_schema_blocks_all_deletion_before_files_are_touched(assets):
    db, root = assets
    _, _, asset, video, _ = create_attempt(db, root)
    db.execute(text("DROP TABLE exam_question_audio_requests"))
    db.commit()
    with pytest.raises(RuntimeError, match="reviewed media migrations"):
        purge.purge_expired_video_report()
    assert asset.exists() and video.exists()


def test_already_expired_attempt_still_cleans_orphan_files_from_failed_commits(assets):
    db, root = assets
    sid, aid, asset, video, orphan = create_attempt(db, root, status="expired", orphan=True)
    db.execute(text("UPDATE exam_question_audio SET status='expired'"))
    db.commit()
    report = purge.purge_expired_video_report()
    assert report.removed == 1 and report.orphan_files_removed == 1
    assert report.question_audio_assets_expired == 0
    assert not asset.exists() and not video.exists() and not orphan.exists()
