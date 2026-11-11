"""청크 → 임베딩 → 벡터 저장소 적재, 질의."""
from __future__ import annotations

import time
import traceback
from typing import Any

from .db import SessionLocal
from .embeddings import EmbeddingError, embed, render_embed_text
from .models import ChunkRun, Document, EmbeddingModel, VectorIndex, VectorStore
from .vectorstores import VectorStoreError, clip_utf8, open_store, timed


def build_rows(run: ChunkRun, document: Document, index: VectorIndex) -> tuple[list[dict[str, Any]], list[str], list[str]]:
    """반환: (적재 행(벡터 제외), 임베딩 입력 텍스트, 경고)."""
    rows, inputs, warnings = [], [], []
    snap = run.snapshot or {}
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
            },
        })
        inputs.append(embed_text)
    if truncated:
        warnings.append(f"{truncated}개 청크가 저장 필드 한도(64KB)를 넘어 잘린 채 저장되었습니다")
    return rows, inputs, warnings


def execute_index_job(index_id: int, run_id: int, mode: str) -> None:
    """mode: create(없으면 생성) | recreate(삭제 후 생성) | append(기존 컬렉션에 추가, 같은 실행은 교체)."""
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

        rows, inputs, warnings = build_rows(run, document, index)
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
            if info.get("dimension") and info["dimension"] != dim:
                raise VectorStoreError(
                    f"기존 컬렉션 차원({info['dimension']})과 임베딩 차원({dim})이 다릅니다. 다른 컬렉션 이름을 쓰거나 재생성하세요"
                )
            if mode == "create" and not index.run_ids:
                raise VectorStoreError("같은 이름의 컬렉션이 이미 있습니다. '추가' 또는 '재생성'을 선택하세요")
            store.delete_by_run(index.collection, run.id)  # 같은 실행 재적재 시 중복 방지
        else:
            store.create_collection(index.collection, dim, index.metric)
        inserted = store.insert(index.collection, rows)
        insert_ms = int((time.monotonic() - started) * 1000)

        index.dimension = dim
        index.run_ids = sorted({*(index.run_ids or []), run.id})
        index.chunk_count = store.count(index.collection)
        index.warnings = warnings
        index.stats = {
            "last_run_id": run.id, "inserted": inserted, "embed_ms": result.latency_ms, "insert_ms": insert_ms,
            "embed_tokens": result.prompt_tokens,
        }
        index.progress = {"phase": "done", "done": len(rows), "total": len(rows)}
        index.status = "done"
        db.commit()
    except Exception as exc:
        db.rollback()
        index = db.get(VectorIndex, index_id)
        if index:
            index.status = "failed"
            known = isinstance(exc, (EmbeddingError, VectorStoreError, ValueError))
            index.error = str(exc) if known else f"{exc}\n{traceback.format_exc()[-1500:]}"
            db.commit()
    finally:
        db.close()


def query_index(index: VectorIndex, model: EmbeddingModel, store_cfg: VectorStore, query: str, top_k: int,
                filter: str = "") -> dict[str, Any]:
    q = embed(model, [query], "query")
    store = open_store(store_cfg)
    hits, search_ms = timed(store.search, index.collection, q.vectors[0], top_k, filter)
    return {
        "query": query,
        "embed_ms": q.latency_ms,
        "search_ms": search_ms,
        "metric": index.metric,
        "warnings": q.warnings,
        "hits": [{"id": h.id, "score": h.score, **h.fields} for h in hits],
    }
