from __future__ import annotations

import os
import tempfile

# 설정은 import 시점에 읽으므로 앱 import 전에 임시 데이터 디렉터리를 지정한다.
_tmp = tempfile.mkdtemp(prefix="cs-test-")
os.environ["CS_DATA_DIR"] = _tmp
os.environ["CS_ENV_FILE"] = ""  # 로컬 backend/.env가 테스트에 섞이지 않도록
os.environ.setdefault("CS_PUBLIC_BASE_URL", "http://testserver")

import pytest  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402


@pytest.fixture(scope="session")
def client():
    from app import services
    from app.main import app
    from app.parser_client import call_parser

    with TestClient(app) as c:
        # 테스트 파싱의 Parser API 호출을 같은 프로세스의 앱으로 보낸다
        def _call(parser, file_name, data, params=None, **kw):
            return call_parser(parser, file_name, data, params, client=c)

        services.call_parser = _call  # type: ignore[assignment]
        # 화면용 /api 는 로그인 필수: 최초 관리자를 만들면 바로 로그인된다(쿠키 유지)
        r = c.post("/api/auth/setup", json={"username": "tester", "password": "test-password-1"})
        assert r.status_code == 201, r.text
        yield c
