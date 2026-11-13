from __future__ import annotations

import time

import httpx
import pytest

from app.models import RerankModel
from app.reranking import RerankError, render_rerank_text, rerank


def _model(**kw) -> RerankModel:
    base = dict(name="t", provider="tei", base_url="http://tei", model_id="bge-reranker-v2-m3", api_key_env="",
                is_external=False, max_input_tokens=512, batch_size=32, document_template="{text}",
                extra_params={}, enabled=True)
    return RerankModel(**{**base, **kw})


def _wait(client, url):
    for _ in range(200):
        body = client.get(url).json()
        if body["status"] in ("done", "failed"):
            return body
        time.sleep(0.05)
    raise AssertionError(body)


def test_tei_rerank_batches_and_maps_scores_by_index(monkeypatch):
    calls = []

    def fake_post(url, json, headers, timeout):
        calls.append((url, json))
        # TEI는 점수순으로 정렬해 돌려준다 → index로 원래 순서에 다시 매핑돼야 한다
        scores = [{"index": i, "score": float(len(t))} for i, t in enumerate(json["texts"])]
        return httpx.Response(200, json=sorted(scores, key=lambda x: -x["score"]), request=httpx.Request("POST", url))

    monkeypatch.setattr(httpx, "post", fake_post)
    res = rerank(_model(batch_size=2), "질의", ["a", "abc", "ab"])
    assert [u for u, _ in calls] == ["http://tei/rerank", "http://tei/rerank"]
    assert [len(b["texts"]) for _, b in calls] == [2, 1]
    assert res.scores == [1.0, 3.0, 2.0]


def test_cohere_compatible_rerank(monkeypatch):
    seen = {}

    def fake_post(url, json, headers, timeout):
        seen.update(url=url, body=json, headers=headers)
        results = [{"index": 1, "relevance_score": 0.9}, {"index": 0, "relevance_score": 0.1}]
        return httpx.Response(200, json={"results": results}, request=httpx.Request("POST", url))

    monkeypatch.setattr(httpx, "post", fake_post)
    monkeypatch.setenv("RR_KEY", "secret")
    res = rerank(_model(provider="cohere_compatible", base_url="http://vllm/v1/", api_key_env="RR_KEY"), "q", ["x", "y"])
    assert seen["url"] == "http://vllm/v1/rerank"
    assert seen["body"]["model"] == "bge-reranker-v2-m3" and seen["body"]["top_n"] == 2
    assert seen["headers"]["Authorization"] == "Bearer secret"
    assert res.scores == [0.1, 0.9]


def test_rerank_errors(monkeypatch):
    def missing(url, json, headers, timeout):
        return httpx.Response(200, json=[{"index": 0, "score": 1.0}], request=httpx.Request("POST", url))

    monkeypatch.setattr(httpx, "post", missing)
    with pytest.raises(RerankError, match="점수가 응답에 없습니다"):
        rerank(_model(), "q", ["a", "b"])
    with pytest.raises(RerankError, match="비활성"):
        rerank(_model(enabled=False), "q", ["a"])
    with pytest.raises(RerankError, match="API 키"):
        rerank(_model(api_key_env="NO_SUCH_KEY_FOR_TEST"), "q", ["a"])


def test_render_rerank_text():
    fields = {"text": "본문", "title": "제목", "section_path": "1장", "metadata": {"document_title": "문서"}}
    assert render_rerank_text("[{document_title}] {title}\n{text}", fields) == "[문서] 제목\n본문"


def test_rerank_model_api_and_query_option(client):
    models = client.get("/api/rerank-models", params={"usable_only": True}).json()
    mock = next(m for m in models if m["provider"] == "mock")
    h = client.post(f"/api/rerank-models/{mock['id']}/health").json()
    assert h["ok"] and h["sane"]

    assert client.post("/api/rerank-models", json={"name": "x", "provider": "nope"}).status_code == 400
    assert client.post("/api/rerank-models", json={"name": "x", "provider": "cohere_compatible"}).status_code == 400
    r = client.post("/api/rerank-models", json={"name": "임시 리랭커", "provider": "tei", "base_url": "http://tei"})
    assert r.status_code == 201
    assert client.delete(f"/api/rerank-models/{r.json()['id']}").status_code == 204

    # 메모리 저장소 인덱스에 적재 후 리랭크 질의
    doc = client.get("/api/documents").json()[-1]
    run = client.post("/api/runs", json={"document_id": doc["id"], "method": "rule_structure",
                                         "settings": {"max_tokens": 120}}).json()
    run = _wait(client, f"/api/runs/{run['id']}")
    emb = next(m for m in client.get("/api/embedding-models").json() if m["provider"] == "mock")
    store = next(s for s in client.get("/api/vector-stores").json() if s["kind"] == "memory")
    ix = client.post("/api/indexes", json={"run_id": run["id"], "store_id": store["id"], "embedding_model_id": emb["id"],
                                          "collection": "test_rerank", "mode": "recreate"}).json()
    ix = _wait(client, f"/api/indexes/{ix['id']}")
    assert ix["status"] == "done", ix["error"]

    plain = client.post(f"/api/indexes/{ix['id']}/query", json={"query": "공용 와이파이", "top_k": 3}).json()
    assert plain["rerank"] is None and [h["vector_rank"] for h in plain["hits"]] == [1, 2, 3]

    res = client.post(f"/api/indexes/{ix['id']}/query", json={
        "query": "공용 와이파이", "top_k": 3, "rerank_model_id": mock["id"], "rerank_candidates": 8}).json()
    assert res["rerank"]["model_name"] == mock["name"]
    assert res["rerank"]["candidates"] == min(8, ix["chunk_count"])
    assert len(res["hits"]) == 3
    scores = [h["rerank_score"] for h in res["hits"]]
    assert scores == sorted(scores, reverse=True)
    assert all(1 <= h["vector_rank"] <= 8 for h in res["hits"])
    assert "와이파이" in res["hits"][0]["text"]

    bad = client.post(f"/api/indexes/{ix['id']}/query", json={"query": "q", "rerank_model_id": mock["id"],
                                                               "rerank_candidates": 0})
    assert bad.status_code == 400
