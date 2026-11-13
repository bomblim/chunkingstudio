"""임베딩 모델 · 벡터 저장소 · 인덱스(적재/질의) API."""
from __future__ import annotations

import time
from typing import Any

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..config import settings
from ..db import get_db
from ..embeddings import TEMPLATE_FIELDS, EmbeddingError, embed
from ..indexing import execute_index_job, query_index
from ..models import ChunkRun, EmbeddingModel, VectorIndex, VectorStore
from ..projects import validate_principal
from ..vectorstores import VectorStoreError, open_store, validate_collection_name
from . import get_or_404, row_dict

router = APIRouter(prefix="/api", tags=["vectors"])

EMBED_TEMPLATES = [
    {"label": "본문만", "template": "{text}"},
    {"label": "섹션 경로 + 본문", "template": "{section_path}\n\n{text}"},
    {"label": "문서 제목 + 섹션 경로 + 본문", "template": "[{document_title}] {section_path}\n\n{text}"},
    {"label": "제목 + 요약 + 본문", "template": "{title}\n{summary}\n\n{text}"},
]


# ------------------------------------------------------------------ 임베딩 모델
class EmbeddingModelIn(BaseModel):
    name: str
    provider: str = "openai_compatible"
    engine: str = ""
    base_url: str = ""
    model_id: str
    api_key_env: str = ""
    is_external: bool = False
    dimension: int | None = None
    max_input_tokens: int = 8192
    query_prefix: str = ""
    document_prefix: str = ""
    batch_size: int = 32
    extra_params: dict[str, Any] = Field(default_factory=dict)
    enabled: bool = True


def _emb_out(m: EmbeddingModel) -> dict[str, Any]:
    d = row_dict(m)
    d["blocked"] = m.is_external and not settings.allow_external_llm
    return d


@router.get("/embedding-models")
def list_embedding_models(usable_only: bool = False, db: Session = Depends(get_db)) -> list[dict[str, Any]]:
    rows = [_emb_out(m) for m in db.scalars(select(EmbeddingModel).order_by(EmbeddingModel.name))]
    return [r for r in rows if r["enabled"] and not r["blocked"]] if usable_only else rows


@router.post("/embedding-models", status_code=201)
def create_embedding_model(body: EmbeddingModelIn, db: Session = Depends(get_db)) -> dict[str, Any]:
    if body.provider not in {"openai_compatible", "mock"}:
        raise HTTPException(400, f"알 수 없는 provider: {body.provider}")
    if db.scalar(select(EmbeddingModel).where(EmbeddingModel.name == body.name)):
        raise HTTPException(409, "같은 이름의 임베딩 모델이 있습니다")
    m = EmbeddingModel(**body.model_dump())
    db.add(m)
    db.commit()
    return _emb_out(m)


@router.put("/embedding-models/{model_id}")
def update_embedding_model(model_id: int, body: EmbeddingModelIn, db: Session = Depends(get_db)) -> dict[str, Any]:
    m = get_or_404(db, EmbeddingModel, model_id)
    for k, v in body.model_dump().items():
        setattr(m, k, v)
    db.commit()
    return _emb_out(m)


@router.post("/embedding-models/{model_id}/health")
def embedding_health(model_id: int, db: Session = Depends(get_db)) -> dict[str, Any]:
    """연결 확인 + 차원 자동 감지."""
    m = get_or_404(db, EmbeddingModel, model_id)
    try:
        res = embed(m, ["연결 테스트 문장입니다."], "document")
        dim = len(res.vectors[0])
        m.dimension = dim
        health = {"ok": True, "dimension": dim, "latency_ms": res.latency_ms}
    except EmbeddingError as exc:
        health = {"ok": False, "message": str(exc)}
    health["checked_at"] = time.strftime("%Y-%m-%dT%H:%M:%S")
    m.last_health = health
    db.commit()
    return health


# ------------------------------------------------------------------ 벡터 저장소
class VectorStoreIn(BaseModel):
    name: str
    kind: str = "milvus"
    uri: str = "http://localhost:19530"
    token_env: str = ""
    db_name: str = ""
    tls_ca_path: str = ""
    tls_server_name: str = ""
    enabled: bool = True


@router.get("/vector-stores")
def list_vector_stores(db: Session = Depends(get_db)) -> list[dict[str, Any]]:
    return [row_dict(s) for s in db.scalars(select(VectorStore).order_by(VectorStore.name))]


@router.post("/vector-stores", status_code=201)
def create_vector_store(body: VectorStoreIn, db: Session = Depends(get_db)) -> dict[str, Any]:
    if body.kind not in {"milvus", "memory"}:
        raise HTTPException(400, f"알 수 없는 저장소 종류: {body.kind}")
    if db.scalar(select(VectorStore).where(VectorStore.name == body.name)):
        raise HTTPException(409, "같은 이름의 저장소가 있습니다")
    s = VectorStore(**body.model_dump())
    db.add(s)
    db.commit()
    return row_dict(s)


@router.put("/vector-stores/{store_id}")
def update_vector_store(store_id: int, body: VectorStoreIn, db: Session = Depends(get_db)) -> dict[str, Any]:
    s = get_or_404(db, VectorStore, store_id)
    for k, v in body.model_dump().items():
        setattr(s, k, v)
    db.commit()
    return row_dict(s)


@router.post("/vector-stores/{store_id}/health")
def vector_store_health(store_id: int, db: Session = Depends(get_db)) -> dict[str, Any]:
    s = get_or_404(db, VectorStore, store_id)
    started = time.monotonic()
    try:
        info = open_store(s).health()
        health = {"ok": True, **info}
    except VectorStoreError as exc:
        health = {"ok": False, "message": str(exc)}
    health["latency_ms"] = int((time.monotonic() - started) * 1000)
    health["checked_at"] = time.strftime("%Y-%m-%dT%H:%M:%S")
    s.last_health = health
    db.commit()
    return health


# ------------------------------------------------------------------ 인덱스 (적재)
class IndexIn(BaseModel):
    run_id: int
    store_id: int
    embedding_model_id: int
    collection: str
    name: str = ""
    embed_template: str = "{text}"
    metric: str = "COSINE"
    mode: str = "create"  # create | recreate | append


class AppendIn(BaseModel):
    run_id: int


class QueryIn(BaseModel):
    query: str
    top_k: int = 5
    filter: str = ""
    # None: 권한 필터 미적용(관리자 보기) / []: 공개 청크만 / ["group:인사팀", ...]: 해당 주체가 볼 수 있는 청크만
    principals: list[str] | None = None


def _index_out(db: Session, ix: VectorIndex) -> dict[str, Any]:
    d = row_dict(ix)
    store = db.get(VectorStore, ix.store_id)
    model = db.get(EmbeddingModel, ix.embedding_model_id)
    d["store_name"] = store.name if store else ""
    d["store_kind"] = store.kind if store else ""
    d["embedding_model_name"] = model.name if model else ""
    return d


def _check_run(db: Session, run_id: int) -> ChunkRun:
    run = get_or_404(db, ChunkRun, run_id)
    if run.status != "done" or not run.chunks:
        raise HTTPException(400, "완료되고 청크가 있는 청킹 실행만 적재할 수 있습니다")
    return run


@router.get("/indexes/meta")
def index_meta() -> dict[str, Any]:
    return {"templates": EMBED_TEMPLATES, "template_fields": TEMPLATE_FIELDS, "metrics": ["COSINE", "IP", "L2"],
            "modes": ["create", "recreate", "append"]}


@router.get("/indexes")
def list_indexes(db: Session = Depends(get_db)) -> list[dict[str, Any]]:
    return [_index_out(db, ix) for ix in db.scalars(select(VectorIndex).order_by(VectorIndex.id.desc()))]


@router.get("/indexes/{index_id}")
def get_index(index_id: int, db: Session = Depends(get_db)) -> dict[str, Any]:
    return _index_out(db, get_or_404(db, VectorIndex, index_id))


@router.post("/indexes", status_code=202)
def create_index(body: IndexIn, background: BackgroundTasks, db: Session = Depends(get_db)) -> dict[str, Any]:
    _check_run(db, body.run_id)
    store = get_or_404(db, VectorStore, body.store_id)
    model = get_or_404(db, EmbeddingModel, body.embedding_model_id)
    if not store.enabled or not model.enabled:
        raise HTTPException(400, "비활성화된 저장소 또는 임베딩 모델입니다")
    if body.metric not in {"COSINE", "IP", "L2"}:
        raise HTTPException(400, "metric은 COSINE / IP / L2 중 하나")
    if body.mode not in {"create", "recreate", "append"}:
        raise HTTPException(400, "mode는 create / recreate / append 중 하나")
    try:
        validate_collection_name(body.collection)
    except VectorStoreError as exc:
        raise HTTPException(400, str(exc)) from exc
    ix = None
    if body.mode == "append":  # 같은 저장소·컬렉션의 기존 인덱스에 추가
        ix = db.scalar(select(VectorIndex).where(VectorIndex.store_id == store.id,
                                                 VectorIndex.collection == body.collection)
                       .order_by(VectorIndex.id.desc()))
        if ix and ix.embedding_model_id != model.id:
            raise HTTPException(400, "기존 컬렉션과 다른 임베딩 모델로는 추가할 수 없습니다")
    if ix is None:
        ix = VectorIndex(name=body.name or body.collection, store_id=store.id, collection=body.collection,
                         embedding_model_id=model.id, embed_template=body.embed_template, metric=body.metric)
        db.add(ix)
    ix.status = "queued"
    db.commit()
    background.add_task(execute_index_job, ix.id, body.run_id, body.mode)
    return _index_out(db, ix)


@router.post("/indexes/{index_id}/append", status_code=202)
def append_run(index_id: int, body: AppendIn, background: BackgroundTasks, db: Session = Depends(get_db)) -> dict[str, Any]:
    ix = get_or_404(db, VectorIndex, index_id)
    _check_run(db, body.run_id)
    ix.status = "queued"
    db.commit()
    background.add_task(execute_index_job, ix.id, body.run_id, "append")
    return _index_out(db, ix)


@router.delete("/indexes/{index_id}", status_code=204)
def delete_index(index_id: int, drop_collection: bool = False, db: Session = Depends(get_db)) -> None:
    ix = get_or_404(db, VectorIndex, index_id)
    if drop_collection:
        try:
            store = open_store(db.get(VectorStore, ix.store_id))
            if store.has_collection(ix.collection):
                store.drop_collection(ix.collection)
        except VectorStoreError as exc:
            raise HTTPException(502, str(exc)) from exc
    db.delete(ix)
    db.commit()


@router.post("/indexes/{index_id}/query")
def query(index_id: int, body: QueryIn, db: Session = Depends(get_db)) -> dict[str, Any]:
    ix = get_or_404(db, VectorIndex, index_id)
    if ix.status != "done" and not ix.chunk_count:
        raise HTTPException(400, "적재가 끝난 인덱스만 질의할 수 있습니다")
    if not body.query.strip():
        raise HTTPException(400, "질의를 입력하세요")
    try:
        principals = None
        if body.principals is not None:
            try:
                principals = sorted({validate_principal(x) for x in body.principals if x.strip()})
            except ValueError as exc:
                raise HTTPException(400, str(exc)) from exc
        return query_index(ix, db.get(EmbeddingModel, ix.embedding_model_id), db.get(VectorStore, ix.store_id),
                           body.query, max(1, min(body.top_k, 100)), body.filter, principals)
    except (EmbeddingError, VectorStoreError) as exc:
        raise HTTPException(502, str(exc)) from exc
