"""Parser 출력 어댑터 레지스트리 (PR-04).

어댑터는 Parser 원본 출력(JSON)을 표준 스키마(StandardDocument)로 변환한다.
새 Parser 포맷은 `@register("이름")`으로 함수를 추가해 확장한다.
"""
from __future__ import annotations

from collections.abc import Callable
from typing import Any

from ..standard import StandardDocument

AdapterFn = Callable[[Any, dict[str, Any]], StandardDocument]

_REGISTRY: dict[str, tuple[AdapterFn, str]] = {}


class AdapterError(ValueError):
    pass


def register(name: str, description: str) -> Callable[[AdapterFn], AdapterFn]:
    def deco(fn: AdapterFn) -> AdapterFn:
        _REGISTRY[name] = (fn, description)
        return fn

    return deco


def list_adapters() -> list[dict[str, str]]:
    return [{"name": k, "description": v[1]} for k, v in sorted(_REGISTRY.items())]


def adapt(name: str, payload: Any, config: dict[str, Any] | None = None) -> StandardDocument:
    if name not in _REGISTRY:
        raise AdapterError(f"등록되지 않은 어댑터: {name}")
    fn, _ = _REGISTRY[name]
    try:
        return fn(payload, config or {})
    except AdapterError:
        raise
    except Exception as exc:  # pydantic ValidationError 등
        raise AdapterError(f"{name} 어댑터 변환 실패: {exc}") from exc


from . import builtin  # noqa: E402,F401  (등록 부수효과)
