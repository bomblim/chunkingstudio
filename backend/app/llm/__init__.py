"""LLM Gateway (MS-01~10).

공급자(provider)
- openai_compatible: OpenAI·Azure OpenAI 호환 엔드포인트 및 오픈소스 서빙(vLLM, TGI, SGLang, Ollama 등)
- anthropic        : Anthropic Messages API (공식 SDK)
- mock             : 오프라인 개발·테스트용 결정적 모델

구조화 출력 전략(MS-06): json_schema → json_mode → guided_json → prompt
`structured_output="auto"`면 공급자/엔진에 맞는 순서로 시도하고, 서버가 400/422로 거부하면 다음 전략으로 내려간다.
"""
from __future__ import annotations

import json
import os
import time
from dataclasses import dataclass, field
from typing import Any

from ..config import settings
from ..models import LLMModel

STRATEGIES = ("json_schema", "json_mode", "guided_json", "prompt")


class LLMError(Exception):
    def __init__(self, message: str, *, retryable: bool = True, status: int | None = None):
        super().__init__(message)
        self.retryable = retryable
        self.status = status


@dataclass
class ChatRequest:
    system: str
    user: str
    schema: dict[str, Any] | None = None
    params: dict[str, Any] = field(default_factory=dict)  # temperature, top_p, max_tokens, seed, effort
    meta: dict[str, Any] = field(default_factory=dict)  # mock 공급자 등 내부 힌트


@dataclass
class ChatResult:
    text: str
    strategy: str
    input_tokens: int | None
    output_tokens: int | None
    latency_ms: int
    request_preview: dict[str, Any]
    warnings: list[str] = field(default_factory=list)


def schema_instruction(schema: dict[str, Any]) -> str:
    return (
        "\n\n# 출력 형식\n반드시 아래 JSON Schema를 만족하는 JSON 객체 하나만 출력하세요. "
        "설명 문장이나 코드 블록 표시(```)를 붙이지 마세요.\n"
        + json.dumps(schema, ensure_ascii=False)
    )


def strategy_chain(model: LLMModel) -> list[str]:
    if model.structured_output and model.structured_output != "auto":
        chosen = model.structured_output
        return [chosen] if chosen == "prompt" else [chosen, "prompt"]
    if model.provider == "anthropic":
        return ["json_schema", "prompt"]
    if model.provider == "mock":
        return ["json_schema"]
    engine = (model.engine or "").lower()
    if engine == "vllm":
        return ["json_schema", "guided_json", "json_mode", "prompt"]
    if engine in {"tgi", "sglang", "ollama"}:
        return ["json_schema", "json_mode", "prompt"]
    return ["json_schema", "json_mode", "prompt"]


def ensure_allowed(model: LLMModel) -> None:
    if not model.enabled:
        raise LLMError(f"비활성화된 모델입니다: {model.name}", retryable=False)
    if model.is_external and not settings.allow_external_llm:
        raise LLMError("폐쇄망 모드: 외부 LLM 호출이 차단되어 있습니다 (CS_ALLOW_EXTERNAL_LLM=false)", retryable=False)


def api_key(model: LLMModel) -> str | None:
    if not model.api_key_env:
        return None
    value = os.environ.get(model.api_key_env)
    if not value:
        raise LLMError(f"환경변수 {model.api_key_env}에 API 키가 없습니다", retryable=False)
    return value


def generate(model: LLMModel, req: ChatRequest) -> ChatResult:
    """전략 체인을 따라 호출. 서버가 전략을 거부(400/422)하면 다음 전략으로 강등."""
    ensure_allowed(model)
    from . import providers

    chain = strategy_chain(model) if req.schema else ["none"]
    warnings: list[str] = []
    last_exc: LLMError | None = None
    for strategy in chain:
        started = time.monotonic()
        try:
            result = providers.call(model, req, strategy)
        except LLMError as exc:
            last_exc = exc
            if exc.status in (400, 422) and strategy != chain[-1]:
                warnings.append(f"'{strategy}' 전략 거부(HTTP {exc.status}) → 다음 전략으로 전환: {str(exc)[:200]}")
                continue
            raise
        result.latency_ms = int((time.monotonic() - started) * 1000)
        result.warnings = warnings + result.warnings
        return result
    assert last_exc is not None
    raise last_exc
