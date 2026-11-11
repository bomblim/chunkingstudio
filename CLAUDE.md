# Chunking Studio

RAG 청킹 품질을 실험·검증·운영하는 UI 기반 솔루션. 상세 요구사항은 `docs/requirements.md` 참고.

## 핵심 방향
- 입력: 런타임은 관리자가 등록한 Parser의 파싱 결과(표준 스키마)를 수신만 함. UI 테스트 시에만 Studio가 Parser API를 직접 호출.
- 청킹: LLM 시멘틱 청킹. LLM은 Element ID 범위(경계)만 반환하고 본문은 원본 Element로 조립 (텍스트 재작성 없음).
- LLM: 선택 가능. 상용 API + 오픈소스 자체 서빙(vLLM 등) 모두 지원.
- 프롬프트를 수정하며 결과를 UI(Prompt Playground)에서 확인·비교.
- 평가: RAGAS 자동 평가 + LLM 기반 평가 데이터셋 자동 생성 (dev/test 분리).

## 현재 상태
- 기술 스택: backend FastAPI + SQLAlchemy (uv, Python 3.12), frontend React + TypeScript + Vite.
- MVP(requirements 9장) 구현: 표준 스키마, Parser Registry, 파싱 결과 뷰어, 모델 레지스트리, 청킹 Playground.
- 벡터 검색: 임베딩 모델 레지스트리(OpenAI 호환·Mock), 벡터 저장소(Milvus·메모리), 청크 적재·질의 테스트. 로컬 Milvus는 `deploy/milvus/docker-compose.yml` (v3.0.6, pymilvus 3.x).
- 프로젝트: 문서 분류 트리(`projects`). 프로젝트별 청킹 프로파일(방식·프롬프트·LLM 모델·설정)을 두고 비운 필드는 상위에서 상속. Playground 기본값·일괄 청킹에 사용. 기존 DB 컬럼 추가는 `db.add_missing_columns()`가 시작 시 처리. 프로젝트 메타데이터(`meta`)·권한(`permissions`, `permission_mode`)은 적재 시 청크 metadata에 복사되고 질의 시 principals로 필터.
- 2단계(실험 비교, RAGAS 평가, 데이터셋 생성)는 미구현.
- 결정·미결 사항은 `docs/requirements.md` 10장 참고.

## 개발 명령
- 백엔드 테스트: `cd backend && uv run pytest` (실제 Milvus 포함: `CS_TEST_MILVUS_URI=http://localhost:19530`)
- 프론트 빌드(타입 체크 포함): `cd frontend && npm run build`
- 실행 설정: `.claude/launch.json` (backend :8000, frontend :5173)
- 폐쇄망 이미지: `deploy/offline/build.sh <버전>` (Studio, UBI 9), `deploy/offline-milvus/build.sh` (Milvus 묶음). 결과물은 `dist/` (git 제외).

## 작업 규칙
- 문서·커뮤니케이션은 한국어.
