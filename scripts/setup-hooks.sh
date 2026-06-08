#!/usr/bin/env bash
# Подключает трекаемые git-хуки (scripts/git-hooks) через core.hooksPath.
# Идемпотентно: можно звать сколько угодно. Вызывается из dev.sh, но можно и руками.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

chmod +x scripts/git-hooks/* 2>/dev/null || true

current="$(git config --local core.hooksPath || true)"
if [ "$current" != "scripts/git-hooks" ]; then
  git config --local core.hooksPath scripts/git-hooks
  printf '\033[1;32m[hooks]\033[0m core.hooksPath → scripts/git-hooks (pre-commit гейт включён)\n'
fi
