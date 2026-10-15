#!/bin/sh
# Старт контейнера ArchMap: ключ подписи, проверка базы, миграции, затем команда (сервер).
# MIGRATE_ON_START=false — миграции идут отдельно: в Kubernetes их делает init-контейнер
# пода (чарт deploy/helm/archmap), а он вызывает этот же скрипт с командой true. Несколько
# подов мигрируют по очереди: alembic/env.py держит advisory-блокировку базы.
set -eu
. /opt/archmap/deploy/secret.sh
if [ "${MIGRATE_ON_START:-true}" = "true" ]; then
  python3 /opt/archmap/deploy/preflight.py
  python3 -m alembic upgrade head
fi
exec "$@"
