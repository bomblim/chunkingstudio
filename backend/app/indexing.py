"""청크 → 임베딩 → 벡터 저장소 적재, 질의."""
from __future__ import annotations

import time
import traceback
from typing import Any

from sqlalchemy import select

from .db import SessionLocal
from .embeddings import EmbeddingError, embed, render_embed_text
from .models import ChunkRun, Document, EmbeddingModel, RerankModel, VectorIndex, VectorStore
from .projects import effective_access, load_tree, path_names
from .reranking import render_rerank_text, rerank
from .vectorstores import VectorStoreError, clip_utf8, combine_filters, open_store, permission_expr, timed


def build_rows(
    run: ChunkRun, document: Document, index: VectorIndex, access: dict[str, Any] | None = None,
    project_path: list[str] | None = None,
) -> tuple[list[dict[str, Any]], list[str], list[str]]:
    """반환: (적재 행(벡터 제외), 임베딩 입력 텍스트, 경고).

    access: 문서가 속한 프로젝트의 effective_access 결과. 적재 시점 값이 청크에 복사되므로
    프로젝트 권한·메타데이터를 바꾸면 다시 적재해야 반영된다.
    """
    rows, inputs, warnings = [], [], []
    snap = run.snapshot or {}
    access = access or {"meta": {}, "permissions": [], "public": True}
    truncated = 0
    for c in run.chunks:
        embed_text = render_embed_text(index.embed_template, c, document.title)
        text, cut1 = clip_utf8(c.get("text") or "")
        stored_embed, cut2 = clip_utf8(embed_text)
        truncated += int(cut1 or cut2)
        rows.append({
            "id": f"r{run.id}_{c['chunk_id']}",
            "chunk_id": c["chunk_id"],
            "run_id": run.id,
            "document_id": document.id,
            "title": clip_utf8(c.get("title") or "", 2000)[0],
            "section_path": clip_utf8(c.get("section_path") or "", 4000)[0],
            "text": text,
            "embed_text": stored_embed,
            "metadata": {
                "document_title": document.title,
                "doc_type": document.doc_type,
                "element_ids": c.get("element_ids", []),
                "start_id": c.get("start_id"),
                "end_id": c.get("end_id"),
                "pages": c.get("pages", []),
                "tokens": c.get("tokens"),
                "summary": c.get("summary") or "",
                "keywords": c.get("keywords") or [],
                "source": c.get("source"),
                "method": run.method,
                "prompt_version": (snap.get("prompt") or {}).get("version"),
                "llm_model": (snap.get("model") or {}).get("name"),
                "parser": document.parser_name,
                "parser_version": document.parser_version,
                "text_truncated": cut1,
                # 프로젝트 메타데이터·권한 (질의 시 권한 필터에 사용)
                "project_id": document.project_id,
                "project_path": project_path or [],
                "project_meta": access["meta"],
                "permissions": access["permissions"],
                "public": access["public"],
            },
        })
        inputs.append(embed_text)
    if truncated:
        warnings.append(f"{truncated}개 청크가 저장 필드 한도(64KB)를 넘어 잘린 채 저장되었습니다")
    return rows, inputs, warnings


def execute_index_job(index_id: str, run_id: str, mode: str, *, replace_document: bool = False,
                      finalize: bool = True) -> str | None:
    """mode: create(없으면 생성) | recreate(삭제 후 생성) | append(기존 컬렉션에 추가, 같은 실행은 교체).

    replace_document: 같은 문서의 이전 실행 청크도 지우고 넣는다(일괄 적재에서 재청킹한 문서가 중복되지 않도록).
    finalize: False면 성공해도 상태를 running으로 둔다(일괄 적재 중간 단계).
    반환: 실패 시 오류 메시지, 성공 시 None.
    """
    db = SessionLocal()
    try:
        index = db.get(VectorIndex, index_id)
        if index is None:
            return
        run = db.get(ChunkRun, run_id)
        document = db.get(Document, run.document_id)
        model = db.get(EmbeddingModel, index.embedding_model_id)
        store_cfg = db.get(VectorStore, index.store_id)
        index.status = "running"
        index.error = ""
        index.progress = {"phase": "embedding", "done": 0, "total": len(run.chunks)}
        db.commit()

        tree = load_tree(db)
        access = effective_access(tree, document.project_id)
        rows, inputs, warnings = build_rows(run, document, index, access, path_names(tree, document.project_id))
        if not rows:
            raise ValueError("적재할 청크가 없습니다")

        def on_batch(done: int, total: int) -> None:
            index.progress = {"phase": "embedding", "done": done, "total": total}
            db.commit()

        result = embed(model, inputs, "document", on_batch)
        warnings.extend(result.warnings)
        dim = len(result.vectors[0])
        if model.dimension != dim:
            model.dimension = dim
        for row, vec in zip(rows, result.vectors, strict=True):
            row["vector"] = vec

        store = open_store(store_cfg)
        index.progress = {"phase": "inserting", "done": 0, "total": len(rows)}
        db.commit()
        started = time.monotonic()
        exists = store.has_collection(index.collection)
        if exists and mode == "recreate":
            store.drop_collection(index.collection)
            exists = False
        if exists:
            info = store.describe(index.collection)
            if info.get("legacy_int_ids"):
                raise VectorStoreError(
                    f"'{index.collection}'은(는) ID를 정수로 쓰던 이전 형식 컬렉션입니다. "
                    "'컬렉션 비우고 다시 적재'로 다시 만드세요"
                )
            if info.get("dimension") and info["dimension"] != dim:
                raise VectorStoreError(
                    f"기존 컬렉션 차원({info['dimension']})과 임베딩 차원({dim})이 다릅니다. 다른 컬렉션 이름을 쓰거나 재생성하세요"
                )
            if mode == "create" and not index.run_ids:
                raise VectorStoreError("같은 이름의 컬렉션이 이미 있습니다. '추가' 또는 '재생성'을 선택하세요")
            store.delete_by_run(index.collection, run.id)  # 같은 실행 재적재 시 중복 방지
            if replace_document:
                store.delete_by_document(index.collection, document.id)
        else:
            store.create_collection(index.collection, dim, index.metric)
        inserted = store.insert(index.collection, rows)
        insert_ms = int((time.monotonic() - started) * 1000)

        index.dimension = dim
        run_ids = set(index.run_ids or [])
        if replace_document:  # 같은 문서의 이전 실행은 컬렉션에서 지웠으므로 목록에서도 뺀다
            run_ids -= set(db.scalars(select(ChunkRun.id).where(ChunkRun.document_id == document.id)))
        index.run_ids = sorted({*run_ids, run.id})
        index.chunk_count = store.count(index.collection)
        index.warnings = warnings
        batch = (index.stats or {}).get("batch")
        index.stats = {
            "last_run_id": run.id, "inserted": inserted, "embed_ms": result.latency_ms, "insert_ms": insert_ms,
            "embed_tokens": result.prompt_tokens, **({"batch": batch} if batch else {}),
        }
        index.progress = {"phase": "done", "done": len(rows), "total": len(rows)}
        index.status = "done" if finalize else "running"
        db.commit()
        return None
    except Exception as exc:
        db.rollback()
        index = db.get(VectorIndex, index_id)
        known = isinstance(exc, (EmbeddingError, VectorStoreError, ValueError))
        message = str(exc) if known else f"{exc}\n{traceback.format_exc()[-1500:]}"
        if index:
            index.status = "failed" if finalize else "running"
            index.error = message
            db.commit()
        return message
    finally:
        db.close()


def execute_index_batch(index_id: str, items: list[dict[str, Any]], mode: str) -> None:
    """여러 문서의 청킹 실행을 한 컬렉션에 순차 적재한다.

    items: [{"run_id", "document_id", "title"}]. 첫 건은 mode(create/recreate/append)로, 이후는 append로 넣고
    문서 단위로 이전 청크를 교체한다. 첫 건이 실패하면(컬렉션 문제일 가능성이 커서) 나머지는 건너뛴다.
    """
    total = len(items)
    failed: list[dict[str, Any]] = []
    succeeded = 0
    for i, item in enumerate(items):
        _set_batch(index_id, {"total": total, "done": i, "succeeded": succeeded, "failed": failed,
                              "current": item.get("title")})
        err = execute_index_job(index_id, item["run_id"], mode if i == 0 else "append",
                                replace_document=True, finalize=False)
        if err:
            failed.append({**item, "error": err[:500]})
            if i == 0:
                failed.extend({**x, "error": "첫 문서 적재 실패로 건너뜀"} for x in items[1:])
                break
        else:
            succeeded += 1
    db = SessionLocal()
    try:
        index = db.get(VectorIndex, index_id)
        if index is None:
            return
        index.stats = {**(index.stats or {}), "batch": {"total": total, "done": total, "succeeded": succeeded,
                                                         "failed": failed, "current": None}}
        if succeeded:
            index.status = "done"
            index.error = ""
            if failed:
                names = ", ".join(f"{f.get('title')}({f['error'][:80]})" for f in failed[:5])
                index.warnings = [*(index.warnings or []),
                                  f"{len(failed)}개 문서 적재 실패: {names}{' …' if len(failed) > 5 else ''}"]
        else:
            index.status = "failed"
            index.error = failed[0]["error"] if failed else "적재할 문서가 없습니다"
        db.commit()
    finally:
        db.close()


def _set_batch(index_id: str, batch: dict[str, Any]) -> None:
    db = SessionLocal()
    try:
        index = db.get(VectorIndex, index_id)
        if index is not None:
            index.stats = {**(index.stats or {}), "batch": batch}
            index.status = "running"
            db.commit()
    finally:
        db.close()


def default_rerank_candidates(top_k: int) -> int:
    return min(200, max(20, top_k * 4))


def query_index(index: VectorIndex, model: EmbeddingModel, store_cfg: VectorStore, query: str, top_k: int,
                filter: str = "", principals: list[str] | None = None, reranker: RerankModel | None = None,
                rerank_candidates: int | None = None) -> dict[str, Any]:
    """principals: None이면 권한 필터 없음(관리자 보기), 목록이면 그 주체가 볼 수 있는 청크만.

    reranker를 주면 벡터 검색으로 후보(rerank_candidates개, 기본 top_k×4·최소 20)를 가져와
    리랭크 점수로 다시 정렬한 뒤 top_k만 돌려준다. 각 결과에 vector_rank(리랭크 전 순위)를 남긴다.
    """
    q = embed(model, [query], "query")
    store = open_store(store_cfg)
    fetch = top_k
    if reranker is not None:
        fetch = max(top_k, min(200, rerank_candidates or default_rerank_candidates(top_k)))
    hits, search_ms = timed(store.search, index.collection, q.vectors[0], fetch, filter, principals)
    rows = [{"id": h.id, "score": h.score, "vector_rank": i + 1, **h.fields} for i, h in enumerate(hits)]
    warnings = list(q.warnings)
    rerank_info = None
    if reranker is not None:
        docs = [render_rerank_text(reranker.document_template, r) for r in rows]
        rr = rerank(reranker, query, docs) if docs else None
        if rr is not None:
            for r, s in zip(rows, rr.scores, strict=True):
                r["rerank_score"] = s
            rows.sort(key=lambda r: r["rerank_score"], reverse=True)
            warnings.extend(rr.warnings)
        rerank_info = {"model_id": reranker.id, "model_name": reranker.name, "candidates": len(docs),
                       "latency_ms": rr.latency_ms if rr else 0}
    return {
        "query": query,
        "embed_ms": q.latency_ms,
        "search_ms": search_ms,
        "metric": index.metric,
        "warnings": warnings,
        "principals": principals,
        "applied_filter": combine_filters(filter, permission_expr(principals)) if store_cfg.kind == "milvus" else None,
        "rerank": rerank_info,
        "hits": rows[:top_k],
    }
