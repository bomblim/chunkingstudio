"""문서 유입·조회 API (IN-01~07, PV-08)."""
from __future__ import annotations

import io
import json
from pathlib import Path
from typing import Any

from fastapi import APIRouter, BackgroundTasks, Depends, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse, PlainTextResponse, Response
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..adapters import AdapterError
from ..db import get_db
from ..models import ChunkRun, Document, IngestFailure, Parser, ParseJob, Project, StoredFile
from ..projects import descendant_ids, load_tree, path_names
from ..services import execute_parse_job, ingest_payload, sha256, store_file
from . import get_or_404, row_dict

router = APIRouter(prefix="/api", tags=["documents"])


def _summary(d: Document, tree: dict[str, Project] | None = None, last_run: ChunkRun | None = None) -> dict[str, Any]:
    out = row_dict(d, exclude={"content"})
    if tree is not None:
        out["project_path"] = path_names(tree, d.project_id)
    if last_run is not None:
        out["last_run"] = {"id": last_run.id, "status": last_run.status, "method": last_run.method,
                           "chunk_count": (last_run.totals or {}).get("chunk_count"),
                           "ok": (last_run.validation or {}).get("ok"), "created_at": last_run.created_at}
    return out


def _check_project(db: Session, project_id: str | None) -> str | None:
    if project_id in (None, 0):
        return None
    get_or_404(db, Project, project_id)
    return project_id


@router.get("/documents")
def list_documents(
    parser_id: str | None = None,
    source: str | None = None,
    q: str | None = None,
    project_id: str | None = None,
    unassigned: bool = False,
    include_descendants: bool = True,
    db: Session = Depends(get_db),
) -> list[dict[str, Any]]:
    """project_id를 주면 해당 프로젝트(기본: 하위 포함) 문서만, unassigned=true면 미분류 문서만."""
    tree = load_tree(db)
    stmt = select(Document).order_by(Document.id.desc())
    if parser_id:
        stmt = stmt.where(Document.parser_id == parser_id)
    if source:
        stmt = stmt.where(Document.source == source)
    if unassigned:
        stmt = stmt.where(Document.project_id.is_(None))
    elif project_id:
        ids = descendant_ids(tree, project_id) if include_descendants else {project_id}
        stmt = stmt.where(Document.project_id.in_(ids))
    rows = list(db.scalars(stmt))
    if q:
        ql = q.lower()
        rows = [
            d for d in rows
            if ql in d.title.lower() or any(ql in (e.get("text") or "").lower() for e in d.content.get("elements", []))
        ]
    last: dict[str, ChunkRun] = {}
    if rows:
        for r in db.scalars(select(ChunkRun).where(ChunkRun.document_id.in_([d.id for d in rows]))
                            .order_by(ChunkRun.id)):
            last[r.document_id] = r
    return [_summary(d, tree, last.get(d.id)) for d in rows]


class DocumentPatch(BaseModel):
    title: str | None = None
    doc_type: str | None = None
    project_id: str | None = None
    clear_project: bool = False  # true면 미분류로


class MoveIn(BaseModel):
    document_ids: list[str]
    project_id: str | None = None  # None이면 미분류로


@router.patch("/documents/{doc_id}")
def patch_document(doc_id: str, body: DocumentPatch, db: Session = Depends(get_db)) -> dict[str, Any]:
    d = get_or_404(db, Document, doc_id)
    if body.title is not None:
        d.title = body.title
    if body.doc_type is not None:
        d.doc_type = body.doc_type
    if body.clear_project:
        d.project_id = None
    elif body.project_id is not None:
        d.project_id = _check_project(db, body.project_id)
    db.commit()
    return _summary(d, load_tree(db))


@router.post("/documents/move")
def move_documents(body: MoveIn, db: Session = Depends(get_db)) -> dict[str, Any]:
    target = _check_project(db, body.project_id)
    docs = list(db.scalars(select(Document).where(Document.id.in_(body.document_ids))))
    for d in docs:
        d.project_id = target
    db.commit()
    return {"moved": len(docs), "project_id": target}


@router.get("/documents/{doc_id}")
def get_document(doc_id: str, db: Session = Depends(get_db)) -> dict[str, Any]:
    d = get_or_404(db, Document, doc_id)
    out = row_dict(d)
    out["has_source_file"] = bool(d.source_file_path and Path(d.source_file_path).exists())
    out["source_kind"] = source_kind(d.source_file_path) if out["has_source_file"] else ""
    out["project_path"] = path_names(load_tree(db), d.project_id)
    out["revisions"] = [
        {"id": r.id, "revision": r.revision, "created_at": r.created_at}
        for r in db.scalars(
            select(Document).where(Document.file_hash == d.file_hash, Document.parser_id == d.parser_id)
            .order_by(Document.revision)
        )
    ]
    return out


@router.get("/documents/{doc_id}/file")
def get_document_file(doc_id: str, db: Session = Depends(get_db)) -> FileResponse:
    d = get_or_404(db, Document, doc_id)
    if not d.source_file_path or not Path(d.source_file_path).exists():
        raise HTTPException(404, "원본 파일이 없습니다")
    return FileResponse(d.source_file_path)


# 원본 대조에 쓰는 이미지 원본. 브라우저가 직접 못 여는 형식(TIFF·BMP 등)과 여러 페이지 TIFF도 있어
# 서버에서 페이지(프레임) 단위 PNG로 바꿔 내려준다.
IMAGE_EXTS = {".png", ".jpg", ".jpeg", ".jpe", ".bmp", ".tif", ".tiff", ".gif", ".webp", ".heic", ".heif"}
PAGE_IMAGE_MAX = 2400  # 긴 변 기준(px). 오버레이 좌표는 비율로 그리므로 축소해도 위치는 같다.


def source_kind(path: str | None) -> str:
    """원본 파일 종류: pdf | image | "" (표시 불가)"""
    ext = Path(path or "").suffix.lower()
    if ext == ".pdf":
        return "pdf"
    if ext in IMAGE_EXTS:
        return "image"
    return ""


@router.get("/documents/{doc_id}/page-image/{page_no}")
def get_page_image(doc_id: str, page_no: int, db: Session = Depends(get_db)) -> Response:
    d = get_or_404(db, Document, doc_id)
    if not d.source_file_path or not Path(d.source_file_path).exists():
        raise HTTPException(404, "원본 파일이 없습니다")
    if source_kind(d.source_file_path) != "image":
        raise HTTPException(400, "이미지 원본이 아닙니다")
    from PIL import Image, ImageOps, UnidentifiedImageError

    try:
        with Image.open(d.source_file_path) as im:
            frames = getattr(im, "n_frames", 1)
            if not 1 <= page_no <= frames:
                raise HTTPException(404, f"페이지가 없습니다 (전체 {frames}페이지)")
            im.seek(page_no - 1)
            # 휴대폰 사진처럼 EXIF 회전 정보가 있으면 브라우저 표시와 같게 돌려 준다
            frame = ImageOps.exif_transpose(im.copy())
            if frame.mode not in ("RGB", "RGBA", "L", "LA"):
                frame = frame.convert("RGBA" if "A" in frame.getbands() else "RGB")
            frame.thumbnail((PAGE_IMAGE_MAX, PAGE_IMAGE_MAX))
            buf = io.BytesIO()
            frame.save(buf, format="PNG", optimize=False)
    except UnidentifiedImageError as exc:
        raise HTTPException(415, "이 이미지 형식은 서버에서 열 수 없습니다(HEIC 등). PNG·JPEG·TIFF로 변환해 올려 주세요") from exc
    return Response(buf.getvalue(), media_type="image/png", headers={"Cache-Control": "private, max-age=3600"})


@router.delete("/documents/{doc_id}", status_code=204)
def delete_document(doc_id: str, db: Session = Depends(get_db)) -> None:
    d = get_or_404(db, Document, doc_id)
    db.delete(d)
    db.commit()


# ------------------------------------------------------------------ 운영 유입 (Parser 결과 수신)
class IngestIn(BaseModel):
    parser_id: str
    title: str
    payload: Any
    doc_type: str = ""
    file_hash: str = ""
    project_id: str | None = None


@router.post("/ingest", status_code=201)
def ingest(body: IngestIn, db: Session = Depends(get_db)) -> dict[str, Any]:
    """IN-01: Parser가 결과를 push. 어댑터로 표준 스키마 변환·검증, 실패 시 격리(IN-03)."""
    parser = get_or_404(db, Parser, body.parser_id)
    try:
        doc = ingest_payload(db, parser=parser, payload=body.payload, title=body.title,
                             doc_type=body.doc_type, file_hash=body.file_hash,
                             project_id=_check_project(db, body.project_id))
    except AdapterError as exc:
        raise HTTPException(422, str(exc)) from exc
    return _summary(doc)


@router.post("/ingest/batch")
async def ingest_batch(
    parser_id: str = Form(...),
    doc_type: str = Form(""),
    project_id: str | None = Form(None),
    file: UploadFile = File(...),
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    """IN-01: JSON(문서 1건 또는 배열) / JSONL(줄당 1건) 배치 import.

    각 항목은 Parser 원본 출력이거나 {"title": ..., "payload": ...} 래퍼.
    """
    parser = get_or_404(db, Parser, parser_id)
    project_id = _check_project(db, project_id)
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
            ok.append(_summary(ingest_payload(db, parser=parser, payload=payload, title=title, doc_type=doc_type,
                                              project_id=project_id)))
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
    project_id: str | None = Form(None),
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
    project_id = _check_project(db, project_id)
    ids = [x.strip() for x in parser_ids.split(",") if x.strip()]
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
                       params=param_obj.get(str(pid), param_obj) if isinstance(param_obj, dict) else {},
                       project_id=project_id)
        db.add(job)
        db.commit()
        background.add_task(execute_parse_job, job.id, str(path), job.params, doc_type)
        jobs.append(row_dict(job))
    return jobs


# ------------------------------------------------------------------ 파이프라인 API: 업로드 → 파싱
@router.post("/files", status_code=201)
async def upload_file(file: UploadFile = File(...), db: Session = Depends(get_db)) -> dict[str, Any]:
    """원본 파일만 업로드한다(파싱은 POST /api/parse-jobs 로 따로). 같은 내용은 한 번만 저장된다."""
    data = await file.read()
    if not data:
        raise HTTPException(400, "빈 파일입니다")
    name = file.filename or "upload"
    path = store_file(data, name)
    f = StoredFile(file_name=name, file_hash=sha256(data), path=str(path), size=len(data),
                   content_type=file.content_type or "")
    db.add(f)
    db.commit()
    return row_dict(f, exclude={"path"})


@router.get("/files/{file_id}")
def get_file(file_id: str, db: Session = Depends(get_db)) -> dict[str, Any]:
    return row_dict(get_or_404(db, StoredFile, file_id), exclude={"path"})


class ParseJobIn(BaseModel):
    file_id: str
    parser_id: str
    project_id: str | None = None  # 파싱 결과 문서를 넣을 프로젝트
    doc_type: str = ""
    params: dict[str, Any] = {}  # Parser 파라미터


@router.post("/parse-jobs", status_code=202)
def create_parse_job(body: ParseJobIn, background: BackgroundTasks, db: Session = Depends(get_db)) -> dict[str, Any]:
    """업로드한 파일을 Parser API로 파싱한다(비동기). GET /api/parse-jobs/{id} 로 상태와 document_id를 확인."""
    f = get_or_404(db, StoredFile, body.file_id)
    if not Path(f.path).exists():
        raise HTTPException(410, "업로드한 파일이 저장소에 없습니다. 다시 업로드하세요")
    parser = get_or_404(db, Parser, body.parser_id)
    if not parser.enabled:
        raise HTTPException(400, f"{parser.name}: 비활성화된 Parser입니다")
    if not parser.api_url:
        raise HTTPException(400, f"{parser.name}: API URL이 없는 결과 수신 전용 Parser입니다 (POST /api/ingest 사용)")
    job = ParseJob(parser_id=parser.id, file_name=f.file_name, file_hash=f.file_hash, params=body.params or {},
                   project_id=_check_project(db, body.project_id))
    db.add(job)
    db.commit()
    background.add_task(execute_parse_job, job.id, f.path, job.params, body.doc_type, "runtime")
    return _job_out(job)


def _job_out(j: ParseJob) -> dict[str, Any]:
    d = row_dict(j)
    d["parser_name"] = j.parser.name if j.parser else ""
    return d


@router.get("/parse-jobs/{job_id}")
def get_parse_job(job_id: str, db: Session = Depends(get_db)) -> dict[str, Any]:
    """status: queued → parsing → converting → done(document_id 생성) | failed(error_kind, error)"""
    return _job_out(get_or_404(db, ParseJob, job_id))


@router.get("/parse-jobs")
def list_parse_jobs(ids: str | None = None, limit: int = 50, db: Session = Depends(get_db)) -> list[dict[str, Any]]:
    stmt = select(ParseJob).order_by(ParseJob.id.desc())
    if ids:
        stmt = stmt.where(ParseJob.id.in_([x.strip() for x in ids.split(",") if x.strip()]))
    else:
        stmt = stmt.limit(limit)
    return [_job_out(j) for j in db.scalars(stmt)]


@router.get("/parse-jobs/{job_id}/raw")
def parse_job_raw(job_id: str, db: Session = Depends(get_db)) -> PlainTextResponse:
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
