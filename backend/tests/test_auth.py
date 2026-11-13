"""화면 로그인·사용자 관리."""
from __future__ import annotations

from fastapi.testclient import TestClient

from app.auth import hash_password, verify_password


def _anon(client) -> TestClient:
    """쿠키 없는 새 클라이언트(같은 앱)"""
    return TestClient(client.app)


def test_password_hash():
    h = hash_password("correct horse")
    assert h.startswith("pbkdf2_sha256$") and "correct horse" not in h
    assert verify_password("correct horse", h) and not verify_password("wrong", h)
    assert hash_password("same") != hash_password("same")  # 솔트


def test_login_required_and_exemptions(client):
    anon = _anon(client)
    assert anon.get("/api/documents").status_code == 401
    assert anon.get("/api/api-keys").status_code == 401  # 키 관리도 로그인 필요
    assert anon.get("/api/users").status_code == 401
    assert anon.get("/api/health").status_code == 200
    st = anon.get("/api/auth/status").json()
    assert st["user"] is None and st["setup_required"] is False  # 이미 tester가 있음
    assert anon.post("/api/auth/setup", json={"username": "hijack", "password": "password123"}).status_code == 409
    assert anon.get("/api/v1/parsers").status_code == 401  # 외부용은 로그인 아닌 API 키
    assert client.get("/api/auth/status").json()["user"]["username"] == "tester"


def test_login_logout_and_user_management(client):
    anon = _anon(client)
    assert anon.post("/api/auth/login", json={"username": "tester", "password": "nope"}).status_code == 401
    assert anon.post("/api/auth/login", json={"username": "ghost", "password": "nope-nope"}).status_code == 401

    # 사용자 추가(로그인한 사용자만)
    assert client.post("/api/users", json={"username": "a", "password": "password123"}).status_code == 400  # 아이디 짧음
    assert client.post("/api/users", json={"username": "kim.dev", "password": "short"}).status_code == 400
    u = client.post("/api/users", json={"username": "kim.dev", "password": "password123", "display_name": "김개발"})
    assert u.status_code == 201 and "password_hash" not in u.json()
    u = u.json()
    assert client.post("/api/users", json={"username": "kim.dev", "password": "password123"}).status_code == 409

    kim = _anon(client)
    r = kim.post("/api/auth/login", json={"username": "kim.dev", "password": "password123"})
    assert r.status_code == 200 and "cs_session" in r.cookies
    assert kim.get("/api/documents").status_code == 200
    assert kim.get("/api/auth/status").json()["user"]["display_name"] == "김개발"

    # 본인 비밀번호 변경
    assert kim.post("/api/auth/password", json={"current_password": "x", "new_password": "newpass123"}).status_code == 400
    assert kim.post("/api/auth/password", json={"current_password": "password123", "new_password": "newpass123"}).status_code == 204

    # 관리자가 비밀번호 재설정 → 그 사용자의 기존 세션은 끊김
    assert client.patch(f"/api/users/{u['id']}", json={"password": "reset-pass-1"}).status_code == 200
    assert kim.get("/api/documents").status_code == 401
    assert kim.post("/api/auth/login", json={"username": "kim.dev", "password": "reset-pass-1"}).status_code == 200

    # 사용 중지 → 즉시 로그아웃, 로그인 불가
    assert client.patch(f"/api/users/{u['id']}", json={"enabled": False}).status_code == 200
    assert kim.get("/api/documents").status_code == 401
    assert kim.post("/api/auth/login", json={"username": "kim.dev", "password": "reset-pass-1"}).status_code == 403

    # 자기 자신은 중지·삭제 불가
    me = client.get("/api/auth/status").json()["user"]
    assert client.patch(f"/api/users/{me['id']}", json={"enabled": False}).status_code == 400
    assert client.delete(f"/api/users/{me['id']}").status_code == 400

    # 로그아웃
    assert kim.post("/api/auth/logout").status_code == 204
    assert client.delete(f"/api/users/{u['id']}").status_code == 204
    assert all(x["username"] != "kim.dev" for x in client.get("/api/users").json())


def test_initial_setup_only_when_no_users(tmp_path):
    """사용자가 없는 새 DB에서는 최초 관리자 생성이 열리고, 만든 뒤에는 닫힌다."""
    import app.db as dbm
    from sqlalchemy import create_engine
    from sqlalchemy.orm import sessionmaker

    from app.auth import require_user
    from app.db import Base, get_db
    from app.main import app as fastapi_app

    engine = create_engine(f"sqlite:///{(tmp_path / 'fresh.db').as_posix()}", connect_args={"check_same_thread": False})
    Base.metadata.create_all(engine)
    Local = sessionmaker(bind=engine)

    def _db():
        s = Local()
        try:
            yield s
        finally:
            s.close()

    fastapi_app.dependency_overrides[get_db] = _db
    try:
        c = TestClient(fastapi_app)  # lifespan 없이 (빈 DB)
        assert c.get("/api/auth/status").json() == {"user": None, "setup_required": True}
        assert c.post("/api/auth/setup", json={"username": "ad", "password": "password123"}).status_code == 400
        r = c.post("/api/auth/setup", json={"username": "admin", "password": "password123", "display_name": "관리자"})
        assert r.status_code == 201
        assert c.get("/api/auth/status").json()["user"]["username"] == "admin"  # 바로 로그인됨
        assert c.post("/api/auth/setup", json={"username": "second", "password": "password123"}).status_code == 409
    finally:
        fastapi_app.dependency_overrides.pop(get_db, None)
    assert require_user and dbm
