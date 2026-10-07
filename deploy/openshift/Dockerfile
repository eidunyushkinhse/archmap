# Образ ArchMap для OpenShift и Kubernetes (DEPLOY.md, «OpenShift»). Обычно его собирает
# deploy/build-image.sh.
#
# Контекст сборки — распакованная поставка deploy/build-bundle.sh: в ней переносной
# Python со всеми зависимостями, бэкенд и собранный фронт. Интернет сборке не нужен,
# только базовый образ. Его можно заменить своим: Linux x86_64 с glibc 2.17+, zlib и
# libstdc++ (проверка ниже остановит сборку, если чего-то не хватает):
#   docker build -f deploy/openshift/Dockerfile --build-arg BASE_IMAGE=… -t archmap:$(cat VERSION) .
#
# Образ работает от любого UID, как запускает OpenShift. Корневая ФС может быть только
# для чтения: приложение пишет лишь во временный каталог /tmp.
ARG BASE_IMAGE=registry.access.redhat.com/ubi9/ubi-minimal:9.8
FROM ${BASE_IMAGE}

ARG VERSION=dev
ARG REVISION=""
ARG CREATED=""
# Метки базового образа описывают UBI; свои — поверх них
LABEL name="archmap" \
      version="${VERSION}" \
      release="${VERSION}" \
      vendor="ArchMap" \
      maintainer="ArchMap" \
      summary="ArchMap: многоуровневые архитектурные схемы" \
      description="Веб-сервис многоуровневых архитектурных схем: API и интерфейс в одном процессе" \
      url="https://github.com/eidunyushkinhse/archmap" \
      io.k8s.display-name="ArchMap" \
      io.k8s.description="Веб-сервис многоуровневых архитектурных схем: API и интерфейс в одном процессе" \
      com.redhat.component="archmap" \
      vcs-ref="${REVISION}" \
      build-date="${CREATED}" \
      org.opencontainers.image.title="ArchMap" \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.revision="${REVISION}" \
      org.opencontainers.image.created="${CREATED}"

COPY python /opt/archmap/python
COPY backend /opt/archmap/backend
COPY frontend /opt/archmap/frontend
COPY deploy/preflight.py /opt/archmap/deploy/
COPY VERSION /opt/archmap/
WORKDIR /opt/archmap/backend

# Байткод заранее: писать в образ при работе нельзя, а без готового байткода каждый
# процесс компилировал бы модули на старте. Байткод сверяется с исходником по хэшу,
# а не по времени файлов: время в слоях образа может и не сохраниться.
RUN ["/opt/archmap/python/bin/python3", "-m", "compileall", "-q", "-j", "0", \
     "--invalidation-mode", "checked-hash", \
     "/opt/archmap/python/lib", "/opt/archmap/backend", "/opt/archmap/deploy"]
# Всё ли системное есть в базовом образе: импорт приложения и сервера целиком
RUN ["/opt/archmap/python/bin/python3", "-c", "import os; os.environ.update(DATABASE_URL='postgresql://check/none', SECRET_KEY='x' * 32); import app.standalone, uvloop, httptools"]

ENV PATH=/opt/archmap/python/bin:$PATH \
    LANG=C.UTF-8 \
    HOME=/tmp \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    FRONTEND_DIR=/opt/archmap/frontend \
    WEB_CONCURRENCY=2 \
    FORWARDED_ALLOW_IPS=*

USER 1001
EXPOSE 8080
# API и интерфейс в одном процессе (app/standalone.py); миграции — отдельной командой
# в init-контейнере (deploy/openshift/deployment.yaml)
CMD ["python3", "-m", "uvicorn", "app.standalone:create_app", "--factory", \
     "--host", "0.0.0.0", "--port", "8080", "--proxy-headers"]
