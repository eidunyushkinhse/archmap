#!/usr/bin/env bash
# Сборка офлайн-поставки ArchMap для голого Linux-сервера (DEPLOY.md, «Сборка поставки»).
# Запуск на машине с интернетом (Linux x86_64, git, Node.js 22+, curl):
#   deploy/build-bundle.sh              → dist-bundle/archmap-<дата>-<коммит>-linux-x86_64.tar.gz
#   deploy/build-bundle.sh --worktree   → пробная сборка из рабочего дерева (с незакоммиченным)
# Внутри: переносной CPython со всеми зависимостями, бэкенд, собранный фронт и скрипты
# установки. Серверу не нужны ни интернет, ни свой Python, ни Node.js.
set -euo pipefail

ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
cd "$ROOT"

# Переносной CPython (github.com/astral-sh/python-build-standalone), сборка
# install_only_stripped: самодостаточный интерпретатор без отладочных символов, требует
# только x86_64 и glibc 2.17+. Версию меняют вместе с контрольной суммой из SHA256SUMS релиза.
PY_VERSION="3.12.15"
PY_RELEASE="20261003"
PY_SHA256="731af898886c5f821890dc901eca3c651cca8e51fa7308c159d12a1194aeac91"
PY_ASSET="cpython-${PY_VERSION}+${PY_RELEASE}-x86_64-unknown-linux-gnu-install_only_stripped.tar.gz"
PY_URL="https://github.com/astral-sh/python-build-standalone/releases/download/${PY_RELEASE}/${PY_ASSET//+/%2B}"

say() { printf '\033[1;36m[bundle]\033[0m %s\n' "$*"; }
die() { printf '\033[1;31m[bundle] ОШИБКА:\033[0m %s\n' "$*" >&2; exit 1; }

FROM_WORKTREE=0
case "${1:-}" in
  "") ;;
  --worktree) FROM_WORKTREE=1 ;;
  *) die "неизвестный параметр: $1" ;;
esac
[ "$(uname -s)-$(uname -m)" = Linux-x86_64 ] || die "собирать на Linux x86_64: зависимости ставятся в переносной Python"
for tool in git npm curl sha256sum tar; do
  command -v "$tool" >/dev/null || die "не найден $tool"
done

COMMIT="$(git rev-parse --short HEAD)"
if [ "$FROM_WORKTREE" = 1 ]; then
  VERSION="${VERSION:-$(date +%Y%m%d)-$COMMIT-worktree}"
else
  VERSION="${VERSION:-$(date +%Y%m%d)-$COMMIT}"
  if ! git diff --quiet HEAD -- || [ -n "$(git ls-files --others --exclude-standard)" ]; then
    say "Незакоммиченные правки в поставку не попадут: собираю HEAD ($COMMIT)"
  fi
fi
NAME="archmap-${VERSION}-linux-x86_64"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
SRC="$WORK/src"
STAGE="$WORK/$NAME"
mkdir -p "$SRC" "$STAGE"

say "Исходники ($([ "$FROM_WORKTREE" = 1 ] && echo "рабочее дерево" || echo "HEAD $COMMIT"))"
PATHS=(backend frontend deploy DEPLOY.md)
if [ "$FROM_WORKTREE" = 1 ]; then
  git ls-files -z --cached --others --exclude-standard -- "${PATHS[@]}" \
    | tar --null -T - -cf - | tar -xf - -C "$SRC"
else
  git archive HEAD -- "${PATHS[@]}" | tar -xf - -C "$SRC"
fi

say "Фронтенд: npm ci + vite build"
( cd "$SRC/frontend" && npm ci --no-audit --no-fund --loglevel=error >/dev/null && npx vite build --logLevel error )
mkdir -p "$STAGE/frontend"
cp -a "$SRC/frontend/dist/." "$STAGE/frontend/"

say "Python $PY_VERSION"
CACHE="${XDG_CACHE_HOME:-$HOME/.cache}/archmap-bundle"
mkdir -p "$CACHE"
if [ ! -f "$CACHE/$PY_ASSET" ]; then
  curl -fsSL --retry 3 -o "$CACHE/$PY_ASSET.part" "$PY_URL"
  mv "$CACHE/$PY_ASSET.part" "$CACHE/$PY_ASSET"
fi
echo "$PY_SHA256  $CACHE/$PY_ASSET" | sha256sum -c --quiet - || die "контрольная сумма $PY_ASSET не сошлась"
tar -xzf "$CACHE/$PY_ASSET" -C "$STAGE"

say "Зависимости бэкенда (только готовые бинарные пакеты)"
"$STAGE/python/bin/python3" -m pip install --quiet --no-cache-dir --disable-pip-version-check \
  --only-binary=:all: --no-compile -r "$SRC/backend/requirements-prod.txt"

say "Бэкенд и скрипты установки"
mkdir -p "$STAGE/backend"
cp -a "$SRC/backend/app" "$SRC/backend/alembic" "$SRC/backend/alembic.ini" \
  "$SRC/backend/requirements-prod.txt" "$STAGE/backend/"
cp -a "$SRC/deploy" "$STAGE/deploy"
rm -f "$STAGE/deploy/build-bundle.sh"
cp "$SRC/DEPLOY.md" "$STAGE/"
printf '%s\n' "$VERSION" > "$STAGE/VERSION"
find "$STAGE/backend" "$STAGE/deploy" -name __pycache__ -prune -exec rm -rf {} +

mkdir -p "$ROOT/dist-bundle"
tar -C "$WORK" -czf "$ROOT/dist-bundle/$NAME.tar.gz" "$NAME"
( cd "$ROOT/dist-bundle" && sha256sum "$NAME.tar.gz" > "$NAME.tar.gz.sha256" )
say "Готово: dist-bundle/$NAME.tar.gz ($(du -h "$ROOT/dist-bundle/$NAME.tar.gz" | cut -f1))"
