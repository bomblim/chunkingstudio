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
  app/embeddings.py      임베딩 호출: OpenAI 호환 /v1/embeddings (TEI·vLLM·Ollama·상용), Mock
  app/vectorstores.py    벡터 저장소: Milvus, 메모리(개발용)
  app/indexing.py        청크 → 임베딩 → 컬렉션 적재, 질의
  app/api/               REST API
  app/sample_parser.py   개발용 샘플 Parser (.md .txt .pdf)
frontend/  React + TypeScript + Vite
  src/pages/             문서·뷰어·Playground·프롬프트·Parser·모델·임베딩·벡터 인덱스 화면
deploy/milvus/           개발용 Milvus standalone docker compose (v3.0.6)
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

### 벡터 검색 (임베딩 → Milvus → 질의)

로컬 Milvus를 띄웁니다 (Docker 필요, 데이터는 `deploy/milvus/volumes/`에 저장).

```bash
docker compose -f deploy/milvus/docker-compose.yml up -d
```

1. **임베딩 모델**에서 사용할 모델을 등록·활성화하고 헬스체크로 차원을 확인합니다. 오프라인 확인용 Mock 임베딩이 기본 등록되어 있습니다. TEI 예시는 다음과 같이 띄웁니다.

   ```bash
   docker run --gpus all -p 8080:80 ghcr.io/huggingface/text-embeddings-inference:latest --model-id BAAI/bge-m3
   ```

2. **Playground**에서 청킹을 실행한 뒤 "벡터 DB 적재 →"를 누르거나, **벡터 인덱스·질의**에서 "청크 적재"를 누릅니다.
3. 적재가 끝나면 같은 화면의 **질의 테스트**에서 검색 결과(점수·청크 원문·위치)를 확인합니다. Milvus는 `run_id == 3` 같은 필터도 쓸 수 있습니다.

컬렉션 필드: `id`, `vector`, `chunk_id`, `run_id`, `document_id`, `title`, `section_path`, `text`(청크 원문), `embed_text`(실제로 임베딩한 텍스트), `metadata`(JSON: element_ids, pages, tokens, 프롬프트 버전 등).

테스트:

```bash
cd backend && uv run pytest
```

실제 Milvus까지 포함하려면 `CS_TEST_MILVUS_URI=http://localhost:19530`을 설정하고 실행합니다.

### 환경변수 (backend)

`backend/.env.example`을 `backend/.env`로 복사해 값을 채우면 서버 시작 시 자동으로 읽습니다.

```bash
cp backend/.env.example backend/.env
```

- `.env`는 git에 커밋되지 않습니다 (`.gitignore`). API 키는 이 파일이나 OS 환경변수에만 두세요.
- 셸·OS에 이미 설정된 값이 `.env`보다 우선합니다. 값을 바꾼 뒤에는 서버를 재시작하세요.
- 다른 파일을 쓰려면 `CS_ENV_FILE`에 경로를 지정합니다 (빈 값이면 로드하지 않음).

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
