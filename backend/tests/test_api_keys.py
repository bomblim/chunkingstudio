"""API 키 관리와 외부용 /api/v1 (키 필수)."""
from __future__ import annotations

import time


def _poll(client, url, headers, done=("done", "failed")):
    for _ in range(200):
        body = client.get(url, headers=headers).json()
        if body.get("status") in done:
            return body
        time.sleep(0.05)
    raise AssertionError(body)


def test_api_key_lifecycle_and_enforcement(client):
    assert client.get("/api/v1/parsers").status_code == 401  # 키 없음
    assert client.get("/api/v1/parsers", headers={"Authorization": "Bearer csk_wrong"}).status_code == 401
    assert client.post("/api/api-keys", json={"name": "  "}).status_code == 400

    created = client.post("/api/api-keys", json={"name": "ERP 연동"})
    assert created.status_code == 201
    k = created.json()
    assert k["key"].startswith("csk_") and k["prefix"] == k["key"][:12] and k["last_used_at"] is None
    listed = client.get("/api/api-keys").json()
    row = next(x for x in listed if x["id"] == k["id"])
    assert "key" not in row and "key_hash" not in row  # 목록에는 원문·해시가 없다

    bearer = {"Authorization": f"Bearer {k['key']}"}
    assert client.get("/api/v1/parsers", headers=bearer).status_code == 200
    assert client.get("/api/v1/parsers", headers={"X-API-Key": k["key"]}).status_code == 200
    assert next(x for x in client.get("/api/api-keys").json() if x["id"] == k["id"])["last_used_at"]
    assert client.get("/api/parsers").status_code == 200  # 화면용 /api 는 그대로

    assert client.delete(f"/api/api-keys/{k['id']}").status_code == 204
    assert client.get("/api/v1/parsers", headers=bearer).status_code == 401  # 삭제한 키는 즉시 거부


def test_v1_pipeline_with_api_key(client):
    key = client.post("/api/api-keys", json={"name": "파이프라인"}).json()["key"]
    h = {"Authorization": f"Bearer {key}"}
    parser = next(p for p in client.get("/api/v1/parsers", headers=h).json() if p["name"] == "sample-parser")
    emb = next(m for m in client.get("/api/v1/embedding-models", headers=h).json() if m["provider"] == "mock")
    conn = client.post("/api/vector-stores", json={"name": "v1 연결", "kind": "memory"}).json()
    coll = client.post(f"/api/vector-stores/{conn['id']}/collections", json={"name": "cs_v1_api"}).json()
    proj = client.post("/api/projects", json={"name": "v1 API", "method": "rule_structure",
                                              "vector_collection_id": coll["id"]}).json()

    f = client.post("/api/v1/files", headers=h, files={"file": ("v1.md", "# 제목\n\n본문 문단\n".encode(), "text/markdown")})
    assert f.status_code == 201, f.text
    job = client.post("/api/v1/parse-jobs", headers=h, json={"file_id": f.json()["id"], "parser_id": parser["id"],
                                                              "project_id": proj["id"]})
    assert job.status_code == 202
    job = _poll(client, f"/api/v1/parse-jobs/{job.json()['id']}", h)
    assert job["status"] == "done"
    run = client.post("/api/v1/runs", headers=h, json={"document_id": job["document_id"]})
    run = _poll(client, f"/api/v1/runs/{run.json()['id']}", h)
    assert run["status"] == "done"
    ix = client.post("/api/v1/indexes", headers=h, json={"run_id": run["id"], "embedding_model_id": emb["id"]})
    ix = _poll(client, f"/api/v1/indexes/{ix.json()['id']}", h)
    assert ix["status"] == "done" and ix["collection"] == "cs_v1_api"
    q = client.post(f"/api/v1/indexes/{ix['id']}/query", headers=h, json={"query": "본문", "top_k": 1})
    assert q.status_code == 200 and q.json()["hits"]
    assert client.post(f"/api/v1/indexes/{ix['id']}/query", json={"query": "본문"}).status_code == 401
