# Chunking Studio — 폐쇄망 배포용 단일 이미지 (Red Hat UBI 9, Milvus 제외)
#
# - 인터넷이 되는 PC에서 빌드한 뒤 `docker save`로 tar를 만들어 폐쇄망 서버로 옮긴다.
# - 실행 시 외부 네트워크가 필요 없도록 Python 패키지와 빌드된 프론트엔드를 모두 이미지에 넣는다.
# - 화면(/)과 API(/api)를 한 컨테이너(uvicorn, 포트 8000)가 제공한다.
#
# 빌드 (저장소 루트에서):  deploy/offline/build.sh  또는
#   docker build -f deploy/offline/Dockerfile -t chunking-studio:<버전> .

ARG NODE_IMAGE=registry.access.redhat.com/ubi9/nodejs-22:1
ARG PYTHON_IMAGE=registry.access.redhat.com/ubi9/python-312:1

# ---------------------------------------------------------------- 1) 프론트엔드 빌드
FROM ${NODE_IMAGE} AS frontend
USER 0
WORKDIR /build/frontend
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY frontend/ ./
RUN npm run build

# ---------------------------------------------------------------- 2) Python 의존성 목록 (uv.lock 기준 고정 버전)
FROM ${PYTHON_IMAGE} AS deps
USER 0
WORKDIR /build
COPY backend/pyproject.toml backend/uv.lock ./
RUN pip install --no-cache-dir "uv==0.12.2" \
 && uv export --frozen --no-dev --no-emit-project --no-hashes -o requirements.txt

# ---------------------------------------------------------------- 3) 실행 이미지
FROM ${PYTHON_IMAGE}
ARG APP_VERSION=dev
LABEL org.opencontainers.image.title="chunking-studio" \
      org.opencontainers.image.description="RAG 청킹 실험·검증 스튜디오 (Milvus 제외, 폐쇄망 배포용)" \
      org.opencontainers.image.version="${APP_VERSION}"

USER 0
COPY --from=deps /build/requirements.txt /tmp/requirements.txt
RUN pip install --no-cache-dir -r /tmp/requirements.txt && rm -f /tmp/requirements.txt

WORKDIR /opt/chunking-studio
COPY backend/app ./backend/app
COPY --from=frontend /build/frontend/dist ./static

# 데이터(SQLite DB, 업로드 원본, Parser 원본 응답, 메모리 벡터 저장소)는 /data 볼륨에 둔다.
# OpenShift처럼 임의 UID로 실행돼도 쓸 수 있도록 그룹 0에 쓰기 권한을 준다.
RUN mkdir -p /data && chown -R 1001:0 /data /opt/chunking-studio && chmod -R g=u /data /opt/chunking-studio

ENV CS_DATA_DIR=/data \
    CS_STATIC_DIR=/opt/chunking-studio/static \
    CS_ENV_FILE=/data/.env \
    CS_PUBLIC_BASE_URL=http://127.0.0.1:8000 \
    CS_CORS_ORIGINS=http://localhost:8000 \
    CS_MILVUS_URI=http://milvus:19530 \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    APP_VERSION=${APP_VERSION}

USER 1001
WORKDIR /opt/chunking-studio/backend
VOLUME ["/data"]
EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD curl -fsS http://127.0.0.1:8000/api/health || exit 1

# 백그라운드 작업(청킹·적재)과 SQLite를 프로세스 하나가 다루므로 worker는 1개로 고정한다.
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000", "--workers", "1"]
