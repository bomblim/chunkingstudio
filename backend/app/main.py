"""Chunking Studio API 서버."""
from __future__ import annotations

from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from .api import dev, documents, llm_models, parsers, prompts, runs, vectors
from .config import settings
from .db import Base, SessionLocal, add_missing_columns, engine


@asynccontextmanager
async def lifespan(app: FastAPI):
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
for r in (parsers.router, documents.router, llm_models.router, prompts.router, runs.router, vectors.router):
    app.include_router(r)
if settings.enable_sample_parser:
    app.include_router(dev.router)


@app.get("/api/health")
def health() -> dict[str, object]:
    return {"ok": True, "allow_external_llm": settings.allow_external_llm}
