# Chunking Studio

RAG 청킹 품질을 실험·검증·운영하는 UI 기반 솔루션. 상세 요구사항은 `docs/requirements.md` 참고.

## 핵심 방향
- 입력: 런타임은 관리자가 등록한 Parser의 파싱 결과(표준 스키마)를 수신만 함. UI 테스트 시에만 Studio가 Parser API를 직접 호출.
- 청킹: LLM 시멘틱 청킹. LLM은 Element ID 범위(경계)만 반환하고 본문은 원본 Element로 조립 (텍스트 재작성 없음).
- LLM: 선택 가능. 상용 API + 오픈소스 자체 서빙(vLLM 등) 모두 지원.
- 프롬프트를 수정하며 결과를 UI(청킹 화면, 옛 Prompt Playground)에서 확인·비교.
- 평가: RAGAS 자동 평가 + LLM 기반 평가 데이터셋 자동 생성 (dev/test 분리).

## 현재 상태
- 기술 스택: backend FastAPI + SQLAlchemy (uv, Python 3.12), frontend React + TypeScript + Vite.
- MVP(requirements 9장) 구현: 표준 스키마, 문서 파서, 파싱 결과 뷰어, 청킹 모델, 청킹 화면(`/playground`).
- 벡터 검색: 임베딩 모델(OpenAI 호환·Mock), 벡터 저장소(Milvus·메모리 연결, 연결마다 컬렉션 여러 개 `vector_collections`), 청크 적재·질의 테스트(선택: 리랭크 모델 `rerank_models` — TEI·Cohere 형식·Mock, 질의 시 후보 재정렬). 적재 위치는 문서 프로젝트의 `vector_collection_id`(상속), 없으면 기본 컬렉션(`is_default`). 로컬 Milvus는 `deploy/milvus/docker-compose.yml` (v3.0.6, pymilvus 3.x).
- 프로젝트: 문서 분류 트리(`projects`). 프로젝트별 청킹 프로파일(방식·프롬프트·LLM 모델·설정)을 두고 비운 필드는 상위에서 상속. 청킹 화면 기본값·일괄 청킹에 사용. 기존 DB 컬럼 추가는 `db.add_missing_columns()`가 시작 시 처리. 프로젝트 메타데이터(`meta`)·권한(`permissions`, `permission_mode`)은 적재 시 청크 metadata에 복사되고 질의 시 principals로 필터.
- ID: 모든 레코드 ID는 UUIDv7 문자열(`app/ids.py`, 생성 순서로 정렬됨). 정수 ID였던 기존 SQLite DB는 시작 시 `app/migrate_uuid.py`가 백업 후 한 번 변환. Milvus 컬렉션의 `run_id`·`document_id`는 VARCHAR(UUID)이며, 정수 ID 시절 컬렉션에는 적재를 막는다(다시 만들어야 함).
- 외부 API: `/api/v1/…`(파이프라인 업로드→파싱→청킹→적재→질의, `app/api/external.py`)은 API 키 필수(`api_keys`, sha256 해시만 저장). 화면용 `/api/…`는 키 없음(내부망 전제).
- 2단계(실험 비교, RAGAS 평가, 데이터셋 생성)는 미구현.
- 결정·미결 사항은 `docs/requirements.md` 10장 참고.

## 개발 명령
- 백엔드 테스트: `cd backend && uv run pytest` (실제 Milvus 포함: `CS_TEST_MILVUS_URI=http://localhost:19530`)
- 프론트 빌드(타입 체크 포함): `cd frontend && npm run build`
- 실행 설정: `.claude/launch.json` (backend :8000, frontend :5173)
- 폐쇄망 이미지: `deploy/offline/build.sh <버전>` (Studio, UBI 9), `deploy/offline-milvus/build.sh` (Milvus 묶음). 결과물은 `dist/` (git 제외).

## 작업 규칙
- 문서·커뮤니케이션은 한국어.
