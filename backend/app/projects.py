"""프로젝트 트리와 청킹 프로파일 상속."""
from __future__ import annotations

import re
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from .models import Project, Prompt, PromptVersion

PROFILE_FIELDS = ("method", "prompt_id", "prompt_version_id", "model_id", "params", "settings", "doc_type")


def load_tree(db: Session) -> dict[int, Project]:
    return {p.id: p for p in db.scalars(select(Project))}


def ancestors(tree: dict[int, Project], project_id: int | None) -> list[Project]:
    """자기 자신부터 루트까지 (순환 방지)."""
    chain: list[Project] = []
    seen: set[int] = set()
    cur = tree.get(project_id) if project_id else None
    while cur is not None and cur.id not in seen:
        chain.append(cur)
        seen.add(cur.id)
        cur = tree.get(cur.parent_id) if cur.parent_id else None
    return chain


def descendant_ids(tree: dict[int, Project], project_id: int) -> set[int]:
    """자기 자신 포함 하위 전체."""
    children: dict[int | None, list[int]] = {}
    for p in tree.values():
        children.setdefault(p.parent_id, []).append(p.id)
    out: set[int] = set()
    stack = [project_id]
    while stack:
        pid = stack.pop()
        if pid in out:
            continue
        out.add(pid)
        stack.extend(children.get(pid, []))
    return out


def would_cycle(tree: dict[int, Project], project_id: int, new_parent_id: int | None) -> bool:
    if new_parent_id is None:
        return False
    return new_parent_id in descendant_ids(tree, project_id)


def path_names(tree: dict[int, Project], project_id: int | None) -> list[str]:
    return [p.name for p in reversed(ancestors(tree, project_id))]


def effective_profile(tree: dict[int, Project], project_id: int | None) -> dict[str, Any]:
    """필드마다 가장 가까운 상위에서 값을 찾는다. sources: 필드 → 값을 준 프로젝트 id."""
    profile: dict[str, Any] = {f: None for f in PROFILE_FIELDS}
    sources: dict[str, int] = {}
    for p in ancestors(tree, project_id):
        for f in PROFILE_FIELDS:
            if f == "prompt_version_id":
                continue  # 프롬프트와 버전은 한 쌍으로 같은 프로젝트에서 가져온다
            if profile[f] is None and getattr(p, f) is not None:
                profile[f] = getattr(p, f)
                sources[f] = p.id
                if f == "prompt_id":
                    profile["prompt_version_id"] = p.prompt_version_id
                    if p.prompt_version_id is not None:
                        sources["prompt_version_id"] = p.id
    profile["sources"] = sources
    return profile


def resolve_prompt_version(db: Session, prompt_id: int | None, prompt_version_id: int | None) -> PromptVersion | None:
    """고정 버전 → 운영(production) 버전 → 최신 버전 순."""
    if prompt_version_id:
        pv = db.get(PromptVersion, prompt_version_id)
        if pv is not None:
            return pv
    if not prompt_id:
        return None
    prompt = db.get(Prompt, prompt_id)
    if prompt is None or not prompt.versions:
        return None
    prod = [v for v in prompt.versions if v.status == "production"]
    return prod[-1] if prod else prompt.versions[-1]


# ------------------------------------------------------------------ 메타데이터·권한
_PRINCIPAL_RE = re.compile(r"^[^\s\"'\\[\],]{1,200}$")
META_KEY_RE = re.compile(r"^[^\s\"'\\[\]]{1,100}$")


def validate_principal(p: str) -> str:
    """주체 문자열 검증. 벡터 DB 필터식에 들어가므로 따옴표·대괄호·공백·쉼표·역슬래시를 허용하지 않는다."""
    p = p.strip()
    if not _PRINCIPAL_RE.match(p):
        raise ValueError(f"권한 주체 형식이 올바르지 않습니다: {p!r} (공백·따옴표·쉼표·대괄호·역슬래시 불가)")
    return p


def validate_meta(meta: dict[str, Any]) -> dict[str, Any]:
    out: dict[str, Any] = {}
    for k, v in meta.items():
        k = str(k).strip()
        if not META_KEY_RE.match(k):
            raise ValueError(f"메타데이터 키 형식이 올바르지 않습니다: {k!r} (공백·따옴표·대괄호·역슬래시 불가)")
        if not isinstance(v, (str, int, float, bool)) and v is not None and not (
            isinstance(v, list) and all(isinstance(x, (str, int, float, bool)) for x in v)
        ):
            raise ValueError(f"메타데이터 '{k}' 값은 문자열·숫자·불리언 또는 그 목록이어야 합니다")
        out[k] = v
    return out


def effective_access(tree: dict[int, Project], project_id: int | None) -> dict[str, Any]:
    """루트 → 자신 순서로 메타데이터를 병합하고 권한을 계산한다.

    반환: meta, meta_sources(키 → 프로젝트 id), permissions(정렬), permission_sources(주체 → 프로젝트 id),
         public(권한 목록이 비어 제한 없음)
    """
    chain = list(reversed(ancestors(tree, project_id)))
    meta: dict[str, Any] = {}
    meta_sources: dict[str, int] = {}
    perms: dict[str, int] = {}
    for p in chain:
        for k, v in (p.meta or {}).items():
            meta[k] = v
            meta_sources[k] = p.id
        own = p.permissions or []
        if p.permission_mode == "override":
            perms = {x: p.id for x in own}
        else:
            for x in own:
                perms.setdefault(x, p.id)
    return {
        "meta": meta,
        "meta_sources": meta_sources,
        "permissions": sorted(perms),
        "permission_sources": perms,
        "public": not perms,
    }
