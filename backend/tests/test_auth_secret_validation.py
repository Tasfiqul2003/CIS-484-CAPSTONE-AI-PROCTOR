import pytest
from fastapi import HTTPException

from app.auth import get_secret, validate_auth_secret


def test_accepts_a_long_random_style_secret():
    secret = "a-test-secret-value-that-is-long-enough-123456"

    assert validate_auth_secret(secret) == secret


@pytest.mark.parametrize("secret", [None, "", "   "])
def test_rejects_missing_or_blank_secret(secret):
    with pytest.raises(ValueError, match="must be configured"):
        validate_auth_secret(secret)


@pytest.mark.parametrize(
    "secret",
    [
        "short",
        "this-secret-is-under-32-chars",
        "secret",
        "changeme",
        "replace-with-a-random-secret-at-least-32-characters",
        "your-secret-key-that-is-long-but-still-a-placeholder",
    ],
)
def test_rejects_short_or_placeholder_secrets(secret):
    with pytest.raises(ValueError):
        validate_auth_secret(secret)


def test_rejects_surrounding_whitespace():
    with pytest.raises(ValueError, match="whitespace"):
        validate_auth_secret(" a-long-enough-test-secret-value-123456 ")


def test_get_secret_returns_generic_server_error_for_unsafe_configuration(monkeypatch):
    monkeypatch.setenv("AUTH_SECRET_KEY", "too-short")

    with pytest.raises(HTTPException) as exc:
        get_secret()

    assert exc.value.status_code == 500
    assert exc.value.detail == "Authentication is not configured securely."
