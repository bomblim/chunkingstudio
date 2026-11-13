"""API 안내 화면의 4단계(업로드 → 파싱 → 청킹 → 적재) 흐름을 그대로 따라 한다."""
from __future__ import annotations

import time


def _poll(client, url, done=("done", "failed")):
    for _ in range(200):
        body = client.get(url).json()
        if body["status"] in done:
            return body
        time.sleep(0.05)
    raise AssertionError(body)


def test_upload_parse_chunk_index_flow(client):
    parser = next(p for p in client.get("/api/parsers").json() if p["name"] == "sample-parser")
    emb = next(m for m in client.get("/api/embedding-models").json() if m["provider"] == "mock")
    conn = client.post("/api/vector-stores", json={"name": "파이프라인 API 연결", "kind": "memory"}).json()
    coll = client.post(f"/api/vector-stores/{conn['id']}/collections", json={"name": "cs_pipeline_api"}).json()
    proj = client.post("/api/projects", json={"name": "파이프라인 API", "method": "rule_structure",
                                              "vector_collection_id": coll["id"]}).json()

    # 1. 문서 업로드
    md = "# 출장 규정\n\n출장비는 사전 승인을 받아야 한다.\n\n## 숙박\n\n- 1박 10만원 이내\n".encode()
    f = client.post("/api/files", files={"file": ("travel.md", md, "text/markdown")})
    assert f.status_code == 201, f.text
    f = f.json()
    assert f["file_name"] == "travel.md" and f["size"] == len(md) and "path" not in f
    assert client.get(f"/api/files/{f['id']}").json()["file_hash"] == f["file_hash"]

    # 2. 파싱 (비동기: 작업 ID → 상태 조회 → document_id)
    job = client.post("/api/parse-jobs", json={"file_id": f["id"], "parser_id": parser["id"], "project_id": proj["id"]})
    assert job.status_code == 202, job.text
    job = _poll(client, f"/api/parse-jobs/{job.json()['id']}")
    assert job["status"] == "done", job
    doc = client.get(f"/api/documents/{job['document_id']}").json()
    assert doc["project_id"] == proj["id"] and doc["content"]["elements"]

    # 3. 청킹 (method 생략 → 프로젝트 프로파일, 비동기)
    run = client.post("/api/runs", json={"document_id": doc["id"]})
    assert run.status_code == 202, run.text
    run = _poll(client, f"/api/runs/{run.json()['id']}")
    assert run["status"] == "done" and run["method"] == "rule_structure" and run["chunks"]

    # 4. 저장소 적재 (컬렉션은 프로젝트 설정, 비동기)
    ix = client.post("/api/indexes", json={"run_id": run["id"], "embedding_model_id": emb["id"]})
    assert ix.status_code == 202, ix.text
    ix = _poll(client, f"/api/indexes/{ix.json()['id']}")
    assert ix["status"] == "done" and ix["collection"] == "cs_pipeline_api"
    assert ix["chunk_count"] == len(run["chunks"])


def test_pipeline_api_errors(client):
    assert client.post("/api/parse-jobs", json={"file_id": "0193a8c2-0000-7000-8000-000000000000", "parser_id": "0193a8c2-0000-7000-8000-000000000001"}).status_code == 404
    up = client.post("/api/parser-dummy")  # 존재하지 않는 경로
    assert up.status_code in (404, 405)
    # 미분류 문서는 method를 생략하면 프로젝트 프로파일이 없어 400
    parser = next(x for x in client.get("/api/parsers").json() if x["adapter"] == "standard")
    doc = client.post("/api/ingest", json={"parser_id": parser["id"], "title": "미분류 API 문서",
                                           "payload": {"elements": [{"element_id": "E1", "type": "paragraph", "text": "본문"}]}}).json()
    r = client.post("/api/runs", json={"document_id": doc["id"]})
    assert r.status_code == 400 and "미분류" in r.json()["detail"]
