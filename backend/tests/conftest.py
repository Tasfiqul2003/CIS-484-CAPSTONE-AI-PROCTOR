from datetime import datetime, timedelta, timezone

import pytest

from backend.app import exam


@pytest.fixture(autouse=True)
def configured_exam_access_prerequisites(monkeypatch, tmp_path):
    monkeypatch.setattr(
        exam,
        "_recording_root",
        lambda **_kwargs: tmp_path,
    )
    monkeypatch.setattr(
        exam,
        "_retention_deadline",
        lambda: datetime.now(timezone.utc) + timedelta(days=30),
    )
