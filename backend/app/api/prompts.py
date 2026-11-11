"""프롬프트 관리 API (PM-01~06)."""
from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from ..chunking import prompting
from ..chunking.engine import ChunkSettings, auto_window_budget, select_elements
from ..db import get_db
from ..models import Document, LLMModel, Prompt, PromptVersion
from ..standard import StandardDocument
from ..tokens import estimate_tokens
from . import get_or_404, row_dict

router = APIRouter(prefix="/api/prompts", tags=["prompts"])

STATUSES = ("draft", "testing", "approved", "production")


class VersionIn(BaseModel):
    system_template: str
    user_template: str
    few_shots: list[dict[str, Any]] = Field(default_factory=list)
    output_schema: dict[str, Any] = Field(default_factory=dict)
    note: str = ""


class PromptIn(BaseModel):
    name: str
    description: str = ""
    doc_types: list[str] = Field(default_factory=list)
    initial: VersionIn | None = None


class PromptMetaIn(BaseModel):
    description: str = ""
    doc_types: list[str] = Field(default_factory=list)


class StatusIn(BaseModel):
    status: str


class ForkIn(BaseModel):
    name: str


def _prompt_out(p: Prompt) -> dict[str, Any]:
    d = row_dict(p)
    d["versions"] = [row_dict(v) for v in p.versions]
    d["latest_version"] = p.versions[-1].version if p.versions else None
    prod = [v for v in p.versions if v.status == "production"]
    d["production_version_id"] = prod[-1].id if prod else None
    return d


def _next_version(db: Session, prompt_id: int) -> int:
    return (db.scalar(select(func.max(PromptVersion.version)).where(PromptVersion.prompt_id == prompt_id)) or 0) + 1


@router.get("/defaults")
def defaults() -> dict[str, Any]:
    return {"system_template": prompting.DEFAULT_SYSTEM, "user_template": prompting.DEFAULT_USER,
            "output_schema": prompting.OUTPUT_SCHEMA, "variables": prompting.TEMPLATE_VARS, "statuses": STATUSES}


@router.get("")
def list_prompts(db: Session = Depends(get_db)) -> list[dict[str, Any]]:
    return [_prompt_out(p) for p in db.scalars(select(Prompt).order_by(Prompt.name))]


@router.post("", status_code=201)
def create_prompt(body: PromptIn, db: Session = Depends(get_db)) -> dict[str, Any]:
    if db.scalar(select(Prompt).where(Prompt.name == body.name)):
        raise HTTPException(409, "같은 이름의 프롬프트가 있습니다")
    p = Prompt(name=body.name, description=body.description, doc_types=body.doc_types)
    db.add(p)
    db.flush()
    init = body.initial or VersionIn(system_template=prompting.DEFAULT_SYSTEM, user_template=prompting.DEFAULT_USER,
                                     output_schema=prompting.OUTPUT_SCHEMA, note="초기 버전")
    db.add(PromptVersion(prompt_id=p.id, version=1, **init.model_dump()))
    db.commit()
    db.refresh(p)
    return _prompt_out(p)


@router.get("/{prompt_id}")
def get_prompt(prompt_id: int, db: Session = Depends(get_db)) -> dict[str, Any]:
    return _prompt_out(get_or_404(db, Prompt, prompt_id))


@router.put("/{prompt_id}")
def update_prompt(prompt_id: int, body: PromptMetaIn, db: Session = Depends(get_db)) -> dict[str, Any]:
    p = get_or_404(db, Prompt, prompt_id)
    p.description, p.doc_types = body.description, body.doc_types
    db.commit()
    return _prompt_out(p)


@router.post("/{prompt_id}/versions", status_code=201)
def create_version(prompt_id: int, body: VersionIn, db: Session = Depends(get_db)) -> dict[str, Any]:
    """PM-04: 저장 = 새 버전 생성 (기존 버전은 불변)."""
    get_or_404(db, Prompt, prompt_id)
    v = PromptVersion(prompt_id=prompt_id, version=_next_version(db, prompt_id), **body.model_dump())
    db.add(v)
    db.commit()
    return row_dict(v)


@router.get("/versions/{version_id}")
def get_version(version_id: int, db: Session = Depends(get_db)) -> dict[str, Any]:
    v = get_or_404(db, PromptVersion, version_id)
    d = row_dict(v)
    d["prompt_name"] = v.prompt.name
    return d


@router.patch("/versions/{version_id}/status")
def set_status(version_id: int, body: StatusIn, db: Session = Depends(get_db)) -> dict[str, Any]:
    """PM-05: 상태 태그. production은 프롬프트당 1개만 유지(기존 production → approved).

    TODO(3단계): RBAC 도입 후 production 승격은 관리자만, 승격 게이트(ET-04) 통과 시에만 허용.
    """
    if body.status not in STATUSES:
        raise HTTPException(400, f"상태는 {STATUSES} 중 하나여야 합니다")
    v = get_or_404(db, PromptVersion, version_id)
    if body.status == "production":
        for other in db.scalars(select(PromptVersion).where(
            PromptVersion.prompt_id == v.prompt_id, PromptVersion.status == "production", PromptVersion.id != v.id
        )):
            other.status = "approved"
    v.status = body.status
    db.commit()
    return row_dict(v)


@router.post("/versions/{version_id}/rollback", status_code=201)
def rollback(version_id: int, db: Session = Depends(get_db)) -> dict[str, Any]:
    """PM-04: 롤백 = 과거 버전 내용을 복사한 새 버전 생성."""
    v = get_or_404(db, PromptVersion, version_id)
    nv = PromptVersion(
        prompt_id=v.prompt_id, version=_next_version(db, v.prompt_id), system_template=v.system_template,
        user_template=v.user_template, few_shots=v.few_shots, output_schema=v.output_schema,
        note=f"v{v.version}에서 롤백",
    )
    db.add(nv)
    db.commit()
    return row_dict(nv)


@router.post("/versions/{version_id}/fork", status_code=201)
def fork(version_id: int, body: ForkIn, db: Session = Depends(get_db)) -> dict[str, Any]:
    v = get_or_404(db, PromptVersion, version_id)
    if db.scalar(select(Prompt).where(Prompt.name == body.name)):
        raise HTTPException(409, "같은 이름의 프롬프트가 있습니다")
    p = Prompt(name=body.name, description=f"{v.prompt.name} v{v.version}에서 fork",
               doc_types=v.prompt.doc_types, forked_from_version_id=v.id)
    db.add(p)
    db.flush()
    db.add(PromptVersion(prompt_id=p.id, version=1, system_template=v.system_template,
                         user_template=v.user_template, few_shots=v.few_shots, output_schema=v.output_schema,
                         note=f"{v.prompt.name} v{v.version}에서 fork"))
    db.commit()
    db.refresh(p)
    return _prompt_out(p)


class PreviewIn(BaseModel):
    document_id: int
    system_template: str
    user_template: str
    few_shots: list[dict[str, Any]] = Field(default_factory=list)
    model_id: int | None = None
    settings: dict[str, Any] = Field(default_factory=dict)
    params: dict[str, Any] = Field(default_factory=dict)


@router.post("/preview")
def preview(body: PreviewIn, db: Session = Depends(get_db)) -> dict[str, Any]:
    """PG-03: LLM 호출 없이 첫 윈도우 기준 변수 치환된 최종 프롬프트 미리보기."""
    d = get_or_404(db, Document, body.document_id)
    cs = ChunkSettings.from_dict(body.settings)
    doc = StandardDocument.model_validate(d.content)
    elements, _ = select_elements(doc, cs)
    model = db.get(LLMModel, body.model_id) if body.model_id else None
    pv = PromptVersion(system_template=body.system_template, user_template=body.user_template,
                       few_shots=body.few_shots)
    budget = cs.window_tokens or auto_window_budget(model, pv, body.params)
    win, tok = [], 0
    for e in elements:
        t = estimate_tokens(prompting.render_element(e))
        if win and tok + t > budget:
            break
        win.append(e)
        tok += t
    by_id = {e.element_id: e for e in doc.elements}
    variables = {
        "elements": prompting.render_elements(win),
        "section_path": prompting.section_path(win[0], by_id) if win else "",
        "max_tokens": str(cs.max_tokens), "min_tokens": str(cs.min_tokens),
        "doc_type": cs.doc_type or d.doc_type or "미지정", "doc_title": d.title,
        "few_shots": prompting.render_few_shots(body.few_shots),
    }
    system, u1 = prompting.render_template(body.system_template, variables)
    user, u2 = prompting.render_template(body.user_template, variables)
    total = sum(estimate_tokens(prompting.render_element(e)) for e in elements)
    return {
        "system": system, "user": user, "unknown_variables": sorted(set(u1 + u2)),
        "window_budget": budget, "first_window_elements": len(win), "total_elements": len(elements),
        "estimated_windows": max(1, -(-total // budget)) if elements else 0,
        "estimated_input_tokens": estimate_tokens(system + user),
    }
