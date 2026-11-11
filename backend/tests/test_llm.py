from __future__ import annotations

import httpx
import pytest

from app import llm
from app.llm import ChatRequest, LLMError, generate, strategy_chain
from app.models import LLMModel

SCHEMA = {"type": "object", "properties": {"chunks": {"type": "array"}}, "required": ["chunks"]}


def _vllm() -> LLMModel:
    return LLMModel(name="v", provider="openai_compatible", engine="vllm", base_url="http://vllm/v1",
                    model_id="qwen", context_length=8192, max_output_tokens=512, structured_output="auto",
                    extra_params={}, enabled=True, is_external=False, api_key_env="")


def test_strategy_chain_by_engine():
    assert strategy_chain(_vllm()) == ["json_schema", "guided_json", "json_mode", "prompt"]


def test_downgrades_strategy_on_400(monkeypatch):
    seen = []

    def fake_post(url, json, headers, timeout):
        seen.append(json)
        req = httpx.Request("POST", url)
        if json.get("response_format", {}).get("type") == "json_schema":
            return httpx.Response(400, text="response_format json_schema not supported", request=req)
        return httpx.Response(200, request=req, json={
            "choices": [{"message": {"content": '{"chunks": []}'}, "finish_reason": "stop"}],
            "usage": {"prompt_tokens": 10, "completion_tokens": 3},
        })

    monkeypatch.setattr(httpx, "post", fake_post)
    res = generate(_vllm(), ChatRequest("sys", "user", SCHEMA, {"temperature": 0}))
    assert res.strategy == "guided_json"
    assert "guided_json" in seen[1] and seen[1]["temperature"] == 0
    assert res.warnings and "json_schema" in res.warnings[0]
    assert res.input_tokens == 10


def test_external_model_blocked_in_closed_network(monkeypatch):
    m = _vllm()
    m.is_external = True
    monkeypatch.setattr(llm, "settings", type("S", (), {"allow_external_llm": False})())
    with pytest.raises(LLMError, match="폐쇄망"):
        generate(m, ChatRequest("s", "u", SCHEMA))
