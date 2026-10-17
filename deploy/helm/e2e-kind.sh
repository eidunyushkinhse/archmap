#!/usr/bin/env bash
# Проверка Helm-чарта в kind — тот же сценарий в CI (джоба helm-kind) и локально:
#   образ из рабочего дерева → кластер kind → PostgreSQL в своём namespace → чарт в
#   namespace со строгим Pod Security («restricted») → helm test → интерфейс и /ready
#   через port-forward → первый администратор и вход → личный токен и /mcp (удалённый
#   MCP-сервер) → helm upgrade не меняет ключ подписи (выданный до обновления токен
#   продолжает работать).
#
#   deploy/helm/e2e-kind.sh
# Переменные: KIND, HELM, KUBECTL — пути к утилитам; NODE_IMAGE — образ узла kind
# (например kindest/node:v1.34.11, если Docker на cgroup v1); KEEP=1 — не удалять кластер;
# SKIP_BUILD=1 — взять уже собранный образ archmap:e2e.
set -euo pipefail

KIND="${KIND:-kind}"; HELM="${HELM:-helm}"; KUBECTL="${KUBECTL:-kubectl}"
CLUSTER="${CLUSTER:-archmap-e2e}"
IMAGE=archmap:e2e
NS=archmap
ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
WORK="$(mktemp -d)"
PASSWORD=e2e-admin-password-1
PF_PID=""

say() { printf '\033[1;36m[e2e]\033[0m %s\n' "$*"; }
die() { printf '\033[1;31m[e2e] ОШИБКА:\033[0m %s\n' "$*" >&2; exit 1; }
cleanup() {
  [ -n "$PF_PID" ] && kill "$PF_PID" 2>/dev/null || true
  rm -rf "$WORK"
  if [ "${KEEP:-0}" != 1 ]; then "$KIND" delete cluster --name "$CLUSTER" >/dev/null 2>&1 || true; fi
}
trap cleanup EXIT
k() { "$KUBECTL" --context "kind-$CLUSTER" "$@"; }

if [ "${SKIP_BUILD:-0}" != 1 ]; then
  say "Образ $IMAGE"
  docker build -q -t "$IMAGE" "$ROOT" >/dev/null
fi

say "Кластер kind «$CLUSTER»"
"$KIND" get clusters 2>/dev/null | grep -qx "$CLUSTER" ||
  "$KIND" create cluster --name "$CLUSTER" ${NODE_IMAGE:+--image "$NODE_IMAGE"} --wait 180s
# Архивом, а не load docker-image: так работает и с хранилищем образов containerd
docker save "$IMAGE" -o "$WORK/image.tar"
"$KIND" load image-archive "$WORK/image.tar" --name "$CLUSTER"

say "PostgreSQL 16 в namespace db"
k create namespace db --dry-run=client -o yaml | k apply -f - >/dev/null
k -n db apply -f - >/dev/null <<'EOF'
apiVersion: apps/v1
kind: Deployment
metadata: {name: postgres}
spec:
  selector: {matchLabels: {app: postgres}}
  template:
    metadata: {labels: {app: postgres}}
    spec:
      containers:
        - name: postgres
          image: postgres:16-alpine
          env:
            - {name: POSTGRES_DB, value: archmap}
            - {name: POSTGRES_USER, value: archmap}
            - {name: POSTGRES_PASSWORD, value: archmap}
          readinessProbe:
            exec: {command: ["pg_isready", "-U", "archmap", "-d", "archmap"]}
            periodSeconds: 2
---
apiVersion: v1
kind: Service
metadata: {name: postgres}
spec:
  selector: {app: postgres}
  ports: [{port: 5432}]
EOF
k -n db rollout status deploy/postgres --timeout=300s

say "Чарт в namespace $NS (Pod Security: restricted)"
k create namespace "$NS" --dry-run=client -o yaml | k apply -f - >/dev/null
k label namespace "$NS" pod-security.kubernetes.io/enforce=restricted --overwrite >/dev/null
VALUES=(--set image.repository=archmap --set image.tag=e2e --set image.pullPolicy=Never
  --set database.url=postgresql://archmap:archmap@postgres.db.svc:5432/archmap)
"$HELM" --kube-context "kind-$CLUSTER" upgrade --install archmap "$ROOT/deploy/helm/archmap" -n "$NS" \
  "${VALUES[@]}" --wait --timeout 5m
"$HELM" --kube-context "kind-$CLUSTER" test archmap -n "$NS" --timeout 2m

say "Интерфейс и API через port-forward"
port_forward() {
  [ -n "$PF_PID" ] && kill "$PF_PID" 2>/dev/null || true
  k -n "$NS" port-forward svc/archmap 18080:80 >"$WORK/pf.log" 2>&1 &
  PF_PID=$!
  for _ in $(seq 1 50); do curl -fsS http://127.0.0.1:18080/ready >/dev/null 2>&1 && return; sleep 0.2; done
  die "port-forward не поднялся: $(cat "$WORK/pf.log")"
}
port_forward
curl -fsS http://127.0.0.1:18080/ | grep -q 'id="root"' || die "интерфейс не отдаётся"
code="$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:18080/api/v1/auth/me)"
[ "$code" = 401 ] || die "/api/v1/auth/me без токена ответил $code вместо 401"

say "Первый администратор и вход"
printf '%s\n%s\n' "$PASSWORD" "$PASSWORD" |
  k -n "$NS" exec -i deploy/archmap -c archmap -- archmap-admin create-admin admin
login() {
  curl -fsS -X POST http://127.0.0.1:18080/api/v1/auth/login \
    -H 'Content-Type: application/x-www-form-urlencoded' \
    --data "username=admin&password=$PASSWORD" | python3 -c 'import json,sys; print(json.load(sys.stdin)["access_token"])'
}
TOKEN="$(login)"

say "Удалённый MCP: личный токен → /mcp tools/list"
PAT="$(curl -fsS -X POST http://127.0.0.1:18080/api/v1/tokens -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' --data '{"name":"e2e"}' |
  python3 -c 'import json,sys; print(json.load(sys.stdin)["secret"])')"
MCP_LIST='{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
curl -fsS -X POST http://127.0.0.1:18080/mcp -H "Authorization: Bearer $PAT" \
  -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
  --data "$MCP_LIST" | grep -q archmap_projects || die "/mcp не отдал список инструментов"
code="$(curl -s -o /dev/null -w '%{http_code}' -X POST http://127.0.0.1:18080/mcp \
  -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' --data "$MCP_LIST")"
[ "$code" = 401 ] || die "/mcp без токена ответил $code вместо 401"

say "helm upgrade: ключ подписи прежний, токен действует"
"$HELM" --kube-context "kind-$CLUSTER" upgrade archmap "$ROOT/deploy/helm/archmap" -n "$NS" \
  "${VALUES[@]}" --set-string podAnnotations.e2e-restart="$(date +%s)" --wait --timeout 5m
k -n "$NS" rollout status deploy/archmap --timeout=300s
port_forward
code="$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $TOKEN" http://127.0.0.1:18080/api/v1/auth/me)"
[ "$code" = 200 ] || die "после upgrade токен не принят ($code): ключ подписи сменился"

say "Готово: чарт ставится, мигрирует, отвечает и переживает обновление"
