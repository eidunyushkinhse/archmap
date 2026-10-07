#!/usr/bin/env bash
# Образ ArchMap для OpenShift / Kubernetes и пакет для переноса в закрытый контур
# (DEPLOY.md, «OpenShift»). Запуск на машине с интернетом, Docker или Podman:
#   deploy/build-image.sh              → dist-bundle/archmap-<дата>-<коммит>-openshift.tar.gz
#   deploy/build-image.sh --worktree   → пробная сборка из рабочего дерева (с незакоммиченным)
# Сначала собирается обычная поставка (deploy/build-bundle.sh): она же контекст сборки
# образа, поэтому внутри контура образ пересобирается тем же Dockerfile без интернета.
# В пакете: образ (архив docker save), манифесты OpenShift с версией образа, DEPLOY.md.
# Переменные: ENGINE=docker|podman, BASE_IMAGE — свой базовый образ.
set -euo pipefail

ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
cd "$ROOT"

say() { printf '\033[1;36m[image]\033[0m %s\n' "$*"; }
die() { printf '\033[1;31m[image] ОШИБКА:\033[0m %s\n' "$*" >&2; exit 1; }

BUNDLE_ARGS=()
case "${1:-}" in
  "") ;;
  --worktree) BUNDLE_ARGS=(--worktree) ;;
  *) die "неизвестный параметр: $1" ;;
esac

if [ -z "${ENGINE:-}" ]; then
  for candidate in docker podman; do
    if command -v "$candidate" >/dev/null; then ENGINE="$candidate"; break; fi
  done
fi
[ -n "${ENGINE:-}" ] || die "нужен docker или podman"
"$ENGINE" info >/dev/null 2>&1 || die "$ENGINE не отвечает (Docker Desktop запущен?)"

COMMIT="$(git rev-parse --short HEAD)"
SUFFIX=""
[ ${#BUNDLE_ARGS[@]} -gt 0 ] && SUFFIX="-worktree"
export VERSION="${VERSION:-$(date +%Y%m%d)-$COMMIT$SUFFIX}"
deploy/build-bundle.sh "${BUNDLE_ARGS[@]}"
BUNDLE="dist-bundle/archmap-${VERSION}-linux-x86_64.tar.gz"
[ -f "$BUNDLE" ] || die "не найдена поставка $BUNDLE"

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
tar -xzf "$BUNDLE" -C "$WORK"
CTX="$WORK/archmap-${VERSION}-linux-x86_64"
IMAGE="archmap:${VERSION}"

BUILD=(build --pull --platform linux/amd64 -f "$CTX/deploy/openshift/Dockerfile" -t "$IMAGE"
  --build-arg "VERSION=$VERSION" --build-arg "REVISION=$(git rev-parse HEAD)"
  --build-arg "CREATED=$(date -u +%Y-%m-%dT%H:%M:%SZ)")
[ -n "${BASE_IMAGE:-}" ] && BUILD+=(--build-arg "BASE_IMAGE=$BASE_IMAGE")
if [ "$ENGINE" = podman ]; then
  BUILD+=(--format docker)
elif docker build --help 2>/dev/null | grep -q -- --provenance; then
  # Без аттестаций: реестры контура не всегда принимают индекс с ними
  BUILD+=(--provenance=false --sbom=false)
fi
say "Образ $IMAGE ($ENGINE)"
"$ENGINE" "${BUILD[@]}" "$CTX"

NAME="archmap-${VERSION}-openshift"
PKG="$WORK/$NAME"
mkdir -p "$PKG"
say "Пакет для контура"
if [ "$ENGINE" = podman ]; then
  podman save --format docker-archive -o "$PKG/archmap-image.tar" "$IMAGE"
else
  docker save -o "$PKG/archmap-image.tar" "$IMAGE"
fi
chmod 644 "$PKG/archmap-image.tar"
cp -a "$CTX/deploy/openshift" "$PKG/openshift"
rm -f "$PKG/openshift/Dockerfile"
sed -i "s|^\(\s*newTag:\).*|\1 \"$VERSION\"|" "$PKG/openshift/kustomization.yaml"
grep -q "newTag: \"$VERSION\"" "$PKG/openshift/kustomization.yaml" || die "не удалось проставить версию в kustomization.yaml"
cp "$CTX/DEPLOY.md" "$CTX/VERSION" "$PKG/"

tar -C "$WORK" -czf "dist-bundle/$NAME.tar.gz" "$NAME"
( cd dist-bundle && sha256sum "$NAME.tar.gz" > "$NAME.tar.gz.sha256" )
say "Готово: dist-bundle/$NAME.tar.gz ($(du -h "dist-bundle/$NAME.tar.gz" | cut -f1)); образ $IMAGE"
say "Та же версия для сборки внутри контура: $BUNDLE"
