"""오프라인 개발·테스트용 결정적 모델.

실제 LLM 없이 Playground 전체 흐름을 확인하기 위한 것으로, heading 경계와 토큰 상한으로 청크를 나눈다.
extra_params
- fail_first_attempt: true → 첫 시도에 깨진 JSON을 반환 (재시도/repair 경로 확인용)
"""
from __future__ import annotations

import json

from ..models import LLMModel
from ..tokens import estimate_tokens
from . import ChatRequest, ChatResult


def mock_chat(model: LLMModel, req: ChatRequest) -> ChatResult:
    meta = req.meta or {}
    if (model.extra_params or {}).get("fail_first_attempt") and meta.get("attempt", 0) == 0 and not meta.get("repair"):
        text = '{"chunks": [{"start_id": "E1", '
    else:
        text = json.dumps(_chunk(meta), ensure_ascii=False)
    return ChatResult(
        text=text, strategy="json_schema", input_tokens=estimate_tokens(req.system + req.user),
        output_tokens=estimate_tokens(text), latency_ms=0,
        request_preview={"model": model.model_id, "provider": "mock"},
    )


def _chunk(meta: dict) -> dict:
    elements: list[dict] = meta.get("elements") or []
    max_tokens = int(meta.get("max_tokens") or 512)
    chunks: list[dict] = []
    cur: list[dict] = []
    cur_tokens = 0

    def close(reason: str) -> None:
        nonlocal cur, cur_tokens
        if not cur:
            return
        first = cur[0]
        title = first["text"][:40] if first["type"] in {"title", "heading"} else ""
        chunks.append({
            "start_id": first["id"],
            "end_id": cur[-1]["id"],
            "title": title,
            "summary": "",
            "keywords": [],
            "reason": reason,
        })
        cur, cur_tokens = [], 0

    for el in elements:
        if el["type"] in {"title", "heading"} and cur and not all(c["type"] in {"title", "heading"} for c in cur):
            close("다음 섹션 heading이 시작되어 분할")
        elif cur and cur_tokens + el["tokens"] > max_tokens:
            close(f"토큰 상한({max_tokens}) 초과로 분할")
        cur.append(el)
        cur_tokens += el["tokens"]
    close("윈도우 끝")
    return {"chunks": chunks}
