# ArchMap — Helm-чарт

[ArchMap](https://archmap.tech) — многоуровневые архитектурные схемы, бизнес-процессы и
документация из кода. Чарт ставит приложение (API и интерфейс одним процессом) в любой
Kubernetes 1.25+; база PostgreSQL 15+ — внешняя.

```bash
helm install archmap oci://ghcr.io/eidunyushkinhse/charts/archmap -n archmap --create-namespace \
  --set database.url='postgresql://archmap:ПАРОЛЬ@pg.example.com:5432/archmap'
kubectl -n archmap exec -it deploy/archmap -c archmap -- archmap-admin create-admin admin
```

- Миграции схемы — init-контейнер пода (несколько реплик мигрируют по очереди).
- Ключ подписи входа создаётся при установке и сохраняется при обновлениях.
- Под без root, корень только для чтения: проходит Pod Security «restricted».
- Снаружи — `httpRoute` (Gateway API) или `ingress`; все значения — в `values.yaml`.

Подробно — установка, настройки, обновление, неполадки:
[DEPLOY.md, раздел «Kubernetes»](https://github.com/eidunyushkinhse/archmap/blob/main/DEPLOY.md#kubernetes).
Лицензия — AGPL-3.0-only.
