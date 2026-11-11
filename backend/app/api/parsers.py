"""Parser Registry API (PR-01~09)."""
from __future__ import annotations

import time
from typing import Any

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from ..adapters import list_adapters
from ..db import get_db
from ..models import Parser, ParseJob
from ..parser_client import ParserCallError, call_parser, upstage_config_problems
from . import get_or_404, row_dict

router = APIRouter(prefix="/api", tags=["parsers"])


class ParserIn(BaseModel):
    name: str
    description: str = ""
    version: str = "1.0"
    owner: str = ""
    input_formats: list[str] = Field(default_factory=list)
    adapter: str = "standard"
    adapter_config: dict[str, Any] = Field(default_factory=dict)
    param_schema: list[dict[str, Any]] = Field(default_factory=list)
    api_url: str = ""
    api_auth_header: str = ""
    api_auth_env: str = ""
    api_timeout_sec: float = 120.0
    api_mode: str = "sync"  # sync | async | upstage
    api_config: dict[str, Any] = Field(default_factory=dict)
    api_status_url: str = ""
    api_file_field: str = "file"
    max_file_mb: float = 50.0
    enabled: bool = True


API_MODES = {"sync", "async", "upstage"}


def _check_mode(body: ParserIn) -> None:
    if body.api_mode not in API_MODES:
        raise HTTPException(400, f"api_mode는 {sorted(API_MODES)} 중 하나")


def _with_stats(db: Session, p: Parser) -> dict[str, Any]:
    d = row_dict(p)
    d["api_config"] = p.api_config or {}
    rows = db.execute(
        select(ParseJob.status, func.count(), func.avg(ParseJob.elapsed_ms))
        .where(ParseJob.parser_id == p.id)
        .group_by(ParseJob.status)
    ).all()
    total = sum(r[1] for r in rows)
    failed = sum(r[1] for r in rows if r[0] == "failed")
    done_avg = next((r[2] for r in rows if r[0] == "done"), None)
    d["monitor"] = {
        "test_calls": total,
        "failed": failed,
        "error_rate": round(failed / total, 3) if total else None,
        "avg_elapsed_ms": int(done_avg) if done_avg else None,
    }
    d["test_callable"] = bool(p.api_url)
    return d


@router.get("/adapters")
def adapters() -> list[dict[str, str]]:
    return list_adapters()


@router.get("/parsers")
def list_parsers(db: Session = Depends(get_db)) -> list[dict[str, Any]]:
    return [_with_stats(db, p) for p in db.scalars(select(Parser).order_by(Parser.name))]


@router.post("/parsers", status_code=201)
def create_parser(body: ParserIn, db: Session = Depends(get_db)) -> dict[str, Any]:
    _check_mode(body)
    if db.scalar(select(Parser).where(Parser.name == body.name)):
        raise HTTPException(409, "같은 이름의 Parser가 있습니다")
    p = Parser(**body.model_dump())
    db.add(p)
    db.commit()
    return _with_stats(db, p)


@router.get("/parsers/{parser_id}")
def get_parser(parser_id: int, db: Session = Depends(get_db)) -> dict[str, Any]:
    return _with_stats(db, get_or_404(db, Parser, parser_id))


@router.put("/parsers/{parser_id}")
def update_parser(parser_id: int, body: ParserIn, db: Session = Depends(get_db)) -> dict[str, Any]:
    _check_mode(body)
    p = get_or_404(db, Parser, parser_id)
    for k, v in body.model_dump().items():
        setattr(p, k, v)
    db.commit()
    return _with_stats(db, p)


@router.post("/parsers/{parser_id}/health")
def parser_health(parser_id: int, db: Session = Depends(get_db)) -> dict[str, Any]:
    """연결 테스트(PR-08): 작은 텍스트 파일로 실제 API를 호출해 본다."""
    p = get_or_404(db, Parser, parser_id)
    started = time.monotonic()
    if p.api_mode == "upstage":
        # 실제 호출은 파일 업로드·작업 실행 비용이 들어 설정만 점검한다. 동작 확인은 테스트 업로드로 한다.
        problems = upstage_config_problems(p)
        health = {"ok": not problems, "elapsed_ms": 0,
                  "message": "; ".join(problems) if problems else "설정 확인 완료 (실제 호출은 테스트 업로드로 확인)"}
        health["checked_at"] = time.strftime("%Y-%m-%dT%H:%M:%S")
        p.last_health = health
        db.commit()
        return health
    try:
        res = call_parser(p, "health-check.md", "# Health check\n\nChunking Studio 연결 테스트".encode(), {})
        health = {"ok": True, "elapsed_ms": res.elapsed_ms, "message": "응답 수신"}
    except ParserCallError as exc:
        health = {"ok": False, "kind": exc.kind, "message": str(exc),
                  "elapsed_ms": int((time.monotonic() - started) * 1000)}
    health["checked_at"] = time.strftime("%Y-%m-%dT%H:%M:%S")
    p.last_health = health
    db.commit()
    return health


@router.get("/parsers/{parser_id}/jobs")
def parser_jobs(parser_id: int, limit: int = 50, db: Session = Depends(get_db)) -> list[dict[str, Any]]:
    rows = db.scalars(
        select(ParseJob).where(ParseJob.parser_id == parser_id).order_by(ParseJob.id.desc()).limit(limit)
    )
    return [row_dict(j) for j in rows]
