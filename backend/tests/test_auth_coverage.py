"""화면용 /api 전 경로가 로그인 없이 막히는지 전수 점검 (새 API를 추가할 때 빠뜨리지 않도록)."""
from __future__ import annotations

import re

from fastapi.testclient import TestClient

DUMMY = "0193a8c2-0000-7000-8000-000000000000"

# 로그인 없이 열려 있어야 하는 경로 (이유)
PUBLIC = {
    "/api/health": "상태 확인(배포 헬스체크)",
    "/api/auth/status": "로그인 화면이 상태를 확인",
    "/api/auth/setup": "최초 관리자 생성(사용자가 없을 때만 허용)",
    "/api/auth/login": "로그인",
    "/api/auth/logout": "로그아웃",
    "/api/dev/sample-parser/parse": "개발용 샘플 파서(Studio가 자기 자신을 호출, CS_ENABLE_SAMPLE_PARSER로 끔)",
}
# 로그인 대신 API 키로 보호
API_KEY_PREFIX = "/api/v1/"


def _routes(app):
    for path, ops in app.openapi()["paths"].items():
        for method in ops:
            yield method.upper(), path


def test_every_ui_api_route_requires_login(client):
    anon = TestClient(client.app)  # 쿠키 없음
    checked, open_routes = 0, []
    for method, path in _routes(client.app):
        if not path.startswith("/api"):
            continue
        url = re.sub(r"\{[^}]+\}", DUMMY, path)
        res = anon.request(method, url, json={} if method in ("POST", "PUT", "PATCH") else None)
        checked += 1
        if path in PUBLIC:
            assert res.status_code != 401, (method, path, "공개 경로인데 401")
            continue
        if path.startswith(API_KEY_PREFIX):
            assert res.status_code == 401, (method, path, res.status_code, "API 키 없이 열림")
            continue
        if res.status_code != 401:
            open_routes.append((method, path, res.status_code))
    assert checked > 60
    assert open_routes == [], f"로그인 없이 열린 화면용 API: {open_routes}"


def test_logged_in_browser_flow_uses_cookie(client):
    """화면(브라우저)은 쿠키 세션으로 /api를 호출한다: 쿠키가 있으면 통과, 지우면 401."""
    assert client.get("/api/documents").status_code == 200
    saved = dict(client.cookies)
    client.cookies.clear()
    try:
        assert client.get("/api/documents").status_code == 401
        assert client.get(f"/api/documents/{DUMMY}/file").status_code == 401  # 원본 파일(PDF·이미지)도 보호
    finally:
        for k, v in saved.items():
            client.cookies.set(k, v)
    assert client.get("/api/documents").status_code == 200
