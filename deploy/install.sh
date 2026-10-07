#!/usr/bin/env bash
# Установка и обновление ArchMap на голом Linux-сервере (подробно — DEPLOY.md).
# Запуск от root из распакованной поставки:
#   sudo ./deploy/install.sh --server-name archmap.example.local [--tls-cert ФАЙЛ --tls-key ФАЙЛ]
#   sudo ./deploy/install.sh --no-nginx     # обратный прокси настроен отдельно
# Первый запуск создаёт /etc/archmap/archmap.env и останавливается: впишите DATABASE_URL
# и запустите снова. Запуск с новой поставкой — обновление: миграции, переключение
# /opt/archmap/current на новый релиз, перезапуск службы; настройки и nginx не трогаются.
set -euo pipefail

SRC="$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/.." && pwd)"
VERSION="$(cat "$SRC/VERSION")"
# Пути переопределяются окружением — так установку проверяют без root во временном каталоге
PREFIX="${ARCHMAP_PREFIX:-/opt/archmap}"
ETC="${ARCHMAP_ETC:-/etc/archmap}"
SVC_USER="${ARCHMAP_USER:-archmap}"
UNIT_DIR="${ARCHMAP_UNIT_DIR:-/etc/systemd/system}"
NGINX_CONF="${ARCHMAP_NGINX_CONF:-/etc/nginx/conf.d/archmap.conf}"
BIN_DIR="${ARCHMAP_BIN_DIR:-/usr/local/bin}"
ENV_FILE="$ETC/archmap.env"
KEEP_RELEASES=3
NGINX_MARK="# ArchMap: сгенерировано deploy/install.sh"

say()  { printf '\033[1;36m[archmap]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[archmap] ВНИМАНИЕ:\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31m[archmap] ОШИБКА:\033[0m %s\n' "$*" >&2; exit 1; }

SERVER_NAME=""; TLS_CERT=""; TLS_KEY=""; WITH_NGINX=1; WITH_SYSTEMD=1
while [ $# -gt 0 ]; do
  case "$1" in
    --server-name) SERVER_NAME="${2:?}"; shift 2 ;;
    --tls-cert) TLS_CERT="${2:?}"; shift 2 ;;
    --tls-key) TLS_KEY="${2:?}"; shift 2 ;;
    --no-nginx) WITH_NGINX=0; shift ;;
    --no-systemd) WITH_SYSTEMD=0; shift ;;
    -h|--help) sed -n '2,8p' "$0"; exit 0 ;;
    *) die "неизвестный параметр: $1 (справка: --help)" ;;
  esac
done
[ -n "$TLS_CERT" ] && [ -z "$TLS_KEY" ] && die "--tls-cert без --tls-key"
[ -n "$TLS_KEY" ] && [ -z "$TLS_CERT" ] && die "--tls-key без --tls-cert"

IS_ROOT=0; [ "$(id -u)" = 0 ] && IS_ROOT=1
if [ "$IS_ROOT" = 0 ] && [ "$PREFIX" = /opt/archmap ]; then
  die "запустите от root: sudo $0 …"
fi
# nginx проверяем до любых изменений: имя сервера нужно для первой настройки
if [ "$WITH_NGINX" = 1 ]; then
  if [ ! -f "$NGINX_CONF" ] && [ -z "$SERVER_NAME" ]; then
    die "для настройки nginx нужен --server-name ИМЯ (адрес, по которому откроют ArchMap), или --no-nginx"
  fi
  if [ "$IS_ROOT" = 1 ] && ! command -v nginx >/dev/null; then
    die "nginx не установлен: поставьте его из репозитория дистрибутива (или --no-nginx)"
  fi
fi
for f in "$TLS_CERT" "$TLS_KEY"; do
  [ -z "$f" ] || [ -r "$f" ] || die "нет доступа к файлу сертификата: $f"
done

PY="$SRC/python/bin/python3"
# Команда от имени пользователя службы с окружением из archmap.env
as_service() {
  if [ "$IS_ROOT" = 1 ]; then runuser -u "$SVC_USER" -- "$@"; else "$@"; fi
}

# ── 1. Платформа и встроенный Python ─────────────────────────────────────────────
[ "$(uname -m)" = x86_64 ] || die "поставка собрана для x86_64, а процессор: $(uname -m)"
glibc="$(getconf GNU_LIBC_VERSION 2>/dev/null | awk '{print $2}')"
if [ -n "$glibc" ] && [ "$(printf '%s\n2.17\n' "$glibc" | sort -V | head -1)" != 2.17 ]; then
  die "нужна glibc 2.17 или новее, в системе $glibc"
fi
if [ "$WITH_SYSTEMD" = 1 ] && ! command -v systemctl >/dev/null; then
  die "systemd не найден: служба ставится через systemctl (или запустите с --no-systemd)"
fi
if ! "$PY" -c "import fastapi, psycopg2, uvicorn, bcrypt" 2>/dev/null; then
  die "встроенный Python не запускается ($PY). Частые причины: каталог смонтирован с noexec;
  на Astra Linux SE включена замкнутая программная среда (запуск только подписанных программ);
  политика SELinux запрещает запуск из этого каталога (журнал: ausearch -m avc)."
fi
say "Устанавливаю ArchMap $VERSION в $PREFIX"

# ── 2. Пользователь службы ───────────────────────────────────────────────────────
if [ "$IS_ROOT" = 1 ] && ! id -u "$SVC_USER" >/dev/null 2>&1; then
  nologin="$(command -v nologin || echo /bin/false)"
  useradd --system --home-dir "$PREFIX" --no-create-home --shell "$nologin" "$SVC_USER"
  say "Создан системный пользователь $SVC_USER"
fi

# ── 3. Релиз: копия поставки в releases/<версия> ─────────────────────────────────
REL="$PREFIX/releases/$VERSION"
mkdir -p "$PREFIX/releases"
if [ "$SRC" != "$REL" ]; then
  rm -rf "$REL.new"
  cp -a "$SRC" "$REL.new"
  rm -rf "$REL"
  mv "$REL.new" "$REL"
fi
# Время каталога — время установки: по нему уборка оставляет свежие релизы (cp -a
# переносит время из архива, у релизов одной сборки оно одинаковое)
touch "$REL"
# Байт-код заранее: служба работает на системе только для чтения и сама его не запишет
"$REL/python/bin/python3" -m compileall -q -j 0 "$REL/backend" "$REL/python/lib" >/dev/null 2>&1 || true
if [ "$IS_ROOT" = 1 ]; then
  chown -R root:root "$REL"
  chmod -R go-w "$REL"
fi
PY="$REL/python/bin/python3"
RUNENV=("$PY" "$REL/deploy/runenv.py" "$ENV_FILE" --)

# ── 4. Настройки ─────────────────────────────────────────────────────────────────
mkdir -p "$ETC"
if [ ! -f "$ENV_FILE" ]; then
  secret="$("$PY" -c 'import secrets; print(secrets.token_hex(32))')"
  if [ -n "$SERVER_NAME" ]; then
    origin="$([ -n "$TLS_CERT" ] && echo https || echo http)://$SERVER_NAME"
  else
    origin="http://localhost"
  fi
  sed -e "s|__SECRET__|$secret|" -e "s|__ORIGIN__|$origin|" "$REL/deploy/archmap.env.example" > "$ENV_FILE"
  chmod 640 "$ENV_FILE"
  [ "$IS_ROOT" = 1 ] && chown "root:$SVC_USER" "$ENV_FILE"
  say "Создан $ENV_FILE со случайным SECRET_KEY."
  say "Впишите в него DATABASE_URL (адрес PostgreSQL) и запустите установку снова."
  exit 2
fi
if grep -q 'ПАРОЛЬ@хост-БД' "$ENV_FILE"; then
  die "в $ENV_FILE не заполнен DATABASE_URL — впишите адрес PostgreSQL и запустите снова"
fi

# ── 5. База: проверка и миграции ─────────────────────────────────────────────────
( cd "$REL/backend" && as_service "${RUNENV[@]}" "$PY" "$REL/deploy/preflight.py" ) \
  || die "база не готова — см. сообщение выше"
say "Миграции схемы БД"
( cd "$REL/backend" && as_service "${RUNENV[@]}" "$PY" -m alembic upgrade head )

# ── 6. Переключение на новый релиз ───────────────────────────────────────────────
PREV="$(readlink "$PREFIX/current" 2>/dev/null || true)"
ln -sfn "releases/$VERSION" "$PREFIX/current.new"
mv -T "$PREFIX/current.new" "$PREFIX/current"
say "Текущий релиз: $VERSION${PREV:+ (был ${PREV#releases/})}"

# ── 7. Служба systemd ────────────────────────────────────────────────────────────
mkdir -p "$UNIT_DIR"
sed -e "s|__PREFIX__|$PREFIX|g" -e "s|__ETC__|$ETC|g" -e "s|__USER__|$SVC_USER|g" \
  "$REL/deploy/archmap.service" > "$UNIT_DIR/archmap.service"
port="$("$PY" -c 'import sys; sys.path.insert(0, sys.argv[1]); import runenv
print(runenv.read_env(sys.argv[2]).get("ARCHMAP_PORT", "8000"))' "$REL/deploy" "$ENV_FILE")"
if [ "$WITH_SYSTEMD" = 1 ] && [ "$IS_ROOT" = 1 ]; then
  systemctl daemon-reload
  systemctl enable --quiet archmap
  systemctl restart archmap
  say "Служба archmap перезапущена, жду ответа на 127.0.0.1:$port…"
  if ! "$PY" - "$port" <<'PYEOF'
import sys, time, urllib.request
for _ in range(60):
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{sys.argv[1]}/health", timeout=2) as r:
            if r.status == 200:
                sys.exit(0)
    except OSError:
        time.sleep(1)
sys.exit(1)
PYEOF
  then
    die "служба не ответила за минуту: journalctl -u archmap -n 50 --no-pager"
  fi
  say "Служба отвечает"
else
  say "Служба не запускалась (нет root или --no-systemd); юнит: $UNIT_DIR/archmap.service"
fi

# ── 8. nginx ─────────────────────────────────────────────────────────────────────
render_nginx() {
  local listen tls="" redirect=""
  if [ -n "$TLS_CERT" ]; then
    listen="listen 443 ssl;"
    tls="    ssl_certificate     $TLS_CERT;
    ssl_certificate_key $TLS_KEY;
    ssl_protocols       TLSv1.2 TLSv1.3;
"
    redirect="server {
    listen 80;
    server_name $SERVER_NAME;
    return 301 https://\$host\$request_uri;
}
"
  else
    listen="listen 80;"
  fi
  cat <<EOF
$NGINX_MARK. Перезаписывается только
# при повторной установке с --server-name; иначе правьте его сами.

# Вход: не больше 10 попыток в минуту с адреса (защита паролей от перебора)
limit_req_zone \$binary_remote_addr zone=archmap_login:10m rate=10r/m;

upstream archmap_backend {
    server 127.0.0.1:$port;
    keepalive 16;
}

${redirect}server {
    $listen
    server_name $SERVER_NAME;
${tls}
    root $PREFIX/current/frontend;
    # Ввоз архива проекта принимает до 64 МБ
    client_max_body_size 64m;

    gzip on;
    gzip_min_length 1024;
    gzip_types text/css application/javascript application/json image/svg+xml;

    proxy_http_version 1.1;
    proxy_set_header Connection "";
    proxy_set_header Host \$host;
    proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto \$scheme;

    location /api/ {
        proxy_pass http://archmap_backend;
        # Ввоз и экспорт больших проектов считаются дольше минуты
        proxy_read_timeout 300s;
    }
    location = /api/v1/auth/login {
        limit_req zone=archmap_login burst=10 nodelay;
        limit_req_status 429;
        error_page 429 = @archmap_login_limited;
        proxy_pass http://archmap_backend;
    }
    # Форма входа показывает detail из ответа — объясняем человеку, что случилось
    location @archmap_login_limited {
        default_type application/json;
        return 429 '{"detail":"Слишком много попыток входа. Подождите минуту и попробуйте снова."}';
    }
    location = /health {
        proxy_pass http://archmap_backend;
        access_log off;
    }
    # Сборка кладёт хэш в имя файла — кэшировать можно навсегда
    location /assets/ {
        expires 1y;
        add_header Cache-Control "public, immutable";
        try_files \$uri =404;
    }
    location / {
        add_header Cache-Control "no-cache";
        try_files \$uri /index.html;
    }
}
EOF
}

if [ "$WITH_NGINX" = 1 ]; then
  if [ -f "$NGINX_CONF" ] && [ -z "$SERVER_NAME" ]; then
    say "nginx: $NGINX_CONF уже есть — не трогаю"
  elif [ -f "$NGINX_CONF" ] && ! head -1 "$NGINX_CONF" | grep -qF "$NGINX_MARK"; then
    warn "nginx: $NGINX_CONF написан не установщиком — не перезаписываю"
  else
    mkdir -p "$(dirname "$NGINX_CONF")"
    render_nginx > "$NGINX_CONF"
    say "nginx: записан $NGINX_CONF"
  fi
  if [ "$IS_ROOT" = 1 ]; then
    if command -v getenforce >/dev/null && [ "$(getenforce)" = Enforcing ]; then
      setsebool -P httpd_can_network_connect 1
      chcon -R -t httpd_sys_content_t "$REL/frontend"
      say "SELinux: nginx разрешено обращаться к бэкенду и читать $REL/frontend"
    fi
    nginx -t -q || die "nginx -t нашёл ошибку в конфигурации"
    if systemctl is-active --quiet nginx; then systemctl reload nginx; else systemctl enable --now nginx; fi
    say "nginx перечитал конфигурацию"
  fi
fi

# ── 9. Команда администрирования и уборка старых релизов ─────────────────────────
mkdir -p "$BIN_DIR"
ln -sfn "$PREFIX/current/deploy/archmap-admin" "$BIN_DIR/archmap-admin"
mapfile -t old < <(ls -1dt "$PREFIX"/releases/*/ 2>/dev/null | tail -n +$((KEEP_RELEASES + 1)))
for d in "${old[@]}"; do
  [ "$(readlink -f "$d")" = "$(readlink -f "$PREFIX/current")" ] || rm -rf "$d"
done

say "Готово: ArchMap $VERSION."
if [ -z "$PREV" ]; then
  say "Первый администратор: sudo archmap-admin create-admin <логин>"
fi
if [ -n "$PREV" ] && [ "$PREV" != "releases/$VERSION" ]; then
  say "Откат кода: sudo ln -sfn $PREV $PREFIX/current && sudo systemctl restart archmap (схему БД откатывает только восстановление из резервной копии)"
fi
