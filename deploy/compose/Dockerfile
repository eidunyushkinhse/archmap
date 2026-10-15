# Образ ArchMap для Docker Compose (compose.yaml в корне репозитория): сборка из исходников.
# Фронт собирает Node, бэкенд ставится по lock с хэшами; API и интерфейс отдаёт один
# процесс (app/standalone.py). Для закрытого контура и OpenShift — отдельный образ из
# офлайн-поставки (deploy/openshift/Dockerfile, DEPLOY.md).

FROM node:22-slim AS front
WORKDIR /src/frontend
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY frontend/ ./
RUN npm run build

FROM python:3.12-slim
ENV PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1
COPY backend/requirements-prod.lock /tmp/requirements-prod.lock
RUN pip install --require-hashes --only-binary=:all: -r /tmp/requirements-prod.lock \
    && rm /tmp/requirements-prod.lock \
    && useradd --system --uid 10001 --home-dir /nonexistent --shell /usr/sbin/nologin archmap \
    && mkdir /data && chown archmap:archmap /data

WORKDIR /opt/archmap/backend
COPY backend/alembic.ini ./
COPY backend/alembic ./alembic
COPY backend/app ./app
COPY deploy/preflight.py /opt/archmap/deploy/
COPY deploy/compose/secret.sh deploy/compose/entrypoint.sh /opt/archmap/deploy/
COPY deploy/compose/archmap-admin /usr/local/bin/
COPY --from=front /src/frontend/dist /opt/archmap/frontend
# Байткод заранее: иначе каждый рабочий процесс компилирует модули на старте
RUN python3 -m compileall -q /opt/archmap/backend/app

ENV PYTHONDONTWRITEBYTECODE=1 \
    FRONTEND_DIR=/opt/archmap/frontend \
    WEB_CONCURRENCY=2 \
    TRUST_FORWARDED_FOR=false

USER archmap
EXPOSE 8080
HEALTHCHECK --interval=15s --timeout=5s --start-period=60s \
    CMD ["python3", "-c", "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8080/ready', timeout=4)"]
# Ключ подписи, проверка базы и миграции (entrypoint.sh), затем сервер. Прокси перед
# контейнером нет — заголовкам X-Forwarded-* не доверяем (TRUST_FORWARDED_FOR=false).
ENTRYPOINT ["/opt/archmap/deploy/entrypoint.sh"]
CMD ["python3", "-m", "uvicorn", "app.standalone:create_app", "--factory", \
     "--host", "0.0.0.0", "--port", "8080"]
