from __future__ import annotations

import time


def _wait(client, url, done=("done", "failed"), key="status"):
    for _ in range(50):
        body = client.get(url).json()
        if body[key] in done:
            return body
        time.sleep(0.1)
    raise AssertionError(f"timeout: {body}")


def test_seed_and_mock_run(client):
    docs = client.get("/api/documents").json()
    assert docs, "샘플 문서가 시드되어야 함"
    docs = [d for d in docs if d["title"].endswith("(샘플)")]  # 다른 테스트가 만든 문서와 섞이지 않도록
    models = client.get("/api/models", params={"usable_only": True}).json()
    mock = next(m for m in models if m["provider"] == "mock")
    prompt = client.get("/api/prompts").json()[0]
    pv_id = prompt["versions"][0]["id"]

    preview = client.post("/api/prompts/preview", json={
        "document_id": docs[0]["id"], "system_template": prompt["versions"][0]["system_template"],
        "user_template": prompt["versions"][0]["user_template"], "model_id": mock["id"],
    }).json()
    assert "[E1][title" in preview["user"] and not preview["unknown_variables"]

    run = client.post("/api/runs", json={
        "document_id": docs[0]["id"], "method": "llm", "model_id": mock["id"], "prompt_version_id": pv_id,
        "settings": {"max_tokens": 200},
    }).json()
    body = _wait(client, f"/api/runs/{run['id']}")
    assert body["status"] == "done", body.get("error")
    assert body["validation"]["ok"] and body["chunks"]
    assert body["snapshot"]["prompt"]["version"] == 1

    fb = client.post(f"/api/runs/{run['id']}/feedback", json={"chunk_id": "C1", "value": "up"}).json()
    assert fb["C1"]["value"] == "up"


def test_test_parse_calls_parser_api(client):
    parser = next(p for p in client.get("/api/parsers").json() if p["name"] == "sample-parser")
    files = {"file": ("note.md", "# 제목\n\n본문 문단입니다.\n\n## 소제목\n\n- 항목".encode())}
    jobs = client.post("/api/test-parse", files=files, data={"parser_ids": str(parser["id"])}).json()
    job = client.get("/api/parse-jobs", params={"ids": str(jobs[0]["id"])}).json()[0]
    assert job["status"] == "done", job
    doc = client.get(f"/api/documents/{job['document_id']}").json()
    assert doc["source"] == "test"
    assert [e["type"] for e in doc["content"]["elements"]] == ["title", "paragraph", "heading", "list"]
    assert client.get(f"/api/parse-jobs/{job['id']}/raw").status_code == 200


def test_test_parse_failure_kind(client):
    parser = next(p for p in client.get("/api/parsers").json() if p["name"] == "sample-parser")
    files = {"file": ("image.png", b"\x89PNG....")}
    jobs = client.post("/api/test-parse", files=files, data={"parser_ids": str(parser["id"])}).json()
    job = client.get("/api/parse-jobs", params={"ids": str(jobs[0]["id"])}).json()[0]
    assert job["status"] == "failed" and job["error_kind"] == "parser_error"


def test_ingest_and_quarantine(client):
    parser = client.post("/api/parsers", json={"name": "unstructured-x", "adapter": "unstructured"}).json()
    payload = [
        {"type": "Title", "element_id": "a", "text": "보고서", "metadata": {"page_number": 1}},
        {"type": "NarrativeText", "element_id": "b", "text": "본문", "metadata": {"page_number": 1, "parent_id": "a"}},
    ]
    doc = client.post("/api/ingest", json={"parser_id": parser["id"], "title": "r1", "payload": payload}).json()
    assert doc["stats"]["element_count"] == 2
    again = client.post("/api/ingest", json={"parser_id": parser["id"], "title": "r1", "payload": payload,
                                             "file_hash": doc["file_hash"]}).json()
    assert again["revision"] == 2  # 재파싱 버전 누적

    bad = client.post("/api/ingest", json={"parser_id": parser["id"], "title": "bad", "payload": {"x": 1}})
    assert bad.status_code == 422
    failures = client.get("/api/ingest/failures").json()
    assert failures[0]["source_name"] == "bad"


def test_prompt_versioning(client):
    p = client.post("/api/prompts", json={"name": "실험 프롬프트"}).json()
    v1 = p["versions"][0]
    v2 = client.post(f"/api/prompts/{p['id']}/versions", json={
        "system_template": v1["system_template"] + "\n추가 규칙", "user_template": v1["user_template"],
        "note": "규칙 추가",
    }).json()
    assert v2["version"] == 2
    client.patch(f"/api/prompts/versions/{v1['id']}/status", json={"status": "production"})
    client.patch(f"/api/prompts/versions/{v2['id']}/status", json={"status": "production"})
    got = client.get(f"/api/prompts/{p['id']}").json()
    assert [v["status"] for v in got["versions"]] == ["approved", "production"]
    rb = client.post(f"/api/prompts/versions/{v1['id']}/rollback").json()
    assert rb["version"] == 3 and rb["system_template"] == v1["system_template"]
    fork = client.post(f"/api/prompts/versions/{v2['id']}/fork", json={"name": "fork 프롬프트"}).json()
    assert fork["forked_from_version_id"] == v2["id"]
