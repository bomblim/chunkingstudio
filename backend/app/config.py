"""환경변수 기반 설정."""
from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path


def _bool(name: str, default: bool) -> bool:
    value = os.environ.get(name)
    if value is None:
        return default
    return value.strip().lower() in {"1", "true", "yes", "on"}


@dataclass(frozen=True)
class Settings:
    data_dir: Path = field(default_factory=lambda: Path(os.environ.get("CS_DATA_DIR", "./data")).resolve())
    database_url: str = field(default_factory=lambda: os.environ.get("CS_DATABASE_URL", ""))
    # 폐쇄망 모드(MS-10): false면 외부(상용) LLM을 숨기고 호출도 거부
    allow_external_llm: bool = field(default_factory=lambda: _bool("CS_ALLOW_EXTERNAL_LLM", True))
    cors_origins: list[str] = field(
        default_factory=lambda: os.environ.get("CS_CORS_ORIGINS", "http://localhost:5173").split(",")
    )
    # 개발용 샘플 Parser API(/api/dev/sample-parser) 노출 여부
    enable_sample_parser: bool = field(default_factory=lambda: _bool("CS_ENABLE_SAMPLE_PARSER", True))
    # 기본 데이터(샘플 Parser/모델/프롬프트/문서) 시드 여부
    seed: bool = field(default_factory=lambda: _bool("CS_SEED", True))
    public_base_url: str = field(default_factory=lambda: os.environ.get("CS_PUBLIC_BASE_URL", "http://127.0.0.1:8000"))

    @property
    def db_url(self) -> str:
        if self.database_url:
            return self.database_url
        return f"sqlite:///{(self.data_dir / 'studio.db').as_posix()}"

    @property
    def files_dir(self) -> Path:
        return self.data_dir / "files"


settings = Settings()
