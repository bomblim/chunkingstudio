#!/usr/bin/env bash
# 인터넷이 되는 PC에서 실행: Milvus standalone에 필요한 공식 이미지 3개를 받아 폐쇄망 반입용 tar.gz로 묶는다.
#
#   deploy/offline-milvus/build.sh [번들 이름 접미사]
#
# 결과물 (dist/):
#   milvus-offline-v3.0.6.tar.gz          docker load 로 올릴 이미지 묶음 (milvus, etcd, minio)
#   milvus-offline-v3.0.6.tar.gz.sha256   무결성 확인용
#   milvus-offline-v3.0.6.manifest.txt    이미지 목록과 digest
#   milvus/docker-compose.yml, milvus/env.example, milvus/README.md
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"

MILVUS_VERSION="v3.0.6"
IMAGES=(
  "milvusdb/milvus:${MILVUS_VERSION}"
  "quay.io/coreos/etcd:v3.5.25"
  "milvusdb/minio:RELEASE.2024-12-18T13-15-44Z"
)
PLATFORM="${PLATFORM:-linux/amd64}"
OUT="$ROOT/dist"
NAME="milvus-offline-${MILVUS_VERSION}${1:+-$1}"

mkdir -p "$OUT/milvus"
for img in "${IMAGES[@]}"; do
  echo "==> pull ${img} (${PLATFORM})"
  docker pull --platform "$PLATFORM" "$img"
done

echo "==> 이미지 저장: dist/${NAME}.tar.gz"
docker save "${IMAGES[@]}" | gzip -6 > "$OUT/${NAME}.tar.gz"
( cd "$OUT" && sha256sum "${NAME}.tar.gz" > "${NAME}.tar.gz.sha256" )

cp deploy/offline-milvus/docker-compose.yml deploy/offline-milvus/env.example deploy/offline-milvus/README.md "$OUT/milvus/"

{
  echo "bundle: ${NAME}"
  echo "platform: ${PLATFORM}"
  echo "built_at: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  for img in "${IMAGES[@]}"; do
    echo "image: ${img} $(docker image inspect --format '{{index .RepoDigests 0}}' "$img" 2>/dev/null || echo '?')"
  done
} > "$OUT/${NAME}.manifest.txt"

echo
echo "완료:"
ls -lh "$OUT/${NAME}"* "$OUT/milvus" | sed 's/^/  /'
echo
echo "폐쇄망 서버에서:  docker load -i ${NAME}.tar.gz  (자세한 절차는 dist/milvus/README.md)"
