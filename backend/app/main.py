"""Chunking Studio API 서버."""
from __future__ import annotations

from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from .api import dev, documents, external, llm_models, parsers, projects, prompts, runs, vectors
from .config import settings
from .db import Base, SessionLocal, add_missing_columns, engine
from .migrate_uuid import migrate_int_ids_to_uuid


@asynccontextmanager
async def lifespan(app: FastAPI):
    migrate_int_ids_to_uuid(engine)  # 정수 ID DB면 한 번 변환(백업 후)
    Base.metadata.create_all(engine)
    add_missing_columns()
    if settings.seed:
        from .seed import seed

        with SessionLocal() as db:
            seed(db)
    yield


app = FastAPI(title="Chunking Studio API", version="0.1.0", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware, allow_origins=settings.cors_origins, allow_credentials=True, allow_methods=["*"],
    allow_headers=["*"],
)
for r in (parsers.router, documents.router, llm_models.router, prompts.router, runs.router, vectors.router, projects.router,
          external.keys_router, external.v1):
    app.include_router(r)
if settings.enable_sample_parser:
    app.include_router(dev.router)


@app.get("/api/health")
def health() -> dict[str, object]:
    return {"ok": True, "allow_external_llm": settings.allow_external_llm, "studio_url": settings.studio_url}


# ---------------------------------------------------------------- 프론트엔드 정적 파일 (컨테이너 배포용)
# CS_STATIC_DIR에 빌드된 프론트(frontend/dist)가 있으면 같은 서버에서 화면도 제공한다.
# /api 이외의 경로는 index.html을 돌려줘 클라이언트 라우팅(/documents 등)을 지원한다.
if settings.static_dir and (settings.static_dir / "index.html").is_file():
    from fastapi import HTTPException
    from fastapi.responses import FileResponse

    _static_root = settings.static_dir.resolve()

    @app.get("/{path:path}", include_in_schema=False)
    def spa(path: str) -> FileResponse:
        if path.startswith("api/") or path == "api":
            raise HTTPException(404, "Not Found")
        target = (_static_root / path).resolve()
        if path and target.is_file() and target.is_relative_to(_static_root):
            return FileResponse(target)
        return FileResponse(_static_root / "index.html", headers={"Cache-Control": "no-cache"})
