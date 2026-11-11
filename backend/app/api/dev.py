"""개발용 샘플 Parser API.

Studio가 외부 Parser를 호출하는 것과 같은 규약(PR-02 테스트 호출)으로 동작한다.
CS_ENABLE_SAMPLE_PARSER=false로 끌 수 있다.
"""
from __future__ import annotations

from typing import Any

from fastapi import APIRouter, File, Form, HTTPException, UploadFile

from .. import sample_parser

router = APIRouter(prefix="/api/dev/sample-parser", tags=["dev"])


@router.post("/parse")
async def parse(file: UploadFile = File(...), params: str = Form("{}")) -> dict[str, Any]:
    data = await file.read()
    try:
        doc = sample_parser.parse_bytes(file.filename or "upload.txt", data)
    except ValueError as exc:
        raise HTTPException(415, str(exc)) from exc
    return doc.model_dump(mode="json")
