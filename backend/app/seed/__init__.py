"""초기 데이터: 샘플 Parser, 모델 예시, 기본 프롬프트, 샘플 문서."""
from __future__ import annotations

from pathlib import Path

from sqlalchemy import select
from sqlalchemy.orm import Session

from .. import sample_parser
from ..chunking import prompting
from ..config import settings
from ..models import (
    Document, EmbeddingModel, LLMModel, Parser, Project, Prompt, PromptVersion, RerankModel, VectorCollection,
    VectorStore,
)
from ..services import save_document, sha256, store_file

SAMPLE = Path(__file__).with_name("sample_policy.md")


def seed(db: Session) -> None:
    parser = db.scalar(select(Parser).where(Parser.name == sample_parser.PARSER_NAME))
    if parser is None:
        parser = Parser(
            name=sample_parser.PARSER_NAME,
            description="개발용 샘플 Parser (.md .txt .pdf). 테스트 업로드 시 Studio가 이 API를 직접 호출합니다.",
            version=sample_parser.PARSER_VERSION,
            owner="chunking-studio",
            input_formats=["md", "txt", "pdf"],
            adapter="standard",
            param_schema=[{"name": "language", "type": "string", "default": "ko", "description": "문서 언어"}],
            api_url=f"{settings.public_base_url}/api/dev/sample-parser/parse",
            api_timeout_sec=60,
        )
        db.add(parser)
        db.commit()

    if not db.scalar(select(LLMModel)):
        db.add_all([
            LLMModel(name="Mock (오프라인)", provider="mock", engine="mock", model_id="mock-chunker",
                     context_length=8192, max_output_tokens=4096, structured_output="auto"),
            LLMModel(name="vLLM Qwen (예시)", provider="openai_compatible", engine="vllm",
                     base_url="http://localhost:8001/v1", model_id="Qwen/Qwen2.5-32B-Instruct",
                     context_length=32768, max_output_tokens=4096, structured_output="auto", enabled=False),
            LLMModel(name="Ollama (예시)", provider="openai_compatible", engine="ollama",
                     base_url="http://localhost:11434/v1", model_id="qwen2.5:14b",
                     context_length=32768, max_output_tokens=4096, structured_output="auto", enabled=False),
            LLMModel(name="Claude Opus 5.5", provider="anthropic", engine="anthropic", model_id="claude-opus-5-5",
                     api_key_env="ANTHROPIC_API_KEY", is_external=True, context_length=1_000_000,
                     max_output_tokens=16000, structured_output="auto", input_price_per_1m=4.0,
                     output_price_per_1m=20.0, enabled=False),
            LLMModel(name="OpenAI 호환 상용 API (예시)", provider="openai_compatible", engine="openai",
                     base_url="https://api.openai.com/v1", model_id="<model-id>", api_key_env="OPENAI_API_KEY",
                     is_external=True, context_length=128000, max_output_tokens=16000, enabled=False),
        ])
        db.commit()

    if not db.scalar(select(Prompt)):
        p = Prompt(name="기본 시멘틱 청킹", description="경계(Element ID 범위)만 반환하는 기본 프롬프트")
        db.add(p)
        db.flush()
        db.add(PromptVersion(prompt_id=p.id, version=1, system_template=prompting.DEFAULT_SYSTEM,
                             user_template=prompting.DEFAULT_USER, output_schema=prompting.OUTPUT_SCHEMA,
                             note="초기 버전", status="approved"))
        db.commit()

    if not db.scalar(select(Document)):
        data = SAMPLE.read_bytes()
        doc = sample_parser.parse_bytes(SAMPLE.name, data)
        path = store_file(data, SAMPLE.name)
        save_document(db, doc, parser=parser, title="사내 원격근무 운영 지침 (샘플)", source="test",
                      file_hash=sha256(data), source_file_path=str(path), doc_type="사내 규정")

    seed_vectors(db)
    seed_rerank(db)
    seed_upstage(db)


QWEN3_QUERY_PREFIX = "Instruct: Given a web search query, retrieve relevant passages that answer the query\nQuery: "


def seed_vectors(db: Session) -> None:
    """임베딩 모델·벡터 저장소 기본값 (기존 DB에도 테이블이 비어 있으면 추가)."""
    if not db.scalar(select(EmbeddingModel)):
        db.add_all([
            EmbeddingModel(name="Mock 임베딩 (오프라인)", provider="mock", engine="mock", model_id="mock-hash-256",
                           dimension=256, max_input_tokens=8192),
            EmbeddingModel(name="bge-m3 (TEI 예시)", provider="openai_compatible", engine="tei",
                           base_url="http://localhost:8080/v1", model_id="BAAI/bge-m3", dimension=1024,
                           max_input_tokens=8192, enabled=False),
            EmbeddingModel(name="KURE-v1 (vLLM 예시)", provider="openai_compatible", engine="vllm",
                           base_url="http://localhost:8002/v1", model_id="nlpai-lab/KURE-v1", dimension=1024,
                           max_input_tokens=8192, enabled=False),
            EmbeddingModel(name="Qwen3-Embedding-0.6B (vLLM 예시)", provider="openai_compatible", engine="vllm",
                           base_url="http://localhost:8003/v1", model_id="Qwen/Qwen3-Embedding-0.6B",
                           dimension=1024, max_input_tokens=32768, query_prefix=QWEN3_QUERY_PREFIX, enabled=False),
            EmbeddingModel(name="OpenAI text-embedding-3-large (예시)", provider="openai_compatible", engine="openai",
                           base_url="https://api.openai.com/v1", model_id="text-embedding-3-large",
                           api_key_env="OPENAI_API_KEY", is_external=True, dimension=3072, max_input_tokens=8191,
                           enabled=False),
        ])
        db.commit()
    if not db.scalar(select(VectorStore)):
        db.add_all([
            VectorStore(name="Milvus 로컬", kind="milvus", uri=settings.milvus_uri, collection="cs_default",
                        is_default=True),
            VectorStore(name="메모리 (개발용)", kind="memory", collection="cs_memory"),
        ])
        db.commit()
    ensure_collections(db)


def seed_rerank(db: Session) -> None:
    """리랭크 모델: 오프라인 Mock(활성) + 자체 서빙·상용 예시(비활성, 주소만 맞추면 사용)."""
    if db.scalar(select(RerankModel)):
        return
    db.add_all([
        RerankModel(name="Mock 리랭커 (오프라인)", provider="mock", engine="mock", model_id="mock-overlap",
                    max_input_tokens=8192),
        RerankModel(name="bge-reranker-v2-m3 (TEI 예시)", provider="tei", engine="tei",
                    base_url="http://localhost:8081", model_id="BAAI/bge-reranker-v2-m3", max_input_tokens=8192,
                    enabled=False),
        RerankModel(name="bge-reranker-v2-m3 (vLLM 예시)", provider="cohere_compatible", engine="vllm",
                    base_url="http://localhost:8000/v1", model_id="BAAI/bge-reranker-v2-m3", max_input_tokens=8192,
                    enabled=False),
        RerankModel(name="Cohere rerank-v3.5 (예시)", provider="cohere_compatible", engine="cohere",
                    base_url="https://api.cohere.com/v2", model_id="rerank-v3.5", api_key_env="COHERE_API_KEY",
                    is_external=True, max_input_tokens=4096, enabled=False),
    ])
    db.commit()


def ensure_collections(db: Session) -> None:
    """저장소(연결)별 컬렉션 테이블 보정.

    - 컬렉션이 하나도 없으면(구버전 DB 또는 첫 시드): 저장소마다 예전 '저장소 컬렉션'을 컬렉션으로 옮기고,
      저장소 단위로 지정하던 프로젝트 설정(vector_store_id)을 그 컬렉션으로 옮긴다.
    - 기본 컬렉션이 없으면 하나를 지정한다.
    """
    stores = list(db.scalars(select(VectorStore).order_by(VectorStore.id)))
    if not stores:
        return
    if not db.scalar(select(VectorCollection)):
        by_store = {}
        for s in stores:
            name = s.collection or ("cs_default" if s.is_default else f"cs_store{s.id}")
            c = VectorCollection(store_id=s.id, name=name, is_default=bool(s.is_default))
            db.add(c)
            by_store[s.id] = c
        db.flush()
        for p in db.scalars(select(Project).where(Project.vector_store_id.is_not(None))):
            if p.vector_collection_id is None and p.vector_store_id in by_store:
                p.vector_collection_id = by_store[p.vector_store_id].id
    if not db.scalar(select(VectorCollection).where(VectorCollection.is_default.is_(True))):
        colls = list(db.scalars(select(VectorCollection).order_by(VectorCollection.id)))
        if colls:
            enabled = {s.id for s in stores if s.enabled and s.kind == "milvus"}
            pick = next((c for c in colls if c.store_id in enabled), colls[0])
            pick.is_default = True
    db.commit()


UPSTAGE_PARSER_NAME = "upstage-parser"


def seed_upstage(db: Session) -> None:
    """Upstage 파서 등록 예시 (비활성). Project ID·Agent ID는 Parser 등록 화면에서 채우고, 키는 UPSTAGE_API_KEY 환경변수로."""
    if db.scalar(select(Parser).where(Parser.name == UPSTAGE_PARSER_NAME)):
        return
    db.add(Parser(
        name=UPSTAGE_PARSER_NAME,
        description="Upstage Agents API(v2): 파일 업로드 → 작업 실행 → 완료까지 폴링. Project ID와 Agent ID를 입력한 뒤 활성화하세요.",
        version="v2",
        owner="Upstage",
        input_formats=["pdf", "docx", "pptx", "xlsx", "hwp", "png", "jpg"],
        adapter="upstage",
        api_url="https://api.upstage.ai/v2",
        api_mode="upstage",
        api_auth_header="Authorization",
        api_auth_env="UPSTAGE_API_KEY",
        api_timeout_sec=600,
        api_config={"project_id": "", "model": "", "config_id": "1", "purpose": "user_data", "include": "",
                    "poll_interval_sec": 2, "extra_body": {}},
        enabled=False,
    ))
    db.commit()
