#!/bin/sh
# Старт контейнера ArchMap (compose.yaml): ключ подписи, проверка базы, миграции, сервер.
# Экземпляр один, поэтому миграции идут прямо здесь (в OpenShift — init-контейнером).
set -eu
. /opt/archmap/deploy/secret.sh
python3 /opt/archmap/deploy/preflight.py
python3 -m alembic upgrade head
exec "$@"
