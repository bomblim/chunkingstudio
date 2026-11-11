"""표준 파싱 결과 스키마 (requirements 2장).

모든 UI 표시·비교·청킹의 기준. Parser 원본 출력은 어댑터를 거쳐 이 스키마로 변환된다.
"""
from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, Field, model_validator

ElementType = Literal[
    "title",
    "heading",
    "paragraph",
    "list",
    "table",
    "figure",
    "caption",
    "header",
    "footer",
    "footnote",
    "code",
    "formula",
    "other",
]

ELEMENT_TYPES: tuple[str, ...] = ElementType.__args__  # type: ignore[attr-defined]


class BBox(BaseModel):
    """페이지 좌표계(Page.width/height 기준) 상의 박스. x0,y0 = 좌상단."""

    x0: float
    y0: float
    x1: float
    y1: float


class TableCell(BaseModel):
    row: int
    col: int
    rowspan: int = 1
    colspan: int = 1
    text: str = ""


class Table(BaseModel):
    cells: list[TableCell] = Field(default_factory=list)
    html: str | None = None
    markdown: str | None = None


class Figure(BaseModel):
    image_ref: str | None = None
    caption: str | None = None
    vlm_description: str | None = None


class Element(BaseModel):
    element_id: str
    type: ElementType = "paragraph"
    text: str = ""
    page: int | None = None
    bbox: BBox | None = None
    reading_order: int = 0
    level: int | None = None  # heading 레벨 (1=최상위)
    parent_id: str | None = None
    confidence: float | None = None
    table: Table | None = None
    figure: Figure | None = None
    extra: dict[str, Any] = Field(default_factory=dict)

    def content_text(self) -> str:
        """청크 본문 조립용 텍스트. 표는 markdown/html을 우선한다."""
        if self.type == "table" and self.table:
            if self.table.markdown:
                return self.table.markdown
            if self.table.html:
                return self.table.html
        if self.type == "figure" and not self.text and self.figure:
            return self.figure.caption or self.figure.vlm_description or ""
        return self.text


class Page(BaseModel):
    page_no: int
    width: float | None = None
    height: float | None = None
    image_ref: str | None = None


class StandardDocument(BaseModel):
    doc_id: str | None = None
    source_file: str | None = None
    file_hash: str | None = None
    parser_id: str | None = None
    parser_version: str | None = None
    parsed_at: str | None = None
    settings: dict[str, Any] = Field(default_factory=dict)
    pages: list[Page] = Field(default_factory=list)
    elements: list[Element] = Field(default_factory=list)
    extra: dict[str, Any] = Field(default_factory=dict)

    @model_validator(mode="after")
    def _check(self) -> StandardDocument:
        seen: set[str] = set()
        for el in self.elements:
            if el.element_id in seen:
                raise ValueError(f"element_id 중복: {el.element_id}")
            seen.add(el.element_id)
        for el in self.elements:
            if el.parent_id and el.parent_id not in seen:
                raise ValueError(f"{el.element_id}의 parent_id({el.parent_id})가 존재하지 않습니다")
        return self

    def ordered_elements(self) -> list[Element]:
        return sorted(self.elements, key=lambda e: (e.reading_order, e.page or 0))
