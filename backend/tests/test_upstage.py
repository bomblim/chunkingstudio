from __future__ import annotations

import json

import httpx
import pytest

from app.adapters import adapt
from app.models import Parser
from app.parser_client import ParserCallError, call_parser

ELEMENTS = [
    {"id": 0, "category": "heading1", "page": 1, "content": {"html": "<h1 id='0'>원격근무 지침</h1>", "markdown": "# 원격근무 지침", "text": "원격근무 지침"},
     "coordinates": [{"x": 0.1, "y": 0.05}, {"x": 0.6, "y": 0.05}, {"x": 0.6, "y": 0.08}, {"x": 0.1, "y": 0.08}]},
    {"id": 1, "category": "paragraph", "page": 1, "content": {"html": "<p id='1'>주 3일까지 가능</p>", "markdown": "주 3일까지 가능", "text": "주 3일까지 가능"},
     "coordinates": [{"x": 0.1, "y": 0.1}, {"x": 0.9, "y": 0.1}, {"x": 0.9, "y": 0.15}, {"x": 0.1, "y": 0.15}]},
    {"id": 2, "category": "table", "page": 2, "content": {"html": "<table id='2'><tr><td>구분</td><td>허용</td></tr></table>", "markdown": "| 구분 | 허용 |", "text": "구분 허용"},
     "coordinates": [{"x": 0.1, "y": 0.2}, {"x": 0.9, "y": 0.2}, {"x": 0.9, "y": 0.4}, {"x": 0.1, "y": 0.4}]},
    {"id": 3, "category": "footer", "page": 2, "content": {"text": "- 2 -"}, "coordinates": []},
]


def _job(parse_result: dict, status: str = "completed") -> dict:
    return {
        "id": "job_abc", "object": "response", "status": status, "error": None,
        "output": [{"type": "message", "status": "completed", "role": "assistant", "model": "step_1_parse",
                    "content": [{"type": "output_text", "text": json.dumps(parse_result, ensure_ascii=False),
                                 "annotations": []}]}],
    }


def _parser(**cfg) -> Parser:
    return Parser(name="upstage", api_url="https://api.upstage.ai/v2", api_mode="upstage", api_file_field="file",
                  api_auth_header="Authorization", api_auth_env="UPSTAGE_TEST_KEY", api_timeout_sec=30,
                  max_file_mb=50, adapter="upstage",
                  api_config={"project_id": "proj_test", "model": "agt_test", "config_id": "1",
                              "purpose": "user_data", "poll_interval_sec": 0, **cfg})


def test_adapter_elements_from_v2_job():
    doc = adapt("upstage", _job({"api": "2.0", "elements": ELEMENTS}))
    types = [e.type for e in doc.elements]
    assert types == ["heading", "paragraph", "table", "footer"]
    assert [e.element_id for e in doc.elements] == ["E0", "E1", "E2", "E3"]
    assert doc.elements[1].parent_id == "E0"  # heading 아래 본문
    assert doc.elements[2].table and doc.elements[2].table.markdown == "| 구분 | 허용 |"
    assert doc.elements[0].bbox and doc.elements[0].bbox.x1 == 0.6
    assert [p.page_no for p in doc.pages] == [1, 2] and doc.pages[0].width == 1.0
    assert doc.extra["upstage"]["job_id"] == "job_abc"


def test_adapter_html_only_fallback():
    html = ("<h1 id='0' data-category='heading1'>제목</h1><p id='1' data-category='paragraph'>본문 <b>강조</b></p>"
            "<table id='2'><tr><td>A</td><td>B</td></tr></table><figure id='3'><img alt='로고'/></figure>")
    doc = adapt("upstage", _job({"api": "2.0", "content": {"html": html}}))
    assert [(e.element_id, e.type) for e in doc.elements] == [("E0", "heading"), ("E1", "paragraph"),
                                                             ("E2", "table"), ("E3", "figure")]
    assert doc.elements[1].text == "본문 강조"
    assert "<td>A</td>" in (doc.elements[2].table.html or "")


def test_adapter_accepts_v1_response():
    doc = adapt("upstage", {"api": "1.1", "content": {"html": ""}, "elements": ELEMENTS[:2]})
    assert len(doc.elements) == 2


def test_upstage_call_flow(monkeypatch):
    monkeypatch.setenv("UPSTAGE_TEST_KEY", "up_secret")
    seen: list[httpx.Request] = []
    polls = {"n": 0}

    def handler(req: httpx.Request) -> httpx.Response:
        seen.append(req)
        assert req.headers["authorization"] == "Bearer up_secret"
        assert req.headers["x-project-id"] == "proj_test"
        if req.url.path == "/v2/files":
            assert b'name="purpose"' in req.content and b"user_data" in req.content
            return httpx.Response(200, json={"id": "file-123", "object": "file"})
        if req.method == "POST" and req.url.path == "/v2/responses":
            body = json.loads(req.content)
            assert body["model"] == "agt_test" and body["config_id"] == "1"
            assert body["input"][0]["content"][0] == {"type": "input_file", "file_id": "file-123"}
            return httpx.Response(200, json={"id": "job_abc", "status": "queued"})
        if req.method == "GET" and req.url.path == "/v2/responses/job_abc":
            polls["n"] += 1
            if polls["n"] < 2:
                return httpx.Response(200, json={"id": "job_abc", "status": "in_progress"})
            return httpx.Response(200, json=_job({"elements": ELEMENTS}))
        return httpx.Response(404)

    client = httpx.Client(transport=httpx.MockTransport(handler))
    res = call_parser(_parser(), "doc.pdf", b"%PDF-1.4", {}, client=client)
    assert res.payload["status"] == "completed" and polls["n"] == 2
    assert len(adapt("upstage", res.payload).elements) == 4


def test_upstage_failed_job(monkeypatch):
    monkeypatch.setenv("UPSTAGE_TEST_KEY", "up_secret")

    def handler(req: httpx.Request) -> httpx.Response:
        if req.url.path == "/v2/files":
            return httpx.Response(200, json={"id": "file-1"})
        return httpx.Response(200, json={"id": "job_x", "status": "failed", "error": {"message": "unsupported file"}})

    with pytest.raises(ParserCallError, match="unsupported file") as ei:
        call_parser(_parser(), "x.bin", b"x", {}, client=httpx.Client(transport=httpx.MockTransport(handler)))
    assert ei.value.kind == "parser_error"


def test_upstage_missing_config(monkeypatch):
    monkeypatch.delenv("UPSTAGE_TEST_KEY", raising=False)
    with pytest.raises(ParserCallError) as ei:
        call_parser(_parser(model=""), "x.pdf", b"x", {}, client=httpx.Client(transport=httpx.MockTransport(lambda r: httpx.Response(500))))
    assert ei.value.kind == "config_error"
    assert "Agent ID" in str(ei.value) and "UPSTAGE_TEST_KEY" in str(ei.value)


def test_seeded_upstage_parser_and_health(client, monkeypatch):
    p = next(x for x in client.get("/api/parsers").json() if x["name"] == "upstage-parser")
    assert p["api_mode"] == "upstage" and p["adapter"] == "upstage" and not p["enabled"]
    assert p["api_config"]["config_id"] == "1"
    health = client.post(f"/api/parsers/{p['id']}/health").json()
    assert not health["ok"] and "Agent ID" in health["message"]
