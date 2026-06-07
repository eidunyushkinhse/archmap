#!/usr/bin/env bash
# Аварийная остановка ArchMap, если процессы остались висеть в фоне
# (например, запускались не через ./dev.sh). Обычно достаточно Ctrl+C в dev.sh.
set -uo pipefail

killed=0
for pat in 'uvicorn app.main:app' 'vite'; do
  if pkill -f "$pat" 2>/dev/null; then
    echo "[stop] остановлено: $pat"
    killed=1
  fi
done
[ "$killed" = 0 ] && echo "[stop] активных процессов ArchMap не найдено."
