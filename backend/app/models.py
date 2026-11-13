"""ORM 모델."""
from __future__ import annotations

from datetime import UTC, datetime
from typing import Any

from sqlalchemy import JSON, Boolean, DateTime, Float, ForeignKey, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column, relationship

from .db import Base


def utcnow() -> datetime:
    return datetime.now(UTC)


class TimestampMixin:
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, onupdate=utcnow)


# ---------------------------------------------------------------- Parser Registry
class Parser(TimestampMixin, Base):
    __tablename__ = "parsers"

    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(200), unique=True)
    description: Mapped[str] = mapped_column(Text, default="")
    version: Mapped[str] = mapped_column(String(50), default="1.0")
    owner: Mapped[str] = mapped_column(String(200), default="")
    input_formats: Mapped[list[str]] = mapped_column(JSON, default=list)
    # 출력 어댑터: Parser 원본 출력 → 표준 스키마 (adapters 레지스트리 이름)
    adapter: Mapped[str] = mapped_column(String(100), default="standard")
    adapter_config: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    # 설정 파라미터 스키마(PR-03): [{name, type, default, description, options?}]
    param_schema: Mapped[list[dict[str, Any]]] = mapped_column(JSON, default=list)
    # 테스트 호출(PR-02/PR-08): Parser REST API
    api_url: Mapped[str] = mapped_column(String(1000), default="")
    api_auth_header: Mapped[str] = mapped_column(String(200), default="")  # 예: "Authorization"
    api_auth_env: Mapped[str] = mapped_column(String(200), default="")  # 값은 환경변수에서 읽음
    api_timeout_sec: Mapped[float] = mapped_column(Float, default=120.0)
    api_mode: Mapped[str] = mapped_column(String(20), default="sync")  # sync | async | upstage
    # 호출 방식별 추가 설정 (upstage: project_id, model, config_id, purpose, include, extra_body, poll_interval_sec)
    api_config: Mapped[dict[str, Any] | None] = mapped_column(JSON, default=dict, nullable=True)
    api_status_url: Mapped[str] = mapped_column(String(1000), default="")  # async: {job_id} 치환
    api_file_field: Mapped[str] = mapped_column(String(100), default="file")
    max_file_mb: Mapped[float] = mapped_column(Float, default=50.0)
    enabled: Mapped[bool] = mapped_column(Boolean, default=True)
    last_health: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)


class ParseJob(TimestampMixin, Base):
    """UI 테스트용 Parser API 호출 이력(PR-09, IN-07)."""

    __tablename__ = "parse_jobs"

    id: Mapped[int] = mapped_column(primary_key=True)
    parser_id: Mapped[int] = mapped_column(ForeignKey("parsers.id"))
    file_name: Mapped[str] = mapped_column(String(500))
    file_hash: Mapped[str] = mapped_column(String(64))
    params: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    # queued | parsing | converting | done | failed
    status: Mapped[str] = mapped_column(String(20), default="queued")
    error_kind: Mapped[str] = mapped_column(String(50), default="")  # parser_error | timeout | adapter_error
    error: Mapped[str] = mapped_column(Text, default="")
    elapsed_ms: Mapped[int] = mapped_column(Integer, default=0)
    raw_response_path: Mapped[str] = mapped_column(String(1000), default="")
    document_id: Mapped[int | None] = mapped_column(ForeignKey("documents.id"), nullable=True)
    project_id: Mapped[int | None] = mapped_column(Integer, nullable=True)  # 파싱 완료 시 문서를 배정할 프로젝트

    parser: Mapped[Parser] = relationship()


# ---------------------------------------------------------------- Projects
class Project(TimestampMixin, Base):
    """문서 분류 트리. 같은 프로젝트(및 하위)의 문서는 같은 청킹 프로파일을 쓴다.

    프로파일 필드가 비어 있으면(None) 상위 프로젝트 값을 상속한다.
    """

    __tablename__ = "projects"

    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(200))
    description: Mapped[str] = mapped_column(Text, default="")
    parent_id: Mapped[int | None] = mapped_column(ForeignKey("projects.id"), nullable=True, index=True)
    sort_order: Mapped[int] = mapped_column(Integer, default=0)
    # ---- 청킹 프로파일 (None = 상위에서 상속)
    method: Mapped[str | None] = mapped_column(String(30), nullable=True)  # llm | rule_structure
    prompt_id: Mapped[int | None] = mapped_column(ForeignKey("prompts.id"), nullable=True)
    # 고정할 프롬프트 버전. None이면 실행 시점의 운영(production) 버전, 없으면 최신 버전
    prompt_version_id: Mapped[int | None] = mapped_column(ForeignKey("prompt_versions.id"), nullable=True)
    model_id: Mapped[int | None] = mapped_column(ForeignKey("llm_models.id"), nullable=True)
    params: Mapped[dict[str, Any] | None] = mapped_column(JSON, nullable=True)
    settings: Mapped[dict[str, Any] | None] = mapped_column(JSON, nullable=True)
    doc_type: Mapped[str | None] = mapped_column(String(100), nullable=True)
    # ---- 메타데이터·권한 (벡터 DB 적재 시 청크에 함께 저장)
    # 자유 키-값. 상위 값을 물려받고 같은 키는 하위 값이 우선
    meta: Mapped[dict[str, Any] | None] = mapped_column(JSON, nullable=True)
    # 열람 가능한 주체(principal) 목록. 예: "group:인사팀", "user:hong", "role:admin"
    permissions: Mapped[list[str] | None] = mapped_column(JSON, nullable=True)
    # inherit(기본): 상위 권한 + 이 목록 / override: 이 목록으로 재정의
    permission_mode: Mapped[str | None] = mapped_column(String(20), nullable=True)


# ---------------------------------------------------------------- Documents
class Document(TimestampMixin, Base):
    __tablename__ = "documents"

    id: Mapped[int] = mapped_column(primary_key=True)
    title: Mapped[str] = mapped_column(String(500))
    parser_id: Mapped[int | None] = mapped_column(ForeignKey("parsers.id"), nullable=True)
    parser_name: Mapped[str] = mapped_column(String(200), default="")
    parser_version: Mapped[str] = mapped_column(String(50), default="")
    file_hash: Mapped[str] = mapped_column(String(64), default="")
    source_file_path: Mapped[str] = mapped_column(String(1000), default="")
    source: Mapped[str] = mapped_column(String(20), default="runtime")  # runtime | test
    doc_type: Mapped[str] = mapped_column(String(100), default="")
    revision: Mapped[int] = mapped_column(Integer, default=1)  # 재파싱 시 누적(IN-05)
    project_id: Mapped[int | None] = mapped_column(ForeignKey("projects.id"), nullable=True, index=True)
    content: Mapped[dict[str, Any]] = mapped_column(JSON)  # StandardDocument
    stats: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)


class IngestFailure(TimestampMixin, Base):
    """스키마 검증 실패 격리(IN-03)."""

    __tablename__ = "ingest_failures"

    id: Mapped[int] = mapped_column(primary_key=True)
    parser_id: Mapped[int | None] = mapped_column(ForeignKey("parsers.id"), nullable=True)
    source_name: Mapped[str] = mapped_column(String(500), default="")
    reason: Mapped[str] = mapped_column(Text)
    payload_excerpt: Mapped[str] = mapped_column(Text, default="")


# ---------------------------------------------------------------- Model Registry
class LLMModel(TimestampMixin, Base):
    __tablename__ = "llm_models"

    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(200), unique=True)
    # openai_compatible | anthropic | mock
    provider: Mapped[str] = mapped_column(String(50))
    # 표시용 서빙 엔진: openai, vllm, tgi, sglang, ollama, anthropic, mock …
    engine: Mapped[str] = mapped_column(String(50), default="")
    base_url: Mapped[str] = mapped_column(String(1000), default="")
    model_id: Mapped[str] = mapped_column(String(300))
    api_key_env: Mapped[str] = mapped_column(String(200), default="")  # 키는 환경변수로만
    is_external: Mapped[bool] = mapped_column(Boolean, default=False)  # 외부 상용 API 여부
    context_length: Mapped[int] = mapped_column(Integer, default=8192)
    max_output_tokens: Mapped[int] = mapped_column(Integer, default=4096)
    # auto | json_schema | json_mode | guided_json | prompt
    structured_output: Mapped[str] = mapped_column(String(30), default="auto")
    input_price_per_1m: Mapped[float] = mapped_column(Float, default=0.0)
    output_price_per_1m: Mapped[float] = mapped_column(Float, default=0.0)
    extra_params: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    enabled: Mapped[bool] = mapped_column(Boolean, default=True)
    last_health: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)


# ---------------------------------------------------------------- Prompts
class Prompt(TimestampMixin, Base):
    __tablename__ = "prompts"

    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(200), unique=True)
    description: Mapped[str] = mapped_column(Text, default="")
    doc_types: Mapped[list[str]] = mapped_column(JSON, default=list)  # PM-06
    forked_from_version_id: Mapped[int | None] = mapped_column(Integer, nullable=True)

    versions: Mapped[list[PromptVersion]] = relationship(
        back_populates="prompt", order_by="PromptVersion.version", cascade="all, delete-orphan"
    )


class PromptVersion(TimestampMixin, Base):
    __tablename__ = "prompt_versions"

    id: Mapped[int] = mapped_column(primary_key=True)
    prompt_id: Mapped[int] = mapped_column(ForeignKey("prompts.id"))
    version: Mapped[int] = mapped_column(Integer)
    system_template: Mapped[str] = mapped_column(Text)
    user_template: Mapped[str] = mapped_column(Text)
    few_shots: Mapped[list[dict[str, Any]]] = mapped_column(JSON, default=list)  # [{input, output}]
    output_schema: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    note: Mapped[str] = mapped_column(Text, default="")
    # draft | testing | approved | production
    status: Mapped[str] = mapped_column(String(20), default="draft")

    prompt: Mapped[Prompt] = relationship(back_populates="versions")


# ---------------------------------------------------------------- Chunking runs
class ChunkRun(TimestampMixin, Base):
    __tablename__ = "chunk_runs"

    id: Mapped[int] = mapped_column(primary_key=True)
    document_id: Mapped[int] = mapped_column(ForeignKey("documents.id"))
    prompt_version_id: Mapped[int | None] = mapped_column(ForeignKey("prompt_versions.id"), nullable=True)
    model_id: Mapped[int | None] = mapped_column(ForeignKey("llm_models.id"), nullable=True)
    method: Mapped[str] = mapped_column(String(30), default="llm")  # llm | rule_structure
    params: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)  # 모델 파라미터
    settings: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)  # 윈도우·크기·범위 등
    # 재현성(EX-05): 실행 시점 스냅샷
    snapshot: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    # queued | running | done | failed
    status: Mapped[str] = mapped_column(String(20), default="queued")
    progress: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    windows: Mapped[list[dict[str, Any]]] = mapped_column(JSON, default=list)
    chunks: Mapped[list[dict[str, Any]]] = mapped_column(JSON, default=list)
    validation: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    totals: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    feedback: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)  # chunk_id → up/down
    error: Mapped[str] = mapped_column(Text, default="")


# ---------------------------------------------------------------- Embedding / Vector store
class EmbeddingModel(TimestampMixin, Base):
    __tablename__ = "embedding_models"

    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(200), unique=True)
    # openai_compatible(/v1/embeddings: TEI·vLLM·Ollama·상용) | mock
    provider: Mapped[str] = mapped_column(String(50))
    engine: Mapped[str] = mapped_column(String(50), default="")
    base_url: Mapped[str] = mapped_column(String(1000), default="")
    model_id: Mapped[str] = mapped_column(String(300))
    api_key_env: Mapped[str] = mapped_column(String(200), default="")
    is_external: Mapped[bool] = mapped_column(Boolean, default=False)
    dimension: Mapped[int | None] = mapped_column(Integer, nullable=True)  # 헬스체크/첫 적재 시 자동 확인
    max_input_tokens: Mapped[int] = mapped_column(Integer, default=8192)
    # 질의/문서 앞에 붙일 지시문 (e5: "query: ", Qwen3-Embedding: "Instruct: ...\nQuery: " 등)
    query_prefix: Mapped[str] = mapped_column(Text, default="")
    document_prefix: Mapped[str] = mapped_column(Text, default="")
    batch_size: Mapped[int] = mapped_column(Integer, default=32)
    extra_params: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    enabled: Mapped[bool] = mapped_column(Boolean, default=True)
    last_health: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)


class VectorStore(TimestampMixin, Base):
    __tablename__ = "vector_stores"

    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(200), unique=True)
    kind: Mapped[str] = mapped_column(String(30))  # milvus | memory
    uri: Mapped[str] = mapped_column(String(1000), default="")
    token_env: Mapped[str] = mapped_column(String(200), default="")  # "user:password" 또는 API 키
    db_name: Mapped[str] = mapped_column(String(200), default="")
    # TLS(https://) 접속 시 신뢰할 CA 인증서 파일 경로(사설 CA일 때)와 인증서 검증용 호스트명 재지정
    tls_ca_path: Mapped[str] = mapped_column(String(1000), default="")
    tls_server_name: Mapped[str] = mapped_column(String(300), default="")
    enabled: Mapped[bool] = mapped_column(Boolean, default=True)
    last_health: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)


class VectorIndex(TimestampMixin, Base):
    """청킹 실행 결과를 임베딩해 벡터 저장소 컬렉션에 적재한 단위."""

    __tablename__ = "vector_indexes"

    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(200))
    store_id: Mapped[int] = mapped_column(ForeignKey("vector_stores.id"))
    collection: Mapped[str] = mapped_column(String(255))
    embedding_model_id: Mapped[int] = mapped_column(ForeignKey("embedding_models.id"))
    # 임베딩할 텍스트 템플릿: {text} {title} {summary} {keywords} {section_path} {document_title}
    embed_template: Mapped[str] = mapped_column(Text, default="{text}")
    metric: Mapped[str] = mapped_column(String(20), default="COSINE")
    dimension: Mapped[int | None] = mapped_column(Integer, nullable=True)
    run_ids: Mapped[list[int]] = mapped_column(JSON, default=list)
    # queued | running | done | failed
    status: Mapped[str] = mapped_column(String(20), default="queued")
    progress: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    chunk_count: Mapped[int] = mapped_column(Integer, default=0)
    warnings: Mapped[list[str]] = mapped_column(JSON, default=list)
    stats: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    error: Mapped[str] = mapped_column(Text, default="")
