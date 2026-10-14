#!/usr/bin/env bash
# Аварийная остановка ArchMap, если процессы остались висеть в фоне
# (например, запускались не через ./dev.sh). Обычно достаточно Ctrl+C в dev.sh.
#
# Гасит только процессы ЭТОЙ копии репозитория: кандидаты по шаблону, но процесс —
# python или node, и его рабочий каталог обязан лежать внутри неё (аудит P-25: прежний `pkill -f vite`
# гасил любой процесс со словом vite — чужие проекты, второй экземпляр в другом каталоге).
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
killed=0
for pat in 'uvicorn app.main:app' 'node_modules/.bin/vite|vite/bin/vite.js'; do
  for pid in $(pgrep -f "$pat" 2>/dev/null); do
    # Сам процесс — python (uvicorn) или node (vite), а не оболочка/редактор, у которых
    # шаблон просто встретился в командной строке.
    exe="$(basename "$(readlink "/proc/$pid/exe" 2>/dev/null || true)")"
    case "$exe" in python*|node) ;; *) continue ;; esac
    cwd="$(readlink "/proc/$pid/cwd" 2>/dev/null || true)"
    case "$cwd" in
      "$ROOT"|"$ROOT"/*)
        if kill "$pid" 2>/dev/null; then
          echo "[stop] остановлено: $pat (pid $pid)"
          killed=1
        fi ;;
    esac
  done
done
[ "$killed" = 0 ] && echo "[stop] активных процессов ArchMap не найдено."
exit 0
