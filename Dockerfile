# Образ ArchMap: API и интерфейс одним процессом (app/standalone.py). Один образ на все
# способы запуска из DEPLOY.md: Docker Compose (compose.yaml) и Kubernetes (Helm-чарт
# deploy/helm/archmap); готовые версии — ghcr.io/eidunyushkinhse/archmap.
#
#   docker build -t archmap .
#   docker buildx build --platform linux/amd64,linux/arm64 -t … .
#
# Фронт собирается на платформе сборки (результат от архитектуры не зависит), бэкенд
# ставится по lock с хэшами только из готовых колёс. Процесс — без root (UID 10001),
# корневая ФС может быть только для чтения: писать приложению нужно лишь в /tmp.

# Базовые образы — тег для чтения, digest для воспроизводимости; обновляет Dependabot
FROM --platform=$BUILDPLATFORM node:22-slim@sha256:6c74791e557ce11fc957704f6d4fe134a7bc8d6f5ca4403205b2966bd488f6b3 AS front
WORKDIR /src/frontend
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY frontend/ ./
RUN npm run build

FROM python:3.12-slim@sha256:a6e34c598f2467ed0e9a8d349809fcd8b5c603269512df273a0bb1784edc11b1
ARG VERSION=dev
ARG REVISION=""
LABEL org.opencontainers.image.title="ArchMap" \
      org.opencontainers.image.description="Многоуровневые архитектурные схемы, процессы и документация из кода" \
      org.opencontainers.image.source="https://github.com/eidunyushkinhse/archmap" \
      org.opencontainers.image.licenses="AGPL-3.0-only" \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.revision="${REVISION}"
ENV PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1
COPY backend/requirements-prod.lock /tmp/requirements-prod.lock
RUN pip install --require-hashes --only-binary=:all: -r /tmp/requirements-prod.lock \
    && rm /tmp/requirements-prod.lock \
    && groupadd --system --gid 10001 archmap \
    && useradd --system --uid 10001 --gid 10001 --home-dir /nonexistent --shell /usr/sbin/nologin archmap \
    && mkdir /data && chown archmap:archmap /data

WORKDIR /opt/archmap/backend
COPY backend/alembic.ini ./
COPY backend/alembic ./alembic
COPY backend/app ./app
COPY deploy/preflight.py /opt/archmap/deploy/
COPY deploy/docker/secret.sh deploy/docker/entrypoint.sh /opt/archmap/deploy/
COPY deploy/docker/archmap-admin /usr/local/bin/
COPY --from=front /src/frontend/dist /opt/archmap/frontend
# Байткод заранее: корневая ФС бывает только для чтения, а без него каждый рабочий
# процесс компилировал бы модули на старте
RUN python3 -m compileall -q /opt/archmap/backend/app \
    && echo "${VERSION}" > /opt/archmap/VERSION

ENV PYTHONDONTWRITEBYTECODE=1 \
    FRONTEND_DIR=/opt/archmap/frontend \
    WEB_CONCURRENCY=2 \
    TRUST_FORWARDED_FOR=false

# Числовой UID: Kubernetes с runAsNonRoot проверяет его без /etc/passwd
USER 10001:10001
EXPOSE 8080
HEALTHCHECK --interval=15s --timeout=5s --start-period=60s \
    CMD ["python3", "-c", "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8080/ready', timeout=4)"]
# Старт (entrypoint.sh): ключ подписи, проверка базы и миграции — затем сервер.
# TRUST_FORWARDED_FOR=false — прокси перед контейнером нет (Docker Compose); за Ingress
# или Gateway чарт включает его: адрес клиента там последний в X-Forwarded-For.
ENTRYPOINT ["/opt/archmap/deploy/entrypoint.sh"]
CMD ["python3", "-m", "uvicorn", "app.standalone:create_app", "--factory", \
     "--host", "0.0.0.0", "--port", "8080"]
