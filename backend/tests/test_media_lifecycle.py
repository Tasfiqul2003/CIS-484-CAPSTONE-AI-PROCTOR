"""Synthetic retention/storage checks; no runtime DB, devices or private media."""
import asyncio
from datetime import datetime, timedelta, timezone
from io import BytesIO
from uuid import UUID

import pytest
from fastapi import HTTPException, UploadFile

from backend.app import exam_video, purge_exam_videos as purge
from backend.tests.test_exam_video import api, start, chunk, BASE, WEBM

SID = UUID("20000000-0000-4000-8000-000000000001")
OTHER_SID = UUID("20000000-0000-4000-8000-000000000002")


class Result:
    def __init__(self, rows):
        self.rows = rows

    def scalars(self):
        return self

    def mappings(self):
        return self

    def all(self):
        return self.rows

    def first(self):
        return self.rows[0] if self.rows else None


class PurgeDB:
    def __init__(self, ids):
        self.ids = list(ids)
        self.removed = []
        self.closed = False

    def execute(self, statement, params=None):
        sql = str(statement)
        if "LIMIT 0" in sql:
            return Result([])  # This fake explicitly models the reviewed audio schema.
        if "FROM exam_session_videos v" in sql:
            return Result([{"session_id": sid, "status": "completed", "recording_expired": True} for sid in self.ids])
        if "FROM exam_question_audio WHERE" in sql:
            return Result([])  # Legacy recordings have no question audio assets.
        if sql.lstrip().startswith("SELECT"):
            raise AssertionError(f"Unhandled purge query: {sql}")
        self.removed.append(UUID(params["sid"]))
        self.ids.remove(UUID(params["sid"]))
        return Result([])

    def commit(self):
        pass

    def rollback(self):
        pass

    def close(self):
        self.closed = True

    def get_bind(self):
        return type("Bind", (), {"dialect": type("Dialect", (), {"name": "sqlite"})()})()


def setup_purge(monkeypatch, tmp_path, ids):
    db = PurgeDB(ids)
    monkeypatch.setattr(purge, "_recording_root", lambda **kwargs: tmp_path)
    monkeypatch.setattr(purge, "open_session", lambda: db)
    return db


def test_purge_dry_run_has_no_file_or_metadata_mutations(monkeypatch, tmp_path):
    db = setup_purge(monkeypatch, tmp_path, [SID])
    asset = tmp_path / f"{SID}.webm"
    asset.write_bytes(b"synthetic")
    report = purge.purge_expired_video_report(dry_run=True)
    assert report.eligible == 1 and report.removed == 0 and report.failed == []
    assert asset.read_bytes() == b"synthetic" and db.removed == [] and db.closed


def test_purge_is_idempotent_after_missing_and_existing_files(monkeypatch, tmp_path):
    db = setup_purge(monkeypatch, tmp_path, [SID, OTHER_SID])
    chunks = tmp_path / str(SID) / "chunks"
    chunks.mkdir(parents=True)
    (chunks / "00000000.chunk").write_bytes(b"synthetic")
    (tmp_path / f"{SID}.webm").write_bytes(b"synthetic")
    assert purge.purge_expired_videos() == 2
    assert purge.purge_expired_videos() == 0
    assert db.removed == [SID, OTHER_SID]
    assert not list(tmp_path.iterdir())


def test_failed_deletion_retains_retry_metadata_and_continues(monkeypatch, tmp_path):
    db = setup_purge(monkeypatch, tmp_path, [SID, OTHER_SID])
    asset = tmp_path / f"{SID}.webm"
    asset.write_bytes(b"synthetic")
    original = purge._remove_recording_files

    def remove(root, sid):
        if sid == SID:
            raise PermissionError("synthetic denied")
        original(root, sid)

    monkeypatch.setattr(purge, "_remove_recording_files", remove)
    report = purge.purge_expired_video_report()
    assert report.removed == 1 and report.failed == [str(SID)]
    assert db.ids == [SID] and db.removed == [OTHER_SID] and asset.exists()
    monkeypatch.setattr(purge, "_remove_recording_files", original)
    assert purge.purge_expired_videos() == 1


def test_unknown_chunk_inventory_is_preserved(monkeypatch, tmp_path):
    setup_purge(monkeypatch, tmp_path, [SID])
    chunks = tmp_path / str(SID) / "chunks"
    chunks.mkdir(parents=True)
    (chunks / "unrelated.txt").write_text("synthetic unrelated")
    asset = tmp_path / f"{SID}.webm"
    asset.write_bytes(b"synthetic")
    report = purge.purge_expired_video_report()
    assert report.failed == [str(SID)] and asset.exists()
    assert (chunks / "unrelated.txt").exists()


def test_partial_purge_failure_is_reported_and_retried(monkeypatch, tmp_path):
    db = setup_purge(monkeypatch, tmp_path, [SID, OTHER_SID])
    original = purge._remove_recording_files

    def remove(root, sid):
        if sid == SID:
            raise PermissionError("Synthetic failure")
        original(root, sid)

    monkeypatch.setattr(purge, "_remove_recording_files", remove)
    report = purge.purge_expired_video_report()
    assert report.removed == 1 and report.failed == [str(SID)]
    assert db.ids == [SID]
    monkeypatch.setattr(purge, "_remove_recording_files", original)
    assert purge.purge_expired_videos() == 1


def test_compatibility_entrypoint_fails_when_cleanup_incomplete(monkeypatch):
    monkeypatch.setattr(purge, "purge_expired_video_report", lambda: purge.PurgeReport(False, 1, 0, [str(SID)]))
    with pytest.raises(RuntimeError, match="incomplete"):
        purge.purge_expired_videos()


def test_expired_recording_rejects_chunks_and_finalization(api):
    client, db, _, _ = api
    start(client)
    db.video['expires_at'] = datetime.now(timezone.utc) - timedelta(seconds=1)
    assert chunk(client).status_code == 410
    assert client.post(BASE + '/complete', json={'expected_chunk_count': 1}).status_code == 410


def test_storage_exhaustion_does_not_write_a_chunk(api, monkeypatch):
    client, _, _, root = api
    start(client)
    monkeypatch.setattr(exam_video.shutil, 'disk_usage', lambda path: type('Usage', (), {'free': 0})())
    assert chunk(client).status_code == 507
    assert not (root / str(SID) / 'chunks' / '00000000.chunk').exists()


def test_safe_leaf_rejects_path_traversal(tmp_path):
    with pytest.raises(HTTPException) as error:
        exam_video._chunks(tmp_path, '../outside')
    assert error.value.status_code == 503


def test_symlinked_session_never_traversed(monkeypatch, tmp_path):
    # Emulate a link without requiring Windows developer mode or privileged links.
    db = setup_purge(monkeypatch, tmp_path, [SID])
    target = tmp_path / str(SID)
    original = type(target).is_symlink
    monkeypatch.setattr(type(target), "is_symlink", lambda path: path == target or original(path))
    report = purge.purge_expired_video_report()
    assert report.failed == [str(SID)] and db.removed == []


def test_read_only_storage_checks_do_not_create_directory(monkeypatch, tmp_path):
    missing = tmp_path / "missing"
    monkeypatch.setenv("EXAM_VIDEO_DIR", str(missing))
    with pytest.raises(HTTPException) as error:
        exam_video._recording_root(write_required=False)
    assert error.value.status_code == 503 and not missing.exists()


def test_redirected_session_directory_is_rejected_before_creating_chunks(monkeypatch, tmp_path):
    session = tmp_path / str(SID)
    chunks = session / "chunks"
    outside = tmp_path.parent / "synthetic-outside-storage"
    original = type(session).resolve

    def resolve(path, *args, **kwargs):
        if path == session:
            return outside
        if path == chunks:
            return outside / "chunks"
        return original(path, *args, **kwargs)

    monkeypatch.setattr(type(session), "resolve", resolve)
    with pytest.raises(HTTPException) as error:
        exam_video._chunks(tmp_path, SID)
    assert error.value.status_code == 503
    assert not session.exists()
