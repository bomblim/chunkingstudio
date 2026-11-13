"""프로젝트(문서 분류 트리) API."""
from __future__ import annotations

from typing import Any

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from ..db import get_db
from ..indexing import execute_index_batch
from ..models import ChunkRun, Document, LLMModel, Project, Prompt, VectorStore
from ..projects import (
    default_vector_store, descendant_ids, effective_access, effective_profile, load_tree, path_names,
    resolve_prompt_version, resolve_vector_store, store_brief,
    validate_meta, validate_principal, would_cycle,
)
from ..services import execute_run
from . import get_or_404, row_dict
from .runs import create_run
from .vectors import _index_out, existing_index_brief, prepare_index

router = APIRouter(prefix="/api/projects", tags=["projects"])


class ProjectIn(BaseModel):
    name: str
    description: str = ""
    parent_id: int | None = None
    sort_order: int = 0
    # 청킹 프로파일: None이면 상위 프로젝트에서 상속
    method: str | None = None
    prompt_id: int | None = None
    prompt_version_id: int | None = None
    model_id: int | None = None
    params: dict[str, Any] | None = None
    settings: dict[str, Any] | None = None
    doc_type: str | None = None
    vector_store_id: int | None = None  # 적재할 벡터 저장소(컬렉션). None이면 상위 상속, 없으면 기본 저장소
    # 메타데이터·권한
    meta: dict[str, Any] | None = None
    permissions: list[str] | None = None
    permission_mode: str | None = None  # inherit | override


class RunAllIn(BaseModel):
    include_descendants: bool = True
    only_without_run: bool = False  # 완료된 실행이 없는 문서만


def _validate(db: Session, body: ProjectIn, project_id: int | None = None) -> None:
    if not body.name.strip():
        raise HTTPException(400, "프로젝트 이름을 입력하세요")
    if body.method not in (None, "llm", "rule_structure"):
        raise HTTPException(400, "method는 llm / rule_structure 중 하나")
    tree = load_tree(db)
    if body.parent_id is not None and body.parent_id not in tree:
        raise HTTPException(404, f"상위 프로젝트 {body.parent_id}가 없습니다")
    if project_id is not None and would_cycle(tree, project_id, body.parent_id):
        raise HTTPException(400, "자기 자신이나 하위 프로젝트 아래로는 옮길 수 없습니다")
    siblings = [p for p in tree.values() if p.parent_id == body.parent_id and p.id != project_id]
    if any(p.name == body.name.strip() for p in siblings):
        raise HTTPException(409, "같은 위치에 같은 이름의 프로젝트가 있습니다")
    if body.prompt_id is not None:
        prompt = get_or_404(db, Prompt, body.prompt_id)
        if body.prompt_version_id is not None and body.prompt_version_id not in {v.id for v in prompt.versions}:
            raise HTTPException(400, "선택한 버전이 해당 프롬프트의 버전이 아닙니다")
    elif body.prompt_version_id is not None:
        raise HTTPException(400, "프롬프트 버전을 고정하려면 프롬프트도 지정해야 합니다")
    if body.model_id is not None:
        get_or_404(db, LLMModel, body.model_id)
    if body.vector_store_id is not None:
        get_or_404(db, VectorStore, body.vector_store_id)
    if body.permission_mode not in (None, "inherit", "override"):
        raise HTTPException(400, "permission_mode는 inherit / override 중 하나")
    try:
        if body.meta is not None:
            body.meta = validate_meta(body.meta) or None
        if body.permissions is not None:
            body.permissions = sorted({validate_principal(x) for x in body.permissions if x.strip()})
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc


def _describe(db: Session, tree: dict[int, Project], p: Project, counts: dict[int | None, int]) -> dict[str, Any]:
    d = row_dict(p)
    d["path"] = path_names(tree, p.id)
    d["doc_count"] = counts.get(p.id, 0)
    d["total_doc_count"] = sum(counts.get(i, 0) for i in descendant_ids(tree, p.id))
    eff = effective_profile(tree, p.id)
    pv = resolve_prompt_version(db, eff["prompt_id"], eff["prompt_version_id"])
    eff["resolved_prompt_version_id"] = pv.id if pv else None
    eff["resolved_prompt_label"] = f"{pv.prompt.name} v{pv.version}" if pv else None
    model = db.get(LLMModel, eff["model_id"]) if eff["model_id"] else None
    eff["model_name"] = model.name if model else None
    eff["source_names"] = {f: tree[pid].name for f, pid in eff["sources"].items() if pid in tree}
    store, source = resolve_vector_store(db, tree, p.id)
    eff["vector_store"] = store_brief(store)
    eff["vector_store_source"] = source
    d["effective"] = eff
    acc = effective_access(tree, p.id)
    acc["meta_source_names"] = {k: tree[pid].name for k, pid in acc["meta_sources"].items() if pid in tree}
    acc["permission_source_names"] = {k: tree[pid].name for k, pid in acc["permission_sources"].items() if pid in tree}
    d["access"] = acc
    return d


def _doc_counts(db: Session) -> dict[int | None, int]:
    return dict(db.execute(select(Document.project_id, func.count()).group_by(Document.project_id)).all())


@router.get("")
def list_projects(db: Session = Depends(get_db)) -> dict[str, Any]:
    """트리 전체를 평탄한 목록으로 반환한다(parent_id로 조립). 미분류 문서 수도 함께."""
    tree = load_tree(db)
    counts = _doc_counts(db)
    items = [_describe(db, tree, p, counts) for p in sorted(tree.values(), key=lambda x: (x.sort_order, x.name))]
    return {"projects": items, "unassigned_count": counts.get(None, 0), "total_count": sum(counts.values())}


@router.post("", status_code=201)
def create_project(body: ProjectIn, db: Session = Depends(get_db)) -> dict[str, Any]:
    _validate(db, body)
    p = Project(**{**body.model_dump(), "name": body.name.strip()})
    db.add(p)
    db.commit()
    return _describe(db, load_tree(db), p, _doc_counts(db))


@router.get("/{project_id}")
def get_project(project_id: int, db: Session = Depends(get_db)) -> dict[str, Any]:
    p = get_or_404(db, Project, project_id)
    return _describe(db, load_tree(db), p, _doc_counts(db))


@router.put("/{project_id}")
def update_project(project_id: int, body: ProjectIn, db: Session = Depends(get_db)) -> dict[str, Any]:
    p = get_or_404(db, Project, project_id)
    _validate(db, body, project_id)
    for k, v in body.model_dump().items():
        setattr(p, k, v.strip() if k == "name" else v)
    db.commit()
    return _describe(db, load_tree(db), p, _doc_counts(db))


@router.delete("/{project_id}", status_code=204)
def delete_project(project_id: int, move_to_parent: bool = False, db: Session = Depends(get_db)) -> None:
    """하위 프로젝트나 문서가 있으면 move_to_parent=true일 때만 삭제(상위로 옮김). 문서는 삭제하지 않는다."""
    p = get_or_404(db, Project, project_id)
    children = list(db.scalars(select(Project).where(Project.parent_id == p.id)))
    docs = list(db.scalars(select(Document).where(Document.project_id == p.id)))
    if (children or docs) and not move_to_parent:
        raise HTTPException(409, f"하위 프로젝트 {len(children)}개, 문서 {len(docs)}개가 있습니다. 상위로 옮기고 삭제하려면 move_to_parent=true")
    for c in children:
        c.parent_id = p.parent_id
    for d in docs:
        d.project_id = p.parent_id
    db.delete(p)
    db.commit()


@router.post("/{project_id}/run-all", status_code=202)
def run_all(project_id: int, body: RunAllIn, background: BackgroundTasks, db: Session = Depends(get_db)) -> dict[str, Any]:
    """프로젝트의 청킹 프로파일로 소속 문서를 일괄 청킹한다(순차 실행)."""
    p = get_or_404(db, Project, project_id)
    tree = load_tree(db)
    eff = effective_profile(tree, p.id)
    method = eff["method"] or ("llm" if eff["prompt_id"] and eff["model_id"] else None)
    if method is None:
        raise HTTPException(400, "프로젝트(또는 상위)에 청킹 방식이 설정되지 않았습니다")
    pv = resolve_prompt_version(db, eff["prompt_id"], eff["prompt_version_id"]) if method == "llm" else None
    if method == "llm" and (pv is None or not eff["model_id"]):
        raise HTTPException(400, "LLM 청킹에는 프롬프트와 모델이 설정되어야 합니다 (상위 프로젝트 포함)")
    ids = descendant_ids(tree, p.id) if body.include_descendants else {p.id}
    docs = list(db.scalars(select(Document).where(Document.project_id.in_(ids)).order_by(Document.id)))
    if body.only_without_run:
        done = set(db.scalars(select(ChunkRun.document_id).where(ChunkRun.status == "done")))
        docs = [d for d in docs if d.id not in done]
    if not docs:
        raise HTTPException(400, "청킹할 문서가 없습니다")
    settings = {**({"doc_type": eff["doc_type"]} if eff["doc_type"] else {}), **(eff["settings"] or {})}
    extra = {"project": {"id": p.id, "path": path_names(tree, p.id), "profile_sources": eff["sources"]}}
    runs = [create_run(db, d, method, pv.id if pv else None, eff["model_id"], eff["params"] or {}, settings, extra)
            for d in docs]
    background.add_task(_execute_sequential, [r.id for r in runs])
    return {"run_ids": [r.id for r in runs], "document_count": len(docs), "method": method,
            "prompt_version_id": pv.id if pv else None, "model_id": eff["model_id"]}


def _execute_sequential(run_ids: list[int]) -> None:
    for rid in run_ids:  # LLM 서버 부하를 줄이기 위해 한 건씩
        execute_run(rid)


# ------------------------------------------------------------------ 일괄 적재 (벡터 DB)
class IndexAllIn(BaseModel):
    """적재 위치는 문서가 속한 프로젝트의 벡터 저장소(컬렉션)로 정해진다(없으면 기본 저장소)."""
    embedding_model_id: int
    embed_template: str = "{text}"
    metric: str = "COSINE"
    mode: str = "append"  # append(같은 문서는 교체) | recreate(컬렉션을 비우고 다시 적재)
    include_descendants: bool = True


def _index_plan(db: Session, project: Project, include_descendants: bool) -> dict[str, Any]:
    """프로젝트 문서마다 '가장 최근에 성공한(완료·청크 있음) 청킹 실행'과 적재할 저장소를 고른다.

    groups: 저장소(컬렉션)별 묶음. others_in_collection은 이 일괄 적재에 포함되지 않지만 같은 컬렉션에
    이미 들어 있는 문서로, '비우고 다시 적재'를 고르면 함께 지워진다.
    """
    tree = load_tree(db)
    default = default_vector_store(db)
    ids = descendant_ids(tree, project.id) if include_descendants else {project.id}
    docs = list(db.scalars(select(Document).where(Document.project_id.in_(ids)).order_by(Document.id)))
    rows = db.execute(
        select(ChunkRun.id, ChunkRun.document_id, ChunkRun.status, ChunkRun.method, ChunkRun.totals, ChunkRun.created_at)
        .where(ChunkRun.document_id.in_([d.id for d in docs])).order_by(ChunkRun.id)
    ).all() if docs else []
    latest_ok: dict[int, Any] = {}
    latest_any: dict[int, Any] = {}
    for r in rows:
        latest_any[r.document_id] = r
        if r.status == "done" and (r.totals or {}).get("chunk_count"):
            latest_ok[r.document_id] = r
    targets: dict[int, tuple[Any, dict[str, Any]]] = {}
    items, skipped = [], []
    for d in docs:
        if d.project_id not in targets:
            targets[d.project_id] = resolve_vector_store(db, tree, d.project_id, default)
        store, source = targets[d.project_id]
        ok, last = latest_ok.get(d.id), latest_any.get(d.id)
        if ok is None:
            reason = "청킹 실행 없음" if last is None else f"성공한 청킹 없음 (최근 #{last.id} {last.status})"
            skipped.append({"document_id": d.id, "title": d.title, "reason": reason})
            continue
        if store is None:
            skipped.append({"document_id": d.id, "title": d.title, "reason": "적재할 벡터 저장소 없음 (기본 저장소 미지정)"})
            continue
        if not store.enabled:
            skipped.append({"document_id": d.id, "title": d.title, "reason": f"저장소 '{store.name}' 비활성"})
            continue
        note = f"더 최근 실행 #{last.id}은(는) {last.status}" if last is not None and last.id != ok.id else ""
        items.append({"document_id": d.id, "title": d.title, "run_id": ok.id, "method": ok.method,
                      "chunk_count": (ok.totals or {}).get("chunk_count"), "created_at": ok.created_at,
                      "project_path": path_names(tree, d.project_id), "note": note, "store_id": store.id,
                      "store_source": source["kind"]})
    batch_doc_ids = {i["document_id"] for i in items}
    groups = []
    for sid in dict.fromkeys(i["store_id"] for i in items):
        store = db.get(VectorStore, sid)
        mine = [i for i in items if i["store_id"] == sid]
        existing = existing_index_brief(db, store)
        others = [x for x in (existing or {}).get("document_ids", []) if x not in batch_doc_ids]
        other_titles = [t for t in db.scalars(select(Document.title).where(Document.id.in_(others[:5])))] if others else []
        groups.append({"store": store_brief(store), "document_count": len(mine),
                       "chunk_count": sum(i["chunk_count"] or 0 for i in mine),
                       "via_default": any(i["store_source"] == "default" for i in mine),
                       "existing_index": existing, "others_in_collection": len(others),
                       "other_titles": other_titles})
    return {"items": items, "skipped": skipped, "groups": groups}


@router.get("/{project_id}/index-plan")
def index_plan(project_id: int, include_descendants: bool = True, db: Session = Depends(get_db)) -> dict[str, Any]:
    return _index_plan(db, get_or_404(db, Project, project_id), include_descendants)


@router.post("/{project_id}/index-all", status_code=202)
def index_all(project_id: int, body: IndexAllIn, background: BackgroundTasks,
              db: Session = Depends(get_db)) -> dict[str, Any]:
    """프로젝트 문서의 최근 성공 청킹 결과를 각 문서의 프로젝트 저장소(컬렉션)에 일괄 적재한다(순차, 문서 단위 교체)."""
    p = get_or_404(db, Project, project_id)
    if body.mode not in ("append", "recreate"):
        raise HTTPException(400, "mode는 append / recreate 중 하나")
    plan = _index_plan(db, p, body.include_descendants)
    if not plan["items"]:
        raise HTTPException(400, "적재할 문서가 없습니다 (성공한 청킹 실행이 있는 문서가 없음)")
    jobs = []
    for g in plan["groups"]:  # 모든 묶음을 먼저 검증한 뒤 한꺼번에 시작한다
        store = g["store"]
        ix = prepare_index(db, store_id=store["id"], embedding_model_id=body.embedding_model_id,
                           collection=store["collection"], name=store["name"], embed_template=body.embed_template,
                           metric=body.metric, mode=body.mode)
        mine = [i for i in plan["items"] if i["store_id"] == store["id"]]
        ix.stats = {**(ix.stats or {}), "batch": {"total": len(mine), "done": 0, "succeeded": 0, "failed": [],
                                                  "current": None}}
        jobs.append((ix, [{"run_id": i["run_id"], "document_id": i["document_id"], "title": i["title"]} for i in mine]))
    db.commit()
    background.add_task(_index_groups, [(ix.id, items) for ix, items in jobs], body.mode)
    return {"indexes": [_index_out(db, ix) for ix, _ in jobs], "document_count": len(plan["items"]),
            "skipped": plan["skipped"]}


def _index_groups(jobs: list[tuple[int, list[dict[str, Any]]]], mode: str) -> None:
    for index_id, items in jobs:  # 임베딩 서버 부하를 줄이기 위해 저장소 묶음도 차례로
        execute_index_batch(index_id, items, mode)
