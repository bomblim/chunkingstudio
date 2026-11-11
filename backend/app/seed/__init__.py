"""초기 데이터: 샘플 Parser, 모델 예시, 기본 프롬프트, 샘플 문서."""
from __future__ import annotations

from pathlib import Path

from sqlalchemy import select
from sqlalchemy.orm import Session

from .. import sample_parser
from ..chunking import prompting
from ..config import settings
from ..models import Document, LLMModel, Parser, Prompt, PromptVersion
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
