"""Upstage 파싱 결과 → 표준 스키마.

지원 입력
1. Agents API(v2) 완료 작업: {"status": "completed", "output": [{"content": [{"type": "output_text", "text": "<JSON>"}]}]}
   - text 안의 JSON이 Document Parse 결과다. include="all"이면 단계별 결과가 여러 개 올 수 있어
     elements가 있는 결과를 우선 쓰고, 없으면 content.html을 파싱한다.
2. Document Parse(v1) 응답 자체: {"api": ..., "content": {...}, "elements": [...]}

Element: {"id", "category", "page", "content": {"html", "markdown", "text"}, "coordinates": [{"x","y"}×4 (0~1 상대좌표)]}
좌표는 상대값 그대로 두고 Page.width/height를 1.0으로 기록한다(뷰어가 원본 페이지 비율에 맞춰 늘려 그린다).
"""
from __future__ import annotations

import json
import re
from html.parser import HTMLParser
from typing import Any

from ..standard import BBox, Element, Figure, Page, StandardDocument, Table
from . import AdapterError, register

CATEGORY_MAP = {
    "paragraph": "paragraph",
    "list": "list",
    "index": "list",
    "table": "table",
    "figure": "figure",
    "chart": "figure",
    "caption": "caption",
    "header": "header",
    "footer": "footer",
    "footnote": "footnote",
    "equation": "formula",
    "code": "code",
}
_HEADING = re.compile(r"^heading(\d)?$")


@register("upstage", "Upstage Document Parse / Agents API(v2) 결과 (elements 또는 content.html)")
def upstage_adapter(payload: Any, config: dict[str, Any]) -> StandardDocument:
    parse = _find_parse_result(payload)
    if parse is None:
        raise AdapterError("Upstage 응답에서 파싱 결과(elements 또는 content.html)를 찾지 못했습니다")
    elements = parse.get("elements")
    if isinstance(elements, list) and elements:
        items = elements
    else:
        html = ((parse.get("content") or {}).get("html")) or ""
        items = _elements_from_html(html)
        if not items:
            raise AdapterError("Upstage 결과에 elements가 없고 content.html도 비어 있습니다")
    doc = _to_standard(items)
    doc.extra["upstage"] = {k: parse.get(k) for k in ("api", "model", "usage") if parse.get(k) is not None}
    if isinstance(payload, dict) and payload.get("id"):
        doc.extra["upstage"]["job_id"] = payload["id"]
    return doc


# ------------------------------------------------------------------ 결과 위치 찾기
def _find_parse_result(payload: Any) -> dict[str, Any] | None:
    if isinstance(payload, str):
        try:
            payload = json.loads(payload)
        except json.JSONDecodeError:
            return None
    if not isinstance(payload, dict):
        return None
    if "elements" in payload or ("content" in payload and isinstance(payload["content"], dict)):
        return payload
    candidates: list[dict[str, Any]] = []
    for out in payload.get("output") or []:
        for part in (out or {}).get("content") or []:
            text = part.get("text") if isinstance(part, dict) else None
            if not text:
                continue
            try:
                parsed = json.loads(text)
            except (json.JSONDecodeError, TypeError):
                continue
            if isinstance(parsed, dict):
                candidates.append(parsed)
    for c in candidates:  # elements가 있는 결과 우선
        if isinstance(c.get("elements"), list) and c["elements"]:
            return c
    for c in candidates:
        if isinstance(c.get("content"), dict) and c["content"].get("html"):
            return c
    return None


# ------------------------------------------------------------------ 변환
def _to_standard(items: list[dict[str, Any]]) -> StandardDocument:
    elements: list[Element] = []
    pages: set[int] = set()
    heading_stack: list[tuple[int, str]] = []
    for idx, it in enumerate(items):
        category = str(it.get("category") or "paragraph").lower()
        content = it.get("content") or {}
        if isinstance(content, str):
            content = {"text": content}
        html = content.get("html") or ""
        markdown = content.get("markdown") or ""
        text = (content.get("text") or markdown or _strip_html(html)).strip()
        page = it.get("page")
        if isinstance(page, int):
            pages.add(page)
        eid = f"E{it['id']}" if it.get("id") is not None else f"E{idx + 1}"
        m = _HEADING.match(category)
        level = None
        if m:
            etype = "heading"
            level = int(m.group(1) or 1)
            while heading_stack and heading_stack[-1][0] >= level:
                heading_stack.pop()
        else:
            etype = CATEGORY_MAP.get(category, "other")
        el = Element(
            element_id=eid,
            type=etype,  # type: ignore[arg-type]
            text=text,
            page=page if isinstance(page, int) else None,
            bbox=_bbox(it.get("coordinates")),
            reading_order=idx,
            level=level,
            parent_id=heading_stack[-1][1] if heading_stack else None,
            extra={"category": category, **({"sub_category": it["sub_category"]} if it.get("sub_category") else {})},
        )
        if etype == "table":
            el.table = Table(html=html or None, markdown=markdown or None)
        elif etype == "figure":
            el.figure = Figure(caption=text or None)
        elements.append(el)
        if etype == "heading" and level is not None:
            heading_stack.append((level, eid))
    _dedupe_ids(elements)
    page_list = [Page(page_no=p, width=1.0, height=1.0) for p in sorted(pages)]
    return StandardDocument(pages=page_list, elements=elements, extra={"coordinates": "relative"})


def _bbox(coords: Any) -> BBox | None:
    if not isinstance(coords, list) or not coords:
        return None
    try:
        xs = [float(p["x"]) for p in coords]
        ys = [float(p["y"]) for p in coords]
    except (KeyError, TypeError, ValueError):
        return None
    return BBox(x0=min(xs), y0=min(ys), x1=max(xs), y1=max(ys))


def _dedupe_ids(elements: list[Element]) -> None:
    seen: dict[str, int] = {}
    for e in elements:
        if e.element_id in seen:
            seen[e.element_id] += 1
            e.element_id = f"{e.element_id}_{seen[e.element_id]}"
        else:
            seen[e.element_id] = 0


# ------------------------------------------------------------------ HTML 대체 경로
_TAG_CATEGORY = {"h1": "heading1", "h2": "heading2", "h3": "heading3", "h4": "heading4", "p": "paragraph",
                 "table": "table", "figure": "figure", "img": "figure", "ul": "list", "ol": "list",
                 "header": "header", "footer": "footer", "code": "code", "pre": "code"}
_BLOCK_TAGS = set(_TAG_CATEGORY)
_VOID = {"img", "br", "hr", "meta", "link", "input"}


class _BlockCollector(HTMLParser):
    """최상위 블록 태그를 Element 후보로 모은다 (id, data-category 속성 사용)."""

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.items: list[dict[str, Any]] = []
        self._cur: dict[str, Any] | None = None
        self._depth = 0
        self._html: list[str] = []
        self._text: list[str] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        a = dict(attrs)
        raw = self.get_starttag_text() or f"<{tag}>"
        if self._cur is None:
            if tag not in _BLOCK_TAGS:
                return
            self._cur = {"tag": tag, "id": a.get("id"), "category": a.get("data-category") or _TAG_CATEGORY[tag]}
            self._depth = 0
            self._html, self._text = [], []
            if tag == "img":
                self._cur["alt"] = a.get("alt") or ""
                self._html.append(raw)
                self._finish()
                return
        self._html.append(raw)
        if tag not in _VOID:
            self._depth += 1
        if tag in {"br", "tr", "li"}:
            self._text.append("\n")

    def handle_endtag(self, tag: str) -> None:
        if self._cur is None:
            return
        self._html.append(f"</{tag}>")
        self._depth -= 1
        if tag in {"td", "th"}:
            self._text.append(" | ")
        if self._depth <= 0:
            self._finish()

    def handle_data(self, data: str) -> None:
        if self._cur is not None:
            self._html.append(data)
            self._text.append(data)

    def _finish(self) -> None:
        cur = self._cur
        assert cur is not None
        text = re.sub(r"[ \t]+", " ", "".join(self._text)).strip() or cur.get("alt", "")
        item: dict[str, Any] = {"category": cur["category"], "content": {"html": "".join(self._html), "text": text}}
        if cur.get("id") is not None and str(cur["id"]).isdigit():
            item["id"] = int(cur["id"])
        self.items.append(item)
        self._cur = None


def _elements_from_html(html: str) -> list[dict[str, Any]]:
    if not html.strip():
        return []
    p = _BlockCollector()
    p.feed(html)
    p.close()
    return [i for i in p.items if i["content"]["text"] or i["category"] == "figure"]


def _strip_html(html: str) -> str:
    return re.sub(r"\s+", " ", re.sub(r"<[^>]+>", " ", html)).strip()
