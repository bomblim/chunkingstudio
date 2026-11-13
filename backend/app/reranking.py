"""리랭크(재순위) 모델 호출.

벡터 검색으로 넉넉히 가져온 후보 청크를, 질의와 청크를 함께 보는 cross-encoder로 다시 점수 매긴다.

- tei: Hugging Face Text Embeddings Inference  POST {base_url}/rerank  {"query", "texts"} → [{"index", "score"}]
- cohere_compatible: POST {base_url}/rerank  {"model", "query", "documents", "top_n"} → {"results": [{"index", "relevance_score"}]}
  vLLM(--task score, /v1/rerank), Infinity, Xinference, Jina, Cohere 등 Cohere 형식 엔드포인트.
- nvidia_nim: NVIDIA NeMo Retriever Reranking NIM(Nemotron 리랭크)  POST {base_url}/ranking
  {"model", "query": {"text"}, "passages": [{"text"}], "truncate"} → {"rankings": [{"index", "logit"}]}
  한 요청 최대 512개 후보, 점수는 정규화하지 않은 logit(클수록 관련 높음).
- mock: 오프라인 개발용. 질의와 문서의 글자 2-gram 겹침 비율(의미 판단은 아님).
"""
from __future__ import annotations

import os
import time
from dataclasses import dataclass, field

import httpx

from .config import settings
from .models import RerankModel
from .tokens import estimate_tokens

PROVIDERS = ("tei", "cohere_compatible", "nvidia_nim", "mock")
NIM_MAX_PASSAGES = 512
TEMPLATE_FIELDS = ("text", "title", "section_path", "document_title")


class RerankError(Exception):
    pass


@dataclass
class RerankResult:
    scores: list[float]  # 입력 문서 순서 그대로의 점수 (클수록 관련 높음)
    latency_ms: int
    warnings: list[str] = field(default_factory=list)


def ensure_allowed(model: RerankModel) -> None:
    if not model.enabled:
        raise RerankError(f"비활성화된 리랭크 모델입니다: {model.name}")
    if model.is_external and not settings.allow_external_llm:
        raise RerankError("폐쇄망 모드: 외부 리랭크 API 호출이 차단되어 있습니다 (CS_ALLOW_EXTERNAL_LLM=false)")


def render_rerank_text(template: str, fields: dict) -> str:
    """검색 결과 필드로 리랭크 입력 문서를 만든다. {text} {title} {section_path} {document_title}"""
    meta = fields.get("metadata") or {}
    values = {
        "text": fields.get("text") or "",
        "title": fields.get("title") or "",
        "section_path": fields.get("section_path") or "",
        "document_title": meta.get("document_title") or "",
    }
    out = template or "{text}"
    for k, v in values.items():
        out = out.replace("{" + k + "}", v)
    return out.strip()


def rerank(model: RerankModel, query: str, documents: list[str]) -> RerankResult:
    ensure_allowed(model)
    if model.provider not in PROVIDERS:
        raise RerankError(f"지원하지 않는 공급자: {model.provider}")
    warnings = []
    q_tokens = estimate_tokens(query)
    too_long = sum(1 for d in documents if q_tokens + estimate_tokens(d) > model.max_input_tokens)
    if too_long:
        warnings.append(f"{too_long}개 후보가 리랭크 모델 최대 입력({model.max_input_tokens} 토큰, 추정)을 넘어 잘린 채 평가됩니다")
    started = time.monotonic()
    scores: list[float] = []
    batch = max(1, model.batch_size or 32)
    if model.provider == "nvidia_nim":
        batch = min(batch, NIM_MAX_PASSAGES)
    for start in range(0, len(documents), batch):
        part = documents[start : start + batch]
        if model.provider == "mock":
            scores.extend(_mock_score(query, d) for d in part)
        elif model.provider == "tei":
            scores.extend(_tei(model, query, part))
        elif model.provider == "nvidia_nim":
            scores.extend(_nvidia_nim(model, query, part))
        else:
            scores.extend(_cohere_compatible(model, query, part))
    return RerankResult(scores, int((time.monotonic() - started) * 1000), warnings)


def _headers(model: RerankModel) -> dict[str, str]:
    headers = {"Content-Type": "application/json"}
    if model.api_key_env:
        key = os.environ.get(model.api_key_env)
        if not key:
            raise RerankError(f"환경변수 {model.api_key_env}에 API 키가 없습니다")
        headers["Authorization"] = f"Bearer {key}"
    return headers


def _post(model: RerankModel, body: dict, path: str = "/rerank") -> object:
    if not model.base_url:
        raise RerankError("base_url이 필요합니다 (예: http://localhost:8081 또는 http://localhost:8000/v1)")
    url = model.base_url.rstrip("/") + path
    try:
        resp = httpx.post(url, json=body, headers=_headers(model), timeout=httpx.Timeout(120.0, connect=10.0))
    except httpx.HTTPError as exc:
        raise RerankError(f"리랭크 API 연결 실패: {exc}") from exc
    if resp.status_code >= 400:
        raise RerankError(f"리랭크 API 오류 HTTP {resp.status_code}: {resp.text[:500]}")
    try:
        return resp.json()
    except ValueError as exc:
        raise RerankError(f"리랭크 API 응답이 JSON이 아닙니다: {resp.text[:300]}") from exc


def _collect(items: list, n: int, score_key: str) -> list[float]:
    scores: list[float | None] = [None] * n
    for it in items:
        idx = it.get("index")
        if isinstance(idx, int) and 0 <= idx < n:
            scores[idx] = float(it.get(score_key, 0.0))
    if any(s is None for s in scores):
        raise RerankError(f"요청 {n}건 중 {sum(s is None for s in scores)}건의 점수가 응답에 없습니다")
    return [float(s) for s in scores]  # type: ignore[arg-type]


def _tei(model: RerankModel, query: str, docs: list[str]) -> list[float]:
    body = {"query": query, "texts": docs, "truncate": True, **(model.extra_params or {})}
    data = _post(model, body)
    if not isinstance(data, list):
        raise RerankError(f"TEI 리랭크 응답 형식이 아닙니다: {str(data)[:300]}")
    return _collect(data, len(docs), "score")


def _cohere_compatible(model: RerankModel, query: str, docs: list[str]) -> list[float]:
    body = {"model": model.model_id, "query": query, "documents": docs, "top_n": len(docs),
            **(model.extra_params or {})}
    data = _post(model, body)
    results = data.get("results") if isinstance(data, dict) else None
    if not isinstance(results, list):
        raise RerankError(f"Cohere 형식 리랭크 응답이 아닙니다: {str(data)[:300]}")
    key = "relevance_score" if results and "relevance_score" in results[0] else "score"
    return _collect(results, len(docs), key)


def _nvidia_nim(model: RerankModel, query: str, docs: list[str]) -> list[float]:
    body = {"model": model.model_id, "query": {"text": query}, "passages": [{"text": d} for d in docs],
            "truncate": "END", **(model.extra_params or {})}
    data = _post(model, body, "/ranking")
    rankings = data.get("rankings") if isinstance(data, dict) else None
    if not isinstance(rankings, list):
        raise RerankError(f"NIM 리랭크 응답 형식이 아닙니다(rankings 없음): {str(data)[:300]}")
    return _collect(rankings, len(docs), "logit")


def _mock_score(query: str, doc: str) -> float:
    def grams(s: str) -> set[str]:
        s = "".join(s.lower().split())
        return {s[i : i + 2] for i in range(max(1, len(s) - 1))}

    q, d = grams(query), grams(doc)
    return round(len(q & d) / len(q), 6) if q else 0.0
