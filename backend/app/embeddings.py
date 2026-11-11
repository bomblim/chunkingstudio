"""임베딩 모델 호출.

- openai_compatible: POST {base_url}/embeddings  {"model": ..., "input": [...]}
  Hugging Face TEI, vLLM(--task embed), Ollama, OpenAI 등 OpenAI 호환 엔드포인트를 그대로 쓴다.
- mock: 오프라인 개발용. 문자 n-gram 해싱 벡터라 어휘가 겹치는 문장끼리 가깝게 나온다(의미 검색은 아님).
"""
from __future__ import annotations

import hashlib
import math
import os
import time
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Literal

import httpx

from .config import settings
from .models import EmbeddingModel
from .tokens import estimate_tokens

Kind = Literal["document", "query"]
MOCK_DIM = 256


class EmbeddingError(Exception):
    pass


@dataclass
class EmbeddingResult:
    vectors: list[list[float]]
    latency_ms: int
    prompt_tokens: int | None = None
    warnings: list[str] = field(default_factory=list)


def ensure_allowed(model: EmbeddingModel) -> None:
    if not model.enabled:
        raise EmbeddingError(f"비활성화된 임베딩 모델입니다: {model.name}")
    if model.is_external and not settings.allow_external_llm:
        raise EmbeddingError("폐쇄망 모드: 외부 임베딩 API 호출이 차단되어 있습니다 (CS_ALLOW_EXTERNAL_LLM=false)")


def embed(
    model: EmbeddingModel,
    texts: list[str],
    kind: Kind = "document",
    on_batch: Callable[[int, int], None] | None = None,
) -> EmbeddingResult:
    ensure_allowed(model)
    prefix = model.query_prefix if kind == "query" else model.document_prefix
    inputs = [f"{prefix}{t}" for t in texts]
    warnings = []
    too_long = [i for i, t in enumerate(inputs) if estimate_tokens(t) > model.max_input_tokens]
    if too_long:
        warnings.append(
            f"{len(too_long)}개 입력이 모델 최대 입력({model.max_input_tokens} 토큰, 추정)을 넘어 잘리거나 실패할 수 있습니다"
        )
    started = time.monotonic()
    vectors: list[list[float]] = []
    tokens = 0
    has_usage = False
    batch = max(1, model.batch_size or 32)
    for start in range(0, len(inputs), batch):
        part = inputs[start : start + batch]
        if model.provider == "mock":
            vecs, used = [_mock_vector(t) for t in part], None
        elif model.provider == "openai_compatible":
            vecs, used = _openai_compatible(model, part)
        else:
            raise EmbeddingError(f"지원하지 않는 공급자: {model.provider}")
        if used is not None:
            tokens += used
            has_usage = True
        vectors.extend(vecs)
        if on_batch:
            on_batch(min(start + batch, len(inputs)), len(inputs))
    dims = {len(v) for v in vectors}
    if len(dims) > 1:
        raise EmbeddingError(f"임베딩 차원이 일정하지 않습니다: {sorted(dims)}")
    return EmbeddingResult(vectors, int((time.monotonic() - started) * 1000), tokens if has_usage else None, warnings)


def _openai_compatible(model: EmbeddingModel, inputs: list[str]) -> tuple[list[list[float]], int | None]:
    if not model.base_url:
        raise EmbeddingError("base_url이 필요합니다 (예: http://localhost:8080/v1)")
    headers = {"Content-Type": "application/json"}
    if model.api_key_env:
        key = os.environ.get(model.api_key_env)
        if not key:
            raise EmbeddingError(f"환경변수 {model.api_key_env}에 API 키가 없습니다")
        headers["Authorization"] = f"Bearer {key}"
    body = {"model": model.model_id, "input": inputs, **(model.extra_params or {})}
    url = model.base_url.rstrip("/") + "/embeddings"
    try:
        resp = httpx.post(url, json=body, headers=headers, timeout=httpx.Timeout(300.0, connect=10.0))
    except httpx.HTTPError as exc:
        raise EmbeddingError(f"임베딩 API 연결 실패: {exc}") from exc
    if resp.status_code >= 400:
        raise EmbeddingError(f"임베딩 API 오류 HTTP {resp.status_code}: {resp.text[:500]}")
    data = resp.json()
    items = sorted(data.get("data") or [], key=lambda d: d.get("index", 0))
    if len(items) != len(inputs):
        raise EmbeddingError(f"요청 {len(inputs)}건에 응답 {len(items)}건이 왔습니다")
    usage = (data.get("usage") or {}).get("prompt_tokens")
    return [list(map(float, d["embedding"])) for d in items], usage


def _mock_vector(text: str, dim: int = MOCK_DIM) -> list[float]:
    vec = [0.0] * dim
    s = " ".join(text.lower().split())
    grams = [s[i : i + 2] for i in range(max(1, len(s) - 1))] + s.split()
    for g in grams:
        h = int.from_bytes(hashlib.md5(g.encode("utf-8")).digest()[:8], "little")
        vec[h % dim] += 1.0 if (h >> 63) & 1 else -1.0
    norm = math.sqrt(sum(x * x for x in vec)) or 1.0
    return [x / norm for x in vec]


TEMPLATE_FIELDS = ("text", "title", "summary", "keywords", "section_path", "document_title")


def render_embed_text(template: str, chunk: dict, document_title: str) -> str:
    values = {
        "text": chunk.get("text") or "",
        "title": chunk.get("title") or "",
        "summary": chunk.get("summary") or "",
        "keywords": ", ".join(chunk.get("keywords") or []),
        "section_path": chunk.get("section_path") or "",
        "document_title": document_title,
    }
    out = template or "{text}"
    for k, v in values.items():
        out = out.replace("{" + k + "}", v)
    return out.strip()
