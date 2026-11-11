"""기본 제공 어댑터."""
from __future__ import annotations

from typing import Any

from ..standard import BBox, Element, Figure, Page, StandardDocument, Table
from . import AdapterError, register


@register("standard", "이미 표준 스키마(StandardDocument JSON)로 출력하는 Parser")
def standard_adapter(payload: Any, config: dict[str, Any]) -> StandardDocument:
    if isinstance(payload, dict) and "document" in payload and "elements" not in payload:
        payload = payload["document"]
    if not isinstance(payload, dict):
        raise AdapterError("표준 스키마 객체(JSON object)가 아닙니다")
    doc = StandardDocument.model_validate(payload)
    _fill_reading_order(doc)
    return doc


_UNSTRUCTURED_TYPES = {
    "Title": "heading",
    "NarrativeText": "paragraph",
    "UncategorizedText": "paragraph",
    "Text": "paragraph",
    "ListItem": "list",
    "Table": "table",
    "Image": "figure",
    "Figure": "figure",
    "FigureCaption": "caption",
    "Header": "header",
    "Footer": "footer",
    "PageNumber": "footer",
    "Footnote": "footnote",
    "Formula": "formula",
    "CodeSnippet": "code",
    "Address": "paragraph",
    "EmailAddress": "paragraph",
}


@register("unstructured", "Unstructured.io 스타일 element 리스트 ([{type, element_id, text, metadata}])")
def unstructured_adapter(payload: Any, config: dict[str, Any]) -> StandardDocument:
    items = payload.get("elements") if isinstance(payload, dict) else payload
    if not isinstance(items, list):
        raise AdapterError("element 리스트를 찾을 수 없습니다")
    pages: dict[int, Page] = {}
    elements: list[Element] = []
    for idx, item in enumerate(items):
        meta = item.get("metadata") or {}
        page_no = meta.get("page_number")
        bbox = None
        coords = meta.get("coordinates") or {}
        points = coords.get("points")
        if points:
            xs = [p[0] for p in points]
            ys = [p[1] for p in points]
            bbox = BBox(x0=min(xs), y0=min(ys), x1=max(xs), y1=max(ys))
            if page_no is not None and page_no not in pages:
                pages[page_no] = Page(
                    page_no=page_no, width=coords.get("layout_width"), height=coords.get("layout_height")
                )
        if page_no is not None and page_no not in pages:
            pages[page_no] = Page(page_no=page_no)
        etype = _UNSTRUCTURED_TYPES.get(item.get("type", ""), "other")
        el = Element(
            element_id=str(item.get("element_id") or f"E{idx + 1}"),
            type=etype,  # type: ignore[arg-type]
            text=item.get("text") or "",
            page=page_no,
            bbox=bbox,
            reading_order=idx,
            level=meta.get("category_depth", 0) + 1 if etype == "heading" else None,
            parent_id=meta.get("parent_id"),
            extra={k: v for k, v in meta.items() if k not in {"coordinates", "page_number", "parent_id"}},
        )
        if etype == "table":
            el.table = Table(html=meta.get("text_as_html"))
        if etype == "figure":
            el.figure = Figure(image_ref=meta.get("image_path"))
        elements.append(el)
    ids = {e.element_id for e in elements}
    for e in elements:  # 존재하지 않는 parent 참조는 제거(경고 대신 보정)
        if e.parent_id and e.parent_id not in ids:
            e.parent_id = None
    return StandardDocument(pages=sorted(pages.values(), key=lambda p: p.page_no), elements=elements)


def _fill_reading_order(doc: StandardDocument) -> None:
    if doc.elements and all(e.reading_order == 0 for e in doc.elements):
        for i, e in enumerate(doc.elements):
            e.reading_order = i


def compute_stats(doc: StandardDocument, low_conf: float = 0.5) -> dict[str, Any]:
    """품질 지표(PV-07)."""
    per_page: dict[int, int] = {}
    type_counts: dict[str, int] = {}
    low = 0
    for e in doc.elements:
        type_counts[e.type] = type_counts.get(e.type, 0) + 1
        if e.page is not None:
            per_page[e.page] = per_page.get(e.page, 0) + len(e.content_text())
        if e.confidence is not None and e.confidence < low_conf:
            low += 1
    page_nos = [p.page_no for p in doc.pages] or sorted(per_page)
    empty_pages = [p for p in page_nos if per_page.get(p, 0) == 0]
    return {
        "element_count": len(doc.elements),
        "page_count": len(page_nos),
        "char_count": sum(len(e.content_text()) for e in doc.elements),
        "type_counts": type_counts,
        "chars_per_page": {str(k): v for k, v in sorted(per_page.items())},
        "empty_pages": empty_pages,
        "low_confidence_count": low,
        "table_count": type_counts.get("table", 0),
        "figure_count": type_counts.get("figure", 0),
        "has_bbox": any(e.bbox for e in doc.elements),
    }
