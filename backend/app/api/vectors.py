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
from ..indexing import default_rerank_candidates, execute_index_job, query_index
from ..models import ChunkRun, Document, EmbeddingModel, Project, RerankModel, VectorCollection, VectorIndex, VectorStore
from ..projects import default_collection, load_tree, resolve_collection, target_brief, validate_principal
from ..reranking import PROVIDERS as RERANK_PROVIDERS
from ..reranking import TEMPLATE_FIELDS as RERANK_TEMPLATE_FIELDS
from ..reranking import RerankError, rerank
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


# ------------------------------------------------------------------ 리랭크 모델
class RerankModelIn(BaseModel):
    name: str
    provider: str = "tei"  # tei | cohere_compatible | mock
    engine: str = ""
    base_url: str = ""
    model_id: str = ""
    api_key_env: str = ""
    is_external: bool = False
    max_input_tokens: int = 512
    batch_size: int = 32
    document_template: str = "{text}"
    extra_params: dict[str, Any] = Field(default_factory=dict)
    enabled: bool = True


def _rerank_out(m: RerankModel) -> dict[str, Any]:
    d = row_dict(m)
    d["blocked"] = m.is_external and not settings.allow_external_llm
    return d


def _check_rerank_body(db: Session, body: RerankModelIn, model_id: int | None = None) -> None:
    if body.provider not in RERANK_PROVIDERS:
        raise HTTPException(400, f"알 수 없는 provider: {body.provider} (가능: {', '.join(RERANK_PROVIDERS)})")
    if not body.name.strip():
        raise HTTPException(400, "이름을 입력하세요")
    if body.provider == "cohere_compatible" and not body.model_id.strip():
        raise HTTPException(400, "Cohere 형식 엔드포인트는 모델 ID가 필요합니다")
    dup = db.scalar(select(RerankModel).where(RerankModel.name == body.name, RerankModel.id != (model_id or 0)))
    if dup:
        raise HTTPException(409, "같은 이름의 리랭크 모델이 있습니다")
    if body.max_input_tokens < 16 or body.batch_size < 1:
        raise HTTPException(400, "최대 입력 토큰(16 이상)과 배치 크기(1 이상)를 확인하세요")


@router.get("/rerank-models/meta")
def rerank_meta() -> dict[str, Any]:
    return {"providers": list(RERANK_PROVIDERS), "template_fields": list(RERANK_TEMPLATE_FIELDS)}


@router.get("/rerank-models")
def list_rerank_models(usable_only: bool = False, db: Session = Depends(get_db)) -> list[dict[str, Any]]:
    rows = [_rerank_out(m) for m in db.scalars(select(RerankModel).order_by(RerankModel.name))]
    return [r for r in rows if r["enabled"] and not r["blocked"]] if usable_only else rows


@router.post("/rerank-models", status_code=201)
def create_rerank_model(body: RerankModelIn, db: Session = Depends(get_db)) -> dict[str, Any]:
    _check_rerank_body(db, body)
    m = RerankModel(**body.model_dump())
    db.add(m)
    db.commit()
    return _rerank_out(m)


@router.put("/rerank-models/{model_id}")
def update_rerank_model(model_id: int, body: RerankModelIn, db: Session = Depends(get_db)) -> dict[str, Any]:
    m = get_or_404(db, RerankModel, model_id)
    _check_rerank_body(db, body, model_id)
    for k, v in body.model_dump().items():
        setattr(m, k, v)
    db.commit()
    return _rerank_out(m)


@router.delete("/rerank-models/{model_id}", status_code=204)
def delete_rerank_model(model_id: int, db: Session = Depends(get_db)) -> None:
    db.delete(get_or_404(db, RerankModel, model_id))
    db.commit()


@router.post("/rerank-models/{model_id}/health")
def rerank_health(model_id: int, db: Session = Depends(get_db)) -> dict[str, Any]:
    """연결 확인: 관련 문장이 무관한 문장보다 높은 점수를 받는지도 함께 본다."""
    m = get_or_404(db, RerankModel, model_id)
    query = "원격근무 시 보안 수칙"
    docs = ["원격근무 중에는 회사 VPN에 접속하고 화면 잠금을 5분으로 설정한다.", "구내식당은 오전 11시 30분부터 운영한다."]
    try:
        res = rerank(m, query, docs)
        health = {"ok": True, "latency_ms": res.latency_ms, "scores": [round(s, 4) for s in res.scores],
                  "sane": res.scores[0] > res.scores[1]}
    except RerankError as exc:
        health = {"ok": False, "message": str(exc)}
    health["checked_at"] = time.strftime("%Y-%m-%dT%H:%M:%S")
    m.last_health = health
    db.commit()
    return health


# ------------------------------------------------------------------ 벡터 저장소(연결) · 컬렉션
class VectorStoreIn(BaseModel):
    """연결 정보만. 적재 컬렉션은 연결 아래에 따로 등록한다(/vector-stores/{id}/collections)."""
    name: str
    kind: str = "milvus"
    uri: str = "http://localhost:19530"
    token_env: str = ""
    db_name: str = ""
    tls_ca_path: str = ""
    tls_server_name: str = ""
    enabled: bool = True


class CollectionIn(BaseModel):
    name: str
    description: str = ""
    is_default: bool = False


def _collection_out(db: Session, c: VectorCollection) -> dict[str, Any]:
    d = row_dict(c)
    d["projects"] = [p.name for p in db.scalars(select(Project).where(Project.vector_collection_id == c.id)
                                                .order_by(Project.name))]
    ix = db.scalar(select(VectorIndex).where(VectorIndex.store_id == c.store_id, VectorIndex.collection == c.name)
                   .order_by(VectorIndex.id.desc()))
    d["chunk_count"] = ix.chunk_count if ix else None
    return d


def _store_out(db: Session, s: VectorStore) -> dict[str, Any]:
    d = row_dict(s, exclude={"collection", "is_default"})
    d["collections"] = [_collection_out(db, c) for c in s.collections]
    return d


def _check_store_body(db: Session, body: VectorStoreIn, store_id: int | None = None) -> None:
    if body.kind not in {"milvus", "memory"}:
        raise HTTPException(400, f"알 수 없는 저장소 종류: {body.kind}")
    if not body.name.strip():
        raise HTTPException(400, "저장소 이름을 입력하세요")
    dup = db.scalar(select(VectorStore).where(VectorStore.name == body.name, VectorStore.id != (store_id or 0)))
    if dup:
        raise HTTPException(409, "같은 이름의 저장소가 있습니다")


@router.get("/vector-stores")
def list_vector_stores(db: Session = Depends(get_db)) -> list[dict[str, Any]]:
    return [_store_out(db, s) for s in db.scalars(select(VectorStore).order_by(VectorStore.name))]


@router.post("/vector-stores", status_code=201)
def create_vector_store(body: VectorStoreIn, db: Session = Depends(get_db)) -> dict[str, Any]:
    _check_store_body(db, body)
    s = VectorStore(**body.model_dump())
    db.add(s)
    db.commit()
    return _store_out(db, s)


@router.put("/vector-stores/{store_id}")
def update_vector_store(store_id: int, body: VectorStoreIn, db: Session = Depends(get_db)) -> dict[str, Any]:
    s = get_or_404(db, VectorStore, store_id)
    _check_store_body(db, body, store_id)
    if not body.enabled and any(c.is_default for c in s.collections):
        raise HTTPException(400, "기본 컬렉션이 있는 저장소는 비활성화할 수 없습니다. 다른 컬렉션을 기본으로 지정한 뒤 바꾸세요")
    for k, v in body.model_dump().items():
        setattr(s, k, v)
    db.commit()
    return _store_out(db, s)


def _check_collection(db: Session, store: VectorStore, body: CollectionIn, collection_id: int | None = None) -> None:
    body.name = body.name.strip()
    if not body.name:
        raise HTTPException(400, "컬렉션 이름을 입력하세요")
    try:
        validate_collection_name(body.name)
    except VectorStoreError as exc:
        raise HTTPException(400, str(exc)) from exc
    dup = db.scalar(select(VectorCollection).where(VectorCollection.store_id == store.id,
                                                   VectorCollection.name == body.name,
                                                   VectorCollection.id != (collection_id or 0)))
    if dup:
        raise HTTPException(409, "이 저장소에 같은 이름의 컬렉션이 있습니다")
    if body.is_default and not store.enabled:
        raise HTTPException(400, "비활성 저장소의 컬렉션은 기본으로 지정할 수 없습니다")


def _apply_default(db: Session, c: VectorCollection, want_default: bool) -> None:
    current = default_collection(db)
    if want_default:
        for other in db.scalars(select(VectorCollection).where(VectorCollection.is_default.is_(True),
                                                               VectorCollection.id != c.id)):
            other.is_default = False
        c.is_default = True
    elif current is not None and current.id == c.id:
        raise HTTPException(400, "기본 컬렉션은 해제할 수 없습니다. 다른 컬렉션을 기본으로 지정하세요")
    else:
        c.is_default = current is None  # 기본 컬렉션이 하나도 없으면 이 컬렉션을 기본으로


@router.post("/vector-stores/{store_id}/collections", status_code=201)
def create_collection(store_id: int, body: CollectionIn, db: Session = Depends(get_db)) -> dict[str, Any]:
    store = get_or_404(db, VectorStore, store_id)
    _check_collection(db, store, body)
    c = VectorCollection(store_id=store.id, name=body.name, description=body.description, is_default=False)
    db.add(c)
    db.flush()
    _apply_default(db, c, body.is_default)
    db.commit()
    return _collection_out(db, c)


@router.put("/vector-collections/{collection_id}")
def update_collection(collection_id: int, body: CollectionIn, db: Session = Depends(get_db)) -> dict[str, Any]:
    c = get_or_404(db, VectorCollection, collection_id)
    _check_collection(db, c.store, body, c.id)
    c.name, c.description = body.name, body.description
    _apply_default(db, c, body.is_default)
    db.commit()
    return _collection_out(db, c)


@router.delete("/vector-collections/{collection_id}", status_code=204)
def delete_collection(collection_id: int, db: Session = Depends(get_db)) -> None:
    """Studio 등록만 지운다(Milvus의 실제 컬렉션·데이터는 그대로)."""
    c = get_or_404(db, VectorCollection, collection_id)
    if c.is_default:
        raise HTTPException(400, "기본 컬렉션은 삭제할 수 없습니다. 다른 컬렉션을 기본으로 지정한 뒤 삭제하세요")
    used = [p.name for p in db.scalars(select(Project).where(Project.vector_collection_id == c.id))]
    if used:
        raise HTTPException(400, f"이 컬렉션을 쓰는 프로젝트가 있습니다: {', '.join(used)}")
    db.delete(c)
    db.commit()


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
    embedding_model_id: int
    # 비우면(기본) 문서가 속한 프로젝트의 저장소·컬렉션(없으면 기본 저장소)에 '추가'로 적재한다(같은 문서는 교체).
    # 직접 지정은 API 자동화·테스트용.
    store_id: int | None = None
    collection: str | None = None
    name: str = ""
    embed_template: str = "{text}"
    metric: str = "COSINE"
    mode: str = "append"  # create | recreate | append


class AppendIn(BaseModel):
    run_id: int


class QueryIn(BaseModel):
    query: str
    top_k: int = 5
    filter: str = ""
    # None: 권한 필터 미적용(관리자 보기) / []: 공개 청크만 / ["group:인사팀", ...]: 해당 주체가 볼 수 있는 청크만
    principals: list[str] | None = None
    # 리랭크: 모델을 주면 벡터 검색 후보(rerank_candidates개, 기본 top_k×4·최소 20)를 다시 점수 매겨 top_k만 반환
    rerank_model_id: int | None = None
    rerank_candidates: int | None = None


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


def prepare_index(db: Session, *, store_id: int, embedding_model_id: int, collection: str, name: str,
                  embed_template: str, metric: str, mode: str) -> VectorIndex:
    """적재 대상 인덱스를 검증하고 준비한다(append면 같은 저장소·컬렉션의 기존 인덱스를 재사용). commit은 호출자가."""
    store = get_or_404(db, VectorStore, store_id)
    model = get_or_404(db, EmbeddingModel, embedding_model_id)
    if not store.enabled or not model.enabled:
        raise HTTPException(400, "비활성화된 저장소 또는 임베딩 모델입니다")
    if metric not in {"COSINE", "IP", "L2"}:
        raise HTTPException(400, "metric은 COSINE / IP / L2 중 하나")
    if mode not in {"create", "recreate", "append"}:
        raise HTTPException(400, "mode는 create / recreate / append 중 하나")
    try:
        validate_collection_name(collection)
    except VectorStoreError as exc:
        raise HTTPException(400, str(exc)) from exc
    ix = None
    if mode in ("append", "recreate"):  # 같은 저장소·컬렉션의 기존 인덱스 기록을 이어 쓴다
        ix = db.scalar(select(VectorIndex).where(VectorIndex.store_id == store.id,
                                                 VectorIndex.collection == collection)
                       .order_by(VectorIndex.id.desc()))
        if ix and ix.status in ("queued", "running"):
            raise HTTPException(409, "이 컬렉션에 적재가 진행 중입니다. 끝난 뒤 다시 시도하세요")
        if ix and mode == "append" and ix.embedding_model_id != model.id:
            raise HTTPException(400, "기존 컬렉션과 다른 임베딩 모델로는 추가할 수 없습니다. 다른 모델을 쓰려면 '비우고 다시 적재'를 선택하세요")
        if ix and mode == "recreate":  # 컬렉션을 새로 만들므로 기록도 초기화(모델·템플릿 변경 허용)
            ix.embedding_model_id, ix.embed_template, ix.metric = model.id, embed_template, metric
            ix.run_ids, ix.chunk_count, ix.dimension, ix.warnings, ix.stats = [], 0, None, [], {}
            if name:
                ix.name = name
    if ix is None:
        ix = VectorIndex(name=name or collection, store_id=store.id, collection=collection,
                         embedding_model_id=model.id, embed_template=embed_template, metric=metric)
        db.add(ix)
    ix.status = "queued"
    ix.error = ""
    return ix


def _index_doc_ids(db: Session, ix: VectorIndex) -> list[int]:
    if not ix.run_ids:
        return []
    return sorted(set(db.scalars(select(ChunkRun.document_id).where(ChunkRun.id.in_(ix.run_ids)))))


def existing_index_brief(db: Session, coll: VectorCollection | None) -> dict[str, Any] | None:
    """컬렉션에 이미 만들어진 인덱스(임베딩 모델을 고정하는 데 씀)."""
    if coll is None:
        return None
    ix = db.scalar(select(VectorIndex).where(VectorIndex.store_id == coll.store_id,
                                             VectorIndex.collection == coll.name)
                   .order_by(VectorIndex.id.desc()))
    if ix is None:
        return None
    model = db.get(EmbeddingModel, ix.embedding_model_id)
    return {"id": ix.id, "status": ix.status, "chunk_count": ix.chunk_count,
            "embedding_model_id": ix.embedding_model_id, "embedding_model_name": model.name if model else "",
            "embed_template": ix.embed_template, "metric": ix.metric, "document_ids": _index_doc_ids(db, ix)}


def target_for_project(db: Session, project_id: int | None, tree: dict | None = None) -> dict[str, Any]:
    """프로젝트(또는 미분류)의 적재 대상: 연결·컬렉션·출처와 그 컬렉션의 기존 인덱스."""
    tree = tree if tree is not None else load_tree(db)
    coll, source = resolve_collection(db, tree, project_id)
    return {"store": target_brief(coll), "source": source, "existing_index": existing_index_brief(db, coll)}


@router.get("/index-target")
def index_target(document_id: int | None = None, project_id: int | None = None,
                 db: Session = Depends(get_db)) -> dict[str, Any]:
    """문서(또는 프로젝트)를 적재할 저장소·컬렉션. 둘 다 없으면 미분류(기본 저장소)."""
    if document_id is not None:
        project_id = get_or_404(db, Document, document_id).project_id
    elif project_id is not None:
        get_or_404(db, Project, project_id)
    return target_for_project(db, project_id)


@router.post("/indexes", status_code=202)
def create_index(body: IndexIn, background: BackgroundTasks, db: Session = Depends(get_db)) -> dict[str, Any]:
    run = _check_run(db, body.run_id)
    replace_document = False
    if body.store_id is None:
        target = target_for_project(db, db.get(Document, run.document_id).project_id)
        if target["store"] is None:
            raise HTTPException(400, "적재할 컬렉션이 없습니다. '벡터 저장소'에서 기본 컬렉션을 지정하세요")
        store_id, collection = target["store"]["id"], target["store"]["collection"]
        mode, replace_document = "append", True
    else:
        store_id, collection, mode = body.store_id, body.collection or "", body.mode
    ix = prepare_index(db, store_id=store_id, embedding_model_id=body.embedding_model_id,
                       collection=collection, name=body.name, embed_template=body.embed_template,
                       metric=body.metric, mode=mode)
    db.commit()
    background.add_task(execute_index_job, ix.id, body.run_id, mode, replace_document=replace_document)
    return _index_out(db, ix)


@router.post("/indexes/{index_id}/append", status_code=202)
def append_run(index_id: int, body: AppendIn, background: BackgroundTasks, db: Session = Depends(get_db)) -> dict[str, Any]:
    ix = get_or_404(db, VectorIndex, index_id)
    run = _check_run(db, body.run_id)
    target = target_for_project(db, db.get(Document, run.document_id).project_id)
    store = target["store"]
    if store is not None and (store["id"] != ix.store_id or store["collection"] != ix.collection):
        raise HTTPException(400, f"이 문서는 '{store['name']}' 저장소의 '{store['collection']}' 컬렉션에 적재하도록 설정되어 있습니다")
    if ix.status in ("queued", "running"):
        raise HTTPException(409, "이 컬렉션에 적재가 진행 중입니다. 끝난 뒤 다시 시도하세요")
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
        reranker = None
        if body.rerank_model_id is not None:
            reranker = get_or_404(db, RerankModel, body.rerank_model_id)
            if body.rerank_candidates is not None and not 1 <= body.rerank_candidates <= 200:
                raise HTTPException(400, "리랭크 후보 수는 1~200 사이여야 합니다")
        top_k = max(1, min(body.top_k, 100))
        return query_index(ix, db.get(EmbeddingModel, ix.embedding_model_id), db.get(VectorStore, ix.store_id),
                           body.query, top_k, body.filter, principals, reranker,
                           body.rerank_candidates or (default_rerank_candidates(top_k) if reranker else None))
    except (EmbeddingError, VectorStoreError, RerankError) as exc:
        raise HTTPException(502, str(exc)) from exc
