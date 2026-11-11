from __future__ import annotations

import importlib


def test_spa_serving(tmp_path, monkeypatch):
    """CS_STATIC_DIR가 있으면 정적 파일과 SPA 경로를 제공하고, /api는 그대로 둔다."""
    (tmp_path / "index.html").write_text("<html>studio</html>", encoding="utf-8")
    (tmp_path / "assets").mkdir()
    (tmp_path / "assets" / "app.js").write_text("console.log(1)", encoding="utf-8")
    monkeypatch.setenv("CS_STATIC_DIR", str(tmp_path))
    from fastapi.testclient import TestClient

    import app.config
    import app.main

    importlib.reload(app.config)
    main = importlib.reload(app.main)
    try:
        c = TestClient(main.app)
        assert c.get("/assets/app.js").text == "console.log(1)"
        assert "studio" in c.get("/documents/3").text  # 클라이언트 라우팅
        assert "studio" in c.get("/").text
        assert c.get("/api/does-not-exist").status_code == 404
        assert c.get("/api/health").json()["ok"] is True
        assert "studio" in c.get("/../../etc/passwd").text  # 상위 경로 탈출은 index.html로
    finally:
        monkeypatch.delenv("CS_STATIC_DIR")
        importlib.reload(app.config)
        importlib.reload(app.main)
