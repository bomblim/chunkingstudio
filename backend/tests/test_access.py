from __future__ import annotations

import os
import time

import pytest

from app.vectorstores import can_access, combine_filters, permission_expr


def _wait(client, url):
    for _ in range(100):
        body = client.get(url).json()
        if body["status"] in ("done", "failed"):
            return body
        time.sleep(0.05)
    raise AssertionError(body)


def _proj(client, name, parent=None, **kw):
    r = client.post("/api/projects", json={"name": name, "parent_id": parent, **kw})
    assert r.status_code == 201, r.text
    return r.json()


def test_permission_expr_and_access():
    assert permission_expr(None) == ""
    assert permission_expr([]) == 'metadata["public"] == true'
    expr = permission_expr(["group:인사팀"])
    assert 'json_contains_any(metadata["permissions"], ["group:인사팀"])' in expr
    assert combine_filters("run_id == 1", expr).startswith("(run_id == 1) and (")
    assert can_access({"public": True}, ["x"]) and can_access({"permissions": ["a"]}, ["a", "b"])
    assert not can_access({"permissions": ["a"]}, ["b"]) and not can_access({}, [])
    assert can_access({}, None)


def test_meta_and_permission_inheritance(client):
    root = _proj(client, "권한 루트", meta={"부서": "방산사업부", "보안등급": "대외비"},
                 permissions=["group:방산", "role:admin"])
    child = _proj(client, "권한 하위", root["id"], meta={"보안등급": "비밀", "연도": 2025},
                  permissions=["group:육군"])
    over = _proj(client, "권한 재정의", root["id"], permissions=["user:hong"], permission_mode="override")
    empty = _proj(client, "공개 루트")

    c = client.get(f"/api/projects/{child['id']}").json()["access"]
    assert c["meta"] == {"부서": "방산사업부", "보안등급": "비밀", "연도": 2025}  # 하위 값 우선
    assert c["meta_source_names"]["부서"] == "권한 루트"
    assert c["permissions"] == ["group:방산", "group:육군", "role:admin"] and not c["public"]
    o = client.get(f"/api/projects/{over['id']}").json()["access"]
    assert o["permissions"] == ["user:hong"]
    assert client.get(f"/api/projects/{empty['id']}").json()["access"]["public"] is True

    bad = client.post("/api/projects", json={"name": "잘못된 권한", "permissions": ['group:"x"']})
    assert bad.status_code == 400
    assert client.post("/api/projects", json={"name": "잘못된 키", "meta": {"a b": 1}}).status_code == 400


def test_index_carries_access_and_query_filters(client):
    secret = _proj(client, "비밀 문서함", meta={"보안등급": "비밀"}, permissions=["group:보안팀"])
    doc = client.get("/api/documents").json()[-1]
    client.patch(f"/api/documents/{doc['id']}", json={"project_id": secret["id"]})
    run = client.post("/api/runs", json={"document_id": doc["id"], "method": "rule_structure",
                                         "settings": {"max_tokens": 200}}).json()
    run = _wait(client, f"/api/runs/{run['id']}")
    emb = next(m for m in client.get("/api/embedding-models").json() if m["provider"] == "mock")
    store = next(s for s in client.get("/api/vector-stores").json() if s["kind"] == "memory")
    ix = client.post("/api/indexes", json={"run_id": run["id"], "store_id": store["id"], "embedding_model_id": emb["id"],
                                           "collection": "access_test", "mode": "recreate"}).json()
    ix = _wait(client, f"/api/indexes/{ix['id']}")
    assert ix["status"] == "done", ix["error"]

    q = {"query": "보안 사고 신고", "top_k": 3}
    admin = client.post(f"/api/indexes/{ix['id']}/query", json=q).json()
    meta = admin["hits"][0]["metadata"]
    assert meta["permissions"] == ["group:보안팀"] and meta["public"] is False
    assert meta["project_meta"] == {"보안등급": "비밀"} and meta["project_path"] == ["비밀 문서함"]

    allowed = client.post(f"/api/indexes/{ix['id']}/query", json={**q, "principals": ["group:보안팀", "user:kim"]}).json()
    assert len(allowed["hits"]) == 3
    denied = client.post(f"/api/indexes/{ix['id']}/query", json={**q, "principals": ["group:인사팀"]}).json()
    assert denied["hits"] == []
    public_only = client.post(f"/api/indexes/{ix['id']}/query", json={**q, "principals": []}).json()
    assert public_only["hits"] == []
    assert client.post(f"/api/indexes/{ix['id']}/query", json={**q, "principals": ["a b"]}).status_code == 400
    client.patch(f"/api/documents/{doc['id']}", json={"clear_project": True})


@pytest.mark.skipif(not os.environ.get("CS_TEST_MILVUS_URI"), reason="CS_TEST_MILVUS_URI 미설정 (실제 Milvus 필요)")
def test_milvus_permission_filter(client):
    proj = _proj(client, "Milvus 권한", permissions=["group:보안팀"])
    secret_doc = client.get("/api/documents").json()[-1]  # 시드 샘플 문서
    parser = next(x for x in client.get("/api/parsers").json() if x["adapter"] == "standard")
    open_doc = client.post("/api/ingest", json={"parser_id": parser["id"], "title": "공개 문서", "payload": {
        "elements": [{"element_id": "E1", "type": "paragraph", "text": "원격근무 보안 수칙은 모든 직원에게 공개된다."}]}}).json()
    client.patch(f"/api/documents/{secret_doc['id']}", json={"project_id": proj["id"]})
    emb = next(m for m in client.get("/api/embedding-models").json() if m["provider"] == "mock")
    store = client.post("/api/vector-stores", json={"name": "milvus-access-test", "kind": "milvus",
                                                    "uri": os.environ["CS_TEST_MILVUS_URI"]}).json()
    ix = None
    for i, d in enumerate((secret_doc, open_doc)):
        run = client.post("/api/runs", json={"document_id": d["id"], "method": "rule_structure"}).json()
        run = _wait(client, f"/api/runs/{run['id']}")
        body = {"run_id": run["id"], "store_id": store["id"], "embedding_model_id": emb["id"],
                "collection": "cs_pytest_access", "mode": "recreate" if i == 0 else "append"}
        ix = _wait(client, f"/api/indexes/{client.post('/api/indexes', json=body).json()['id']}")
        assert ix["status"] == "done", ix["error"]
    q = {"query": "원격근무 보안", "top_k": 50}
    everything = client.post(f"/api/indexes/{ix['id']}/query", json=q).json()["hits"]
    docs_seen = {h["document_id"] for h in everything}
    assert docs_seen == {secret_doc["id"], open_doc["id"]}
    outsider = client.post(f"/api/indexes/{ix['id']}/query", json={**q, "principals": ["group:인사팀"]}).json()
    assert {h["document_id"] for h in outsider["hits"]} == {open_doc["id"]}  # 공개 문서만
    insider = client.post(f"/api/indexes/{ix['id']}/query", json={**q, "principals": ["group:보안팀"]}).json()
    assert {h["document_id"] for h in insider["hits"]} == docs_seen
    assert "json_contains_any" in insider["applied_filter"]
    client.delete(f"/api/indexes/{ix['id']}", params={"drop_collection": True})
    client.patch(f"/api/documents/{secret_doc['id']}", json={"clear_project": True})
