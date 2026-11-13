from __future__ import annotations

import os
import time

import httpx
import pytest

from app.embeddings import embed, render_embed_text
from app.models import EmbeddingModel


def _wait(client, url):
    for _ in range(100):
        body = client.get(url).json()
        if body["status"] in ("done", "failed"):
            return body
        time.sleep(0.05)
    raise AssertionError(body)


def _done_run(client) -> dict:
    doc = client.get("/api/documents").json()[-1]  # 시드 샘플 문서
    run = client.post("/api/runs", json={"document_id": doc["id"], "method": "rule_structure",
                                         "settings": {"max_tokens": 200}}).json()
    return _wait(client, f"/api/runs/{run['id']}")


def _by_name(items, name):
    return next(i for i in items if i["name"] == name)


def test_openai_compatible_embedding_batches_and_prefix(monkeypatch):
    calls = []

    def fake_post(url, json, headers, timeout):
        calls.append(json)
        data = [{"index": i, "embedding": [float(i), 1.0, 0.0]} for i in range(len(json["input"]))][::-1]
        return httpx.Response(200, json={"data": data, "usage": {"prompt_tokens": 7}}, request=httpx.Request("POST", url))

    monkeypatch.setattr(httpx, "post", fake_post)
    m = EmbeddingModel(name="t", provider="openai_compatible", base_url="http://tei/v1", model_id="bge-m3",
                       batch_size=2, max_input_tokens=8192, query_prefix="query: ", document_prefix="",
                       enabled=True, is_external=False, extra_params={}, api_key_env="")
    res = embed(m, ["a", "b", "c"], "document")
    assert [len(c["input"]) for c in calls] == [2, 1]
    assert res.vectors[1][0] == 1.0  # index 순서로 정렬
    assert res.prompt_tokens == 14
    embed(m, ["질문"], "query")
    assert calls[-1]["input"] == ["query: 질문"]


def test_render_embed_text():
    chunk = {"text": "본문", "section_path": "1장 > 1.1", "title": "제목", "keywords": ["a", "b"]}
    assert render_embed_text("[{document_title}] {section_path}\n\n{text}", chunk, "문서") == "[문서] 1장 > 1.1\n\n본문"


def test_index_and_query_memory_store(client):
    run = _done_run(client)
    emb = _by_name(client.get("/api/embedding-models").json(), "Mock 임베딩 (오프라인)")
    store = _by_name(client.get("/api/vector-stores").json(), "메모리 (개발용)")
    assert client.post(f"/api/embedding-models/{emb['id']}/health").json()["dimension"] == 256

    ix = client.post("/api/indexes", json={
        "run_id": run["id"], "store_id": store["id"], "embedding_model_id": emb["id"], "collection": "test_mem",
        "embed_template": "{section_path}\n\n{text}", "mode": "recreate",
    }).json()
    ix = _wait(client, f"/api/indexes/{ix['id']}")
    assert ix["status"] == "done", ix["error"]
    assert ix["chunk_count"] == len(run["chunks"]) and ix["dimension"] == 256

    res = client.post(f"/api/indexes/{ix['id']}/query", json={"query": "공용 와이파이 사용 금지", "top_k": 3}).json()
    assert len(res["hits"]) == 3
    top = res["hits"][0]
    assert "와이파이" in top["text"]  # 청크 원문이 함께 저장·반환됨
    assert top["metadata"]["element_ids"] and top["run_id"] == run["id"]

    # 같은 실행을 append로 다시 넣어도 중복되지 않음 (저장소·컬렉션 직접 지정 = API 자동화 경로)
    again = client.post("/api/indexes", json={
        "run_id": run["id"], "store_id": store["id"], "embedding_model_id": emb["id"], "collection": "test_mem",
        "mode": "append",
    }).json()
    assert again["id"] == ix["id"]
    again = _wait(client, f"/api/indexes/{again['id']}")
    assert again["chunk_count"] == len(run["chunks"])
    # '실행 추가'는 문서의 프로젝트 저장소(미분류 → 기본 저장소)와 다른 컬렉션이면 거절
    assert client.post(f"/api/indexes/{ix['id']}/append", json={"run_id": run["id"]}).status_code == 400

    dup = client.post("/api/indexes", json={
        "run_id": run["id"], "store_id": store["id"], "embedding_model_id": emb["id"], "collection": "test_mem",
        "mode": "create",
    }).json()
    dup = _wait(client, f"/api/indexes/{dup['id']}")
    assert dup["status"] == "failed" and "이미 있습니다" in dup["error"]


def test_rejects_invalid_collection_name(client):
    run = _done_run(client)
    emb = _by_name(client.get("/api/embedding-models").json(), "Mock 임베딩 (오프라인)")
    store = _by_name(client.get("/api/vector-stores").json(), "메모리 (개발용)")
    r = client.post("/api/indexes", json={"run_id": run["id"], "store_id": store["id"],
                                          "embedding_model_id": emb["id"], "collection": "1-bad name"})
    assert r.status_code == 400


@pytest.mark.skipif(not os.environ.get("CS_TEST_MILVUS_URI"), reason="CS_TEST_MILVUS_URI 미설정 (실제 Milvus 필요)")
def test_milvus_round_trip(client):
    run = _done_run(client)
    emb = _by_name(client.get("/api/embedding-models").json(), "Mock 임베딩 (오프라인)")
    store = client.post("/api/vector-stores", json={"name": "milvus-test", "kind": "milvus", "collection": "cs_pytest_milvus",
                                                    "uri": os.environ["CS_TEST_MILVUS_URI"]}).json()
    health = client.post(f"/api/vector-stores/{store['id']}/health").json()
    assert health["ok"], health
    ix = client.post("/api/indexes", json={
        "run_id": run["id"], "store_id": store["id"], "embedding_model_id": emb["id"],
        "collection": "cs_pytest_chunks", "mode": "recreate",
    }).json()
    ix = _wait(client, f"/api/indexes/{ix['id']}")
    assert ix["status"] == "done", ix["error"]
    assert ix["chunk_count"] == len(run["chunks"])
    res = client.post(f"/api/indexes/{ix['id']}/query", json={"query": "통신비 지원 한도", "top_k": 2}).json()
    assert "통신비" in res["hits"][0]["text"]
    filtered = client.post(f"/api/indexes/{ix['id']}/query",
                           json={"query": "통신비", "top_k": 5, "filter": f"run_id == {run['id']}"}).json()
    assert all(h["run_id"] == run["id"] for h in filtered["hits"])
    client.delete(f"/api/indexes/{ix['id']}", params={"drop_collection": True})


def test_milvus_tls_kwargs(tmp_path):
    from app.vectorstores import VectorStoreError, tls_kwargs

    assert tls_kwargs("http://milvus:19530") == {}
    assert tls_kwargs("https://milvus.example.com:19530") == {"secure": True}
    ca = tmp_path / "ca.pem"
    ca.write_text("dummy")
    assert tls_kwargs("https://10.0.0.5:19530", str(ca), "milvus.example.com") == {
        "secure": True, "server_pem_path": str(ca), "server_name": "milvus.example.com"}
    with pytest.raises(VectorStoreError, match="https"):
        tls_kwargs("http://milvus:19530", str(ca))
    with pytest.raises(VectorStoreError, match="CA 인증서 파일이 없습니다"):
        tls_kwargs("https://milvus:19530", str(tmp_path / "missing.pem"))
