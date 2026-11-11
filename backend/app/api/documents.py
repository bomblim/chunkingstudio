"""문서 유입·조회 API (IN-01~07, PV-08)."""
from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from fastapi import APIRouter, BackgroundTasks, Depends, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse, PlainTextResponse
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..adapters import AdapterError
from ..db import get_db
from ..models import Document, IngestFailure, Parser, ParseJob
from ..services import execute_parse_job, ingest_payload, sha256, store_file
from . import get_or_404, row_dict

router = APIRouter(prefix="/api", tags=["documents"])


def _summary(d: Document) -> dict[str, Any]:
    return row_dict(d, exclude={"content"})


@router.get("/documents")
def list_documents(
    parser_id: int | None = None,
    source: str | None = None,
    q: str | None = None,
    db: Session = Depends(get_db),
) -> list[dict[str, Any]]:
    stmt = select(Document).order_by(Document.id.desc())
    if parser_id:
        stmt = stmt.where(Document.parser_id == parser_id)
    if source:
        stmt = stmt.where(Document.source == source)
    rows = list(db.scalars(stmt))
    if q:
        ql = q.lower()
        rows = [
            d for d in rows
            if ql in d.title.lower() or any(ql in (e.get("text") or "").lower() for e in d.content.get("elements", []))
        ]
    return [_summary(d) for d in rows]


@router.get("/documents/{doc_id}")
def get_document(doc_id: int, db: Session = Depends(get_db)) -> dict[str, Any]:
    d = get_or_404(db, Document, doc_id)
    out = row_dict(d)
    out["has_source_file"] = bool(d.source_file_path and Path(d.source_file_path).exists())
    out["revisions"] = [
        {"id": r.id, "revision": r.revision, "created_at": r.created_at}
        for r in db.scalars(
            select(Document).where(Document.file_hash == d.file_hash, Document.parser_id == d.parser_id)
            .order_by(Document.revision)
        )
    ]
    return out


@router.get("/documents/{doc_id}/file")
def get_document_file(doc_id: int, db: Session = Depends(get_db)) -> FileResponse:
    d = get_or_404(db, Document, doc_id)
    if not d.source_file_path or not Path(d.source_file_path).exists():
        raise HTTPException(404, "원본 파일이 없습니다")
    return FileResponse(d.source_file_path)


@router.delete("/documents/{doc_id}", status_code=204)
def delete_document(doc_id: int, db: Session = Depends(get_db)) -> None:
    d = get_or_404(db, Document, doc_id)
    db.delete(d)
    db.commit()


# ------------------------------------------------------------------ 운영 유입 (Parser 결과 수신)
class IngestIn(BaseModel):
    parser_id: int
    title: str
    payload: Any
    doc_type: str = ""
    file_hash: str = ""


@router.post("/ingest", status_code=201)
def ingest(body: IngestIn, db: Session = Depends(get_db)) -> dict[str, Any]:
    """IN-01: Parser가 결과를 push. 어댑터로 표준 스키마 변환·검증, 실패 시 격리(IN-03)."""
    parser = get_or_404(db, Parser, body.parser_id)
    try:
        doc = ingest_payload(db, parser=parser, payload=body.payload, title=body.title,
                             doc_type=body.doc_type, file_hash=body.file_hash)
    except AdapterError as exc:
        raise HTTPException(422, str(exc)) from exc
    return _summary(doc)


@router.post("/ingest/batch")
async def ingest_batch(
    parser_id: int = Form(...),
    doc_type: str = Form(""),
    file: UploadFile = File(...),
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    """IN-01: JSON(문서 1건 또는 배열) / JSONL(줄당 1건) 배치 import.

    각 항목은 Parser 원본 출력이거나 {"title": ..., "payload": ...} 래퍼.
    """
    parser = get_or_404(db, Parser, parser_id)
    raw = (await file.read()).decode("utf-8-sig")
    name = file.filename or "batch"
    items: list[Any]
    if name.lower().endswith(".jsonl"):
        items = [json.loads(line) for line in raw.splitlines() if line.strip()]
    else:
        data = json.loads(raw)
        items = data if isinstance(data, list) and data and isinstance(data[0], dict) and (
            "payload" in data[0] or "elements" in data[0]
        ) else [data]
    ok, failed = [], []
    for i, item in enumerate(items):
        title = f"{name}#{i + 1}"
        payload = item
        if isinstance(item, dict) and "payload" in item:
            title = item.get("title") or title
            payload = item["payload"]
        elif isinstance(item, dict) and item.get("source_file"):
            title = item["source_file"]
        try:
            ok.append(_summary(ingest_payload(db, parser=parser, payload=payload, title=title, doc_type=doc_type)))
        except AdapterError as exc:
            failed.append({"title": title, "reason": str(exc)})
    return {"imported": ok, "failed": failed}


@router.get("/ingest/failures")
def ingest_failures(limit: int = 100, db: Session = Depends(get_db)) -> list[dict[str, Any]]:
    return [row_dict(f) for f in db.scalars(select(IngestFailure).order_by(IngestFailure.id.desc()).limit(limit))]


# ------------------------------------------------------------------ 테스트 유입 (Parser API 직접 호출)
@router.post("/test-parse", status_code=202)
async def test_parse(
    background: BackgroundTasks,
    file: UploadFile = File(...),
    parser_ids: str = Form(..., description="쉼표로 구분한 Parser ID"),
    params: str = Form("{}", description="Parser 파라미터 JSON"),
    doc_type: str = Form(""),
    db: Session = Depends(get_db),
) -> list[dict[str, Any]]:
    """IN-02: 샘플 문서 업로드 → 선택한 Parser API를 직접 호출 → 표준 스키마로 변환."""
    data = await file.read()
    if not data:
        raise HTTPException(400, "빈 파일입니다")
    try:
        param_obj = json.loads(params or "{}")
    except json.JSONDecodeError as exc:
        raise HTTPException(400, f"params JSON 오류: {exc}") from exc
    ids = [int(x) for x in parser_ids.split(",") if x.strip()]
    if not ids:
        raise HTTPException(400, "Parser를 하나 이상 선택하세요")
    path = store_file(data, file.filename or "upload")
    digest = sha256(data)
    jobs = []
    for pid in ids:
        parser = get_or_404(db, Parser, pid)
        if not parser.api_url:
            raise HTTPException(400, f"{parser.name}: API URL이 없는 결과 수신 전용 Parser입니다")
        job = ParseJob(parser_id=pid, file_name=file.filename or "upload", file_hash=digest,
                       params=param_obj.get(str(pid), param_obj) if isinstance(param_obj, dict) else {})
        db.add(job)
        db.commit()
        background.add_task(execute_parse_job, job.id, str(path), job.params, doc_type)
        jobs.append(row_dict(job))
    return jobs


@router.get("/parse-jobs")
def list_parse_jobs(ids: str | None = None, limit: int = 50, db: Session = Depends(get_db)) -> list[dict[str, Any]]:
    stmt = select(ParseJob).order_by(ParseJob.id.desc())
    if ids:
        stmt = stmt.where(ParseJob.id.in_([int(x) for x in ids.split(",") if x.strip()]))
    else:
        stmt = stmt.limit(limit)
    out = []
    for j in db.scalars(stmt):
        d = row_dict(j)
        d["parser_name"] = j.parser.name if j.parser else ""
        out.append(d)
    return out


@router.get("/parse-jobs/{job_id}/raw")
def parse_job_raw(job_id: int, db: Session = Depends(get_db)) -> PlainTextResponse:
    job = get_or_404(db, ParseJob, job_id)
    if not job.raw_response_path or not Path(job.raw_response_path).exists():
        raise HTTPException(404, "원본 응답이 없습니다")
    return PlainTextResponse(Path(job.raw_response_path).read_text(encoding="utf-8"), media_type="application/json")


@router.get("/search")
def search_elements(q: str, limit: int = 50, db: Session = Depends(get_db)) -> list[dict[str, Any]]:
    """본문 검색(PV-08)."""
    ql = q.lower()
    hits = []
    for d in db.scalars(select(Document).order_by(Document.id.desc())):
        for e in d.content.get("elements", []):
            if ql in (e.get("text") or "").lower():
                hits.append({"document_id": d.id, "title": d.title, "element_id": e["element_id"],
                             "type": e.get("type"), "page": e.get("page"), "text": e.get("text", "")[:200]})
                if len(hits) >= limit:
                    return hits
    return hits
