import hmac
import os
import re
from datetime import datetime, timedelta, timezone

import jwt
from fastapi import APIRouter, Depends, Header, HTTPException, Request, Response
from pydantic import BaseModel, Field
from pwdlib import PasswordHash
from sqlalchemy import text
from sqlalchemy.orm import Session

from .db import get_db

router = APIRouter(prefix="/auth", tags=["Authentication"])
password_hash = PasswordHash.recommended()

COOKIE_NAME = "oralexam_session"
SESSION_HOURS = 8


class LoginRequest(BaseModel):
    username: str = Field(min_length=3, max_length=64)
    password: str = Field(min_length=1, max_length=256)


class BootstrapRequest(BaseModel):
    username: str = Field(min_length=3, max_length=64)
    password: str = Field(min_length=12, max_length=256)


class CreateProfessorRequest(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    email: str = Field(min_length=3, max_length=320)
    username: str = Field(min_length=3, max_length=64)
    password: str = Field(min_length=12, max_length=256)


def normalize_username(username: str) -> str:
    username = username.strip().lower()
    if not re.fullmatch(r"[a-z0-9._-]{3,64}", username):
        raise HTTPException(
            status_code=400,
            detail="Username must use 3–64 letters, numbers, periods, underscores, or hyphens.",
        )
    return username


def get_secret() -> str:
    secret = os.getenv("AUTH_SECRET_KEY")
    if not secret:
        raise HTTPException(
            status_code=500,
            detail="Authentication is not configured.",
        )
    return secret


def set_session_cookie(response: Response, account: dict) -> None:
    expires = datetime.now(timezone.utc) + timedelta(hours=SESSION_HOURS)
    token = jwt.encode(
        {
            "sub": str(account["id"]),
            "role": account["role"],
            "exp": expires,
        },
        get_secret(),
        algorithm="HS256",
    )

    response.set_cookie(
        key=COOKIE_NAME,
        value=token,
        httponly=True,
        secure=os.getenv("AUTH_COOKIE_SECURE", "false").lower() == "true",
        samesite="lax",
        max_age=SESSION_HOURS * 60 * 60,
        path="/",
    )


def get_current_account(
    request: Request,
    db: Session = Depends(get_db),
) -> dict:
    token = request.cookies.get(COOKIE_NAME)
    if not token:
        raise HTTPException(status_code=401, detail="Please sign in.")

    try:
        payload = jwt.decode(
            token,
            get_secret(),
            algorithms=["HS256"],
            options={"require": ["sub", "exp", "role"]},
        )
        account_id = payload["sub"]
    except (jwt.InvalidTokenError, KeyError):
        raise HTTPException(status_code=401, detail="Session expired or invalid.")

    account = db.execute(
        text("""
            SELECT id, username, role, professor_id, is_active
            FROM user_accounts
            WHERE id = :id
        """),
        {"id": account_id},
    ).mappings().first()

    if not account or not account["is_active"]:
        raise HTTPException(status_code=401, detail="Account is inactive or unavailable.")

    return dict(account)


def require_admin(
    account: dict = Depends(get_current_account),
) -> dict:
    if account["role"] != "admin":
        raise HTTPException(status_code=403, detail="Administrator access required.")
    return account


def require_professor(
    account: dict = Depends(get_current_account),
) -> dict:
    if account["role"] != "professor":
        raise HTTPException(status_code=403, detail="Professor access required.")
    return account


@router.post("/admin/bootstrap")
def bootstrap_admin(
    body: BootstrapRequest,
    response: Response,
    bootstrap_token: str = Header(alias="X-Admin-Bootstrap-Token"),
    db: Session = Depends(get_db),
):
    configured_token = os.getenv("ADMIN_BOOTSTRAP_TOKEN")
    if not configured_token or not hmac.compare_digest(
        bootstrap_token, configured_token
    ):
        raise HTTPException(status_code=403, detail="Invalid bootstrap token.")

    existing_admin = db.execute(
        text("SELECT 1 FROM user_accounts WHERE role = 'admin' LIMIT 1")
    ).first()

    if existing_admin:
        raise HTTPException(
            status_code=403,
            detail="Administrator setup has already been completed.",
        )

    username = normalize_username(body.username)

    existing_username = db.execute(
        text("SELECT 1 FROM user_accounts WHERE LOWER(username) = :username"),
        {"username": username},
    ).first()

    if existing_username:
        raise HTTPException(status_code=409, detail="Username is already in use.")

    account_id = db.execute(
        text("""
            INSERT INTO user_accounts (username, password_hash, role, professor_id)
            VALUES (:username, :password_hash, 'admin', NULL)
            RETURNING id
        """),
        {
            "username": username,
            "password_hash": password_hash.hash(body.password),
        },
    ).scalar_one()

    db.commit()

    account = {
        "id": account_id,
        "username": username,
        "role": "admin",
        "professor_id": None,
    }
    set_session_cookie(response, account)

    return {
        "message": "Administrator account created.",
        "username": username,
        "role": "admin",
    }


@router.post("/login")
def login(
    body: LoginRequest,
    response: Response,
    db: Session = Depends(get_db),
):
    username = body.username.strip().lower()

    account = db.execute(
        text("""
            SELECT id, username, password_hash, role, professor_id, is_active
            FROM user_accounts
            WHERE LOWER(username) = :username
        """),
        {"username": username},
    ).mappings().first()

    # Use the same error for unknown usernames and incorrect passwords.
    if (
        not account
        or not account["is_active"]
        or not password_hash.verify(body.password, account["password_hash"])
    ):
        raise HTTPException(status_code=401, detail="Invalid username or password.")

    set_session_cookie(response, dict(account))

    return {
        "message": "Signed in successfully.",
        "username": account["username"],
        "role": account["role"],
    }


@router.get("/me")
def current_user(account: dict = Depends(get_current_account)):
    return {
        "id": str(account["id"]),
        "username": account["username"],
        "role": account["role"],
        "professor_id": (
            str(account["professor_id"]) if account["professor_id"] else None
        ),
    }


@router.post("/logout")
def logout(response: Response):
    response.delete_cookie(
        key=COOKIE_NAME,
        path="/",
        httponly=True,
        secure=os.getenv("AUTH_COOKIE_SECURE", "false").lower() == "true",
        samesite="lax",
    )
    return {"message": "Signed out."}


@router.post("/admin/professors", status_code=201)
def create_professor(
    body: CreateProfessorRequest,
    account: dict = Depends(require_admin),
    db: Session = Depends(get_db),
):
    username = normalize_username(body.username)
    name = body.name.strip()
    email = body.email.strip()

    if not name or not email:
        raise HTTPException(status_code=400, detail="Name and email are required.")

    existing_username = db.execute(
        text("SELECT 1 FROM user_accounts WHERE LOWER(username) = :username"),
        {"username": username},
    ).first()

    if existing_username:
        raise HTTPException(status_code=409, detail="Username is already in use.")

    # Create the professor record and login account in one transaction.
    try:
        professor_id = db.execute(
            text("""
                INSERT INTO professors (name, email)
                VALUES (:name, :email)
                RETURNING id
            """),
            {"name": name, "email": email},
        ).scalar_one()

        db.execute(
            text("""
                INSERT INTO user_accounts
                    (username, password_hash, role, professor_id)
                VALUES
                    (:username, :password_hash, 'professor', :professor_id)
            """),
            {
                "username": username,
                "password_hash": password_hash.hash(body.password),
                "professor_id": professor_id,
            },
        )
        db.commit()
    except Exception:
        db.rollback()
        raise

    return {
        "message": "Professor account created.",
        "name": name,
        "email": email,
        "username": username,
        "professor_id": str(professor_id),
    }
