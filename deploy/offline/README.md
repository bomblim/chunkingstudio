# Chunking Studio 폐쇄망 배포 (Red Hat UBI 9, Milvus 제외)

화면과 API를 함께 제공하는 컨테이너 하나입니다. 실행 중에는 외부 인터넷이 필요 없습니다.
Milvus는 포함하지 않으며, 이미 운영 중인 Milvus에 연결합니다.

| 항목 | 내용 |
|---|---|
| 베이스 이미지 | `registry.access.redhat.com/ubi9/python-312` (빌드 단계: `ubi9/nodejs-22`) |
| 포트 | 8000 (화면 `/`, API `/api`) |
| 데이터 | `/data` 볼륨: SQLite DB, 업로드 원본, Parser 원본 응답, 메모리 벡터 저장소 |
| 실행 사용자 | UID 1001, 그룹 0 (OpenShift 임의 UID 호환) |
| 플랫폼 | linux/amd64 (다른 아키텍처는 빌드 시 `PLATFORM=linux/arm64`) |

## 1. 이미지 만들기 (인터넷이 되는 PC)

필요: Docker, Git Bash(또는 Linux 셸). 저장소 루트에서:

```bash
deploy/offline/build.sh 1.0.0
```

`dist/`에 다음 파일이 생깁니다. 전부 폐쇄망 서버로 옮깁니다.

| 파일 | 용도 |
|---|---|
| `chunking-studio-1.0.0.tar.gz` | 이미지 (`docker load`) |
| `chunking-studio-1.0.0.tar.gz.sha256` | 무결성 확인 |
| `chunking-studio-1.0.0.manifest.txt` | 빌드 정보 (베이스 이미지 digest, 커밋) |
| `docker-compose.yml` | 실행 설정 (이미지 태그 채워짐) |
| `env.example` | 환경변수 예시 |

## 2. 폐쇄망 서버에서 실행

```bash
sha256sum -c chunking-studio-1.0.0.tar.gz.sha256
docker load -i chunking-studio-1.0.0.tar.gz
cp env.example .env        # CS_MILVUS_URI, CS_CORS_ORIGINS, API 키 등 수정
mkdir -p data && sudo chown 1001:0 data   # 컨테이너 사용자(UID 1001)가 쓸 수 있도록
docker compose up -d
```

Podman을 쓰는 RHEL에서는 `podman load`, `podman-compose up -d` 또는 아래 단일 명령을 씁니다.

```bash
podman run -d --name chunking-studio -p 8000:8000 --env-file .env -v ./data:/data:Z chunking-studio:1.0.0
```

확인:

```bash
curl http://localhost:8000/api/health
```

브라우저에서 `http://<서버>:8000` 접속.

## 3. 설정

- 환경변수는 `.env`(compose `env_file`)로 넣습니다. `/data/.env` 파일이 있으면 컨테이너가 시작할 때 추가로 읽습니다.
- API 키(Upstage, LLM, 임베딩, Milvus 토큰)는 화면에 저장하지 않고 환경변수 이름만 등록합니다. 값은 `.env`에 둡니다.
- 폐쇄망에서는 `CS_ALLOW_EXTERNAL_LLM=false`를 권장합니다. 외부 상용 API가 화면에서 숨겨지고 호출도 차단됩니다.
- 사내 LLM(vLLM 등)·임베딩(TEI 등)·Parser·Milvus 주소는 컨테이너에서 접근 가능한 주소로 등록합니다. `localhost`는 컨테이너 자신을 가리킵니다.
- Milvus를 TLS(`https://...:19530`)로 접속할 때 사내 CA 인증서는 `data/tls/ca.pem`처럼 `/data` 아래에 두고, 화면 **벡터 저장소**의 "CA 인증서 경로"에 `/data/tls/ca.pem`을 입력합니다. 구성 방법은 Milvus 번들 문서(`milvus-DEPLOY.md`)의 "엔진 TLS" 절을 참고하세요.

## 4. 업그레이드 · 백업

- 업그레이드: 새 tar를 `docker load` → `docker-compose.yml`의 이미지 태그 변경 → `docker compose up -d`. DB에 새 컬럼이 생기면 시작할 때 자동으로 추가됩니다.
- 백업: 컨테이너를 멈추고 `data/` 디렉터리를 복사합니다 (`studio.db`, `files/`, `parse_raw/`, `vectors/`). Milvus 데이터는 Milvus 쪽에서 백업합니다.

## 5. 참고

- API 문서 화면(`/docs`)은 Swagger UI를 인터넷 CDN에서 불러오므로 폐쇄망에서는 표시되지 않습니다. 스펙은 `/openapi.json`으로 받을 수 있습니다.
- 백그라운드 작업(청킹·적재)이 프로세스 안에서 돌기 때문에 uvicorn worker는 1개입니다. 컨테이너를 여러 개 띄우려면 DB를 PostgreSQL(`CS_DATABASE_URL`)로 바꾸고 작업 큐 도입이 필요합니다.
