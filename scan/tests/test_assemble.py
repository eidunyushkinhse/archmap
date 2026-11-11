"""Сборка схемы: вид объектов, связи, источники, Dockerfile без манифеста."""

from __future__ import annotations

from functools import partial
from pathlib import Path

from archmap_scan import owners, registry, stats, texts, vocab, walk
from archmap_scan.assemble import assemble
from archmap_scan.objects import Model, Obj
from archmap_scan.walk import Files
from tests.helpers import FIXTURES, ctx_of, files_of, model_of, time_limit, timed, tree


def _obj(model: Model, name: str) -> Obj:
    obj = model.obj(name)
    assert obj is not None, name
    return obj


def _links(model: Model) -> set[tuple[str, str, str | None]]:
    return {(lk.src.name, lk.dst.name, lk.technology) for lk in model.links}


def test_compose_fixture_model() -> None:
    model = model_of(FIXTURES / "compose")
    kinds = {o.name: (o.shape, o.technology, o.role) for o in model.objects}
    assert kinds == {
        "api": ("service", "Python", "сервис"),
        "worker": ("service", None, "воркер"),
        "legacy": ("service", "legacy-tool", "сервис"),
        "proxy": ("service", "Traefik", "прокси"),
        "web": ("service", "nginx", "прокси"),
        "db": ("database", "PostgreSQL", "БД"),
        "search": ("database", "Elasticsearch", "БД"),
        # CELERY_BROKER_URL указывает на Redis: это брокер задач, а не кэш.
        "cache": ("broker", "Redis", "брокер"),
    }
    # DATABASE_URL с подстановкой не даёт адреса, но depends_on к базе связь рисует.
    # Очереди -Q воркера Celery — связи «доставляет» от брокера, они сильнее «использует».
    assert _links(model) == {
        ("api", "cache", "Redis"),
        ("api", "db", "PostgreSQL"),
        ("api", "search", "Elasticsearch"),
        ("cache", "worker", "Redis"),
    }
    assert sorted(lk.channel or "" for lk in model.links if lk.src.name == "cache") == [
        "default", "emails",
    ]
    assert model.hints["depends_on"][0]["to"] == "worker"
    # api и worker собраны из одного каталога: пути к коду нет ни у кого.
    assert _obj(model, "api").path is None and _obj(model, "worker").path is None
    assert model.hints["shared_code"] == [{
        "kind": "directory", "name": "services/api/", "reason": texts.REASON_SHARED_CODE,
        "source": model.hints["shared_code"][0]["source"], "containers": ["api", "worker"],
    }]
    assert [o.name for o in model.objects][:5] == ["api", "legacy", "proxy", "web", "worker"]


def test_unique_code_dir_and_root_container(tmp_path: Path) -> None:
    tree(tmp_path, {
        "docker-compose.yml": "services:\n  app:\n    build: .\n  db:\n    image: mysql\n",
        "Dockerfile": "FROM golang:1.22\n",
    })
    model = model_of(tmp_path)
    app = _obj(model, "app")
    assert app.code_dir == "" and app.path is None and app.technology == "Go"
    assert app.dockerfile is not None
    assert _links(model) == set()


def test_standalone_dockerfiles(tmp_path: Path) -> None:
    tree(tmp_path, {
        "services/orders/Dockerfile": "FROM python:3.12\nCMD python -m orders\n",
        "services/orders/Dockerfile.worker": "FROM python:3.12\nCMD celery worker\n",
        "Dockerfile-postgresql": "FROM zulip/zulip-postgresql:14\n",
        "tools/ci/Dockerfile": "FROM ubuntu\n",
        ".devcontainer/Dockerfile": "FROM ubuntu\n",
        "Dockerfile": "FROM node:20\n",
    })
    model = model_of(tmp_path, system="Ярмарка")
    kinds = {o.name: (o.shape, o.technology, o.role, o.code_dir) for o in model.objects}
    # Dockerfile.worker рядом с основным Dockerfile каталога контейнера — вариант orders при
    # любом суффиксе (ТЗ §15 п. 12 С8 отменяет решение А6: раньше это был объект «worker»).
    # Dockerfile-postgresql в корне и с дефисом остаётся своим объектом без каталога кода.
    assert kinds == {
        "orders": ("service", "Python", "сервис", "services/orders"),
        "Ярмарка": ("service", "Node.js", "сервис", ""),
        "postgresql": ("database", "PostgreSQL", "БД", None),
    }
    assert model.hints["merged"] == [{
        "kind": "dockerfile", "name": "services/orders/Dockerfile.worker", "object": "orders",
        "reason": texts.REASON_DOCKERFILE_SIBLING,
        "source": ["services/orders/Dockerfile.worker:1"],
    }]
    dev = {str(h["name"]) for h in model.hints["profiles"]}
    assert dev == {"tools/ci/Dockerfile", ".devcontainer/Dockerfile"}


def test_service_links_and_dynamic(tmp_path: Path) -> None:
    tree(tmp_path, {
        "docker-compose.yml": (
            "services:\n"
            "  front:\n    image: ghcr.io/org/front:1\n"
            "    environment:\n"
            "      API_URL: http://back:8080\n"
            "      GRPC_ADDR: back:9000\n"
            "      SELF_URL: http://front\n"
            "      OTHER: ${X}\n"
            "  back:\n    image: ghcr.io/org/back:1\n"
            "    environment: [RQ_REDIS_URL=redis://queue:6379, CACHE_HOST=memo]\n"
            "  queue:\n    image: redis\n"
            "  memo:\n    image: memcached\n"
        ),
    })
    model = model_of(tmp_path)
    assert _links(model) == {
        ("front", "back", "HTTP"),
        ("back", "queue", "Redis"),
        ("back", "memo", "Memcached"),
    }
    front_back = next(lk for lk in model.links if lk.src.name == "front")
    assert {str(loc) for loc in front_back.locs} == {"docker-compose.yml:5", "docker-compose.yml:6"}
    assert _obj(model, "queue").shape == "broker"
    assert _obj(model, "memo").role == "кэш"


def test_technology_from_manifests_and_frontend(tmp_path: Path) -> None:
    tree(tmp_path, {
        "docker-compose.yml": "services:\n  storefront:\n    build: ./frontend\n",
        "frontend/package.json": '{"name": "storefront", "dependencies": {"react": "18"}}',
        "frontend/Dockerfile": "FROM node:20 AS b\nFROM nginx\n",
    })
    store = _obj(model_of(tmp_path), "storefront")
    assert (store.technology, store.role) == ("Node.js + React", "фронтенд")
    assert {str(loc) for loc in store.locs} == {
        "docker-compose.yml:2", "frontend/Dockerfile:1", "frontend/package.json:1",
    }


def test_workspace_dir_for_image_only_workload(tmp_path: Path) -> None:
    tree(tmp_path, {
        "k8s/orders.yaml": (
            "apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: orders\nspec:\n"
            "  template:\n    spec:\n      containers:\n        - image: ghcr.io/org/orders:1\n"
        ),
        "services/orders/pyproject.toml": '[project]\nname = "orders"\ndependencies = ["fastapi"]\n',
    })
    orders = _obj(model_of(tmp_path), "orders")
    assert orders.code_dir == "services/orders" and orders.path == "services/orders"
    assert orders.technology == "Python + FastAPI"


def test_implicit_container(tmp_path: Path) -> None:
    tree(tmp_path, {
        "pyproject.toml": '[project]\nname = "notes"\ndependencies = ["flask", "redis"]\n',
        ".env.example": "PORT=8000\n",
    })
    model = model_of(tmp_path, system=None)
    assert model.system == "notes" and model.implicit
    notes = _obj(model, "notes")
    assert notes.technology == "Python + Flask" and notes.code_dir == ""
    assert list(model.params["notes"]) == ["PORT"]
    assert model.hints["clients"] == [{
        "kind": "library", "name": "redis", "object": "notes",
        "reason": texts.REASON_CLIENT_LIBRARY, "source": "pyproject.toml:2",
        "technology": "Redis",
    }]


def test_no_manifests_no_implicit_container(tmp_path: Path) -> None:
    tree(tmp_path, {"main.c": "int main(){}\n"})
    model = model_of(tmp_path, system=None)
    assert model.objects == [] and model.system == tmp_path.name


def test_depends_on_hint_only_without_edge(tmp_path: Path) -> None:
    tree(tmp_path, {
        "docker-compose.yml": (
            "services:\n"
            "  web:\n    build: web\n    environment: [API=http://api:8080]\n"
            "    depends_on: [api, auth]\n"
            "  api:\n    build: api\n"
            "  auth:\n    build: auth\n"
        ),
    })
    model = model_of(tmp_path)
    assert _links(model) == {("web", "api", "HTTP")}
    assert [(h["from"], h["to"]) for h in model.hints["depends_on"]] == [("web", "auth")]


def test_dev_manifests_are_hints_not_objects(tmp_path: Path) -> None:
    """Манифесты в каталогах и файлах для разработки объектов не дают (ТЗ §4, находка
    фазы 1а на Grafana: devenv/docker/blocks/*), а код в этих каталогах читается."""
    deployment = (
        "apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: {name}\nspec:\n"
        "  template:\n    spec:\n      containers:\n        - image: ghcr.io/org/{name}:1\n"
    )
    tree(tmp_path, {
        "go.mod": "module github.com/grafana/grafana\n",
        "package.json": '{"name": "grafana", "dependencies": {"react": "18"}}',
        "Dockerfile": "FROM node:20 AS js\nFROM golang:1.22\n",
        "devenv/docker/blocks/pg/docker-compose.yaml": (
            "services:\n  pg:\n    image: postgres\n  tool:\n    build: .\n"
        ),
        "devenv/docker/blocks/pg/Dockerfile": "FROM golang:1.22\n",
        "hack/Dockerfile": "FROM node:20\n",
        "ops/Dockerfile.ci": "FROM node:20\n",
        "contrib/supervisor/helper.conf": "[program:helper]\ncommand=python3 helper.py\n",
        "deploy/sandbox/app.service": "[Service]\nExecStart=/usr/bin/app\n",
        "deploy/playground.yaml": deployment.format(name="play"),
        "deploy/k8s.yaml": deployment.format(name="prod"),
        "devenv/tool/main.go": "package main\n",
    })
    model = model_of(tmp_path, system=None)
    assert sorted(o.name for o in model.objects) == ["grafana", "prod"]
    grafana = _obj(model, "grafana")
    assert grafana.technology == "Go + React" and grafana.code_dir == ""
    dev = {str(h["name"]): str(h["source"]) for h in model.hints["profiles"]}
    assert dev == {
        "pg": "devenv/docker/blocks/pg/docker-compose.yaml:2",
        "tool": "devenv/docker/blocks/pg/docker-compose.yaml:4",
        "devenv/docker/blocks/pg/Dockerfile": "devenv/docker/blocks/pg/Dockerfile:1",
        "hack/Dockerfile": "hack/Dockerfile:1",
        "ops/Dockerfile.ci": "ops/Dockerfile.ci:1",
        "helper": "contrib/supervisor/helper.conf:1",
        "app": "deploy/sandbox/app.service:1",
        "play": "deploy/playground.yaml:4",
    }
    reasons = {str(h["reason"]) for h in model.hints["profiles"]}
    assert all(r.startswith(texts.dev_manifest("")) for r in reasons)
    # Каталоги для разработки из обхода не исключаются: код в них читается.
    _ctx, files = files_of(tmp_path)
    assert "devenv/tool/main.go" in files.paths


def test_dev_signs_by_place_and_form() -> None:
    """Признак разработки по месту и форме (ТЗ §15 п. 10 Б1): каталог docker/federation/,
    имя docker-compose.playwright.yml, Procfile, который Makefile запускает goreman, и сервис
    основы, который расширяют только файлы разработки (maildev PostHog). Причина подсказки
    называет признак. Ловушки: сервис основы со своей сборкой (usage) и db, который
    расширяет боевой файл, остаются объектами; Procfile, который менеджер не запускает
    (heroku/Procfile, «gem install foreman» в bin/setup), даёт объект."""
    model = model_of(FIXTURES / "dev-signs")
    assert sorted(o.name for o in model.objects) == ["db", "usage", "web", "worker"]
    dev = {str(h["name"]): str(h["reason"]) for h in model.hints["profiles"]}
    assert dev == {
        "maildev": texts.dev_manifest(texts.dev_sign_base("docker-compose.base.yml")),
        "playwright": texts.dev_manifest(texts.dev_sign_file("docker-compose.playwright.yml")),
        "web-alpha": texts.dev_manifest(texts.dev_sign_dir("docker/federation")),
        "db_alpha": texts.dev_manifest(texts.dev_sign_dir("docker/federation")),
        "api": texts.dev_manifest(texts.dev_sign_manager("goreman", "Makefile:5")),
        "ui": texts.dev_manifest(texts.dev_sign_manager("goreman", "Makefile:5")),
    }


def test_dev_stage_one_keeps_prod_service() -> None:
    """Ступень 1 политики (ТЗ §15 п. 10 Б2): боевые манифесты есть (k8s), сервисы манифестов
    разработки идут в подсказки, в том числе чарт Helm в каталоге dev/. Сервис api есть и в
    боевом k8s, и в файле разработки: объект один, по боевому, подсказки о нём нет, а
    Dockerfile его сборки в файле разработки — Dockerfile этого объекта. Ловушка: mailhog
    только в файле разработки и остаётся подсказкой."""
    model = model_of(FIXTURES / "dev-stage")
    assert [(o.name, o.technology) for o in model.objects] == [("api", "Python")]
    assert model.objects[0].dockerfile is not None
    dev = {str(h["name"]): str(h["reason"]) for h in model.hints["profiles"]}
    assert dev == {
        "mailhog": texts.dev_manifest(texts.dev_sign_file("docker-compose.dev.yml")),
        "tools": texts.dev_manifest(texts.dev_sign_dir("dev")),
    }


def test_ci_candidates_on_stage_two() -> None:
    """Ступень 2 (ТЗ §15 п. 13 Д4): боевых манифестов нет, но compose в каталоге ci/ (сборочная
    матрица Envoy) объектов не даёт, его сервисы уходят в hints.profiles с причиной «манифест
    CI». Ловушки: стенд разработки docker-compose.dev.yml остаётся объектом с пометкой;
    сервис cache есть и в стенде, и в CI, поэтому подсказки CI о нём нет; Dockerfile в
    distribution/ остаётся объектом relay, как Dockerfile-envoy у Envoy."""
    model = model_of(FIXTURES / "ci-stage")
    assert sorted(o.name for o in model.objects) == ["cache", "relay"]
    assert [h["name"] for h in model.hints["dev_manifest_objects"]] == ["cache"]
    profiles = {str(h["name"]): str(h["reason"]) for h in model.hints["profiles"]}
    ci = texts.ci_manifest(texts.dev_sign_dir("ci"))
    assert profiles == {"build": ci, "build-dind": ci}
    assert walk.ci_sign("ci/matrix/docker-compose.yml") and walk.ci_sign(".ci/compose.yml")
    assert walk.ci_sign("ops/docker-compose.ci.yml") and walk.ci_sign(".github/compose.yml")
    assert not walk.ci_sign("services/circuit/compose.yaml")
    assert not walk.ci_sign("ci.yaml") and not walk.ci_sign("deploy/docker-compose.civic.yml")


def test_kotlin_files_owned_by_kotlin_container() -> None:
    """Владельцы файлов Kotlin (ТЗ §15 п. 13 Д6): `.kt` и `.kts` относились к Java, поэтому
    контейнер ledger на Gradle с плагином Kotlin не владел ни своими `.kt`, ни `.java`
    смешанного модуля, а контейнер billing на Java владел чужим ему `.kt`. Ловушка: Stray.kt
    в каталоге billing (Gradle без плагина Kotlin) теперь «нет контейнера на этом языке»."""
    model = model_of(FIXTURES / "kotlin-owners")
    cs = model.objects
    assert [(o.name, o.language) for o in cs] == [("billing", "Java"), ("ledger", "Kotlin")]
    found = {
        rel: [o.name for o in owners.file_owners(rel, cs)] for rel in (
            "ledger/src/main/kotlin/Ledger.kt", "ledger/src/main/java/Legacy.java",
            "ledger/build.gradle.kts", "billing/src/main/java/Billing.java",
            "billing/src/main/kotlin/Stray.kt",
        )
    }
    assert found == {
        "ledger/src/main/kotlin/Ledger.kt": ["ledger"],
        "ledger/src/main/java/Legacy.java": ["ledger"],
        "ledger/build.gradle.kts": ["ledger"],
        "billing/src/main/java/Billing.java": ["billing"],
        "billing/src/main/kotlin/Stray.kt": [],
    }
    assert owners.missing_reason("billing/src/main/kotlin/Stray.kt", cs) == (
        texts.REASON_OTHER_LANGUAGE
    )
    # Единственный контейнер на Kotlin забирает код Java вне каталогов (sole_owner).
    assert owners.file_owners("shared/Util.java", [_obj(model, "ledger")]) == [
        _obj(model, "ledger"),
    ]
    assert owners.file_owners("shared/Util.kt", [_obj(model, "billing")]) == []


def test_compose_stand_name_is_dev_sign() -> None:
    """Имя стенда (ТЗ §15 п. 13 Д8): docker-compose.multinode-clickhouse.yml PostHog с верхним
    name: posthog-multinode-smoke давал 9 объектов clickhouse-*. Слово smoke, test, ci, e2e,
    dev, local, bench в имени проекта compose — признак разработки всему файлу. Ловушки:
    contest-shop не test (слово целиком); clickhouse есть и в боевом файле и остаётся по
    нему, подсказки о нём нет."""
    model = model_of(FIXTURES / "stand-name")
    assert sorted(o.name for o in model.objects) == ["api", "clickhouse"]
    assert [str(loc) for loc in sorted(_obj(model, "clickhouse").locs)] == [
        "docker-compose.yml:7",
    ]
    sign = texts.dev_manifest(texts.dev_sign_stand_name("shop-multinode-smoke"))
    assert {str(h["name"]): h["reason"] for h in model.hints["profiles"]} == {
        "clickhouse-aux": sign, "clickhouse-logs": sign,
    }


def test_merge_by_system_prefix() -> None:
    """Склейка по имени с префиксом продукта (ТЗ §15 п. 13 Д9): dist/mastodon-web.service и
    dist/mastodon-streaming.service Mastodon оставались дублями compose web и streaming
    (команды разной формы, склейка по команде §13.5 их не видит). Имя остаётся короткое, у
    сервиса compose, источники обоих в evidence, запись в hints.merged. Ловушки: shop-db
    (сервис) и db (база) разных видов; shop-worker на Python и worker на Ruby."""
    model = model_of(FIXTURES / "prefix-merge", system="shop")
    assert sorted(o.name for o in model.objects) == [
        "db", "shop-db", "shop-worker", "streaming", "web", "worker",
    ]
    assert "ops/shop-web.service:2" in {str(loc) for loc in _obj(model, "web").locs}
    assert _obj(model, "streaming").parsers == ["compose", "systemd"]
    assert [(h["name"], h["object"], h["reason"], h["source"]) for h in model.hints["merged"]] == [
        ("shop-streaming", "streaming", texts.REASON_MERGED_PREFIX,
         ["docker-compose.yml:6", "ops/shop-streaming.service:1"]),
        ("shop-web", "web", texts.REASON_MERGED_PREFIX,
         ["docker-compose.yml:3", "ops/shop-web.service:1"]),
    ]


def test_command_only_process_gets_no_code_dir(tmp_path: Path) -> None:
    """Д10 (ТЗ §15 п. 13): процесс, заданный только командой (Procfile, x-programs, юнит
    systemd без своей сборки), каталога кода не получает, если рядом есть контейнер со
    своей сборкой того же языка: у Sentry 21 программа x-programs из корня забрала код src/
    у self-hosted, и 109 параметров писались каждому процессу. (а) Procfile рядом с
    Dockerfile корня: параметр и маршрут у контейнера Dockerfile, у worker и scheduler только
    воркеры. Ловушки: (б) Procfile без Dockerfile владеет корнем, как раньше; (в) программа
    с именем сервиса compose склеивается с ним и факты получает по сервису."""
    model = model_of(FIXTURES / "procfile-build")
    assert [(o.name, o.code_dir) for o in model.objects] == [
        ("scheduler", None), ("worker", None), ("Ярмарка", ""),
    ]
    assert {k: sorted(v) for k, v in model.params.items()} == {"Ярмарка": ["DATABASE_URL"]}
    assert list(model.http) == ["Ярмарка"] and sorted(model.workers) == ["scheduler", "worker"]
    assert _obj(model, "Ярмарка").path is None and "shared_code" not in model.hints
    app = "import os\nDATABASE_URL = os.environ['DATABASE_URL']\n"
    tree(tmp_path / "solo", {
        "requirements.txt": "celery\n", "app.py": app,
        "Procfile": "web: gunicorn app:app\nworker: celery -A app worker\n",
    })
    solo = model_of(tmp_path / "solo")
    assert [(o.name, o.code_dir) for o in solo.objects] == [("web", ""), ("worker", "")]
    assert sorted(solo.params) == ["web", "worker"]
    # Ловушка (AWX): сборка без языка во вложенном каталоге (logstash в tools/) код корня у
    # процесса на Python не забирает.
    tree(tmp_path / "tools", {
        "requirements.txt": "celery\n", "app.py": app, "Procfile": "web: gunicorn app:app\n",
        "tools/logstash/Dockerfile": "FROM docker.elastic.co/logstash/logstash:8.15.0\n",
        "compose.yaml": "services:\n  logstash:\n    build: tools/logstash\n",
    })
    tools = model_of(tmp_path / "tools")
    assert [(o.name, o.code_dir) for o in tools.objects] == [
        ("logstash", "tools/logstash"), ("web", ""),
    ]
    assert sorted(tools.params) == ["web"]
    tree(tmp_path / "named", {
        "requirements.txt": "celery\n", "app.py": app, "Dockerfile": "FROM python:3.12\n",
        "compose.yaml": "services:\n  worker:\n    build: .\n",
        "Procfile": "worker: celery -A app worker\nbeat: celery -A app beat\n",
    })
    named = model_of(tmp_path / "named")
    assert [(o.name, o.code_dir) for o in named.objects] == [("beat", None), ("worker", "")]
    assert sorted(named.params) == ["worker"]


def test_compose_in_code_dir_of_other_container_is_stand() -> None:
    """Compose-файл в каталоге кода контейнера из другого боевого файла — стенд разработки
    компонента (livestream/ и rust/ PostHog): каталог сборки capture (rust/) и каталог
    Dockerfile, склеенного с сервисом stream по имени. Ловушка: свой compose компонента
    services/api, которого другой файл не собирает, остаётся боевым."""
    model = model_of(FIXTURES / "dev-stand")
    assert sorted(o.name for o in model.objects) == ["api", "capture", "stream", "web"]
    dev = {str(h["name"]): str(h["reason"]) for h in model.hints["profiles"]}
    assert dev == {
        "kafka-local": texts.dev_manifest(texts.dev_sign_stand("capture", "rust")),
        "redis-node": texts.dev_manifest(texts.dev_sign_stand("stream", "stream")),
    }


def test_dev_procfile_on_hostile_makefile(tmp_path: Path) -> None:
    """Разбор строк запуска менеджера линеен на враждебном Makefile."""
    tree(tmp_path, {
        "Procfile": "web: run\n",
        "Makefile": "goreman " + "-x " * 200_000 + "\n" + "foreman" * 200_000 + "\n"
        + "X=" * 200_000 + "\n",
    })
    _ctx, files = files_of(tmp_path)
    sign, took = timed(partial(walk.dev_procfile, files, "Procfile"), time_limit())
    assert sign is None
    assert took < time_limit()


def test_suffixed_dockerfile_owns_no_code(tmp_path: Path) -> None:
    """Находка фазы 1а на Zulip: Dockerfile-postgresql стал контейнером «postgresql» с
    технологией корня «Node.js + Koa» и repo. Контейнер из Dockerfile с суффиксом
    получает вид и технологию только по FROM, без каталога кода."""
    tree(tmp_path, {
        "package.json": '{"name": "zulip", "dependencies": {"koa": "3"}}',
        "Dockerfile-postgresql": (
            "ARG PGROONGA_VERSION=latest\n"
            "FROM groonga/pgroonga:$PGROONGA_VERSION-alpine-14-slim\n"
        ),
        "services/report/Dockerfile.report": "FROM python:3.12\nCMD python -m report\n",
        "services/report/pyproject.toml": '[project]\nname = "x"\ndependencies = ["flask"]\n',
    })
    model = model_of(tmp_path, system=None)
    pg = _obj(model, "postgresql")
    assert (pg.shape, pg.technology, pg.role) == ("database", "PostgreSQL", "БД")
    assert pg.code_dir is None and not pg.repo and pg.path is None
    report = _obj(model, "report")
    assert (report.technology, report.code_dir, report.path) == ("Python", None, None)


def test_dockerfile_binds_to_manifest_image() -> None:
    """Dockerfile в подкаталоге привязывается к сервису по артефакту skaffold или по имени
    образа, равному имени каталога-предка; имя каталога src контейнер не называет; вариант
    для разработки рядом с основным Dockerfile — тот же контейнер (ТЗ §15 п. 10 А6)."""
    model = model_of(FIXTURES / "dockerfile-bind")
    kinds = {o.name: (o.technology, o.code_dir) for o in model.objects}
    assert kinds == {
        # skaffold: src/cartservice/src собирает образ cartservice (без него — объект «src»).
        "cartservice": (".NET", "src/cartservice/src"),
        # Ловушка: каталог с именем сервиса склеивается по имени, как раньше.
        "emailservice": ("Python", "src/emailservice"),
        # Образ ghcr.io/shop/payment — имя каталога-предка src/payment/server.
        "payments-api": ("Go", "src/payment/server"),
        # Без сервиса манифеста: ближайший каталог не из src, app, docker, build.
        "notifier": ("Node.js", "notifier/src"),
    }
    merged = [(h["name"], h["object"], h["reason"]) for h in model.hints["merged"]]
    assert merged == [(
        "src/cartservice/src/Dockerfile.debug", "cartservice", texts.REASON_DOCKERFILE_VARIANT,
    )]
    # Вариант для разработки без основного Dockerfile — манифест разработки.
    assert [h["name"] for h in model.hints["profiles"]] == ["runner/Dockerfile.playwright"]


def test_root_dockerfile_and_dev_compose_builds(tmp_path: Path) -> None:
    """Корневой Dockerfile собирает образ с именем репозитория: это Dockerfile сервисов на
    этом образе (Mastodon: web и sidekiq на ghcr.io/mastodon/mastodon), а не объект с
    именем корня. Сборка сервиса в файле compose для разработки называет Dockerfile его
    образа: основной Dockerfile даёт сервису каталог кода, вариант уходит в hints.merged."""
    root = tree(tmp_path / "forum", {
        "Gemfile": 'gem "rails"\ngem "sidekiq"\n',
        "package.json": '{"name": "@forum/forum", "dependencies": {"react": "19"}}',
        "Dockerfile": "FROM ruby:3.4\n",
        "Dockerfile.node": "FROM node:22\n",
        "Procfile": "web: bin/heroku-web\nworker: bundle exec sidekiq\n",
        "docker-compose.yml": (
            "services:\n"
            "  web:\n    image: ghcr.io/forum/forum:v4\n    command: bundle exec puma\n"
            "  sidekiq:\n    image: ghcr.io/forum/forum:v4\n    command: bundle exec sidekiq\n"
            "  plugins:\n    image: ${REGISTRY}-node:latest\n"
            "  api:\n    image: ${REGISTRY}:latest\n"
        ),
        "docker-compose.dev.yml": (
            "services:\n"
            "  plugins:\n    build:\n      context: .\n      dockerfile: Dockerfile.node\n"
        ),
    })
    model = model_of(root, system=None)
    names = sorted(o.name for o in model.objects)
    # Ни «@forum/forum» (корневой Dockerfile), ни «node» (Dockerfile.node), ни «worker».
    assert names == ["api", "plugins", "sidekiq", "web"]
    assert _obj(model, "web").technology == "Ruby + Rails"
    assert _obj(model, "web").code_dir == "" and _obj(model, "sidekiq").code_dir == ""
    # Ловушка: образ с подстановкой ни к чему не привязывается.
    assert _obj(model, "api").code_dir is None
    merged = {h["name"]: (h["object"], h["reason"]) for h in model.hints["merged"]}
    assert merged["Dockerfile.node"] == ("plugins", texts.REASON_DOCKERFILE_IMAGE)
    assert merged["worker"][0] == "sidekiq"


def test_task_on_database_or_broker_image() -> None:
    """Задача на образе базы или брокера — сервис с ролью «задача», связи к ней по
    depends_on в подсказках (ТЗ §15 п. 10 А8: personhog-tables-ready и kafka-init PostHog
    стали базой и брокером). Сервер с restart: on-failure и реплика остаются как были. С
    части 2 (Д7) задача с признаком (restart «no», слово задачи в имени) объектом не
    становится вовсе: tables-ready в hints.unassigned, связей к ней нет. Технология задачи
    по образу пишется как в словаре образов (ТЗ §15 п. 19 Т2): «Redpanda», а не «redpanda»."""
    model = model_of(FIXTURES / "compose-task")
    kinds = {o.name: (o.shape, o.role, o.technology) for o in model.objects}
    assert kinds == {
        "api": ("service", "сервис", "Python"),
        "topics": ("service", "задача", "Redpanda"),
        "db": ("database", "БД", "PostgreSQL"),
        "replica": ("database", "БД", "PostgreSQL"),
        "kafka": ("broker", "брокер", "Redpanda"),
    }
    assert {(lk.src.name, lk.dst.name) for lk in model.links} == {
        ("api", "db"), ("api", "kafka"), ("topics", "kafka"),
    }
    assert [(h["from"], h["to"]) for h in model.hints["depends_on"]] == [("api", "topics")]
    assert [h["name"] for h in model.hints["unassigned"]] == ["tables-ready"]


def test_init_tasks_are_not_services() -> None:
    """Задача инициализации на образе базы, брокера или клиента хранилища (ТЗ §15 п. 13 Д7):
    personhog-tables-ready и kafka-init PostHog, minio-createbucket Supabase были сервисами.
    Своя команда не запускает сервер образа и есть признак задачи (restart «no», слово в
    имени, k8s Job): объекта нет, запись в hints.unassigned, depends_on к ней и от неё не
    рисуются. Ловушки: postgres с ключами и redpanda start при restart: on-failure остаются
    базой и брокером; migrate на образе приложения остаётся сервисом."""
    model = model_of(FIXTURES / "init-tasks")
    kinds = {o.name: (o.shape, o.role) for o in model.objects}
    assert kinds == {
        "api": ("service", "сервис"), "migrate": ("service", "сервис"),
        "db": ("database", "БД"), "minio": ("database", "хранилище"),
        "kafka": ("broker", "брокер"),
    }
    assert sorted((lk.src.name, lk.dst.name) for lk in model.links) == [
        ("api", "db"), ("migrate", "db"),
    ]
    assert "depends_on" not in model.hints
    tasks = {str(h["name"]): (h["reason"], h["source"]) for h in model.hints["unassigned"]}
    assert tasks == {
        "db-ready": (texts.init_task("PostgreSQL"), "compose.yaml:7"),
        "kafka-init": (texts.init_task("Redpanda"), "compose.yaml:16"),
        "minio-createbucket": (texts.init_task("minio-client"), "compose.yaml:24"),
        "orders-load": (texts.init_task("PostgreSQL"), "k8s/seed.yaml:4"),
    }
    assert vocab.starts_server("PostgreSQL", "sh -c 'exec postgres -c fsync=off'")
    assert vocab.starts_server("PostgreSQL", "docker-entrypoint.sh")
    assert not vocab.starts_server("PostgreSQL", "psql -U postgres -d postgres -c 'select 1'")
    assert vocab.starts_server("rclone", "rclone serve s3 /data")
    assert not vocab.starts_server("rustfs/rc", "/bin/sh -ec rc mb local/x")
    assert vocab.init_image("rustfs/rc") == "rustfs/rc" and vocab.init_image("rc") is None
    assert vocab.init_image("prometheuscommunity/postgres-exporter") is None

    # Враждебная команда на 2 МБ: слова считаются до предела, ключ оболочки без регулярки.
    def run() -> bool:
        for command in ("-" + "c" * 2_000_000 + "!", "sh -" + "c" * 2_000_000 + " postgres",
                        "psql " * 400_000, "-c " * 700_000):
            vocab.starts_server("PostgreSQL", command)
        return vocab.init_task_name("x-" * 1_000_000)

    named, took = timed(run, time_limit())
    assert named is False
    assert took < time_limit()


def test_image_vocabulary_and_redis_queue_broker() -> None:
    """pgautoupgrade — PostgreSQL (Lemmy), образ с clickhouse в имени — ClickHouse
    (clickhouse-posthog), browserless/chromium — сервис; Redis — брокер, если к нему идёт
    контейнер с библиотекой очередей (Sidekiq у Mastodon, BullMQ у immich). Ловушки:
    координатор clickhouse-keeper не база, Redis контейнера без такой библиотеки — кэш
    (ТЗ §15 п. 10 А13)."""
    model = model_of(FIXTURES / "compose-images")
    kinds = {o.name: (o.shape, o.technology, o.role) for o in model.objects}
    assert kinds["postgres"] == ("database", "PostgreSQL", "БД")
    assert kinds["events"] == ("database", "ClickHouse", "БД")
    assert kinds["keeper"][0] == "service"
    assert kinds["chrome"] == ("service", "Chromium", "сервис")
    assert kinds["redis"] == ("broker", "Redis", "брокер")
    assert kinds["cache"] == ("database", "Redis", "кэш")
    # База с depends_on к брокеру связана с ним (clickhouse→kafka PostHog), к сервису — нет.
    assert {(lk.src.name, lk.dst.name) for lk in model.links} == {
        ("app", "events"), ("app", "postgres"), ("app", "redis"), ("report", "cache"),
        ("events", "kafka"),
    }


def test_image_dictionary_by_name_part() -> None:
    """Слово словаря образов среди частей имени через дефис и подчёркивание (ТЗ §15 п. 14
    И3): timescale/timescaledb-ha и quay.io/sclorg/postgresql-15-c9s — PostgreSQL (Keycloak,
    operator/src/test/resources/example-postgres.yaml), ghcr.io/getsentry/docker-redis-cluster
    — Redis (Sentry, devservices/config.yml), jwilder/nginx-proxy — прокси nginx (Grafana,
    devenv/docker/ha_test/docker-compose.yaml). Ловушки: my-app-redis-client (слово client)
    и postgres-exporter остаются сервисами, redis_mongodb с двумя технологиями тоже."""
    model = model_of(FIXTURES / "image-dictionary")
    kinds = {o.name: (o.shape, o.technology, o.role) for o in model.objects}
    assert kinds["metrics"] == ("database", "PostgreSQL", "БД")
    assert kinds["legacy"] == ("database", "PostgreSQL", "БД")
    assert kinds["sessions"] == ("database", "Redis", "кэш")
    assert kinds["edge"] == ("service", "nginx", vocab.ROLE_PROXY)
    assert kinds["cache-tool"] == ("service", "my-app-redis-client", "сервис")
    assert kinds["pg-metrics"] == ("service", "postgres-exporter", "сервис")
    assert kinds["bundle"] == ("service", "redis_mongodb", "сервис")


def test_image_dictionary_hostile_is_fast() -> None:
    """Имя образа на 2 МБ из частей словаря и разделителей разбирается за линейное время."""
    def run() -> None:
        for image in ("redis-" * 300_000 + "client", "-_" * 1_000_000, "postgres_" * 200_000,
                      "x/" * 500_000 + "clickhouse-" * 100_000):
            vocab.image_kind(image)

    assert timed(run, time_limit())[1] < time_limit()


def test_queue_broker_by_manifest_next_to_dockerfile() -> None:
    """Монорепозиторий собирает сервис из корня, а библиотека очередей в манифесте рядом с
    его Dockerfile (immich: контекст «../», server/Dockerfile, bullmq в server/package.json):
    Redis сервиса — брокер. Ловушка: у web рядом с Dockerfile манифест без такой библиотеки,
    его Redis остаётся кэшем (ТЗ §15 п. 10 А13)."""
    model = model_of(FIXTURES / "compose-monorepo")
    kinds = {o.name: (o.shape, o.role) for o in model.objects}
    assert kinds["redis"] == ("broker", "брокер")
    assert kinds["cache"] == ("database", "кэш")


def test_service_build_dirs_and_doc_segments() -> None:
    """Служебные и учебные каталоги (ТЗ §15 п. 12 С3). (а) docs, examples и подобные
    совпадают частью сегмента через дефис или подчёркивание: учебные Dockerfile Airflow в
    docker-stack-docs/docker-examples/extending/*/ дали 13 объектов. Частью слова не
    совпадают: documents/ и exampleservice/ читаются. (б) Манифест в каталоге служебной
    сборки — кандидат разработки: supervisor.conf AWX в tools/docker-compose/,
    scripts/release/Dockerfile Nomad, loki-build-image/ Loki, staging/.../_mock/
    Kubernetes, юнит terraform/shared/config/consul-template.service Nomad. Боевой
    манифест есть (compose), поэтому это подсказки. Ловушка: deploy/k8s/ признаком не
    является, Deployment worker остаётся объектом."""
    root = FIXTURES / "service-build"
    listing = walk.list_files(ctx_of(root))
    assert set(listing.excluded) == {
        walk.Excluded("docker-stack-docs/", 1, "convention"),
        walk.Excluded("helm_examples/", 1, "convention"),
    }
    model = model_of(root)
    assert sorted(o.name for o in model.objects) == [
        "app", "db", "documents", "exampleservice", "worker",
    ]
    dev = {str(h["name"]): str(h["reason"]) for h in model.hints["profiles"]}
    assert dev == {
        "awx-dispatcher": texts.dev_manifest(texts.service_build("tools")),
        "consul-template": texts.dev_manifest(texts.service_build("terraform")),
        "loki-build-image/Dockerfile": texts.dev_manifest(texts.service_build("loki-build-image")),
        "scripts/release/Dockerfile": texts.dev_manifest(texts.service_build("scripts")),
        "staging/_mock/Dockerfile": texts.dev_manifest(texts.service_build("staging/_mock")),
    }
    assert walk.service_sign("deploy/helm/k8s/docker/Dockerfile") is None
    assert walk.service_sign("ci-build-image/Dockerfile") is not None
    assert walk.convention_rule("documents/x/Dockerfile") is None


def test_service_build_dockerfile_on_stage_two() -> None:
    """Ступень 2 (ТЗ §15 п. 10 Б3): боевых манифестов нет, и Dockerfile служебной сборки
    становится объектом с пометкой «из манифеста разработки», а не пропадает (ловушка ТЗ
    §15 п. 12 С3: scripts/docker/Dockerfile Monica, когда Sail уходит в разработку). Он
    копирует весь контекст, поэтому каталог кода и имя у него от корня с composer.json (С5б):
    «Ярмарка» с технологией PHP + Laravel, а не «scripts»."""
    model = model_of(FIXTURES / "service-build-solo")
    assert [(o.name, o.code_dir, o.technology) for o in model.objects] == [
        ("Ярмарка", "", "PHP + Laravel"),
    ]
    assert model.hints["dev_manifest_objects"] == [{
        "kind": "container", "name": "Ярмарка",
        "reason": texts.dev_manifest(texts.service_build("scripts")),
        "source": "scripts/docker/Dockerfile:1",
    }]


def test_code_dir_by_service_or_image_name() -> None:
    """Каталог кода по имени сервиса или образа (ТЗ §15 п. 12 С5а). Petclinic
    (docker-compose.yml) описывает сервисы только образами springcommunity/spring-petclinic-*,
    а код лежит в одноимённых каталогах с pom.xml: технологией было имя образа.
    OpenTelemetry Demo (compose.yaml) собирает сервисы из корня (context: ./) с Dockerfile из
    переменной, а код лежит в src/<сервис>/: все получили Node.js корневого package.json.
    Ловушки: сервис web при web/ и src/web/ берёт ближайший к корню; worker без совпадений
    с корневым контекстом остаётся в корне; tracing-server на образе openzipkin/zipkin
    каталога не получает (технология «Zipkin» по словарю программ, ТЗ §15 п. 19 Т2). (С5б) docker/Dockerfile Petclinic с ARG ARTIFACT_NAME собирает
    образы всех сервисов и объектом «Ярмарка» не становится: подсказка «общий Dockerfile
    сборки»."""
    model = model_of(FIXTURES / "code-by-name")
    kinds = {o.name: (o.code_dir, o.technology) for o in model.objects}
    assert kinds == {
        "admin-server": ("spring-petclinic-admin-server", "Java + Spring Boot"),
        "vets": ("spring-petclinic-vets-service", "Java + Spring Boot"),
        "tracing-server": (None, "Zipkin"),
        "cart": ("src/cart/src", ".NET"),
        "fraud": ("src/fraud", "Kotlin"),
        "web": ("web", "Node.js + React"),
        "worker": ("", "Node.js + Express"),
        "db": (None, "MySQL"),
    }
    shared = [h for h in model.hints["unassigned"] if h["kind"] == "dockerfile"]
    assert shared == [{
        "kind": "dockerfile", "name": "docker/Dockerfile",
        "reason": texts.REASON_SHARED_DOCKERFILE, "source": "docker/Dockerfile:1",
        "containers": ["admin-server", "vets"],
    }]


def test_dev_signs_by_service_form() -> None:
    """Признак разработки по форме сервиса compose (ТЗ §15 п. 12 С6): docker-compose.yml и
    container-compose.yml Forem держат рядом с боевыми службами установку зависимостей (yarn
    install), посев (rake db:seed), сервер разработки (webpack-dev-server), сборку в режиме
    слежения (yarn build --watch), заглушку devcontainer (sleep infinity) и раннер тестов
    rspec_system без своей команды; mailpit — инструмент разработки. Боевой Procfile или
    compose есть, поэтому это подсказки. (г) .devcontainer/Dockerfile n8n к боевому объекту
    не привязывается, даже если файл разработки собирает им сервис с тем же именем.
    Ловушки: bundle exec sidekiq и bundle exec rails server не команды разработки; jaeger и
    minio не инструменты разработки."""
    model = model_of(FIXTURES / "dev-forms")
    assert sorted(o.name for o in model.objects) == [
        "api", "db", "jaeger", "minio", "sidekiq", "web",
    ]
    assert _obj(model, "api").code_dir is None
    dev = {str(h["name"]): str(h["reason"]) for h in model.hints["profiles"]}
    command = texts.dev_sign_command
    assert dev == {
        "yarn": texts.dev_manifest(command("yarn install", "docker-compose.yml:13")),
        "seed": texts.dev_manifest(command("rake db:seed", "docker-compose.yml:16")),
        "webpacker": texts.dev_manifest(command("webpack-dev-server", "docker-compose.yml:19")),
        "esbuild": texts.dev_manifest(command("--watch", "docker-compose.yml:22")),
        "devcontainer": texts.dev_manifest(command("sleep infinity", "docker-compose.yml:25")),
        "rspec_system": texts.dev_manifest(texts.dev_sign_test_service("rspec_system")),
        "mailpit": texts.dev_manifest(texts.dev_sign_tool("mailpit")),
        ".devcontainer/Dockerfile": texts.dev_manifest(texts.dev_sign_dir(".devcontainer")),
    }


def test_laravel_sail_file_is_development() -> None:
    """Файл Laravel Sail целиком окружение разработки (ТЗ §15 п. 12 С6в): контекст сборки
    vendor/laravel/sail/runtimes/8.4 (каталога в обходе нет) и образ sail-8.4/app у Monica.
    Боевых манифестов не остаётся, поэтому ступень 2: сервисы Sail и его база — объекты с
    пометкой, а scripts/docker/Dockerfile — объект с каталогом кода корня (PHP + Laravel), и
    вариант fpm на PHP по итоговой стадии (С3, С4, С5б)."""
    model = model_of(FIXTURES / "dev-sail")
    kinds = {o.name: o.technology for o in model.objects}
    assert kinds == {
        "fpm": "PHP", "laravel.queue": "app", "laravel.test": "app", "Ярмарка": "PHP + Laravel",
        "mariadb": "MariaDB",
    }
    marks = {str(h["name"]): str(h["reason"]) for h in model.hints["dev_manifest_objects"]}
    sail = texts.dev_manifest(texts.dev_sign_sail("docker-compose.yml:2"))
    assert marks["laravel.test"] == sail and marks["mariadb"] == sail
    assert marks["Ярмарка"] == texts.dev_manifest(texts.service_build("scripts"))


def _families(root: Path) -> tuple[Model, list[str], dict[str, str], dict[str, list[str]]]:
    """Модель, стеки, статусы семей и их unsupported по дереву root (без git)."""
    ctx = ctx_of(root, "Ярмарка")
    files = Files(ctx.root, walk.list_files(ctx).files)
    findings, errors = registry.collect(files, ctx)
    assert errors == {}
    model = assemble(findings, ctx)
    fams = stats.families(model, findings, errors)
    return (
        model, stats.stacks(model),
        {f: s.status for f, s in fams.items()}, {f: s.unsupported for f, s in fams.items()},
    )


def test_root_container_language_by_free_packages() -> None:
    """Язык корневого контейнера по свободным подкаталогам (ТЗ §15 п. 12 С7а). eShop: в
    корне только служебный package.json (тесты e2e на playwright), а код .NET лежит в 28
    src/*/*.csproj; неявный контейнер корня получал Node.js и stacks [Node.js]. Утилиты Go в
    internal/tools/ (как у OpenTelemetry Demo) служебная сборка и не считаются: иначе языков
    было бы два и язык не менялся бы. Ловушки root-occupied: web собирается из корня, но
    api/ занят своим сервисом, его Go языком web не становится; package.json корня с
    зависимостями не служебный, Python свободного lib/ язык web не меняет."""
    model, stacks, _, _ = _families(FIXTURES / "root-dotnet")
    assert [(o.name, o.technology) for o in model.objects] == [("Ярмарка", ".NET")]
    assert stacks == [".NET"]
    model = model_of(FIXTURES / "root-occupied")
    assert {o.name: (o.code_dir, o.technology) for o in model.objects} == {
        "web": ("", "Node.js"), "api": ("api", "Go"),
    }


def test_stacks_and_known_language_status() -> None:
    """Стеки из словаря и «стек не опознан» только без языка (ТЗ §15 п. 12 С7б, С7в).
    Petclinic (docker-compose.yml): stacks перечисляли имена образов
    (spring-petclinic-admin-server, zipkin), как и у Loki (alertmanager), Kubernetes
    (cpvpa-amd64) и Supabase (logflare); channels и http_routes были unknown с пустыми
    parsers, хотя язык Java известен. Здесь язык billing назван только базовым образом
    Dockerfile, pom.xml нет. Образ остаётся технологией объекта tracing (написание программы
    по словарю, «Zipkin», ТЗ §15 п. 19 Т2), но стеком не считается: своего Dockerfile нет."""
    model, stacks, status, unsupported = _families(FIXTURES / "java-image")
    assert {o.name: o.technology for o in model.objects} == {"billing": "Java", "tracing": "Zipkin"}
    assert stacks == ["Java"]
    for fam in ("channels", "http_routes"):
        assert status[fam] == "unsupported" and unsupported[fam] == ["Java"]


def test_program_images_one_spelling() -> None:
    """Технология по образу одним написанием (ТЗ §15 п. 19 Т2): сервис compose на
    grafana/grafana и свой Dockerfile на том же образе — оба «Grafana» (immich
    immich-grafana и Petclinic grafana-server писались «grafana» и «Grafana»); программы по
    организации и имени (temporalio/ui, jaegertracing/all-in-one), Deployment k8s на
    grafana/loki. Роли и формы прежние. Программа на чужом образе стеком не считается, как
    раньше имя образа; со своим Dockerfile считается (Т1). Ловушки: etcd строчными, calico/node,
    sail-8.3/app и example/ui остаются именами образа."""
    model, stacks, _status, _unsupported = _families(FIXTURES / "program-images")
    kinds = {o.name: (o.shape, o.role, o.technology) for o in model.objects}
    assert kinds == {
        "dashboards": ("service", "сервис", "Grafana"),
        "metrics": ("service", "сервис", "Prometheus"),
        "collector": ("service", "сервис", "OpenTelemetry Collector"),
        "temporal": ("service", "сервис", "Temporal"),
        "temporal-ui": ("service", "сервис", "Temporal"),
        "tracing": ("service", "сервис", "Jaeger"),
        "search": ("service", "сервис", "SearXNG"),
        "gateway": ("service", "прокси", "nginx"),
        "grafana-own": ("service", "сервис", "Grafana"),
        "etcd": ("service", "сервис", "etcd"),
        "calico-node": ("service", "сервис", "node"),
        "laravel": ("service", "сервис", "app"),
        "other-ui": ("service", "сервис", "ui"),
        "logs": ("service", "сервис", "Loki"),
    }
    assert "Grafana" in stacks and "nginx" in stacks
    assert not {"Prometheus", "Temporal", "Loki", "OpenTelemetry Collector"} & set(stacks)


def _dockerfile_hints(model: Model) -> dict[str, list[tuple[str, str | None, str]]]:
    """Подсказки о Dockerfile по разделам: (файл, контейнер, причина)."""
    out: dict[str, list[tuple[str, str | None, str]]] = {}
    for section in ("merged", "profiles", "unassigned"):
        for h in model.hints.get(section, []):
            if h.get("kind") == "dockerfile":
                obj = h.get("object")
                out.setdefault(section, []).append(
                    (str(h["name"]), str(obj) if obj else None, str(h["reason"])),
                )
    return out


def test_dockerfile_variant_beside_main() -> None:
    """Вариант рядом с основным Dockerfile при любом суффиксе (ТЗ §15 п. 12 С8, отменяет
    решение А6). Loki: cmd/loki/Dockerfile.cross давал объект «cross», n8n
    docker/images/runners/Dockerfile.distroless объект «distroless», OpenTelemetry Demo
    src/frontend/Dockerfile.cypress объект «cypress». Ловушки: в корне репозитория суффикс
    называет отдельный образ (Dockerfile.llm-analytics PostHog, ok вердикта); общий
    rust/Dockerfile нескольких сервисов PostHog не делает rust/Dockerfile.sqlx-migrate
    вариантом одного из них (ok вердикта); форма с дефисом (Dockerfile-fpm Monica) правилом
    не задета; Dockerfile.playwright без основного по-прежнему подсказка (А6)."""
    model = model_of(FIXTURES / "dockerfile-variants")
    assert {o.name: (o.code_dir, o.technology) for o in model.objects} == {
        "web": ("", "Python"), "llm-analytics": (None, "Python"), "loki": ("cmd/loki", "Go"),
        "capture": ("rust", "Rust"), "cymbal": ("rust", "Rust"), "sqlx-migrate": (None, "Rust"),
        "worker": ("worker", "PHP"), "fpm": (None, "PHP"),
    }
    hints = _dockerfile_hints(model)
    assert hints["merged"] == [
        ("cmd/loki/Dockerfile.cross", "loki", texts.REASON_DOCKERFILE_SIBLING),
    ]
    assert [name for name, _, _ in hints["profiles"]] == ["qa/Dockerfile.playwright"]


def test_dockerfile_in_container_subdir_and_mobile() -> None:
    """Dockerfile в подкаталоге каталога кода контейнера без своего сервиса — вариант этого
    контейнера; мобильное приложение контейнером не считается (ТЗ §15 п. 12 С8).
    OpenTelemetry Demo: src/checkout/genproto/Dockerfile (и в currency, frontend) давал объект
    «genproto», src/react-native-app/android.Dockerfile объект «android»; Keycloak
    operator/scripts/Dockerfile-custom-image на ступени 2 давал объект «custom-image».
    Ловушки: подкаталог со своим манифестом сборки (src/checkout/plugin/go.mod) — свой
    контейнер; Dockerfile в разных каталогах остаются разными контейнерами."""
    model = model_of(FIXTURES / "dockerfile-subdirs")
    assert {o.name: (o.code_dir, o.technology) for o in model.objects} == {
        "checkout": ("src/checkout", "Go"), "plugin": ("src/checkout/plugin", "Go"),
        "frontend": ("src/frontend", "Node.js + Next.js"), "operator": ("operator", "Java"),
    }
    hints = _dockerfile_hints(model)
    assert sorted(hints["merged"]) == [
        ("operator/scripts/Dockerfile-custom-image", "operator", texts.REASON_DOCKERFILE_SUBDIR),
        ("src/checkout/genproto/Dockerfile", "checkout", texts.REASON_DOCKERFILE_SUBDIR),
        ("src/frontend/Dockerfile.cypress", "frontend", texts.REASON_DOCKERFILE_SIBLING),
    ]
    assert hints["unassigned"] == [
        ("src/react-native-app/android.Dockerfile", None, texts.REASON_MOBILE_APP),
    ]
    assert walk.mobile_dir("src/react-native-app/Gemfile") == "src/react-native-app/"
    assert walk.mobile_dir("apps/ios/Dockerfile") == "apps/ios/"
    assert walk.mobile_dir("cmd/bios/Dockerfile") is None


def test_dev_sign_by_image_tag() -> None:
    """Тег образа разработки (ТЗ §15 п. 13 Д1): Forem container-compose.yml bundle на
    quay.io/forem/forem:development. Тег целиком или последней частью через «-» и «_»
    (main_test), у брокера тоже (rabbitmq:local). Ловушки: у сервиса с build тег образа —
    имя локальной сборки (Forem docker-compose.yml: forem:1.0.0-development у web), версии,
    latest, alpine и вариант Chainguard latest-dev (Supabase docker-compose.s3.yml
    minio-client) не признак."""
    model = model_of(FIXTURES / "dev-image-tags")
    assert sorted(o.name for o in model.objects) == [
        "api", "cache", "db", "mc", "proxy", "web",
    ]
    dev = {str(h["name"]): str(h["reason"]) for h in model.hints["profiles"]}
    tag = texts.dev_sign_image_tag
    assert dev == {
        "bundle": texts.dev_manifest(tag("development")),
        "checker": texts.dev_manifest(tag("main_test")),
        "queue": texts.dev_manifest(tag("local")),
    }
    assert vocab.dev_image_tag("node:22-alpine") is None
    assert vocab.dev_image_tag("python:3.12-slim") is None
    assert vocab.dev_image_tag("registry:5000/app") is None
    assert vocab.dev_image_tag("app:1.2-dev") == "1.2-dev"
