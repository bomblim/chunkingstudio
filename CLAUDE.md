# Chunking Studio

RAG 청킹 품질을 실험·검증·운영하는 UI 기반 솔루션. 상세 요구사항은 `docs/requirements.md` 참고.

## 핵심 방향
- 입력: 런타임은 관리자가 등록한 Parser의 파싱 결과(표준 스키마)를 수신만 함. UI 테스트 시에만 Studio가 Parser API를 직접 호출.
- 청킹: LLM 시멘틱 청킹. LLM은 Element ID 범위(경계)만 반환하고 본문은 원본 Element로 조립 (텍스트 재작성 없음).
- LLM: 선택 가능. 상용 API + 오픈소스 자체 서빙(vLLM 등) 모두 지원.
- 프롬프트를 수정하며 결과를 UI(Prompt Playground)에서 확인·비교.
- 평가: RAGAS 자동 평가 + LLM 기반 평가 데이터셋 자동 생성 (dev/test 분리).

## 현재 상태
- 요구사항 v0.2만 존재. 기술 스택 미정.
- 결정·미결 사항은 `docs/requirements.md` 10장 참고.

## 작업 규칙
- 문서·커뮤니케이션은 한국어.
