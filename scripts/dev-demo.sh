#!/usr/bin/env bash
# Второй экземпляр ArchMap в демо-режиме рядом с основным ./dev.sh
# (docs/tasks/demo-mode.md): своя БД archmap_demo, бэкенд на 8001, фронт на 5174.
# Основной экземпляр и его БД не трогает.
#
#   scripts/dev-demo.sh        — поднять (держит терминал, как ./dev.sh; Ctrl+C гасит)
#   scripts/dev-demo.sh stop   — остановить ТОЛЬКО демо-экземпляр
#
# Устроен поверх ./dev.sh: переменные окружения важнее backend/.env (pydantic-
# settings), поэтому DATABASE_URL и DEMO_MODE отсюда перекрывают .env основного,
# а миграции dev.sh накатывает в ту же archmap_demo. SECRET_KEY берётся из .env.
# ./stop.sh для демо не годится: он гасит все uvicorn и vite, включая основной.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

DEMO_BACKEND_PORT="${DEMO_BACKEND_PORT:-8001}"
DEMO_FRONTEND_PORT="${DEMO_FRONTEND_PORT:-5174}"
DEMO_DB_NAME="${DEMO_DB_NAME:-archmap_demo}"
DB_USER="${DB_USER:-postgres}"
DB_PASSWORD="${DB_PASSWORD:-postgres}"
DB_HOST="${DB_HOST:-localhost}"
DB_PORT="${DB_PORT:-5432}"

if [ "${1:-}" = "stop" ]; then
  stopped=0
  # Ищем процессы по порту в командной строке: у основного экземпляра порты другие.
  if pkill -f "app\.main:app .*--port ${DEMO_BACKEND_PORT}( |$)"; then
    echo "[demo] бэкенд на ${DEMO_BACKEND_PORT} остановлен"; stopped=1
  fi
  if pkill -f "vite.*--port ${DEMO_FRONTEND_PORT}( |$)"; then
    echo "[demo] фронтенд на ${DEMO_FRONTEND_PORT} остановлен"; stopped=1
  fi
  [ "$stopped" = 0 ] && echo "[demo] демо-экземпляр не запущен."
  exit 0
fi

export DB_NAME="$DEMO_DB_NAME" DB_USER DB_PASSWORD DB_HOST DB_PORT
export DATABASE_URL="postgresql://${DB_USER}:${DB_PASSWORD}@${DB_HOST}:${DB_PORT}/${DEMO_DB_NAME}"
export DEMO_MODE=true
export CORS_ORIGINS="http://localhost:${DEMO_FRONTEND_PORT}"
# Прокси Vite второго фронта читает BACKEND_PORT (frontend/vite.config.ts).
export BACKEND_PORT="$DEMO_BACKEND_PORT"
export FRONTEND_PORT="$DEMO_FRONTEND_PORT"

exec "$ROOT/dev.sh"
