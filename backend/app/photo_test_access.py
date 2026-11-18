"""Expiring, single-EID photo-check exception for operator-controlled testing."""
from datetime import datetime, timedelta, timezone
import os
import re

EID_KEY = 'EXAM_TEST_PHOTO_EID'
UNTIL_KEY = 'EXAM_TEST_PHOTO_UNTIL'
EID_PATTERN = re.compile(r'[a-zA-Z0-9._-]{1,64}')


def photo_test_policy():
    eid = os.getenv(EID_KEY, '').strip().casefold()
    raw = os.getenv(UNTIL_KEY, '').strip()
    if not EID_PATTERN.fullmatch(eid) or not raw:
        return None
    try:
        until = datetime.fromisoformat(raw.replace('Z', '+00:00'))
        now = datetime.now(timezone.utc)
        if until.tzinfo is None or not now < until <= now + timedelta(hours=24):
            return None
    except ValueError:
        return None
    return {'eid': eid, 'until': until.isoformat()}


def photo_test_access(eid):
    policy = photo_test_policy()
    return bool(policy and str(eid).strip().casefold() == policy['eid'])
