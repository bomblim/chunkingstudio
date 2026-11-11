"""모델 레지스트리 API (MS-04~10)."""
from __future__ import annotations

import time
from typing import Any

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..config import settings
from ..db import get_db
from ..llm import STRATEGIES, ChatRequest, LLMError, generate, strategy_chain
from ..models import LLMModel
from . import get_or_404, row_dict

router = APIRouter(prefix="/api/models", tags=["models"])

PROVIDERS = [
    {"name": "openai_compatible", "label": "OpenAI 호환 (상용 API · vLLM · TGI · SGLang · Ollama)",
     "engines": ["openai", "azure", "vllm", "tgi", "sglang", "ollama", "other"]},
    {"name": "anthropic", "label": "Anthropic (Claude)", "engines": ["anthropic"]},
    {"name": "mock", "label": "Mock (오프라인 테스트)", "engines": ["mock"]},
]


class ModelIn(BaseModel):
    name: str
    provider: str
    engine: str = ""
    base_url: str = ""
    model_id: str
    api_key_env: str = ""
    is_external: bool = False
    context_length: int = 8192
    max_output_tokens: int = 4096
    structured_output: str = "auto"
    input_price_per_1m: float = 0.0
    output_price_per_1m: float = 0.0
    extra_params: dict[str, Any] = Field(default_factory=dict)
    enabled: bool = True


def _out(m: LLMModel) -> dict[str, Any]:
    d = row_dict(m)
    d["strategy_chain"] = strategy_chain(m)
    d["blocked"] = m.is_external and not settings.allow_external_llm
    return d


def _validate(body: ModelIn) -> None:
    if body.provider not in {p["name"] for p in PROVIDERS}:
        raise HTTPException(400, f"알 수 없는 provider: {body.provider}")
    if body.structured_output not in {"auto", *STRATEGIES}:
        raise HTTPException(400, f"알 수 없는 structured_output: {body.structured_output}")


@router.get("/meta")
def meta() -> dict[str, Any]:
    return {"providers": PROVIDERS, "strategies": ["auto", *STRATEGIES],
            "allow_external_llm": settings.allow_external_llm}


@router.get("")
def list_models(usable_only: bool = False, db: Session = Depends(get_db)) -> list[dict[str, Any]]:
    rows = [_out(m) for m in db.scalars(select(LLMModel).order_by(LLMModel.name))]
    if usable_only:  # 폐쇄망이면 외부 모델 숨김(MS-10)
        rows = [r for r in rows if r["enabled"] and not r["blocked"]]
    return rows


@router.post("", status_code=201)
def create_model(body: ModelIn, db: Session = Depends(get_db)) -> dict[str, Any]:
    _validate(body)
    if db.scalar(select(LLMModel).where(LLMModel.name == body.name)):
        raise HTTPException(409, "같은 이름의 모델이 있습니다")
    m = LLMModel(**body.model_dump())
    db.add(m)
    db.commit()
    return _out(m)


@router.put("/{model_id}")
def update_model(model_id: int, body: ModelIn, db: Session = Depends(get_db)) -> dict[str, Any]:
    _validate(body)
    m = get_or_404(db, LLMModel, model_id)
    for k, v in body.model_dump().items():
        setattr(m, k, v)
    db.commit()
    return _out(m)


@router.delete("/{model_id}", status_code=204)
def delete_model(model_id: int, db: Session = Depends(get_db)) -> None:
    m = get_or_404(db, LLMModel, model_id)
    m.enabled = False  # 실행 이력 보존을 위해 비활성화만
    db.commit()


@router.post("/{model_id}/health")
def model_health(model_id: int, db: Session = Depends(get_db)) -> dict[str, Any]:
    """헬스체크(MS-09): 짧은 구조화 출력 요청으로 응답·지연시간·사용 전략 확인."""
    m = get_or_404(db, LLMModel, model_id)
    schema = {"type": "object", "properties": {"ok": {"type": "boolean"}}, "required": ["ok"],
              "additionalProperties": False}
    started = time.monotonic()
    try:
        res = generate(m, ChatRequest("You are a health check.", 'Return {"ok": true}.', schema,
                                      {"max_tokens": 64}))
        health = {"ok": True, "latency_ms": res.latency_ms, "strategy": res.strategy,
                  "response": res.text[:200], "warnings": res.warnings}
    except LLMError as exc:
        health = {"ok": False, "message": str(exc), "latency_ms": int((time.monotonic() - started) * 1000)}
    health["checked_at"] = time.strftime("%Y-%m-%dT%H:%M:%S")
    m.last_health = health
    db.commit()
    return health
