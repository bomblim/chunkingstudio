# Chunking Studio

RAG 청킹 품질을 실험·검증·운영하는 UI 기반 솔루션. 상세 요구사항은 `docs/requirements.md` 참고.

## 핵심 방향
- 입력: 관리자가 등록한 Parser의 파싱 결과(표준 스키마). 원본 문서 업로드는 테스트용.
- 청킹: LLM 시멘틱 청킹. LLM은 Element ID 범위(경계)만 반환해 원문 변형을 방지.
- 프롬프트를 수정하며 결과를 UI(Prompt Playground)에서 확인·비교.
- 평가: RAGAS 자동 평가 + LLM 기반 평가 데이터셋 자동 생성 (dev/test 분리).

## 현재 상태
- 요구사항 초안(v0.1)만 존재. 기술 스택 미정.
- 미결 사항은 `docs/requirements.md` 10장 참고.

## 작업 규칙
- 문서·커뮤니케이션은 한국어.
