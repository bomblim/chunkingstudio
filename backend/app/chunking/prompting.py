"""프롬프트 템플릿 렌더링과 기본 프롬프트."""
from __future__ import annotations

import json
import re
from typing import Any

from ..standard import Element
from ..tokens import estimate_tokens

TEMPLATE_VARS = {
    "elements": "윈도우에 포함된 Element 목록 ([ID][타입] 텍스트)",
    "section_path": "윈도우 시작 위치의 heading 경로",
    "max_tokens": "청크 최대 토큰",
    "min_tokens": "청크 최소 토큰",
    "doc_type": "문서 유형",
    "doc_title": "문서 제목",
    "few_shots": "Few-shot 예시",
}

_VAR = re.compile(r"\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}")

OUTPUT_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "chunks": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "start_id": {"type": "string", "description": "청크 첫 Element ID"},
                    "end_id": {"type": "string", "description": "청크 마지막 Element ID"},
                    "title": {"type": "string"},
                    "summary": {"type": "string"},
                    "keywords": {"type": "array", "items": {"type": "string"}},
                    "reason": {"type": "string", "description": "이 위치에서 경계를 나눈 근거"},
                },
                "required": ["start_id", "end_id", "title", "summary", "keywords", "reason"],
                "additionalProperties": False,
            },
        }
    },
    "required": ["chunks"],
    "additionalProperties": False,
}

DEFAULT_SYSTEM = """당신은 RAG 검색 품질을 위해 문서를 의미 단위 청크로 나누는 전문가입니다.

입력은 문서를 구성하는 Element 목록이며, 각 줄은 `[Element ID][타입 ~토큰수] 텍스트` 형식입니다.
여러 줄로 된 Element는 다음 줄부터 두 칸 들여쓰기로 이어집니다.

규칙
1. 원문을 다시 쓰지 말고, 각 청크의 경계만 start_id와 end_id(Element ID)로 지정하세요.
2. 모든 Element는 정확히 하나의 청크에 포함되어야 하며, 청크는 문서 순서대로 겹치지 않게 이어져야 합니다.
3. 하나의 주제·절차·표와 그 설명은 같은 청크에 두고, 주제가 바뀌는 곳에서 나누세요.
4. heading은 그 아래 본문과 같은 청크의 시작에 두세요. heading만 있는 청크를 만들지 마세요.
5. 청크 크기는 약 {{min_tokens}}~{{max_tokens}} 토큰을 목표로 하되, 의미 단위를 우선하세요.
6. reason에는 해당 위치에서 경계를 나눈 근거를 한 문장으로 쓰세요.
7. title은 청크 내용을 대표하는 짧은 제목, summary는 한두 문장 요약, keywords는 3~5개 핵심어입니다."""

DEFAULT_USER = """문서: {{doc_title}} (유형: {{doc_type}})
현재 위치: {{section_path}}

{{few_shots}}

# Element 목록
{{elements}}"""


def render_element(el: Element) -> str:
    label = el.type
    if el.type in {"title", "heading"} and el.level:
        label += f" L{el.level}"
    text = el.content_text().strip()
    tokens = estimate_tokens(text)
    lines = text.split("\n") if text else [""]
    head = f"[{el.element_id}][{label} ~{tokens}t] {lines[0]}"
    rest = [f"  {ln}" for ln in lines[1:]]
    return "\n".join([head, *rest])


def render_elements(elements: list[Element]) -> str:
    return "\n".join(render_element(e) for e in elements)


def render_few_shots(few_shots: list[dict[str, Any]]) -> str:
    if not few_shots:
        return ""
    parts = ["# 예시"]
    for i, shot in enumerate(few_shots, 1):
        out = shot.get("output")
        if not isinstance(out, str):
            out = json.dumps(out, ensure_ascii=False)
        parts.append(f"## 예시 {i}\n입력:\n{shot.get('input', '')}\n출력:\n{out}")
    return "\n\n".join(parts)


def render_template(template: str, variables: dict[str, str]) -> tuple[str, list[str]]:
    """{{var}} 치환. 반환: (결과, 알 수 없는 변수 목록)."""
    unknown: list[str] = []

    def repl(m: re.Match[str]) -> str:
        name = m.group(1)
        if name in variables:
            return variables[name]
        unknown.append(name)
        return m.group(0)

    return _VAR.sub(repl, template), unknown


def template_variables(template: str) -> list[str]:
    return sorted({m.group(1) for m in _VAR.finditer(template)})


def section_path(el: Element, by_id: dict[str, Element]) -> str:
    path: list[str] = []
    cur = el if el.type in {"title", "heading"} else by_id.get(el.parent_id or "")
    guard = 0
    while cur is not None and guard < 20:
        if cur.type in {"title", "heading"}:
            path.append(cur.text.strip()[:60])
        cur = by_id.get(cur.parent_id or "")
        guard += 1
    return " > ".join(reversed(path)) or "(문서 시작)"


REPAIR_SYSTEM = (
    "당신은 JSON 수리기입니다. 주어진 출력을 JSON Schema에 맞는 올바른 JSON 객체 하나로 고쳐서 출력하세요. "
    "내용(Element ID와 문자열)은 바꾸지 말고 형식만 고치세요. JSON 외의 텍스트는 출력하지 마세요."
)


def repair_user(raw: str, error: str, schema: dict[str, Any]) -> str:
    return (
        f"# 오류\n{error}\n\n# JSON Schema\n{json.dumps(schema, ensure_ascii=False)}\n\n# 고칠 출력\n{raw}"
    )
