from __future__ import annotations

import os
import time

import pytest


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


def _conn(client, name):
    r = client.post("/api/vector-stores", json={"name": name, "kind": "memory"})
    assert r.status_code == 201, r.text
    return r.json()


def _coll(client, store_id, name, **kw):
    r = client.post(f"/api/vector-stores/{store_id}/collections", json={"name": name, **kw})
    assert r.status_code == 201, r.text
    return r.json()


def _ctx(client):
    parser = next(x for x in client.get("/api/parsers").json() if x["adapter"] == "standard")
    emb = next(m for m in client.get("/api/embedding-models").json() if m["provider"] == "mock")
    return parser["id"], emb["id"]


def _default_collection(client):
    return next(c for s in client.get("/api/vector-stores").json() for c in s["collections"] if c["is_default"])


def test_collections_under_one_connection_and_default_rules(client):
    stores = client.get("/api/vector-stores").json()
    defaults = [c for s in stores for c in s["collections"] if c["is_default"]]
    assert len(defaults) == 1  # 시드(또는 이전 저장소 마이그레이션): 기본 컬렉션 하나

    conn = _conn(client, "다중 컬렉션 연결")
    a = _coll(client, conn["id"], "cs_multi_a", description="방산 규정")
    b = _coll(client, conn["id"], "cs_multi_b")
    got = next(s for s in client.get("/api/vector-stores").json() if s["id"] == conn["id"])
    assert [c["name"] for c in got["collections"]] == ["cs_multi_a", "cs_multi_b"]
    assert got["collections"][0]["description"] == "방산 규정"
    # 같은 연결 안에서 이름 중복 불가, 이름 규칙 검사
    assert client.post(f"/api/vector-stores/{conn['id']}/collections", json={"name": "cs_multi_a"}).status_code == 409
    assert client.post(f"/api/vector-stores/{conn['id']}/collections", json={"name": "1bad"}).status_code == 400

    # 기본 컬렉션은 하나만: b를 기본으로 지정하면 기존 기본은 해제
    original = defaults[0]
    assert client.put(f"/api/vector-collections/{b['id']}", json={"name": "cs_multi_b", "is_default": True}).status_code == 200
    assert _default_collection(client)["id"] == b["id"]
    assert client.put(f"/api/vector-collections/{b['id']}", json={"name": "cs_multi_b", "is_default": False}).status_code == 400
    assert client.delete(f"/api/vector-collections/{b['id']}").status_code == 400  # 기본은 삭제 불가
    conn_body = {"name": conn["name"], "kind": "memory", "enabled": False}
    assert client.put(f"/api/vector-stores/{conn['id']}", json=conn_body).status_code == 400  # 기본 컬렉션의 연결은 비활성 불가
    # 원래 기본으로 되돌림
    assert client.put(f"/api/vector-collections/{original['id']}",
                      json={"name": original["name"], "description": original["description"], "is_default": True}).status_code == 200

    # 프로젝트가 쓰는 컬렉션은 삭제 불가, 안 쓰면 삭제
    p = client.post("/api/projects", json={"name": "컬렉션 사용", "vector_collection_id": a["id"]}).json()
    assert client.delete(f"/api/vector-collections/{a['id']}").status_code == 400
    client.put(f"/api/projects/{p['id']}", json={"name": p["name"], "vector_collection_id": None})
    assert client.delete(f"/api/vector-collections/{a['id']}").status_code == 204


def test_project_index_all_uses_project_collection_and_latest_run(client):
    parser_id, emb_id = _ctx(client)
    conn = _conn(client, "적재 테스트 연결")
    s1 = _coll(client, conn["id"], "cs_t_s1")
    s2 = _coll(client, conn["id"], "cs_t_s2")  # 같은 연결의 다른 컬렉션
    root = client.post("/api/projects", json={"name": "일괄적재", "vector_collection_id": s1["id"]}).json()
    child = client.post("/api/projects", json={"name": "하위-상속", "parent_id": root["id"]}).json()
    child2 = client.post("/api/projects", json={"name": "하위-S2", "parent_id": root["id"],
                                                "vector_collection_id": s2["id"]}).json()
    eff = next(p for p in client.get("/api/projects").json()["projects"] if p["id"] == child["id"])["effective"]
    assert eff["vector_store"]["collection_id"] == s1["id"] and eff["vector_store"]["id"] == conn["id"]
    assert eff["vector_store_source"]["project_name"] == "일괄적재"

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
    assert {g["store"]["collection"]: g["document_count"] for g in plan["groups"]} == {"cs_t_s1": 2, "cs_t_s2": 1}

    r = client.post(f"/api/projects/{root['id']}/index-all", json={"embedding_model_id": emb_id})
    assert r.status_code == 202, r.text
    ixs = {ix["collection"]: _wait(client, f"/api/indexes/{ix['id']}") for ix in r.json()["indexes"]}
    assert ixs["cs_t_s1"]["status"] == "done" and ixs["cs_t_s2"]["status"] == "done"
    assert ixs["cs_t_s1"]["store_id"] == ixs["cs_t_s2"]["store_id"] == conn["id"]
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
    other = client.post("/api/projects", json={"name": "S1 공유", "vector_collection_id": s1["id"]}).json()
    e = _doc(client, parser_id, "문서E", other["id"])
    e1 = _run(client, e["id"])
    one = client.post("/api/indexes", json={"run_id": e1["id"], "embedding_model_id": emb_id}).json()
    one = _wait(client, f"/api/indexes/{one['id']}")
    assert one["id"] == ixs["cs_t_s1"]["id"] and e1["id"] in one["run_ids"]
    g1 = next(g for g in client.get(f"/api/projects/{root['id']}/index-plan").json()["groups"]
              if g["store"]["collection_id"] == s1["id"])
    assert g1["others_in_collection"] == 1 and g1["other_titles"] == ["문서E"]
    listed = next(s for s in client.get("/api/vector-stores").json() if s["id"] == conn["id"])
    c_s1 = next(c for c in listed["collections"] if c["id"] == s1["id"])
    assert sorted(c_s1["projects"]) == ["S1 공유", "일괄적재"] and c_s1["chunk_count"] == one["chunk_count"]


def test_unassigned_document_goes_to_default_collection(client):
    parser_id, emb_id = _ctx(client)
    original = _default_collection(client)
    conn = _conn(client, "기본 컬렉션 테스트")
    tmp = _coll(client, conn["id"], "cs_t_default", is_default=True)
    try:
        f = _doc(client, parser_id, "미분류 문서F")
        target = client.get("/api/index-target", params={"document_id": f["id"]}).json()
        assert target["store"]["collection_id"] == tmp["id"] and target["source"]["kind"] == "default"
        f1 = _run(client, f["id"])
        ix = client.post("/api/indexes", json={"run_id": f1["id"], "embedding_model_id": emb_id}).json()
        ix = _wait(client, f"/api/indexes/{ix['id']}")
        assert ix["status"] == "done" and ix["collection"] == "cs_t_default" and ix["store_id"] == conn["id"]
    finally:
        r = client.put(f"/api/vector-collections/{original['id']}",
                       json={"name": original["name"], "description": original["description"], "is_default": True})
        assert r.status_code == 200


def test_project_index_all_without_runs(client):
    _, emb_id = _ctx(client)
    p = client.post("/api/projects", json={"name": "빈 적재"}).json()
    r = client.post(f"/api/projects/{p['id']}/index-all", json={"embedding_model_id": emb_id})
    assert r.status_code == 400


def test_empty_collection(client):
    parser_id, emb_id = _ctx(client)
    conn = _conn(client, "비우기 테스트")
    coll = _coll(client, conn["id"], "cs_t_empty")
    proj = client.post("/api/projects", json={"name": "비우기", "method": "rule_structure",
                                              "vector_collection_id": coll["id"]}).json()
    d = _doc(client, parser_id, "비울 문서", proj["id"])
    run = _run(client, d["id"])
    ix = client.post("/api/indexes", json={"run_id": run["id"], "embedding_model_id": emb_id}).json()
    ix = _wait(client, f"/api/indexes/{ix['id']}")
    assert ix["status"] == "done" and ix["chunk_count"] > 0

    r = client.post(f"/api/vector-collections/{coll['id']}/empty")
    assert r.status_code == 200, r.text
    assert r.json() == {"collection": "cs_t_empty", "dropped": True, "removed_indexes": 1,
                        "removed_chunks": ix["chunk_count"]}
    assert client.get(f"/api/indexes/{ix['id']}").status_code == 404
    listed = next(s for s in client.get("/api/vector-stores").json() if s["id"] == conn["id"])
    c = next(x for x in listed["collections"] if x["id"] == coll["id"])
    assert c["chunk_count"] is None and c["projects"] == ["비우기"]  # 등록·프로젝트 지정은 유지

    # 비운 뒤 다시 적재하면 컬렉션이 새로 만들어진다
    ix2 = client.post("/api/indexes", json={"run_id": run["id"], "embedding_model_id": emb_id}).json()
    ix2 = _wait(client, f"/api/indexes/{ix2['id']}")
    assert ix2["status"] == "done" and ix2["chunk_count"] == ix["chunk_count"]
    # 빈 컬렉션을 다시 비워도 오류 없이 처리
    assert client.post(f"/api/vector-collections/{coll['id']}/empty").json()["removed_indexes"] == 1
    assert client.post(f"/api/vector-collections/{coll['id']}/empty").json()["dropped"] is False


def test_collection_contents(client):
    parser_id, emb_id = _ctx(client)
    conn = _conn(client, "내용 보기 테스트")
    coll = _coll(client, conn["id"], "cs_t_browse")
    empty = client.get(f"/api/vector-collections/{coll['id']}/contents").json()
    assert empty["exists"] is False and empty["total"] == 0 and empty["documents"] == []

    proj = client.post("/api/projects", json={"name": "내용 보기", "method": "rule_structure",
                                              "vector_collection_id": coll["id"]}).json()
    runs = []
    for title in ("내용A", "내용B"):
        d = _doc(client, parser_id, title, proj["id"])
        run = _run(client, d["id"])
        ix = _wait(client, f"/api/indexes/{client.post('/api/indexes', json={'run_id': run['id'], 'embedding_model_id': emb_id}).json()['id']}")
        assert ix["status"] == "done"
        runs.append((d, run))
    total = sum(r["totals"]["chunk_count"] for _, r in runs)

    page = client.get(f"/api/vector-collections/{coll['id']}/contents", params={"limit": 2}).json()
    assert page["exists"] and page["total"] == total and len(page["items"]) == 2
    assert {d["title"] for d in page["documents"]} == {"내용A", "내용B"}
    assert page["embedding_model"] and page["index"]["metric"] == "COSINE"
    item = page["items"][0]
    assert item["text"] and item["chunk_id"] and item["metadata"]["project_path"] == ["내용 보기"]
    nxt = client.get(f"/api/vector-collections/{coll['id']}/contents", params={"limit": 2, "offset": 2}).json()
    assert {i["id"] for i in nxt["items"]}.isdisjoint({i["id"] for i in page["items"]})

    a_doc, a_run = runs[0]
    only_a = client.get(f"/api/vector-collections/{coll['id']}/contents", params={"document_id": a_doc["id"], "limit": 100}).json()
    assert only_a["total"] == a_run["totals"]["chunk_count"] and all(i["document_id"] == a_doc["id"] for i in only_a["items"])



@pytest.mark.skipif(not os.environ.get("CS_TEST_MILVUS_URI"), reason="CS_TEST_MILVUS_URI 미설정 (실제 Milvus 필요)")
def test_collection_contents_milvus(client):
    parser_id, emb_id = _ctx(client)
    conn = client.post("/api/vector-stores", json={"name": "milvus 내용 보기", "kind": "milvus",
                                                   "uri": os.environ["CS_TEST_MILVUS_URI"]}).json()
    coll = _coll(client, conn["id"], "cs_pytest_browse")
    client.post(f"/api/vector-collections/{coll['id']}/empty")  # 이전 실행 잔여물 정리
    proj = client.post("/api/projects", json={"name": "milvus 내용", "method": "rule_structure",
                                              "vector_collection_id": coll["id"]}).json()
    d = _doc(client, parser_id, "밀버스 문서", proj["id"])
    run = _run(client, d["id"])
    ix = _wait(client, f"/api/indexes/{client.post('/api/indexes', json={'run_id': run['id'], 'embedding_model_id': emb_id}).json()['id']}")
    assert ix["status"] == "done", ix["error"]
    page = client.get(f"/api/vector-collections/{coll['id']}/contents", params={"limit": 3}).json()
    assert page["exists"] and page["total"] == run["totals"]["chunk_count"] and "error" not in page
    assert len(page["items"]) == min(3, page["total"]) and page["items"][0]["text"]
    only = client.get(f"/api/vector-collections/{coll['id']}/contents", params={"document_id": d["id"]}).json()
    assert only["total"] == run["totals"]["chunk_count"]
    client.post(f"/api/vector-collections/{coll['id']}/empty")
