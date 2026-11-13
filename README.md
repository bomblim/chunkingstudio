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

### 프로젝트 (문서 분류 트리)

문서 화면 왼쪽 트리에서 프로젝트(예: 방산규정집, ERP매뉴얼)를 만들고 하위 프로젝트로 나눌 수 있습니다.

- **청킹 프로파일**: 프로젝트 "설정"에서 청킹 방식·프롬프트(버전 고정 또는 운영 버전 자동)·LLM 모델·청킹 설정·문서 유형을 지정합니다. 비워 둔 항목은 상위 프로젝트 값을 상속합니다.
- **문서 배정**: 업로드·가져오기 시 프로젝트를 고르거나, 목록에서 문서를 선택해 "프로젝트로 이동"합니다.
- **Playground**: 프로젝트 문서를 열면 그 프로파일이 기본값으로 적용되고, 조정한 설정을 "현재 설정을 프로젝트에 저장"으로 되돌려 저장할 수 있습니다.
- **일괄 청킹**: 프로젝트의 "일괄 청킹"은 하위 포함 모든 문서를 프로파일대로 한 건씩 순차 실행합니다.
- **일괄 적재**: 프로젝트의 "일괄 적재"는 하위 포함 문서마다 가장 최근에 성공한 청킹 실행을 골라 한 컬렉션(기본 `cs_proj<id>`)에 순차 적재합니다. 성공한 청킹이 없는 문서는 제외되고, 같은 문서의 이전 청크는 교체되어 중복되지 않습니다.
- **메타데이터·권한**: 프로젝트 "설정 → 메타데이터 · 권한"에서 키-값 메타데이터(예: 부서, 보안등급)와 열람 권한 주체(`group:인사팀`, `user:hong` 등)를 지정합니다. 메타데이터는 상위 값을 물려받고 같은 키는 하위가 우선, 권한은 "상위 + 추가" 또는 "재정의"를 고릅니다. 권한이 비어 있으면 전체 공개입니다.
- **권한 반영**: 벡터 DB 적재 시 청크 `metadata`에 `project_meta`, `permissions`, `public`이 복사됩니다(바꾼 뒤에는 다시 적재). 질의 테스트의 "권한 필터"에 사용자 주체를 넣으면 공개 청크와 해당 주체가 허용된 청크만 검색됩니다. Milvus 필터식: `metadata["public"] == true or json_contains_any(metadata["permissions"], [...])`

### Upstage 파서

`upstage-parser`가 비활성 상태로 미리 등록되어 있습니다. Upstage Agents API(v2)를 파일 업로드 → 작업 실행 → 완료까지 폴링 순서로 호출합니다.

1. `backend/.env`에 API 키를 넣고 백엔드를 재시작합니다. 토큰만 넣으면 `Bearer `가 자동으로 붙습니다.

   ```
   UPSTAGE_API_KEY=up_xxxxxxxx
   ```

2. **Parser Registry**에서 `upstage-parser`를 수정해 **Project ID**(`proj_…`)와 **Agent ID**(`agt_…`)를 입력하고 활성화합니다. config_id, purpose, include도 여기서 바꿀 수 있습니다. 다른 Parser도 "Upstage 기본값 채우기"로 같은 설정을 만들 수 있습니다.
3. **문서 → 테스트 문서 업로드**에서 `upstage-parser`를 골라 파일을 올립니다.

연결 테스트 버튼은 비용이 드는 실제 호출 대신 설정만 확인합니다. 결과는 `upstage` 어댑터가 표준 스키마로 바꿉니다(`elements`가 있으면 그대로, 없으면 `content.html`을 나눠서). 좌표는 0~1 상대값으로 저장되며 원본 대조 뷰가 페이지 비율에 맞춰 그립니다.

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

Milvus를 TLS로 접속하려면 저장소 URI를 `https://`로 등록합니다. 사설 CA면 "CA 인증서 경로", 인증서 이름과 접속 호스트가 다르면 "인증서 서버 이름"을 지정합니다. nginx로 TLS를 종료하는 구성은 [deploy/offline-milvus/README.md](deploy/offline-milvus/README.md) 4장을 참고하세요.

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

## 폐쇄망 배포

인터넷이 되는 PC에서 이미지를 만들어 tar로 옮긴 뒤 폐쇄망 서버에서 `docker load`로 올립니다. GitHub Release에 빌드된 파일이 첨부됩니다.

- **Chunking Studio** (Red Hat UBI 9, 화면+API 단일 컨테이너): [deploy/offline/README.md](deploy/offline/README.md) — `deploy/offline/build.sh <버전>`
- **Milvus** (공식 v3.0.6 이미지 묶음): [deploy/offline-milvus/README.md](deploy/offline-milvus/README.md) — `deploy/offline-milvus/build.sh`

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
