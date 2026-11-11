# Chunking Studio

RAG 파이프라인의 청킹 품질을 실험·검증·운영하기 위한 UI 기반 솔루션.

## 주요 기능

- **Parser Registry** — 관리자가 등록한 Parser의 파싱 결과를 표준 스키마로 통합하고 UI로 확인
- **LLM 시멘틱 청킹 Playground** — 프롬프트를 수정해가며 청킹 결과를 원문 위에서 바로 확인·비교
- **RAGAS 자동 평가** — 프롬프트 버전별 검색·생성 품질 자동 측정, 승격 게이트 (2단계 예정)
- **평가 데이터셋 자동 생성** — LLM으로 질문·정답셋 생성, 품질 필터 및 검수 (2단계 예정)

## 구조

```
backend/   FastAPI + SQLAlchemy (SQLite 기본, CS_DATABASE_URL로 PostgreSQL 등 지정)
  app/standard.py        표준 파싱 결과 스키마
  app/adapters/          Parser 출력 → 표준 스키마 어댑터 (standard, unstructured)
  app/parser_client.py   UI 테스트용 Parser REST API 호출 (sync / async 폴링)
  app/llm/               LLM Gateway: OpenAI 호환(vLLM·TGI·SGLang·Ollama·상용), Anthropic, Mock
  app/chunking/          경계 기반 청킹 엔진 (윈도잉·Stitching·검증·repair·fallback)
  app/api/               REST API
  app/sample_parser.py   개발용 샘플 Parser (.md .txt .pdf)
frontend/  React + TypeScript + Vite
  src/pages/             문서·뷰어·Playground·프롬프트·Parser·모델 화면
```

## 개발 환경 실행

필요: [uv](https://docs.astral.sh/uv/) (Python 3.12 자동 설치), Node.js 20+

```bash
cd backend && uv sync && uv run uvicorn app.main:app --port 8000
```

```bash
cd frontend && npm install && npm run dev
```

브라우저에서 http://localhost:5173 을 엽니다. 첫 실행 시 샘플 Parser, Mock 모델, 기본 프롬프트, 샘플 문서가 자동 등록되어 LLM 없이도 전체 흐름을 확인할 수 있습니다.

테스트:

```bash
cd backend && uv run pytest
```

### 환경변수 (backend)

| 이름 | 기본값 | 설명 |
|---|---|---|
| `CS_DATA_DIR` | `./data` | DB·업로드 파일·Parser 원본 응답 저장 위치 |
| `CS_DATABASE_URL` | `sqlite:///{CS_DATA_DIR}/studio.db` | SQLAlchemy DB URL |
| `CS_ALLOW_EXTERNAL_LLM` | `true` | `false`면 폐쇄망 모드: 외부(상용) 모델 숨김·호출 차단 |
| `CS_ENABLE_SAMPLE_PARSER` | `true` | 개발용 샘플 Parser API 노출 |
| `CS_SEED` | `true` | 초기 데이터 자동 등록 |
| `CS_PUBLIC_BASE_URL` | `http://127.0.0.1:8000` | 샘플 Parser 등록 시 사용할 API 주소 |
| `CS_CORS_ORIGINS` | `http://localhost:5173` | 허용 Origin (쉼표 구분) |

LLM API 키와 Parser 인증값은 DB에 저장하지 않고, 모델·Parser에 등록한 **환경변수 이름**으로 서버에서 읽습니다 (예: `ANTHROPIC_API_KEY`).

## 주요 API

| 용도 | API |
|---|---|
| 운영 유입 (Parser 결과 push) | `POST /api/ingest` `{parser_id, title, payload}` |
| 운영 유입 (배치) | `POST /api/ingest/batch` (JSON / JSONL 업로드) |
| 테스트 파싱 (Parser API 직접 호출) | `POST /api/test-parse` (파일 + `parser_ids`) → `GET /api/parse-jobs?ids=` |
| 청킹 실행 | `POST /api/runs` → `GET /api/runs/{id}` |

전체 목록은 서버 실행 후 http://localhost:8000/docs 에서 확인합니다.

## 문서

- [요구사항 정의서](docs/requirements.md)
