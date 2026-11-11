"""공급자별 호출 구현."""
from __future__ import annotations

import json
from typing import Any

import httpx

from ..models import LLMModel
from . import ChatRequest, ChatResult, LLMError, api_key, schema_instruction


def call(model: LLMModel, req: ChatRequest, strategy: str) -> ChatResult:
    if model.provider == "openai_compatible":
        return _openai_compatible(model, req, strategy)
    if model.provider == "anthropic":
        return _anthropic(model, req, strategy)
    if model.provider == "mock":
        from .mock import mock_chat

        return mock_chat(model, req)
    raise LLMError(f"지원하지 않는 공급자: {model.provider}", retryable=False)


# ------------------------------------------------------------------ OpenAI 호환 (상용 + 오픈소스 서빙)
def _openai_compatible(model: LLMModel, req: ChatRequest, strategy: str) -> ChatResult:
    if not model.base_url:
        raise LLMError("base_url이 필요합니다 (예: http://vllm:8000/v1)", retryable=False)
    system = req.system
    if req.schema and strategy in {"json_mode", "prompt"}:
        system += schema_instruction(req.schema)
    p = req.params
    body: dict[str, Any] = {
        "model": model.model_id,
        "messages": [{"role": "system", "content": system}, {"role": "user", "content": req.user}],
        "max_tokens": int(p.get("max_tokens") or model.max_output_tokens),
    }
    for key in ("temperature", "top_p", "seed"):
        if p.get(key) is not None:
            body[key] = p[key]
    if req.schema:
        if strategy == "json_schema":
            body["response_format"] = {
                "type": "json_schema",
                "json_schema": {"name": "chunking_output", "schema": req.schema},
            }
        elif strategy == "json_mode":
            body["response_format"] = {"type": "json_object"}
        elif strategy == "guided_json":  # vLLM 제약 디코딩
            body["guided_json"] = req.schema
    body.update(model.extra_params or {})

    headers = {"Content-Type": "application/json"}
    key = api_key(model)
    if key:
        headers["Authorization"] = f"Bearer {key}"
    url = model.base_url.rstrip("/") + "/chat/completions"
    try:
        resp = httpx.post(url, json=body, headers=headers, timeout=httpx.Timeout(600.0, connect=10.0))
    except httpx.TimeoutException as exc:
        raise LLMError(f"LLM 타임아웃: {exc}") from exc
    except httpx.HTTPError as exc:
        raise LLMError(f"LLM 연결 실패: {exc}") from exc
    if resp.status_code >= 400:
        retryable = resp.status_code in (408, 409, 429) or resp.status_code >= 500
        raise LLMError(f"HTTP {resp.status_code}: {resp.text[:500]}", retryable=retryable, status=resp.status_code)
    data = resp.json()
    choice = (data.get("choices") or [{}])[0]
    text = (choice.get("message") or {}).get("content") or ""
    usage = data.get("usage") or {}
    warnings = []
    if choice.get("finish_reason") == "length":
        warnings.append("출력이 max_tokens에서 잘렸습니다")
    preview = {k: v for k, v in body.items() if k != "messages"}
    return ChatResult(
        text=text, strategy=strategy, input_tokens=usage.get("prompt_tokens"),
        output_tokens=usage.get("completion_tokens"), latency_ms=0, request_preview=preview, warnings=warnings,
    )


# ------------------------------------------------------------------ Anthropic (공식 SDK)
# 서버 측 refusal fallback을 지원하는 모델 (요청 거부 시 다른 모델로 자동 재시도)
_FALLBACK_MODELS = ("claude-fable-5-2", "claude-fable-5-1", "claude-opus-5-5", "claude-opus-5", "claude-sonnet-5-5")


def _anthropic(model: LLMModel, req: ChatRequest, strategy: str) -> ChatResult:
    import anthropic

    client = anthropic.Anthropic(api_key=api_key(model), base_url=model.base_url or None, max_retries=0)
    system = req.system
    p = req.params
    kwargs: dict[str, Any] = {
        "model": model.model_id,
        "max_tokens": int(p.get("max_tokens") or model.max_output_tokens),
        "system": system,
        "messages": [{"role": "user", "content": req.user}],
    }
    output_config: dict[str, Any] = {}
    if p.get("effort"):
        output_config["effort"] = p["effort"]
    if req.schema and strategy == "json_schema":
        output_config["format"] = {"type": "json_schema", "schema": req.schema}
    elif req.schema:
        kwargs["system"] = system + schema_instruction(req.schema)
    if output_config:
        kwargs["output_config"] = output_config
    warnings = []
    if any(p.get(k) is not None for k in ("temperature", "top_p")):
        warnings.append("Anthropic 최신 모델은 temperature/top_p를 지원하지 않아 무시했습니다 (effort로 조절)")

    use_fallback = model.model_id in _FALLBACK_MODELS and (model.extra_params or {}).get("fallbacks", "default") != "off"
    try:
        if use_fallback:
            msg = client.beta.messages.create(
                betas=["server-side-fallback-2026-07-01"], fallbacks="default", **kwargs
            )
        else:
            msg = client.messages.create(**kwargs)
    except anthropic.APIStatusError as exc:
        retryable = exc.status_code in (408, 409, 429) or exc.status_code >= 500
        raise LLMError(f"HTTP {exc.status_code}: {str(exc)[:500]}", retryable=retryable, status=exc.status_code) from exc
    except anthropic.APIConnectionError as exc:
        raise LLMError(f"Anthropic 연결 실패: {exc}") from exc

    if msg.stop_reason == "refusal":
        raise LLMError("모델이 요청을 거부했습니다 (stop_reason=refusal)", retryable=False)
    if msg.stop_reason == "max_tokens":
        warnings.append("출력이 max_tokens에서 잘렸습니다")
    text = "".join(getattr(b, "text", "") for b in msg.content if getattr(b, "type", "") == "text")
    preview = {k: v for k, v in kwargs.items() if k not in {"messages", "system"}}
    if use_fallback:
        preview["fallbacks"] = "default"
    return ChatResult(
        text=text, strategy=strategy, input_tokens=msg.usage.input_tokens, output_tokens=msg.usage.output_tokens,
        latency_ms=0, request_preview=json.loads(json.dumps(preview, default=str)), warnings=warnings,
    )
