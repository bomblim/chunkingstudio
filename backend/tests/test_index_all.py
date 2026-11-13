from __future__ import annotations

import time


def _wait(client, url, key="status"):
    for _ in range(200):
        body = client.get(url).json()
        if body[key] in ("done", "failed"):
            return body
        time.sleep(0.05)
    raise AssertionError(body)


def _doc(client, parser_id, title, project_id=None):
    els = [{"element_id": f"E{i}", "type": "heading" if i % 3 == 0 else "paragraph", "text": f"{title} 본문 {i}"}
           for i in range(6)]
    doc = client.post("/api/ingest", json={"parser_id": parser_id, "title": title, "payload": {"elements": els}}).json()
    if project_id is not None:
        client.patch(f"/api/documents/{doc['id']}", json={"project_id": project_id})
    return doc


def _run(client, doc_id):
    run = client.post("/api/runs", json={"document_id": doc_id, "method": "rule_structure"}).json()
    return _wait(client, f"/api/runs/{run['id']}")


def _store(client, name, collection, **kw):
    r = client.post("/api/vector-stores", json={"name": name, "kind": "memory", "collection": collection, **kw})
    assert r.status_code == 201, r.text
    return r.json()


def _ctx(client):
    parser = next(x for x in client.get("/api/parsers").json() if x["adapter"] == "standard")
    emb = next(m for m in client.get("/api/embedding-models").json() if m["provider"] == "mock")
    return parser["id"], emb["id"]


def test_vector_store_collection_and_default_rules(client):
    assert client.post("/api/vector-stores", json={"name": "컬렉션없음", "kind": "memory"}).status_code == 400
    assert client.post("/api/vector-stores", json={"name": "잘못된이름", "kind": "memory",
                                                   "collection": "1bad-name"}).status_code == 400
    stores = client.get("/api/vector-stores").json()
    default = [s for s in stores if s["is_default"]]
    assert len(default) == 1 and default[0]["collection"]  # 시드: 기본 저장소 하나, 모든 저장소에 컬렉션
    assert all(s["collection"] for s in stores)
    d = default[0]
    body = {k: d[k] for k in ("name", "kind", "uri", "token_env", "db_name", "tls_ca_path", "tls_server_name",
                              "collection", "enabled")}
    r = client.put(f"/api/vector-stores/{d['id']}", json={**body, "is_default": False})
    assert r.status_code == 400  # 기본 저장소는 직접 해제할 수 없음
    r = client.put(f"/api/vector-stores/{d['id']}", json={**body, "is_default": True, "enabled": False})
    assert r.status_code == 400  # 기본 저장소는 비활성화할 수 없음


def test_project_index_all_uses_project_store_and_latest_run(client):
    parser_id, emb_id = _ctx(client)
    s1 = _store(client, "적재 테스트 S1", "cs_t_s1")
    s2 = _store(client, "적재 테스트 S2", "cs_t_s2")
    root = client.post("/api/projects", json={"name": "일괄적재", "vector_store_id": s1["id"]}).json()
    child = client.post("/api/projects", json={"name": "하위-상속", "parent_id": root["id"]}).json()
    child2 = client.post("/api/projects", json={"name": "하위-S2", "parent_id": root["id"],
                                                "vector_store_id": s2["id"]}).json()
    eff = next(p for p in client.get("/api/projects").json()["projects"] if p["id"] == child["id"])["effective"]
    assert eff["vector_store"]["id"] == s1["id"] and eff["vector_store_source"]["project_name"] == "일괄적재"

    a = _doc(client, parser_id, "문서A", root["id"])
    b = _doc(client, parser_id, "문서B", child["id"])
    c = _doc(client, parser_id, "문서C", child2["id"])
    _doc(client, parser_id, "문서D", root["id"])  # 청킹 안 함 → 제외
    _run(client, a["id"])
    a2 = _run(client, a["id"])  # A는 두 번 청킹 → 최근 것만
    b1, c1 = _run(client, b["id"]), _run(client, c["id"])

    plan = client.get(f"/api/projects/{root['id']}/index-plan").json()
    assert {i["title"]: i["run_id"] for i in plan["items"]} == {"문서A": a2["id"], "문서B": b1["id"], "문서C": c1["id"]}
    assert [s["title"] for s in plan["skipped"]] == ["문서D"]
    groups = {g["store"]["collection"]: g["document_count"] for g in plan["groups"]}
    assert groups == {"cs_t_s1": 2, "cs_t_s2": 1}

    r = client.post(f"/api/projects/{root['id']}/index-all", json={"embedding_model_id": emb_id})
    assert r.status_code == 202, r.text
    ixs = {ix["collection"]: _wait(client, f"/api/indexes/{ix['id']}") for ix in r.json()["indexes"]}
    assert ixs["cs_t_s1"]["status"] == "done" and ixs["cs_t_s2"]["status"] == "done"
    assert ixs["cs_t_s1"]["run_ids"] == sorted([a2["id"], b1["id"]])
    assert ixs["cs_t_s2"]["run_ids"] == [c1["id"]]
    s1_chunks = a2["totals"]["chunk_count"] + b1["totals"]["chunk_count"]
    assert ixs["cs_t_s1"]["chunk_count"] == s1_chunks

    # A를 다시 청킹하고 다시 일괄 적재(추가)하면 A의 이전 청크는 교체되어 중복되지 않는다
    a3 = _run(client, a["id"])
    r2 = client.post(f"/api/projects/{root['id']}/index-all", json={"embedding_model_id": emb_id}).json()
    again = {ix["collection"]: _wait(client, f"/api/indexes/{ix['id']}") for ix in r2["indexes"]}
    assert again["cs_t_s1"]["id"] == ixs["cs_t_s1"]["id"]  # 같은 인덱스 기록을 이어 씀
    assert again["cs_t_s1"]["run_ids"] == sorted([a3["id"], b1["id"]])
    assert again["cs_t_s1"]["chunk_count"] == s1_chunks
    hits = client.post(f"/api/indexes/{again['cs_t_s1']['id']}/query", json={"query": "문서A", "top_k": 50}).json()
    assert {h["run_id"] for h in hits["hits"]} == {a3["id"], b1["id"]}

    # 같은 컬렉션을 쓰는 다른 프로젝트 문서는 '비우고 다시 적재' 시 함께 지워진다는 정보를 준다
    other = client.post("/api/projects", json={"name": "S1 공유", "vector_store_id": s1["id"]}).json()
    e = _doc(client, parser_id, "문서E", other["id"])
    e1 = _run(client, e["id"])
    one = client.post("/api/indexes", json={"run_id": e1["id"], "embedding_model_id": emb_id}).json()
    one = _wait(client, f"/api/indexes/{one['id']}")
    assert one["id"] == ixs["cs_t_s1"]["id"] and e1["id"] in one["run_ids"]
    g1 = next(g for g in client.get(f"/api/projects/{root['id']}/index-plan").json()["groups"]
              if g["store"]["id"] == s1["id"])
    assert g1["others_in_collection"] == 1 and g1["other_titles"] == ["문서E"]


def test_unassigned_document_goes_to_default_store(client):
    parser_id, emb_id = _ctx(client)
    original = next(s for s in client.get("/api/vector-stores").json() if s["is_default"])
    tmp = _store(client, "기본 저장소 테스트", "cs_t_default", is_default=True)
    try:
        stores = client.get("/api/vector-stores").json()
        assert [s["id"] for s in stores if s["is_default"]] == [tmp["id"]]  # 기본은 하나만
        f = _doc(client, parser_id, "미분류 문서F")
        target = client.get("/api/index-target", params={"document_id": f["id"]}).json()
        assert target["store"]["id"] == tmp["id"] and target["source"]["kind"] == "default"
        f1 = _run(client, f["id"])
        ix = client.post("/api/indexes", json={"run_id": f1["id"], "embedding_model_id": emb_id}).json()
        ix = _wait(client, f"/api/indexes/{ix['id']}")
        assert ix["status"] == "done" and ix["collection"] == "cs_t_default" and ix["store_id"] == tmp["id"]
    finally:
        body = {k: original[k] for k in ("name", "kind", "uri", "token_env", "db_name", "tls_ca_path",
                                          "tls_server_name", "collection", "enabled")}
        assert client.put(f"/api/vector-stores/{original['id']}", json={**body, "is_default": True}).status_code == 200


def test_project_index_all_without_runs(client):
    _, emb_id = _ctx(client)
    p = client.post("/api/projects", json={"name": "빈 적재"}).json()
    r = client.post(f"/api/projects/{p['id']}/index-all", json={"embedding_model_id": emb_id})
    assert r.status_code == 400
