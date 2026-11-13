"""화면 로그인: 비밀번호 해시, 세션, 로그인 필수 의존성.

- 비밀번호: PBKDF2-HMAC-SHA256 + 사용자별 솔트 (표준 라이브러리만 사용, 폐쇄망 친화)
- 세션: 무작위 토큰을 HttpOnly 쿠키로 주고 DB에는 sha256만 저장. 쓰는 동안 만료 시각을 연장한다.
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import re
import secrets
from datetime import UTC, datetime, timedelta

from fastapi import Cookie, Depends, HTTPException, Request, Response
from sqlalchemy import delete, select
from sqlalchemy.orm import Session

from .config import settings
from .db import get_db
from .models import AuthSession, User

COOKIE = "cs_session"
PBKDF2_ITERATIONS = 310_000
USERNAME_RE = re.compile(r"^[A-Za-z0-9._@-]{3,100}$")
MIN_PASSWORD = 8


def hash_password(password: str) -> str:
    salt = secrets.token_bytes(16)
    dk = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, PBKDF2_ITERATIONS)
    b64 = lambda b: base64.b64encode(b).decode("ascii")  # noqa: E731
    return f"pbkdf2_sha256${PBKDF2_ITERATIONS}${b64(salt)}${b64(dk)}"


def verify_password(password: str, stored: str) -> bool:
    try:
        algo, iters, salt, digest = stored.split("$")
        if algo != "pbkdf2_sha256":
            return False
        dk = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), base64.b64decode(salt), int(iters))
        return hmac.compare_digest(dk, base64.b64decode(digest))
    except (ValueError, TypeError):
        return False


def validate_username(username: str) -> str:
    username = username.strip()
    if not USERNAME_RE.match(username):
        raise HTTPException(400, "아이디는 영문·숫자·._@- 로 3~100자여야 합니다")
    return username


def validate_password(password: str) -> None:
    if len(password) < MIN_PASSWORD:
        raise HTTPException(400, f"비밀번호는 {MIN_PASSWORD}자 이상이어야 합니다")


def _token_hash(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def _now() -> datetime:
    return datetime.now(UTC)


def _aware(dt: datetime) -> datetime:
    return dt if dt.tzinfo else dt.replace(tzinfo=UTC)


def start_session(db: Session, user: User, request: Request, response: Response) -> None:
    token = secrets.token_urlsafe(32)
    db.add(AuthSession(user_id=user.id, token_hash=_token_hash(token),
                       expires_at=_now() + timedelta(hours=settings.session_hours)))
    user.last_login_at = _now()
    db.execute(delete(AuthSession).where(AuthSession.expires_at < _now()))  # 만료된 세션 정리
    db.commit()
    response.set_cookie(COOKIE, token, httponly=True, samesite="lax", path="/",
                        secure=request.url.scheme == "https", max_age=int(settings.session_hours * 3600))


def end_session(db: Session, token: str | None, response: Response) -> None:
    if token:
        db.execute(delete(AuthSession).where(AuthSession.token_hash == _token_hash(token)))
        db.commit()
    response.delete_cookie(COOKIE, path="/")


def current_user(db: Session, token: str | None) -> User | None:
    if not token:
        return None
    s = db.scalar(select(AuthSession).where(AuthSession.token_hash == _token_hash(token)))
    if s is None or _aware(s.expires_at) < _now():
        return None
    user = db.get(User, s.user_id)
    if user is None or not user.enabled:
        return None
    # 사용 중이면 연장 (남은 시간이 절반 아래로 떨어졌을 때만 기록)
    full = timedelta(hours=settings.session_hours)
    if _aware(s.expires_at) - _now() < full / 2:
        s.expires_at = _now() + full
        db.commit()
    return user


def require_user(cs_session: str | None = Cookie(None), db: Session = Depends(get_db)) -> User:
    user = current_user(db, cs_session)
    if user is None:
        raise HTTPException(401, "로그인이 필요합니다")
    return user


def ensure_initial_admin(db: Session) -> None:
    """사용자가 없고 .env에 CS_ADMIN_USERNAME·CS_ADMIN_PASSWORD가 있으면 첫 관리자를 만든다."""
    if not settings.admin_username or not settings.admin_password:
        return
    if db.scalar(select(User)):
        return
    if not USERNAME_RE.match(settings.admin_username) or len(settings.admin_password) < MIN_PASSWORD:
        raise RuntimeError("CS_ADMIN_USERNAME(영문·숫자 3자 이상)·CS_ADMIN_PASSWORD(8자 이상)를 확인하세요")
    db.add(User(username=settings.admin_username, display_name="관리자",
                password_hash=hash_password(settings.admin_password)))
    db.commit()
