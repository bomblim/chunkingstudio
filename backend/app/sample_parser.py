"""개발용 샘플 Parser.

실제 Parser API가 없을 때 '테스트 업로드 → Parser API 직접 호출' 흐름을 확인하기 위한 구현.
Studio 입장에서는 일반 외부 Parser와 동일하게 REST API(/api/dev/sample-parser/parse)로 호출된다.
- .md / .txt: 마크다운 헤딩·목록·표를 Element로 분리 (bbox 없음, 가상 페이지)
- .pdf: pdfplumber로 줄 단위 텍스트·좌표를 추출해 블록으로 묶고, 글자 크기로 헤딩 추정
"""
from __future__ import annotations

import io
import re
from datetime import UTC, datetime

from .standard import BBox, Element, Page, StandardDocument, Table, TableCell

PARSER_NAME = "sample-parser"
PARSER_VERSION = "0.1.0"
LINES_PER_VIRTUAL_PAGE = 40


def parse_bytes(file_name: str, data: bytes) -> StandardDocument:
    lower = file_name.lower()
    if lower.endswith(".pdf"):
        doc = _parse_pdf(data)
    elif lower.endswith((".md", ".markdown", ".txt")):
        doc = _parse_markdown(data.decode("utf-8", errors="replace"))
    else:
        raise ValueError(f"지원하지 않는 형식입니다: {file_name} (지원: .md .txt .pdf)")
    doc.source_file = file_name
    doc.parser_id = PARSER_NAME
    doc.parser_version = PARSER_VERSION
    doc.parsed_at = datetime.now(UTC).isoformat()
    return doc


# ------------------------------------------------------------------ markdown
_HEADING = re.compile(r"^(#{1,6})\s+(.*)$")
_LIST = re.compile(r"^\s*([-*+]|\d+[.)])\s+")
_TABLE_ROW = re.compile(r"^\s*\|.*\|\s*$")
_TABLE_SEP = re.compile(r"^\s*\|?\s*:?-{3,}")


def _parse_markdown(text: str) -> StandardDocument:
    lines = text.replace("\r\n", "\n").split("\n")
    elements: list[Element] = []
    heading_stack: list[tuple[int, str]] = []
    buf: list[str] = []
    buf_kind = ""
    buf_start = 0

    def page_of(line_no: int) -> int:
        return line_no // LINES_PER_VIRTUAL_PAGE + 1

    def parent() -> str | None:
        return heading_stack[-1][1] if heading_stack else None

    def flush() -> None:
        nonlocal buf, buf_kind
        if not buf:
            return
        eid = f"E{len(elements) + 1}"
        page = page_of(buf_start)
        if buf_kind == "table":
            rows = [r for r in buf if not _TABLE_SEP.match(r)]
            cells = []
            for ri, row in enumerate(rows):
                for ci, cell in enumerate(row.strip().strip("|").split("|")):
                    cells.append(TableCell(row=ri, col=ci, text=cell.strip()))
            md = "\n".join(buf)
            elements.append(
                Element(
                    element_id=eid, type="table", text=md, page=page, reading_order=len(elements),
                    parent_id=parent(), table=Table(cells=cells, markdown=md),
                )
            )
        else:
            body = "\n".join(buf).strip()
            if body:
                elements.append(
                    Element(
                        element_id=eid, type="list" if buf_kind == "list" else "paragraph", text=body,
                        page=page, reading_order=len(elements), parent_id=parent(),
                    )
                )
        buf, buf_kind = [], ""

    for i, line in enumerate(lines):
        m = _HEADING.match(line)
        if m:
            flush()
            level = len(m.group(1))
            while heading_stack and heading_stack[-1][0] >= level:
                heading_stack.pop()
            eid = f"E{len(elements) + 1}"
            elements.append(
                Element(
                    element_id=eid, type="title" if level == 1 and not elements else "heading",
                    text=m.group(2).strip(), page=page_of(i), reading_order=len(elements),
                    level=level, parent_id=parent(),
                )
            )
            heading_stack.append((level, eid))
            continue
        if not line.strip():
            flush()
            continue
        kind = "table" if _TABLE_ROW.match(line) else "list" if _LIST.match(line) else "paragraph"
        if buf and kind != buf_kind and not (buf_kind == "list" and line.startswith((" ", "\t"))):
            flush()
        if not buf:
            buf_kind, buf_start = kind, i
        buf.append(line)
    flush()

    n_pages = max((e.page or 1) for e in elements) if elements else 1
    pages = [Page(page_no=p) for p in range(1, n_pages + 1)]
    return StandardDocument(pages=pages, elements=elements)


# ------------------------------------------------------------------ pdf
def _parse_pdf(data: bytes) -> StandardDocument:
    import pdfplumber

    pages: list[Page] = []
    elements: list[Element] = []
    with pdfplumber.open(io.BytesIO(data)) as pdf:
        all_sizes: list[float] = []
        page_lines: list[list[dict]] = []
        for page in pdf.pages:
            lines = page.extract_text_lines(return_chars=True)
            for ln in lines:
                sizes = [c.get("size", 0) for c in ln.get("chars", [])]
                ln["size"] = max(sizes) if sizes else 0
                all_sizes.extend(sizes)
            page_lines.append(lines)
            pages.append(Page(page_no=page.page_number, width=float(page.width), height=float(page.height)))
        body_size = _median(all_sizes) or 10.0
        heading_stack: list[tuple[int, str]] = []
        for page_obj, lines in zip(pages, page_lines, strict=True):
            blocks = _group_lines(lines, body_size)
            for blk in blocks:
                eid = f"E{len(elements) + 1}"
                text = " ".join(ln["text"] for ln in blk).strip()
                if not text:
                    continue
                size = max(ln["size"] for ln in blk)
                bbox = BBox(
                    x0=min(ln["x0"] for ln in blk), y0=min(ln["top"] for ln in blk),
                    x1=max(ln["x1"] for ln in blk), y1=max(ln["bottom"] for ln in blk),
                )
                is_heading = size >= body_size * 1.15 and len(text) < 120 and len(blk) <= 2
                level = None
                etype = "paragraph"
                if is_heading:
                    level = 1 if size >= body_size * 1.6 else 2 if size >= body_size * 1.3 else 3
                    etype = "heading"
                    while heading_stack and heading_stack[-1][0] >= level:
                        heading_stack.pop()
                elif _LIST.match(text):
                    etype = "list"
                if page_obj.height and bbox.y1 < page_obj.height * 0.06 and len(text) < 80:
                    etype = "header"
                elif page_obj.height and bbox.y0 > page_obj.height * 0.94 and len(text) < 80:
                    etype = "footer"
                parent = heading_stack[-1][1] if heading_stack else None
                elements.append(
                    Element(
                        element_id=eid, type=etype, text=text, page=page_obj.page_no, bbox=bbox,  # type: ignore[arg-type]
                        reading_order=len(elements), level=level,
                        parent_id=parent,
                        extra={"font_size": round(size, 1)},
                    )
                )
                if etype == "heading" and level is not None:
                    heading_stack.append((level, eid))
    return StandardDocument(pages=pages, elements=elements)


def _group_lines(lines: list[dict], body_size: float) -> list[list[dict]]:
    blocks: list[list[dict]] = []
    cur: list[dict] = []
    for ln in lines:
        if cur:
            prev = cur[-1]
            gap = ln["top"] - prev["bottom"]
            size_change = abs(ln["size"] - prev["size"]) > body_size * 0.15
            if gap > body_size * 0.8 or size_change:
                blocks.append(cur)
                cur = []
        cur.append(ln)
    if cur:
        blocks.append(cur)
    return blocks


def _median(values: list[float]) -> float:
    if not values:
        return 0.0
    s = sorted(values)
    return s[len(s) // 2]
