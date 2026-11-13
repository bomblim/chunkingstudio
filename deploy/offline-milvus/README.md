# Milvus 폐쇄망 배포 번들 (standalone v3.0.6)

Chunking Studio와 별도로 배포하는 Milvus 묶음입니다. Milvus 공식 이미지 3개를 그대로 사용합니다(Red Hat 기반 이미지가 아님).

| 이미지 | 역할 |
|---|---|
| `milvusdb/milvus:v3.0.6` | Milvus standalone (포트 19530, 헬스 9091) |
| `quay.io/coreos/etcd:v3.5.25` | 메타데이터 저장 |
| `milvusdb/minio:RELEASE.2024-12-18T13-15-44Z` | 벡터·세그먼트 저장 (외부 미노출) |

Chunking Studio(pymilvus 3.x)와 짝을 맞춘 버전입니다.

## 1. 번들 만들기 (인터넷이 되는 PC)

```bash
deploy/offline-milvus/build.sh
```

`dist/`에 `milvus-offline-v3.0.6.tar.gz`(+ `.sha256`, `.manifest.txt`)와 `dist/milvus/`(compose, env 예시, nginx 예시 2개, 이 문서)가 생깁니다.

## 2. 폐쇄망 서버에서 실행

```bash
sha256sum -c milvus-offline-v3.0.6.tar.gz.sha256
docker load -i milvus-offline-v3.0.6.tar.gz
cd milvus
cp env.example .env          # MinIO 계정을 바꾸려면 처음 실행 전에 수정
docker compose up -d
docker compose ps            # standalone이 healthy가 될 때까지 1~2분
curl http://localhost:9091/healthz
```

Podman: `podman load -i ...` 후 `podman-compose up -d`.

## 3. Chunking Studio 연결

- **다른 서버**: Studio의 `.env`에 `CS_MILVUS_URI=http://<Milvus 서버>:19530`
- **같은 서버**: Studio 컨테이너를 Milvus 네트워크에 붙이고 `CS_MILVUS_URI=http://milvus-standalone:19530`
  ```yaml
  # Studio docker-compose.yml에 추가
  services:
    chunking-studio:
      networks: [milvus]
  networks:
    milvus:
      external: true
  ```

이미 등록된 저장소 주소는 화면 **벡터 저장소**에서 바꾸고 "연결 테스트"로 확인합니다.

## 4. 엔진 TLS + 관리 화면 인증 (nginx)

엔진(19530)은 같은 서버의 nginx가 TLS로 받아 Milvus로 넘기고(`grpc_pass`), 관리(9091)는 기존 사이트의 `/milvus/` 경로에 인증을 걸어 엽니다(`https://<호스트>/milvus/` → WebUI). 예시 설정: 엔진 [`nginx-milvus.conf`](nginx-milvus.conf), 관리 화면 [`nginx-milvus-admin.conf`](nginx-milvus-admin.conf).

1. Milvus를 로컬에서만 받도록 `.env` 수정 후 `docker compose up -d`
   ```ini
   MILVUS_BIND=127.0.0.1
   MILVUS_PORT=29530          # nginx가 19530을 쓰므로 내부 포트를 옮김
   MILVUS_HEALTH_BIND=127.0.0.1
   ```
2. 인증서 준비: 서버 인증서의 SAN에 Studio가 접속할 호스트명(예: `DNS:milvus.example.com`)이 있어야 합니다. 사내 CA라면 중간 CA까지 이어 붙인 체인을 `ssl_certificate`에 넣습니다.
3. `nginx-milvus.conf`를 `/etc/nginx/conf.d/milvus.conf`로 복사해 호스트명·인증서 경로를 고칩니다. 관리 화면은 `nginx-milvus-admin.conf`를 `/etc/nginx/snippets/milvus-admin.conf`로 복사하고, 기존 사이트 `server { }` 안에 `include /etc/nginx/snippets/milvus-admin.conf;`를 넣습니다(계정: `htpasswd -c /etc/nginx/.htpasswd-milvus admin`). 그다음 `nginx -t && systemctl reload nginx`
4. RHEL(SELinux enforcing)에서는 nginx가 19530 포트를 열고 Milvus로 접속할 수 있게 허용합니다.
   ```bash
   sudo semanage port -a -t http_port_t -p tcp 19530
   sudo setsebool -P httpd_can_network_connect 1
   ```
5. 방화벽에서 19530은 Studio·RAG 런타임 서버만 허용합니다.
6. Studio **벡터 저장소**에서 URI를 `https://milvus.example.com:19530`으로 바꾸고, 사내 CA면 **CA 인증서 경로**에 CA 파일(컨테이너 안 경로, 예: `/data/tls/ca.pem`)을 지정한 뒤 "연결 테스트"를 누릅니다. 인증서 이름과 URI 호스트가 다르면(IP로 접속 등) **인증서 서버 이름**에 인증서의 호스트명을 넣습니다.

참고:
- WebUI는 화면·API 경로가 루트(`/webui`, `/api/v1`) 기준이라, 예시 설정은 nginx `sub_filter`로 응답의 두 곳을 `/milvus` 아래로 바꿉니다. Milvus 버전을 올리면 접속해서 다시 확인하세요(v3.0.6에서 확인).
- pymilvus(gRPC)는 OS 신뢰 저장소가 아니라 gRPC 내장 공인 CA 목록을 씁니다. 사내 CA 인증서는 반드시 CA 파일을 지정해야 합니다.
- 이 구성은 gRPC만 통과시킵니다. Milvus REST API(`/v2/vectordb/...`)를 TLS로 쓰려면 별도 `server`(예: 다른 포트)에서 `proxy_pass http://127.0.0.1:29530`으로 넘깁니다.
- nginx 1.25.1 이상은 `listen ... http2` 대신 `http2 on;`을 권장합니다(기존 형식도 경고만 내고 동작).

## 5. 운영 참고

- 데이터: `milvus/volumes/` (milvus, etcd, minio). 백업은 컨테이너를 멈추고 이 디렉터리를 통째로 복사합니다.
- 인증: 기본 구성은 인증이 꺼져 있습니다. 사용하려면 Milvus 설정(`common.security.authorizationEnabled`)을 켜고, Studio 저장소의 "인증 토큰 환경변수"(`user:password`)를 등록합니다. 비밀번호가 평문으로 다니지 않도록 4장의 TLS와 함께 쓰는 것을 권장합니다.
- 자원: 공식 권장 최소 사양은 CPU 8코어·메모리 32GB입니다(데이터 규모에 따라 조정).
