#!/usr/bin/env bash
# 인터넷이 되는 PC에서 실행: 이미지를 빌드하고 폐쇄망 반입용 tar.gz를 만든다.
#
#   deploy/offline/build.sh [버전]        # 버전 생략 시 git 커밋 해시
#
# 결과물 (dist/):
#   chunking-studio-<버전>.tar.gz          docker load 로 올릴 이미지
#   chunking-studio-<버전>.tar.gz.sha256   무결성 확인용
#   chunking-studio-<버전>.manifest.txt    빌드 정보 (베이스 이미지 digest 등)
#   docker-compose.yml, env.example, README.md  배포 서버에 함께 가져갈 파일
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"

VERSION="${1:-$(git rev-parse --short HEAD 2>/dev/null || echo dev)}"
if [ -n "$(git status --porcelain 2>/dev/null)" ] && [ -z "${1:-}" ]; then
  VERSION="${VERSION}-dirty"
fi
IMAGE="chunking-studio:${VERSION}"
PLATFORM="${PLATFORM:-linux/amd64}"
OUT="$ROOT/dist"
NAME="chunking-studio-${VERSION}"

echo "==> 이미지 빌드: ${IMAGE} (${PLATFORM})"
docker build --platform "$PLATFORM" --pull \
  --build-arg "APP_VERSION=${VERSION}" \
  -f deploy/offline/Dockerfile -t "$IMAGE" .

mkdir -p "$OUT"
echo "==> 이미지 저장: dist/${NAME}.tar.gz"
docker save "$IMAGE" | gzip -6 > "$OUT/${NAME}.tar.gz"
( cd "$OUT" && sha256sum "${NAME}.tar.gz" > "${NAME}.tar.gz.sha256" )

echo "==> 배포 파일 복사"
sed "s#chunking-studio:VERSION#${IMAGE}#" deploy/offline/docker-compose.yml > "$OUT/docker-compose.yml"
cp deploy/offline/env.example "$OUT/env.example"
cp deploy/offline/README.md "$OUT/README.md"

{
  echo "image: ${IMAGE}"
  echo "platform: ${PLATFORM}"
  echo "built_at: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "git_commit: $(git rev-parse HEAD 2>/dev/null || echo unknown)"
  echo "image_id: $(docker image inspect --format '{{.Id}}' "$IMAGE")"
  echo "image_size: $(docker image inspect --format '{{.Size}}' "$IMAGE") bytes"
  for base in registry.access.redhat.com/ubi9/python-312:1 registry.access.redhat.com/ubi9/nodejs-22:1; do
    echo "base: ${base} $(docker image inspect --format '{{index .RepoDigests 0}}' "$base" 2>/dev/null || echo '?')"
  done
} > "$OUT/${NAME}.manifest.txt"

echo
echo "완료:"
ls -lh "$OUT" | sed 's/^/  /'
echo
echo "폐쇄망 서버에서:  docker load -i ${NAME}.tar.gz  (자세한 절차는 dist/README.md)"
