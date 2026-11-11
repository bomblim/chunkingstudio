"""청킹 실행 API (Playground)."""
from __future__ import annotations

from typing import Any

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..chunking.engine import ChunkSettings
from ..db import get_db
from ..llm import LLMError, ensure_allowed
from ..models import ChunkRun, Document, LLMModel, PromptVersion
from ..services import execute_run, run_snapshot
from . import get_or_404, row_dict

router = APIRouter(prefix="/api/runs", tags=["runs"])


class RunIn(BaseModel):
    document_id: int
    method: str = "llm"  # llm | rule_structure
    prompt_version_id: int | None = None
    model_id: int | None = None
    params: dict[str, Any] = Field(default_factory=dict)
    settings: dict[str, Any] = Field(default_factory=dict)


class FeedbackIn(BaseModel):
    chunk_id: str
    value: str | None  # up | down | None(취소)
    comment: str = ""


def _summary(r: ChunkRun) -> dict[str, Any]:
    d = row_dict(r, exclude={"windows", "chunks", "snapshot"})
    snap = r.snapshot or {}
    d["model_name"] = (snap.get("model") or {}).get("name", "")
    prompt = snap.get("prompt") or {}
    d["prompt_label"] = f"v{prompt['version']}" if prompt else ""
    d["prompt_id"] = prompt.get("prompt_id")
    return d


def create_run(
    db: Session,
    document: Document,
    method: str,
    prompt_version_id: int | None,
    model_id: int | None,
    params: dict[str, Any],
    settings: dict[str, Any],
    extra_snapshot: dict[str, Any] | None = None,
) -> ChunkRun:
    """실행 레코드 생성(검증 포함). 실제 실행은 호출 측이 execute_run으로 예약한다."""
    model = pv = None
    if method == "llm":
        if not model_id or not prompt_version_id:
            raise HTTPException(400, "LLM 청킹에는 model_id와 prompt_version_id가 필요합니다")
        model = get_or_404(db, LLMModel, model_id)
        pv = get_or_404(db, PromptVersion, prompt_version_id)
        try:
            ensure_allowed(model)
        except LLMError as exc:
            raise HTTPException(400, str(exc)) from exc
    elif method != "rule_structure":
        raise HTTPException(400, f"알 수 없는 method: {method}")
    cs = ChunkSettings.from_dict({"doc_type": document.doc_type, **(settings or {})})
    snapshot = run_snapshot(model, pv, document)
    if extra_snapshot:
        snapshot.update(extra_snapshot)
    run = ChunkRun(
        document_id=document.id, prompt_version_id=pv.id if pv else None, model_id=model.id if model else None,
        method=method, params=params or {}, settings=cs.to_dict(), snapshot=snapshot,
    )
    db.add(run)
    db.commit()
    return run


@router.post("", status_code=202)
def start_run(body: RunIn, background: BackgroundTasks, db: Session = Depends(get_db)) -> dict[str, Any]:
    document = get_or_404(db, Document, body.document_id)
    run = create_run(db, document, body.method, body.prompt_version_id, body.model_id, body.params, body.settings)
    background.add_task(execute_run, run.id)
    return _summary(run)


@router.get("")
def list_runs(document_id: int | None = None, limit: int = 50, db: Session = Depends(get_db)) -> list[dict[str, Any]]:
    stmt = select(ChunkRun).order_by(ChunkRun.id.desc()).limit(limit)
    if document_id:
        stmt = stmt.where(ChunkRun.document_id == document_id)
    return [_summary(r) for r in db.scalars(stmt)]


@router.get("/{run_id}")
def get_run(run_id: int, db: Session = Depends(get_db)) -> dict[str, Any]:
    r = get_or_404(db, ChunkRun, run_id)
    d = row_dict(r)
    d.update({k: v for k, v in _summary(r).items() if k in {"model_name", "prompt_label", "prompt_id"}})
    return d


@router.post("/{run_id}/feedback")
def feedback(run_id: int, body: FeedbackIn, db: Session = Depends(get_db)) -> dict[str, Any]:
    r = get_or_404(db, ChunkRun, run_id)
    fb = dict(r.feedback or {})
    if body.value is None:
        fb.pop(body.chunk_id, None)
    elif body.value in {"up", "down"}:
        fb[body.chunk_id] = {"value": body.value, "comment": body.comment}
    else:
        raise HTTPException(400, "value는 up/down/null")
    r.feedback = fb
    db.commit()
    return fb


@router.delete("/{run_id}", status_code=204)
def delete_run(run_id: int, db: Session = Depends(get_db)) -> None:
    db.delete(get_or_404(db, ChunkRun, run_id))
    db.commit()


@router.get("/-/settings-defaults")
def settings_defaults() -> dict[str, Any]:
    return ChunkSettings().to_dict()
