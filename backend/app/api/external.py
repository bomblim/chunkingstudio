"""외부 시스템용 API (/api/v1) 와 API 키 관리 (/api/api-keys).

- /api/v1/... : 업로드 → 파싱 → 청킹 → 적재 → 질의 파이프라인. **API 키 필수**
  헤더 `Authorization: Bearer csk_…` 또는 `X-API-Key: csk_…`
- /api/api-keys : 화면(API 안내 → API 키 관리)에서 키 발급·목록·삭제. 화면용 /api 와 같이 내부망 전제.

/api/v1 엔드포인트는 화면용 /api 의 같은 함수를 그대로 다시 등록한 것이라 요청·응답 형식이 같다.
"""
from __future__ import annotations

import hashlib
import secrets
from typing import Any

from fastapi import APIRouter, Depends, Header, HTTPException
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..db import get_db
from ..models import ApiKey, utcnow
from . import documents, get_or_404, parsers, projects, row_dict, runs, vectors

KEY_PREFIX = "csk_"


def _hash(key: str) -> str:
    return hashlib.sha256(key.encode("utf-8")).hexdigest()


def require_api_key(
    authorization: str | None = Header(None),
    x_api_key: str | None = Header(None),
    db: Session = Depends(get_db),
) -> ApiKey:
    key = (x_api_key or "").strip()
    if not key and authorization:
        scheme, _, value = authorization.partition(" ")
        key = value.strip() if scheme.lower() == "bearer" else ""
    if not key:
        raise HTTPException(401, "API 키가 필요합니다 (헤더 Authorization: Bearer <키> 또는 X-API-Key)",
                            headers={"WWW-Authenticate": "Bearer"})
    row = db.scalar(select(ApiKey).where(ApiKey.key_hash == _hash(key)))
    if row is None:
        raise HTTPException(401, "유효하지 않은 API 키입니다", headers={"WWW-Authenticate": "Bearer"})
    row.last_used_at = utcnow()
    db.commit()
    return row


# ------------------------------------------------------------------ API 키 관리 (화면용)
keys_router = APIRouter(prefix="/api/api-keys", tags=["api-keys"])


class ApiKeyIn(BaseModel):
    name: str


def _key_out(k: ApiKey) -> dict[str, Any]:
    return row_dict(k, exclude={"key_hash"})


@keys_router.get("")
def list_api_keys(db: Session = Depends(get_db)) -> list[dict[str, Any]]:
    return [_key_out(k) for k in db.scalars(select(ApiKey).order_by(ApiKey.id.desc()))]


@keys_router.post("", status_code=201)
def create_api_key(body: ApiKeyIn, db: Session = Depends(get_db)) -> dict[str, Any]:
    """키 원문(`key`)은 이 응답에서만 볼 수 있다."""
    name = body.name.strip()
    if not name:
        raise HTTPException(400, "키 이름을 입력하세요 (예: ERP 연동)")
    key = KEY_PREFIX + secrets.token_urlsafe(32)
    row = ApiKey(name=name[:200], prefix=key[:12], key_hash=_hash(key))
    db.add(row)
    db.commit()
    return {**_key_out(row), "key": key}


@keys_router.delete("/{key_id}", status_code=204)
def delete_api_key(key_id: str, db: Session = Depends(get_db)) -> None:
    db.delete(get_or_404(db, ApiKey, key_id))
    db.commit()


# ------------------------------------------------------------------ 외부용 API (키 필수)
v1 = APIRouter(prefix="/api/v1", tags=["external v1"], dependencies=[Depends(require_api_key)])

_ROUTES: list[tuple[str, str, Any, int]] = [
    # (메서드, 경로, 함수, 성공 상태 코드)
    ("GET", "/parsers", parsers.list_parsers, 200),
    ("GET", "/projects", projects.list_projects, 200),
    ("GET", "/embedding-models", vectors.list_embedding_models, 200),
    ("GET", "/rerank-models", vectors.list_rerank_models, 200),
    # 1. 업로드
    ("POST", "/files", documents.upload_file, 201),
    ("GET", "/files/{file_id}", documents.get_file, 200),
    # 2. 파싱
    ("POST", "/parse-jobs", documents.create_parse_job, 202),
    ("GET", "/parse-jobs/{job_id}", documents.get_parse_job, 200),
    ("POST", "/ingest", documents.ingest, 201),
    ("GET", "/documents/{doc_id}", documents.get_document, 200),
    # 3. 청킹
    ("POST", "/runs", runs.start_run, 202),
    ("GET", "/runs/{run_id}", runs.get_run, 200),
    ("POST", "/projects/{project_id}/run-all", projects.run_all, 202),
    # 4. 적재
    ("GET", "/index-target", vectors.index_target, 200),
    ("POST", "/indexes", vectors.create_index, 202),
    ("GET", "/indexes", vectors.list_indexes, 200),
    ("GET", "/indexes/{index_id}", vectors.get_index, 200),
    ("POST", "/projects/{project_id}/index-all", projects.index_all, 202),
    # 5. 질의
    ("POST", "/indexes/{index_id}/query", vectors.query, 200),
]
for _method, _path, _fn, _status in _ROUTES:
    v1.add_api_route(_path, _fn, methods=[_method], status_code=_status, name=f"v1_{_fn.__name__}")
