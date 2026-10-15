# shellcheck shell=sh
# Ключ подписи токенов входа для контейнера ArchMap (подключается из entrypoint.sh и
# archmap-admin). Задан SECRET_KEY в окружении — берётся он; иначе ключ создаётся при
# первом старте и хранится в томе /data: пересоздание контейнера не выкидывает
# пользователей из системы.
if [ -z "${SECRET_KEY:-}" ]; then
  if [ ! -s /data/secret_key ]; then
    (umask 077 && python3 -c 'import secrets; print(secrets.token_hex(32))' > /data/secret_key)
  fi
  SECRET_KEY="$(cat /data/secret_key)"
  export SECRET_KEY
fi
