#!/usr/bin/env bash
# Локальный запуск ArchMap одной командой: ./dev.sh
# Поднимает бэкенд (FastAPI) и фронтенд (Vite), держит оба в этом терминале.
# Останавливаются вместе по Ctrl+C.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"

# --- 0. Pre-commit гейт: подключаем трекаемые git-хуки (идемпотентно) ---
bash scripts/setup-hooks.sh || true

# --- настройки (можно переопределить через окружение) ---
BACKEND_PORT="${BACKEND_PORT:-8000}"
FRONTEND_PORT="${FRONTEND_PORT:-5173}"
DB_NAME="${DB_NAME:-archmap}"
DB_USER="${DB_USER:-postgres}"
DB_HOST="${DB_HOST:-localhost}"
DB_PORT="${DB_PORT:-5432}"

say()  { printf '\033[1;36m[dev]\033[0m %s\n' "$*"; }
err()  { printf '\033[1;31m[dev] ОШИБКА:\033[0m %s\n' "$*" >&2; }

# --- 1. Проверка Postgres ---
if ! pg_isready -h "$DB_HOST" -p "$DB_PORT" -q; then
  err "Postgres не отвечает на $DB_HOST:$DB_PORT."
  err "Запусти его:  sudo service postgresql start   (или: sudo systemctl start postgresql)"
  exit 1
fi
say "Postgres на $DB_HOST:$DB_PORT доступен."

# --- 2. Проверка/создание БД ---
if ! PGPASSWORD="${DB_PASSWORD:-postgres}" psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" \
       -tAc "SELECT 1 FROM pg_database WHERE datname='$DB_NAME'" 2>/dev/null | grep -q 1; then
  say "БД '$DB_NAME' не найдена — создаю."
  PGPASSWORD="${DB_PASSWORD:-postgres}" createdb -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" "$DB_NAME"
fi

# --- 2b. Проверка/создание backend/.env (fail-fast конфиг требует SECRET_KEY) ---
if [ ! -f backend/.env ]; then
  say "backend/.env не найден — создаю со случайным SECRET_KEY."
  GEN_SECRET="$(openssl rand -hex 32)"
  cat > backend/.env <<EOF
DATABASE_URL=postgresql://${DB_USER}:${DB_PASSWORD:-postgres}@${DB_HOST}:${DB_PORT}/${DB_NAME}
SECRET_KEY=${GEN_SECRET}
CORS_ORIGINS=http://localhost:${FRONTEND_PORT}
EOF
elif grep -q "change-me-in-production-needs-32-bytes" backend/.env; then
  err "В backend/.env секрет-заглушка. Замените SECRET_KEY: openssl rand -hex 32."
  exit 1
fi

# --- 3. Бэкенд: venv + миграции ---
if [ ! -x backend/venv/bin/uvicorn ]; then
  err "Не найден backend/venv. Создай окружение:"
  err "  cd backend && python3 -m venv venv && ./venv/bin/pip install -r requirements.txt"
  exit 1
fi
say "Применяю миграции Alembic (upgrade head)."
( cd backend && ./venv/bin/alembic upgrade head )

# --- 4. Фронтенд: зависимости ---
if [ ! -d frontend/node_modules ]; then
  say "Ставлю зависимости фронта (npm install) — это один раз."
  ( cd frontend && npm install )
fi

# --- 5. Останавливаем оба процесса при выходе ---
pids=()
cleanup() {
  say "Останавливаю сервисы…"
  for pid in "${pids[@]}"; do
    kill "$pid" 2>/dev/null || true
  done
  wait 2>/dev/null || true
  say "Остановлено."
}
trap cleanup INT TERM EXIT

# --- 6. Запуск ---
say "Бэкенд → http://localhost:$BACKEND_PORT  (Swagger: /docs)"
( cd backend && exec ./venv/bin/uvicorn app.main:app --reload \
    --host 127.0.0.1 --port "$BACKEND_PORT" ) &
pids+=("$!")

say "Фронтенд → http://localhost:$FRONTEND_PORT"
( cd frontend && exec npm run dev -- --port "$FRONTEND_PORT" ) &
pids+=("$!")

say "Готово. Открой http://localhost:$FRONTEND_PORT — для остановки нажми Ctrl+C."

# Ждём, пока живы оба; если один упал — гасим второй и выходим.
wait -n
err "Один из процессов завершился — останавливаю второй."
exit 1
