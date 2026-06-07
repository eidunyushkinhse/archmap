# Локальный запуск ArchMap

Инструкция, чтобы поднимать проект самому — без участия Claude.

## TL;DR — быстрый старт

Если окружение уже настроено (см. «Первичная настройка» ниже), всё сводится к одной команде из корня проекта:

```bash
./dev.sh
```

Скрипт сам проверит Postgres, создаст БД при необходимости, применит миграции и поднимет бэк + фронт. Открывай **http://localhost:5173**. Остановить — **Ctrl+C** (гасит оба процесса разом).

Если что-то осталось висеть в фоне:

```bash
./stop.sh
```

---

## Что из чего состоит

| Сервис   | Адрес                       | Чем поднимается           |
|----------|-----------------------------|---------------------------|
| Frontend | http://localhost:5173       | Vite (`npm run dev`)      |
| Backend  | http://localhost:8000       | Uvicorn (FastAPI)         |
| Swagger  | http://localhost:8000/docs  | — встроен в бэкенд        |
| Postgres | localhost:5432, БД `archmap`| системная служба          |

Фронт ходит в бэк через прокси Vite: запросы на `/api` проксируются на `localhost:8000` (см. `frontend/vite.config.ts`). Отдельный URL прописывать не нужно.

---

## Первичная настройка (один раз)

Нужна, если клонировал проект заново или снёс venv/node_modules.

### 1. Postgres

Должен быть установлен и запущен, БД создаст скрипт. Проверить, что служба жива:

```bash
pg_isready -h localhost -p 5432        # → accepting connections
# если нет — запустить:
sudo service postgresql start          # или: sudo systemctl start postgresql
```

Дефолтные доступы (зашиты в `backend/app/config.py`): пользователь `postgres`, пароль `postgres`, БД `archmap`.

### 2. Бэкенд — venv и зависимости

```bash
cd backend
python3 -m venv venv
./venv/bin/pip install -r requirements.txt
```

(Опционально) свои доступы к БД/секрет — через `.env`:

```bash
cp .env.example .env       # потом поправить значения при необходимости
```

### 3. Фронтенд — зависимости

```bash
cd frontend
npm install
```

После этого `./dev.sh` поднимет всё сам.

---

## Ручной запуск (без скрипта)

Если хочется по отдельности — в двух терминалах:

**Терминал 1 — бэкенд:**
```bash
cd backend
./venv/bin/alembic upgrade head          # применить миграции
./venv/bin/uvicorn app.main:app --reload --port 8000
```

**Терминал 2 — фронтенд:**
```bash
cd frontend
npm run dev
```

---

## Частые проблемы

- **`Postgres не отвечает`** — служба не запущена: `sudo service postgresql start`.
- **`Не найден backend/venv`** — не сделана первичная настройка (см. шаг 2).
- **Порт занят (8000/5173)** — остался висеть старый процесс: `./stop.sh`, затем снова `./dev.sh`. Либо запустить на других портах: `BACKEND_PORT=8001 FRONTEND_PORT=5174 ./dev.sh`.
- **Ошибки про отсутствующие таблицы/колонки** — не накатились миграции: `cd backend && ./venv/bin/alembic upgrade head`.

---

## Переменные окружения для `dev.sh`

Все необязательные, можно переопределить перед запуском:

```bash
BACKEND_PORT=8001 FRONTEND_PORT=5174 DB_NAME=archmap_test ./dev.sh
```

Доступны: `BACKEND_PORT`, `FRONTEND_PORT`, `DB_NAME`, `DB_USER`, `DB_PASSWORD`, `DB_HOST`, `DB_PORT`.
