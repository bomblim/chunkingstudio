"""유입·실행 공통 로직."""
from __future__ import annotations

import hashlib
import json
import traceback
from pathlib import Path
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from .adapters import AdapterError, adapt
from .adapters.builtin import compute_stats
from .chunking.engine import ChunkSettings, run_chunking
from .config import settings
from .db import SessionLocal
from .models import ChunkRun, Document, IngestFailure, LLMModel, Parser, ParseJob, PromptVersion
from .parser_client import ParserCallError, call_parser
from .standard import StandardDocument


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def store_file(data: bytes, file_name: str) -> Path:
    digest = sha256(data)
    target_dir = settings.files_dir / digest[:2]
    target_dir.mkdir(parents=True, exist_ok=True)
    suffix = Path(file_name).suffix.lower()
    path = target_dir / f"{digest}{suffix}"
    if not path.exists():
        path.write_bytes(data)
    return path


# ------------------------------------------------------------------ ingest
def ingest_payload(
    db: Session,
    *,
    parser: Parser | None,
    payload: Any,
    title: str,
    source: str = "runtime",
    file_hash: str = "",
    source_file_path: str = "",
    doc_type: str = "",
    project_id: int | None = None,
) -> Document:
    """Parser 출력 → 어댑터 → 표준 스키마 검증 → 저장. 실패 시 격리 후 AdapterError."""
    adapter = parser.adapter if parser else "standard"
    try:
        doc = adapt(adapter, payload, parser.adapter_config if parser else {})
    except AdapterError as exc:
        db.add(IngestFailure(
            parser_id=parser.id if parser else None, source_name=title, reason=str(exc),
            payload_excerpt=json.dumps(payload, ensure_ascii=False, default=str)[:2000],
        ))
        db.commit()
        raise
    return save_document(db, doc, parser=parser, title=title, source=source, file_hash=file_hash,
                         source_file_path=source_file_path, doc_type=doc_type, project_id=project_id)


def save_document(
    db: Session,
    doc: StandardDocument,
    *,
    parser: Parser | None,
    title: str,
    source: str,
    file_hash: str = "",
    source_file_path: str = "",
    doc_type: str = "",
    project_id: int | None = None,
) -> Document:
    file_hash = file_hash or doc.file_hash or sha256(doc.model_dump_json().encode())
    doc.file_hash = file_hash
    if parser:
        doc.parser_id = doc.parser_id or parser.name
        doc.parser_version = doc.parser_version or parser.version
    prev = db.scalar(
        select(func.max(Document.revision)).where(
            Document.file_hash == file_hash, Document.parser_id == (parser.id if parser else None)
        )
    )
    row = Document(
        title=title or doc.source_file or "untitled",
        parser_id=parser.id if parser else None,
        parser_name=parser.name if parser else (doc.parser_id or ""),
        parser_version=doc.parser_version or "",
        file_hash=file_hash,
        source_file_path=source_file_path,
        source=source,
        doc_type=doc_type,
        revision=(prev or 0) + 1,
        project_id=project_id,
        content=doc.model_dump(mode="json"),
        stats=compute_stats(doc),
    )
    db.add(row)
    db.commit()
    db.refresh(row)
    return row


# ------------------------------------------------------------------ 테스트 파싱 (Parser API 직접 호출)
def execute_parse_job(job_id: int, file_path: str, params: dict[str, Any], doc_type: str = "") -> None:
    db = SessionLocal()
    try:
        job = db.get(ParseJob, job_id)
        if job is None:
            return
        parser = db.get(Parser, job.parser_id)
        data = Path(file_path).read_bytes()
        job.status = "parsing"
        db.commit()
        try:
            result = call_parser(parser, job.file_name, data, params)
        except ParserCallError as exc:
            job.status, job.error_kind, job.error = "failed", exc.kind, str(exc)
            db.commit()
            return
        job.elapsed_ms = result.elapsed_ms
        raw_dir = settings.data_dir / "parse_raw"
        raw_dir.mkdir(parents=True, exist_ok=True)
        raw_path = raw_dir / f"job_{job.id}.json"
        raw_path.write_text(result.raw_text, encoding="utf-8")
        job.raw_response_path = str(raw_path)
        job.status = "converting"
        db.commit()
        try:
            doc = ingest_payload(
                db, parser=parser, payload=result.payload, title=job.file_name, source="test",
                file_hash=job.file_hash, source_file_path=file_path, doc_type=doc_type,
                project_id=job.project_id,
            )
        except AdapterError as exc:
            job.status, job.error_kind, job.error = "failed", "adapter_error", str(exc)
            db.commit()
            return
        job.document_id = doc.id
        job.status = "done"
        db.commit()
    except Exception as exc:  # 예기치 못한 오류도 job에 남긴다
        db.rollback()
        job = db.get(ParseJob, job_id)
        if job:
            job.status, job.error_kind, job.error = "failed", "internal", f"{exc}\n{traceback.format_exc()[-1500:]}"
            db.commit()
    finally:
        db.close()


# ------------------------------------------------------------------ 청킹 실행
def execute_run(run_id: int) -> None:
    db = SessionLocal()
    try:
        run = db.get(ChunkRun, run_id)
        if run is None:
            return
        document = db.get(Document, run.document_id)
        model = db.get(LLMModel, run.model_id) if run.model_id else None
        pv = db.get(PromptVersion, run.prompt_version_id) if run.prompt_version_id else None
        run.status = "running"
        db.commit()

        def progress(p: dict[str, Any]) -> None:
            run.progress = p
            db.commit()

        result = run_chunking(
            StandardDocument.model_validate(document.content),
            method=run.method,
            settings=ChunkSettings.from_dict(run.settings),
            model=model,
            prompt_version=pv,
            params=run.params,
            doc_title=document.title,
            on_progress=progress,
        )
        run.chunks = result.chunks
        run.windows = result.windows
        run.validation = result.validation
        run.totals = {**result.totals, "excluded_ids": result.excluded_ids}
        run.status = "done"
        db.commit()
    except Exception as exc:
        db.rollback()
        run = db.get(ChunkRun, run_id)
        if run:
            run.status = "failed"
            run.error = f"{exc}\n{traceback.format_exc()[-2000:]}"
            db.commit()
    finally:
        db.close()


def run_snapshot(model: LLMModel | None, pv: PromptVersion | None, document: Document) -> dict[str, Any]:
    """재현성(EX-05): 실행 시점 설정을 그대로 보관."""
    snap: dict[str, Any] = {
        "document": {"id": document.id, "title": document.title, "revision": document.revision,
                     "file_hash": document.file_hash, "parser": document.parser_name,
                     "parser_version": document.parser_version},
    }
    if model:
        snap["model"] = {"id": model.id, "name": model.name, "provider": model.provider, "engine": model.engine,
                         "model_id": model.model_id, "structured_output": model.structured_output,
                         "context_length": model.context_length}
    if pv:
        snap["prompt"] = {"prompt_id": pv.prompt_id, "version_id": pv.id, "version": pv.version,
                          "system_template": pv.system_template, "user_template": pv.user_template,
                          "few_shots": pv.few_shots, "output_schema": pv.output_schema}
    return snap
