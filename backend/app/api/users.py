"""로그인(/api/auth)과 사용자 관리(/api/users)."""
from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Cookie, Depends, HTTPException, Request, Response
from pydantic import BaseModel
from sqlalchemy import delete, func, select
from sqlalchemy.orm import Session

from ..auth import (
    COOKIE, current_user, end_session, hash_password, require_user, start_session, validate_password,
    validate_username, verify_password,
)
from ..db import get_db
from ..models import AuthSession, User
from . import get_or_404, row_dict

auth_router = APIRouter(prefix="/api/auth", tags=["auth"])
users_router = APIRouter(prefix="/api/users", tags=["users"], dependencies=[Depends(require_user)])


def user_out(u: User) -> dict[str, Any]:
    return row_dict(u, exclude={"password_hash"})


def _user_count(db: Session) -> int:
    return db.scalar(select(func.count()).select_from(User)) or 0


# ------------------------------------------------------------------ 로그인
class LoginIn(BaseModel):
    username: str
    password: str


class SetupIn(BaseModel):
    username: str
    password: str
    display_name: str = ""


@auth_router.get("/status")
def auth_status(cs_session: str | None = Cookie(None), db: Session = Depends(get_db)) -> dict[str, Any]:
    """화면 시작 시 호출: 로그인 상태와, 사용자가 하나도 없어 최초 관리자 생성이 필요한지."""
    user = current_user(db, cs_session)
    return {"user": user_out(user) if user else None, "setup_required": _user_count(db) == 0}


@auth_router.post("/setup", status_code=201)
def setup(body: SetupIn, request: Request, response: Response, db: Session = Depends(get_db)) -> dict[str, Any]:
    """최초 관리자 만들기. 사용자가 하나도 없을 때만 허용하고, 만든 뒤 바로 로그인한다."""
    if _user_count(db) > 0:
        raise HTTPException(409, "이미 사용자가 있습니다. 로그인하세요")
    username = validate_username(body.username)
    validate_password(body.password)
    user = User(username=username, display_name=body.display_name.strip() or username,
                password_hash=hash_password(body.password))
    db.add(user)
    db.commit()
    start_session(db, user, request, response)
    return user_out(user)


@auth_router.post("/login")
def login(body: LoginIn, request: Request, response: Response, db: Session = Depends(get_db)) -> dict[str, Any]:
    user = db.scalar(select(User).where(User.username == body.username.strip()))
    # 아이디가 없을 때도 같은 시간이 걸리도록 해시를 계산한다
    ok = verify_password(body.password, user.password_hash if user else hash_password("x" * 12))
    if user is None or not ok:
        raise HTTPException(401, "아이디 또는 비밀번호가 맞지 않습니다")
    if not user.enabled:
        raise HTTPException(403, "사용 중지된 계정입니다. 관리자에게 문의하세요")
    start_session(db, user, request, response)
    return user_out(user)


@auth_router.post("/logout", status_code=204)
def logout(response: Response, cs_session: str | None = Cookie(None), db: Session = Depends(get_db)) -> None:
    end_session(db, cs_session, response)


class PasswordChangeIn(BaseModel):
    current_password: str
    new_password: str


@auth_router.post("/password", status_code=204)
def change_my_password(body: PasswordChangeIn, user: User = Depends(require_user), db: Session = Depends(get_db)) -> None:
    if not verify_password(body.current_password, user.password_hash):
        raise HTTPException(400, "현재 비밀번호가 맞지 않습니다")
    validate_password(body.new_password)
    user.password_hash = hash_password(body.new_password)
    db.commit()


# ------------------------------------------------------------------ 사용자 관리
class UserIn(BaseModel):
    username: str
    password: str
    display_name: str = ""


class UserPatch(BaseModel):
    display_name: str | None = None
    enabled: bool | None = None
    password: str | None = None  # 비밀번호 재설정


@users_router.get("")
def list_users(db: Session = Depends(get_db)) -> list[dict[str, Any]]:
    return [user_out(u) for u in db.scalars(select(User).order_by(User.username))]


@users_router.post("", status_code=201)
def create_user(body: UserIn, db: Session = Depends(get_db)) -> dict[str, Any]:
    username = validate_username(body.username)
    if db.scalar(select(User).where(User.username == username)):
        raise HTTPException(409, "같은 아이디가 있습니다")
    validate_password(body.password)
    u = User(username=username, display_name=body.display_name.strip() or username,
             password_hash=hash_password(body.password))
    db.add(u)
    db.commit()
    return user_out(u)


def _enabled_others(db: Session, user_id: str) -> int:
    return db.scalar(select(func.count()).select_from(User).where(User.enabled.is_(True), User.id != user_id)) or 0


@users_router.patch("/{user_id}")
def update_user(user_id: str, body: UserPatch, me: User = Depends(require_user), db: Session = Depends(get_db)) -> dict[str, Any]:
    u = get_or_404(db, User, user_id)
    if body.display_name is not None:
        u.display_name = body.display_name.strip() or u.username
    if body.enabled is not None and body.enabled != u.enabled:
        if not body.enabled:
            if u.id == me.id:
                raise HTTPException(400, "자기 자신은 사용 중지할 수 없습니다")
            if _enabled_others(db, u.id) == 0:
                raise HTTPException(400, "사용 가능한 마지막 계정은 중지할 수 없습니다")
            db.execute(delete(AuthSession).where(AuthSession.user_id == u.id))  # 즉시 로그아웃
        u.enabled = body.enabled
    if body.password is not None:
        validate_password(body.password)
        u.password_hash = hash_password(body.password)
        if u.id != me.id:  # 다른 사람 비밀번호를 바꾸면 그 사람의 기존 세션은 끊는다
            db.execute(delete(AuthSession).where(AuthSession.user_id == u.id))
    db.commit()
    return user_out(u)


@users_router.delete("/{user_id}", status_code=204)
def delete_user(user_id: str, me: User = Depends(require_user), db: Session = Depends(get_db)) -> None:
    u = get_or_404(db, User, user_id)
    if u.id == me.id:
        raise HTTPException(400, "자기 자신은 삭제할 수 없습니다")
    if u.enabled and _enabled_others(db, u.id) == 0:
        raise HTTPException(400, "사용 가능한 마지막 계정은 삭제할 수 없습니다")
    db.execute(delete(AuthSession).where(AuthSession.user_id == u.id))
    db.delete(u)
    db.commit()


__all__ = ["auth_router", "users_router", "COOKIE"]
