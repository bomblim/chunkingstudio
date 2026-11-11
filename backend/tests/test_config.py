from __future__ import annotations

import os

from app.config import load_env_file


def test_load_env_file_parses_and_does_not_override(tmp_path, monkeypatch):
    env = tmp_path / ".env"
    env.write_text(
        "# 주석\n"
        "CS_TEST_A=hello\n"
        'CS_TEST_B="quoted value # not comment"\n'
        "export CS_TEST_C=world # 줄 끝 주석\n"
        "CS_TEST_KEEP=from-file\n"
        "잘못된 줄\n",
        encoding="utf-8",
    )
    for k in ("CS_TEST_A", "CS_TEST_B", "CS_TEST_C"):
        monkeypatch.delenv(k, raising=False)
    monkeypatch.setenv("CS_TEST_KEEP", "from-shell")

    loaded = load_env_file(env)
    try:
        assert set(loaded) == {"CS_TEST_A", "CS_TEST_B", "CS_TEST_C"}
        assert os.environ["CS_TEST_A"] == "hello"
        assert os.environ["CS_TEST_B"] == "quoted value # not comment"
        assert os.environ["CS_TEST_C"] == "world"
        assert os.environ["CS_TEST_KEEP"] == "from-shell"  # 셸 값이 우선
    finally:
        for k in loaded:
            os.environ.pop(k, None)


def test_missing_env_file_is_ignored(tmp_path):
    assert load_env_file(tmp_path / "none.env") == []
