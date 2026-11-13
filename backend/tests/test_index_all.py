from __future__ import annotations

import time


def _wait(client, url, key="status"):
    for _ in range(200):
        body = client.get(url).json()
        if body[key] in ("done", "failed"):
            return body
        time.sleep(0.05)
    raise AssertionError(body)


def _doc(client, parser_id, title, project_id):
    els = [{"element_id": f"E{i}", "type": "heading" if i % 3 == 0 else "paragraph", "text": f"{title} 본문 {i}"}
           for i in range(6)]
    doc = client.post("/api/ingest", json={"parser_id": parser_id, "title": title, "payload": {"elements": els}}).json()
    client.patch(f"/api/documents/{doc['id']}", json={"project_id": project_id})
    return doc


def _run(client, doc_id):
    run = client.post("/api/runs", json={"document_id": doc_id, "method": "rule_structure"}).json()
    return _wait(client, f"/api/runs/{run['id']}")


def test_project_index_all_uses_latest_successful_run(client):
    parser = next(x for x in client.get("/api/parsers").json() if x["adapter"] == "standard")
    root = client.post("/api/projects", json={"name": "일괄적재"}).json()
    child = client.post("/api/projects", json={"name": "하위", "parent_id": root["id"]}).json()
    a = _doc(client, parser["id"], "문서A", root["id"])
    b = _doc(client, parser["id"], "문서B", child["id"])
    _doc(client, parser["id"], "문서C", root["id"])  # 청킹 안 함 → 제외
    _run(client, a["id"])
    a2 = _run(client, a["id"])  # A는 두 번 청킹 → 최근 것만
    b1 = _run(client, b["id"])

    plan = client.get(f"/api/projects/{root['id']}/index-plan").json()
    assert {i["title"]: i["run_id"] for i in plan["items"]} == {"문서A": a2["id"], "문서B": b1["id"]}
    assert [s["title"] for s in plan["skipped"]] == ["문서C"]
    assert plan["default_collection"] == f"cs_proj{root['id']}"
    # 하위 제외
    assert [i["title"] for i in client.get(f"/api/projects/{root['id']}/index-plan",
                                           params={"include_descendants": False}).json()["items"]] == ["문서A"]

    emb = next(m for m in client.get("/api/embedding-models").json() if m["provider"] == "mock")
    store = next(s for s in client.get("/api/vector-stores").json() if s["kind"] == "memory")
    body = {"store_id": store["id"], "embedding_model_id": emb["id"], "collection": "cs_pytest_index_all",
            "mode": "recreate"}
    r = client.post(f"/api/projects/{root['id']}/index-all", json=body)
    assert r.status_code == 202, r.text
    assert r.json()["document_count"] == 2 and len(r.json()["skipped"]) == 1
    ix = _wait(client, f"/api/indexes/{r.json()['index']['id']}")
    assert ix["status"] == "done", ix
    assert ix["run_ids"] == sorted([a2["id"], b1["id"]])
    expected = a2["totals"]["chunk_count"] + b1["totals"]["chunk_count"]
    assert ix["chunk_count"] == expected
    assert ix["stats"]["batch"]["succeeded"] == 2 and not ix["stats"]["batch"]["failed"]

    # A를 다시 청킹하고 '추가'로 일괄 적재하면 A의 이전 청크는 교체되어 중복되지 않는다
    a3 = _run(client, a["id"])
    r2 = client.post(f"/api/projects/{root['id']}/index-all", json={**body, "mode": "append"}).json()
    assert r2["index"]["id"] == ix["id"]
    ix2 = _wait(client, f"/api/indexes/{ix['id']}")
    assert ix2["status"] == "done"
    assert ix2["run_ids"] == sorted([a3["id"], b1["id"]])
    assert ix2["chunk_count"] == expected

    hits = client.post(f"/api/indexes/{ix['id']}/query", json={"query": "문서A 본문", "top_k": 50}).json()["hits"]
    assert {h["run_id"] for h in hits} == {a3["id"], b1["id"]}


def test_project_index_all_without_runs(client):
    p = client.post("/api/projects", json={"name": "빈 적재"}).json()
    emb = next(m for m in client.get("/api/embedding-models").json() if m["provider"] == "mock")
    store = next(s for s in client.get("/api/vector-stores").json() if s["kind"] == "memory")
    r = client.post(f"/api/projects/{p['id']}/index-all", json={"store_id": store["id"], "embedding_model_id": emb["id"],
                                                                "collection": "cs_pytest_empty"})
    assert r.status_code == 400
