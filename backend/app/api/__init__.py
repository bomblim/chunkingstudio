from __future__ import annotations

from typing import Any

from fastapi import HTTPException
from sqlalchemy.orm import Session


def row_dict(row: Any, exclude: set[str] | None = None) -> dict[str, Any]:
    exclude = exclude or set()
    return {c.name: getattr(row, c.name) for c in row.__table__.columns if c.name not in exclude}


def get_or_404(db: Session, model: type, obj_id: str) -> Any:
    obj = db.get(model, obj_id)
    if obj is None:
        raise HTTPException(404, f"{model.__name__} {obj_id}을(를) 찾을 수 없습니다")
    return obj
