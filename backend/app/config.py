"""환경변수 기반 설정."""
from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path


BACKEND_DIR = Path(__file__).resolve().parents[1]


def load_env_file(path: Path) -> list[str]:
    """`KEY=VALUE` 형식의 .env 파일을 읽어 os.environ에 넣는다.

    이미 설정된 환경변수는 덮어쓰지 않는다(셸·OS 설정이 우선). 반환: 새로 설정한 키 목록.
    """
    if not path.is_file():
        return []
    loaded: list[str] = []
    for raw in path.read_text(encoding="utf-8-sig").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        if line.startswith("export "):
            line = line[len("export "):].lstrip()
        key, _, value = line.partition("=")
        key, value = key.strip(), value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in {'"', "'"}:
            value = value[1:-1]
        elif " #" in value:  # 따옴표 없는 값의 줄 끝 주석 제거
            value = value.split(" #", 1)[0].rstrip()
        if key and key not in os.environ:
            os.environ[key] = value
            loaded.append(key)
    return loaded


# CS_ENV_FILE로 경로 지정 가능, 빈 문자열이면 로드하지 않음 (기본: backend/.env)
_env_file = os.environ.get("CS_ENV_FILE", str(BACKEND_DIR / ".env"))
if _env_file:
    load_env_file(Path(_env_file))


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
