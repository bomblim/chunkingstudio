from __future__ import annotations

import time


def _wait_runs(client, ids):
    for _ in range(100):
        runs = [client.get(f"/api/runs/{i}").json() for i in ids]
        if all(r["status"] in ("done", "failed") for r in runs):
            return runs
        time.sleep(0.05)
    raise AssertionError(runs)


def _proj(client, name, parent=None, **profile):
    r = client.post("/api/projects", json={"name": name, "parent_id": parent, **profile})
    assert r.status_code == 201, r.text
    return r.json()


def _by_name(items, name):
    return next(i for i in items if i["name"] == name)


def test_tree_inheritance_move_and_run_all(client):
    mock = next(m for m in client.get("/api/models").json() if m["provider"] == "mock")
    prompt = client.get("/api/prompts").json()[0]

    root = _proj(client, "방산규정집", method="llm", prompt_id=prompt["id"], model_id=mock["id"],
                 settings={"max_tokens": 300}, doc_type="규정")
    child = _proj(client, "육군", root["id"])
    grand = _proj(client, "육군 2025", child["id"], settings={"max_tokens": 150})

    # 같은 위치 같은 이름은 거부
    assert client.post("/api/projects", json={"name": "육군", "parent_id": root["id"]}).status_code == 409
    # 하위로 이동(순환) 거부
    r = client.put(f"/api/projects/{root['id']}", json={**{k: root[k] for k in ("name", "description", "sort_order", "method", "prompt_id", "prompt_version_id", "model_id", "params", "settings", "doc_type")}, "parent_id": grand["id"]})
    assert r.status_code == 400

    tree = client.get("/api/projects").json()
    g = _by_name(tree["projects"], "육군 2025")
    assert g["path"] == ["방산규정집", "육군", "육군 2025"]
    eff = g["effective"]
    assert eff["settings"] == {"max_tokens": 150}  # 자기 설정 우선
    assert eff["prompt_id"] == prompt["id"] and eff["model_id"] == mock["id"]  # 루트에서 상속
    assert eff["source_names"]["model_id"] == "방산규정집"
    assert eff["resolved_prompt_version_id"] is not None  # 고정 버전 없으면 운영/최신 버전

    # 문서 배정
    doc = client.get("/api/documents").json()[-1]
    moved = client.post("/api/documents/move", json={"document_ids": [doc["id"]], "project_id": grand["id"]}).json()
    assert moved["moved"] == 1
    in_root = client.get("/api/documents", params={"project_id": root["id"]}).json()
    assert [d["id"] for d in in_root] == [doc["id"]]  # 하위 포함 조회
    assert in_root[0]["project_path"] == ["방산규정집", "육군", "육군 2025"]
    assert client.get("/api/documents", params={"project_id": root["id"], "include_descendants": False}).json() == []
    assert doc["id"] not in [d["id"] for d in client.get("/api/documents", params={"unassigned": True}).json()]

    # 일괄 청킹: 루트 기준이면 루트 프로파일(최대 300), 하위 문서도 포함
    res = client.post(f"/api/projects/{root['id']}/run-all", json={}).json()
    assert res["document_count"] == 1 and res["method"] == "llm"
    run = _wait_runs(client, res["run_ids"])[0]
    assert run["status"] == "done", run["error"]
    assert run["settings"]["max_tokens"] == 300 and run["settings"]["doc_type"] == "규정"
    assert run["snapshot"]["project"]["path"] == ["방산규정집"]
    listed = client.get("/api/documents", params={"project_id": root["id"]}).json()[0]
    assert listed["last_run"]["id"] == run["id"]

    # 하위에서 실행하면 하위 설정(최대 150)
    res2 = client.post(f"/api/projects/{grand['id']}/run-all", json={}).json()
    assert _wait_runs(client, res2["run_ids"])[0]["settings"]["max_tokens"] == 150

    # 삭제: 하위/문서가 있으면 거부, move_to_parent면 상위로 옮기고 삭제
    assert client.delete(f"/api/projects/{child['id']}").status_code == 409
    assert client.delete(f"/api/projects/{grand['id']}", params={"move_to_parent": True}).status_code == 204
    assert client.get(f"/api/documents/{doc['id']}").json()["project_id"] == child["id"]

    # 미분류로 되돌리기
    client.patch(f"/api/documents/{doc['id']}", json={"clear_project": True})
    assert client.get(f"/api/documents/{doc['id']}").json()["project_id"] is None


def test_run_all_requires_profile(client):
    p = _proj(client, "ERP매뉴얼")
    doc = client.get("/api/documents").json()[-1]
    client.patch(f"/api/documents/{doc['id']}", json={"project_id": p["id"]})
    r = client.post(f"/api/projects/{p['id']}/run-all", json={})
    assert r.status_code == 400 and "청킹 방식" in r.json()["detail"]
    client.put(f"/api/projects/{p['id']}", json={"name": "ERP매뉴얼", "method": "rule_structure"})
    res = client.post(f"/api/projects/{p['id']}/run-all", json={}).json()
    assert _wait_runs(client, res["run_ids"])[0]["method"] == "rule_structure"
    client.patch(f"/api/documents/{doc['id']}", json={"clear_project": True})


def test_ingest_into_project(client):
    p = _proj(client, "ingest 대상")
    parser = next(x for x in client.get("/api/parsers").json() if x["adapter"] == "standard")
    payload = {"elements": [{"element_id": "E1", "type": "paragraph", "text": "본문"}]}
    d = client.post("/api/ingest", json={"parser_id": parser["id"], "title": "t", "payload": payload,
                                         "project_id": p["id"]}).json()
    assert d["project_id"] == p["id"]
    assert client.post("/api/ingest", json={"parser_id": parser["id"], "title": "t", "payload": payload,
                                            "project_id": "0193a8c2-0000-7000-8000-00000000ffff"}).status_code == 404
