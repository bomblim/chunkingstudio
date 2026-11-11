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

`dist/`에 `milvus-offline-v3.0.6.tar.gz`(+ `.sha256`, `.manifest.txt`)와 `dist/milvus/`(compose, env 예시, 이 문서)가 생깁니다.

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

## 4. 운영 참고

- 데이터: `milvus/volumes/` (milvus, etcd, minio). 백업은 컨테이너를 멈추고 이 디렉터리를 통째로 복사합니다.
- 인증: 기본 구성은 인증이 꺼져 있습니다. 사용하려면 Milvus 설정(`common.security.authorizationEnabled`)을 켜고, Studio 저장소의 "인증 토큰 환경변수"(`user:password`)를 등록합니다.
- 자원: 공식 권장 최소 사양은 CPU 8코어·메모리 32GB입니다(데이터 규모에 따라 조정).
