"""Разборщик compose: сервисы, слияние файлов, профили, подсказки, пределы."""

from __future__ import annotations

import shutil
from functools import partial
from pathlib import Path

from archmap_scan import registry, texts
from archmap_scan.assemble import assemble
from archmap_scan.context import make_context
from archmap_scan.model import Findings, Unit
from archmap_scan.objects import Model
from archmap_scan.parsers import compose, proxyconf
from archmap_scan.walk import Files, list_files
from archmap_scan.yamlload import MAX_YAML_BYTES, load_all
from tests.helpers import FIXTURES, files_of, git, model_of, time_limit, timed, tree


def _parse(root: Path) -> Findings:
    ctx, files = files_of(root)
    return compose.parse(files, ctx)


def _unit(found: Findings, name: str) -> Unit:
    return next(u for u in found.units if u.name == name)


def test_fixture_services() -> None:
    found = _parse(FIXTURES / "compose")
    assert sorted(u.name for u in found.units if u.dev is None) == [
        "api", "cache", "db", "legacy", "proxy", "search", "web", "worker",
    ]
    # Сервис только файла разработки — кандидат с признаком, судьбу решает сборка.
    assert [(u.name, u.dev) for u in found.units if u.dev is not None] == [
        ("mailpit", texts.dev_sign_file("docker-compose.dev.yml")),
    ]
    api = _unit(found, "api")
    assert api.build_dir == "services/api"
    assert api.dockerfile == "services/api/Dockerfile.prod"
    assert api.command == "gunicorn api.wsgi --workers 4"
    assert api.host == "api"
    env = {e.name: e for e in api.env}
    # Якорь «<<: *env» раскрыт, поздний файл (override) добавил свою переменную.
    assert set(env) == {
        "LOG_LEVEL", "DATABASE_URL", "CACHE_URL", "SEARCH_HOST", "METRICS_PORT", "FEATURE_X",
    }
    assert env["DATABASE_URL"].dynamic and not env["CACHE_URL"].dynamic
    assert env["METRICS_PORT"].value == "9100"
    assert [d for d, _ in api.depends_on] == ["db", "worker"]
    assert str(api.loc) == "docker-compose.yml:7"
    assert [str(loc) for loc in api.extra_locs] == ["docker-compose.override.yml:2"]

    worker = _unit(found, "worker")
    assert worker.build_dir == "services/api" and worker.dockerfile == "services/api/Dockerfile"
    assert {e.name: e.value for e in worker.env} == {
        "CELERY_BROKER_URL": "redis://cache:6379/1", "DEBUG": None,
    }
    assert _unit(found, "search").image == "docker.elastic.co/elasticsearch/elasticsearch:8.13.0"


def test_fixture_hints() -> None:
    found = _parse(FIXTURES / "compose")
    by_section: dict[str, list[dict[str, object]]] = {}
    for h in found.hints:
        by_section.setdefault(h.section, []).append(h.data)
    profiles = {str(h["name"]): h for h in by_section["profiles"]}
    assert profiles["adminer"]["profiles"] == ["debug"]
    assert "mailpit" not in profiles
    reasons = {(h["name"], h["reason"]) for h in by_section["unassigned"]}
    assert any(name == "legacy" and "extends" in str(r) for name, r in reasons)
    assert any(name == "worker" and "env_file" in str(r) for name, r in reasons)
    assert any(name == "compose.yaml" and "include" in str(r) for name, r in reasons)
    assert by_section["unparsed"] == [
        {
            "kind": "file", "name": "docker-compose.broken.yml",
            "reason": by_section["unparsed"][0]["reason"], "source": "docker-compose.broken.yml",
        }
    ]
    dynamic = by_section["dynamic_names"]
    assert [(h["kind"], h["object"], h["name"]) for h in dynamic] == [
        ("env", "api", "DATABASE_URL"),
    ]
    # Значение подстановки в подсказки не попадает.
    assert "API_DB_PASSWORD" not in repr(by_section)


def test_compose_v1_and_lists(tmp_path: Path) -> None:
    tree(tmp_path, {
        "docker-compose.yml": (
            "web:\n  image: nginx\n  command: [nginx, -g, daemon off;]\n"
            "  environment: [A=1, B]\n  depends_on: {db: {condition: x}}\n"
            "db:\n  image: mysql:8\n"
        ),
    })
    found = _parse(tmp_path)
    web = _unit(found, "web")
    assert web.command == "nginx -g daemon off;"
    assert [(e.name, e.value) for e in web.env] == [("A", "1"), ("B", None)]
    assert [d for d, _ in web.depends_on] == ["db"]


def test_build_outside_root_and_remote(tmp_path: Path) -> None:
    tree(tmp_path, {
        "docker-compose.yml": (
            "services:\n  a:\n    build: ../elsewhere\n"
            "  b:\n    build: https://github.com/org/b.git\n"
            "  c:\n    build:\n      context: .\n"
        ),
    })
    found = _parse(tmp_path)
    assert _unit(found, "a").build_dir is None
    assert _unit(found, "b").build_dir is None
    assert _unit(found, "c").build_dir == "" and _unit(found, "c").dockerfile == "Dockerfile"
    assert any("вне области" in str(h.data["reason"]) for h in found.hints)


def test_too_large_yaml_is_refused(tmp_path: Path) -> None:
    tree(tmp_path, {"docker-compose.yml": "services: {}\n# " + "x" * MAX_YAML_BYTES + "\n"})
    ctx, files = files_of(tmp_path)
    found = compose.parse(files, ctx)
    assert found.units == [] and files.too_large == {"docker-compose.yml"}


def test_not_a_mapping(tmp_path: Path) -> None:
    tree(tmp_path, {"compose.yaml": "- a\n- b\n", "compose.dev.yaml": "services: [x]\n"})
    assert _parse(tmp_path).units == []


def test_unreadable_listed_file_is_skipped(tmp_path: Path) -> None:
    files = Files(tmp_path, ["docker-compose.yml"])
    ctx, _ = files_of(tmp_path)
    assert compose.parse(files, ctx).units == []


def test_missing_build_context_is_not_code_dir(tmp_path: Path) -> None:
    """Контекст сборки, которого нет в обходе (находка фазы 1а на Grafana: путь,
    записанный относительно другого корня), каталогом кода не становится: path не
    ставится, причина — в подсказках."""
    tree(tmp_path, {
        "deploy/docker-compose.yml": (
            "services:\n"
            "  api:\n    build: ../services/api\n"
            "  ghost:\n    build:\n      context: docker/blocks/ghost\n"
        ),
        "services/api/main.py": "print('api')\n",
    })
    found = _parse(tmp_path)
    assert _unit(found, "api").build_dir == "services/api"
    ghost = _unit(found, "ghost")
    assert ghost.build_dir is None and ghost.dockerfile is None
    hints = [h.data for h in found.hints if h.section == "unassigned"]
    assert hints == [{
        "kind": "container", "name": "ghost", "reason": "каталог сборки не найден в репозитории",
        "source": "deploy/docker-compose.yml:5",
    }]


def test_files_has_dir(tmp_path: Path) -> None:
    files = Files(tmp_path, ["a/b/c.txt", "d.txt"])
    assert files.has_dir("") and files.has_dir("a") and files.has_dir("a/b")
    assert not files.has_dir("a/b/c.txt") and not files.has_dir("x")
    assert not Files(tmp_path, []).has_dir("")


def test_substitutions_with_defaults(tmp_path: Path) -> None:
    """Находка фазы 1а на Grafana: «technology: server}» из образа с подстановками.
    ${VAR:-x} и ${VAR-x} раскрываются в дефолт; оставшаяся подстановка в image —
    технологии нет, место в подсказках."""
    tree(tmp_path, {
        "docker-compose.yml": (
            "services:\n"
            "  authentik:\n"
            "    image: ${AUTHENTIK_IMAGE:-ghcr.io/goauthentik/server}:${TAG:-2024.2}\n"
            "    environment:\n"
            "      PG_URL: postgres://u:${PW-secret}@db:${PG_PORT:-5432}/x\n"
            "      OTHER: http://${HOST}:80\n"
            "    command: celery worker -Q ${QUEUES:-mail,push}\n"
            "  custom:\n    image: ${REGISTRY}/thing:1\n"
            "  bare:\n    image: $IMAGE\n"
            "  built:\n    image: ${REGISTRY}/built\n    build: .\n"
            "  nested:\n    image: ${A:-${B:-redis}}:7\n"
            "  escaped:\n    image: nginx\n    command: sh -c 'echo $$HOME ${X:?нужен}'\n"
        ),
    })
    found = _parse(tmp_path)
    auth = _unit(found, "authentik")
    assert auth.image == "ghcr.io/goauthentik/server:2024.2"
    env = {e.name: e for e in auth.env}
    assert env["PG_URL"].value == "postgres://u:secret@db:5432/x" and not env["PG_URL"].dynamic
    assert env["OTHER"].dynamic
    assert auth.command == "celery worker -Q mail,push"
    assert _unit(found, "custom").image is None and _unit(found, "bare").image is None
    assert _unit(found, "built").image is None and _unit(found, "built").build_dir == ""
    assert _unit(found, "nested").image == "redis:7"
    assert _unit(found, "escaped").command == "sh -c 'echo $$HOME ${X:?нужен}'"
    dynamic = sorted(
        (str(h.data["object"]), str(h.data["name"]))
        for h in found.hints if h.section == "dynamic_names"
    )
    assert dynamic == [("authentik", "OTHER"), ("bare", "image"), ("custom", "image")]


def test_expand_is_bounded() -> None:
    assert compose.expand("${A:-x}${B-y}${C}$D") == "xy${C}$D"
    assert compose.expand("${A:-") == "${A:-"
    assert compose.expand("${:-x}") == "${:-x}"
    deep = "${A:-" * 50 + "v" + "}" * 50
    assert "v" in compose.expand(deep)
    hostile = "${A:-" * 200_000
    assert compose.expand(hostile) == hostile


def test_expand_hostile_in_time() -> None:
    for value in ("${A}" * 60_000, "${A:-" * 60_000, "a$" * 120_000, "${A:-x" + "}" * 240_000):
        _out, took = timed(partial(compose.expand, value), 1.0)
        assert took < 1.0


_DOTENV = (
    "# Переменные compose\n"
    "IMAGE_NAME=ghcr.io/example/demo\n"
    "DEMO_VERSION=2.0.0\n"
    "AD_DOCKERFILE=services/advert/Dockerfile\n"
    "AD_PORT=9555\n"
    "AD_ADDR=ad:${AD_PORT}\n"
    "EXTERNAL_URL=https://shop.example.com\n"
    "SECRET_TOKEN=not-a-param\n"
    "KAFKA_DOCKERFILE=src/kafka/Dockerfile\n"
    "CHECKOUT_DOCKERFILE=src/checkout/Dockerfile\n"
)


def _dotenv_model(root: Path, use_git: bool) -> Model:
    ctx = make_context(root, use_git=use_git)
    files = Files(ctx.root, list_files(ctx).files)
    findings, errors = registry.collect(files, ctx)
    assert errors == {}
    return assemble(findings, ctx)


def test_dotenv_substitution_only_when_committed(tmp_path: Path) -> None:
    """Переменные compose из закоммиченного .env (ТЗ §15 п. 12 С13). OpenTelemetry Demo
    (docker-compose.yml): dockerfile: ${AD_DOCKERFILE}, image: ${IMAGE_NAME} и адреса
    ${AD_ADDR} живут в закоммиченном .env, 46 подсказок «значение с подстановкой
    переменной». С git .env раскрывает подстановки в dockerfile, image и environment: у ad
    свой Dockerfile на Java, у web связь к ad по адресу ad:9555 (хост равен имени сервиса,
    §6). Попутно: src/kafka/Dockerfile на apache/kafka без манифестов сборки даёт брокер, а
    genproto/ в каталоге Dockerfile checkout остаётся вариантом, как без .env. Ловушки: адрес
    чужого хоста (EXTERNAL_URL) связи не даёт; SECRET_TOKEN из .env параметром не становится;
    .env в .gitignore (не закоммичен) и без git не читается."""
    repo = tmp_path / "repo"
    shutil.copytree(FIXTURES / "compose-dotenv", repo)
    (repo / ".env").write_text(_DOTENV, encoding="utf-8")
    git(repo, "init", "-q")
    git(repo, "add", "-A")
    git(repo, "add", "-f", ".env")
    git(repo, "commit", "-qm", "init")
    model = _dotenv_model(repo, use_git=True)
    objs = {o.name: o for o in model.objects}
    assert set(objs) == {"ad", "web", "kafka", "checkout"}
    # Брокер по образу своего Dockerfile без манифестов сборки, как у Dockerfile без
    # манифеста; genproto/ в каталоге Dockerfile checkout — его вариант (С8).
    assert (objs["kafka"].shape, objs["kafka"].technology) == ("broker", "Kafka")
    assert [h["name"] for h in model.hints["merged"]] == ["src/checkout/genproto/Dockerfile"]
    ad = objs["ad"]
    assert ad.dockerfile is not None and ad.dockerfile.path == "services/advert/Dockerfile"
    assert ad.technology == "Java"
    assert {(lk.src.name, lk.dst.name) for lk in model.links} == {("web", "ad")}
    assert "SECRET_TOKEN" not in {n for table in model.params.values() for n in table}
    dynamic = [h for h in model.hints.get("dynamic_names", []) if h["kind"] == "env"]
    assert dynamic == []
    # Не закоммиченный .env (в .gitignore) и обход без git: подстановок нет.
    other = tmp_path / "ignored"
    shutil.copytree(FIXTURES / "compose-dotenv", other)
    (other / ".env").write_text(_DOTENV, encoding="utf-8")
    (other / ".gitignore").write_text(".env\n", encoding="utf-8")
    git(other, "init", "-q")
    git(other, "add", "-A")
    git(other, "commit", "-qm", "init")
    for model in (_dotenv_model(other, use_git=True), _dotenv_model(repo, use_git=False)):
        names = {o.name for o in model.objects}
        assert names == {"ad", "advert", "web", "kafka", "checkout"}
        assert model.links == []


def test_proxy_config_links() -> None:
    """Смонтированный файл конфигурации прокси (ТЗ §15 п. 14 Ж3). Найдено в Lemmy:
    docker/docker-compose.yml:9–17 сервис proxy на nginx:1-alpine с томом ./nginx.conf, а в
    docker/nginx.conf:8 upstream lemmy { server "lemmy:8536"; }; в PostHog
    docker-compose.base.yml:112 Caddyfile строками в environment с reverse_proxy capture:3000.
    Ловушки: каталог тома читается только своими файлами (conf.d/sub/ нет); server
    127.0.0.1 и имя upstream в proxy_pass связей не дают; сервис не прокси (app) свой том
    не читает; внешний хост — подсказка; отсутствующий файл и путь вне репозитория —
    hints.unparsed; depends_on proxy → api и web не пишется, связь уже есть."""
    root = FIXTURES / "compose-proxy"
    model = model_of(root)
    links = {
        (lk.src.name, lk.dst.name): (lk.technology, sorted(str(loc) for loc in lk.locs))
        for lk in model.links
    }
    assert links == {
        ("edge", "api"): ("HTTP", ["compose.yaml:18"]),
        ("edge", "files"): ("HTTP", ["compose.yaml:19"]),
        ("edge", "web"): ("HTTP", ["compose.yaml:20"]),
        ("lb", "api"): ("HTTP", ["haproxy.cfg:5"]),
        ("proxy", "api"): ("HTTP", ["nginx/conf.d/default.conf:3", "nginx/nginx.conf:5"]),
        ("proxy", "web"): ("HTTP", ["nginx/nginx.conf:14"]),
    }
    assert [(h["name"], h["reason"]) for h in model.hints["unassigned"]] == [
        ("proxy→payments.example.com", texts.REASON_LINK_NOT_OBJECT),
    ]
    assert [(h["name"], h["reason"], h["source"]) for h in model.hints["unparsed"]] == [
        ("missing.conf", texts.REASON_PROXY_MISSING, "compose.yaml:7"),
        ("/etc/ssl", texts.REASON_PROXY_OUTSIDE, "compose.yaml:8"),
    ]
    assert "depends_on" not in model.hints


def test_proxy_config_hostile_is_fast(tmp_path: Path) -> None:
    """Враждебный файл конфигурации прокси: строка в 2 МБ, тысячи upstream и server,
    reverse_proxy с длинным хвостом. Разбор построчный, адресов не больше предела."""
    big = 2_000_000
    payloads = {
        "line": "a" * big,
        "upstreams": "upstream a {\n" * (big // 13),
        "servers": "upstream a {\n" + "    server x:1;\n" * (big // 16),
        "caddy": "reverse_proxy " + "a:1 " * (big // 4),
        "braces": "{" * big + "\nproxy_pass http://x;\n",
        "haproxy": "backend b\n" + "    server s h:1 check\n" * (big // 23),
    }
    for kind, text in payloads.items():
        root = tree(tmp_path / kind, {
            "compose.yaml": "services:\n  proxy:\n    image: nginx\n    volumes:\n"
            "      - ./p.conf:/etc/nginx/nginx.conf\n  x:\n    image: shop/x\n",
            "p.conf": text,
        })
        ctx, files = files_of(root)
        found, took = timed(partial(compose.parse, files, ctx), time_limit())
        assert took < time_limit(), f"{kind}: {took:.2f} с"
        assert sum(len(u.links) for u in found.units) <= 200


def _envoy_model(tmp_path: Path, use_git: bool) -> Model:
    repo = tmp_path / ("git" if use_git else "plain")
    shutil.copytree(FIXTURES / "compose-envoy", repo)
    (repo / ".env").write_text("FRONTEND_HOST=frontend\n", encoding="utf-8")
    git(repo, "init", "-q")
    git(repo, "add", "-A")
    git(repo, "add", "-f", ".env")
    git(repo, "commit", "-qm", "init")
    return _dotenv_model(repo, use_git=use_git)


def test_envoy_proxy_by_dockerfile(tmp_path: Path) -> None:
    """Прокси Envoy по базовому образу Dockerfile, конфигурация из COPY (ТЗ §15 п. 16 С1).
    Найдено в OpenTelemetry Demo: compose.yaml:324 frontend-proxy с образом
    ${IMAGE_NAME}:${DEMO_VERSION}-frontend-proxy, сборка src/frontend-proxy/Dockerfile
    (FROM envoyproxy/envoy, COPY ./src/frontend-proxy/envoy.tmpl.yaml), в нём кластеры с
    socket_address address: ${FRONTEND_HOST}, окружение «- FRONTEND_HOST» со значением в
    закоммиченном .env. Связи — кластеры load_assignment и старые hosts, подстановки из
    окружения единицы и .env. Ловушки: адрес слушателя (frontend, строка 6) и admin
    (0.0.0.0) связей не дают; 127.0.0.1 и нераскрытая ${ADMIN_HOST} связей не дают; файл
    ранней стадии (extra.yaml), файл не из COPY (envoy.dev.yaml) и конфигурация сервиса не
    прокси (api/sidecar.yaml за FROM python) не читаются; файл из COPY, которого нет в
    обходе (overrides.yaml), даёт подсказку; без git .env не читается и ${FRONTEND_HOST} не
    раскрывается."""
    model = _envoy_model(tmp_path, use_git=True)
    assert {o.name for o in model.objects} == {"proxy", "frontend", "api"}
    links = {
        (lk.src.name, lk.dst.name): (lk.technology, sorted(str(loc) for loc in lk.locs))
        for lk in model.links
    }
    assert links == {
        # compose.yaml:7 — адрес в окружении API_HOST=api, как и раньше.
        ("proxy", "api"): ("HTTP", ["compose.yaml:7", "proxy/envoy.yaml:29", "proxy/envoy.yaml:35"]),
        ("proxy", "frontend"): ("HTTP", ["proxy/envoy.yaml:18"]),
    }
    assert [(h["name"], h["reason"], h["source"]) for h in model.hints["unparsed"]] == [
        ("proxy/overrides.yaml", texts.REASON_PROXY_COPY_MISSING, "proxy/Dockerfile:9"),
    ]
    plain = _envoy_model(tmp_path, use_git=False)
    assert {(lk.src.name, lk.dst.name) for lk in plain.links} == {("proxy", "api")}


def test_proxy_kind_by_image_and_dockerfile(tmp_path: Path) -> None:
    """Вид прокси по образу и по базовому образу последней стадии Dockerfile (С1): свой тег
    со сборкой на nginx читает свой том как прокси, а сервис на образе словаря не прокси
    (postgres) своим Dockerfile в прокси не превращается."""
    assert [proxyconf.proxy_kind(i) for i in (
        "envoyproxy/envoy:v1.30", "nginx:1.27", "openresty/openresty", "caddy:2",
        "haproxy:3", "traefik:v3", "postgres:16", "shop/web:1.0",
    )] == ["envoy", "nginx", "nginx", "caddy", "haproxy", "traefik", None, None]
    root = tree(tmp_path, {
        "compose.yaml": "services:\n"
        "  web:\n    image: shop/web:1.0\n    build: ./web\n"
        "    volumes:\n      - ./web/site.conf:/etc/nginx/conf.d/default.conf\n"
        "  db:\n    image: postgres:16\n    build: ./db\n"
        "    volumes:\n      - ./db/proxy.conf:/etc/proxy.conf\n"
        "  api:\n    image: shop/api:1.0\n",
        "web/Dockerfile": "FROM node:22 AS build\nRUN npm ci\nFROM nginx:1.27-alpine\n",
        "web/site.conf": "server {\n  location /api {\n    proxy_pass http://api:8000;\n  }\n}\n",
        "db/Dockerfile": "FROM nginx:1.27\n",
        "db/proxy.conf": "proxy_pass http://api:8000;\n",
    })
    found = _parse(root)
    assert [(lk.src, lk.dst, str(lk.loc)) for u in found.units for lk in u.links] == [
        ("web", "api", "web/site.conf:3"),
    ]


def test_envoy_hostile_is_fast(tmp_path: Path) -> None:
    """Враждебный вход Envoy (С1). Обход кластеров по разобранному документу предельного
    размера YAML (десятки тысяч кластеров без раскрывшихся адресов) — в пределе с запасом;
    файл больше предела YAML непрочитан. Dockerfile прокси в 2 МБ (сто тысяч COPY, строка с
    миллионом источников): смотрится не больше 200 источников, разбор в пределе."""
    budget = MAX_YAML_BYTES - 200
    cluster = "    - hosts: [{socket_address: {address: '${B}'}}]\n"
    endpoint = (
        "    - load_assignment: {endpoints: [{lb_endpoints: [{endpoint: {address: "
        "{socket_address: {address: 127.0.0.1}}}}]}]}\n"
    )
    for item in (cluster, endpoint):
        docs = load_all("static_resources:\n  clusters:\n" + item * (budget // len(item)))
        # Повтор в timed по тому же пределу, что проверяется (ТЗ §15 п. 18 П3).
        limit = 0.7 * time_limit()
        got, took = timed(partial(lambda d: list(proxyconf.envoy_addresses(d)), docs), limit)
        assert took < limit, f"{took:.2f} с"
        assert len(got) == budget // len(item)
    compose_text = "services:\n  proxy:\n    build: ./p\n  a:\n    image: shop/a\n"
    big = tree(tmp_path / "big", {
        "compose.yaml": compose_text,
        "p/Dockerfile": "FROM envoyproxy/envoy:v1.30\nCOPY envoy.yaml /etc/envoy/\n",
        "p/envoy.yaml": "static_resources:\n  clusters:\n" + cluster * (MAX_YAML_BYTES // len(cluster)),
    })
    ctx, files = files_of(big)
    assert compose.parse(files, ctx).hints == [] and files.too_large == {"p/envoy.yaml"}
    dockerfiles = {
        "copies": "".join(f"COPY c{i}.yaml /e/\n" for i in range(100_000)),
        "sources": "COPY " + "a.yaml " * 290_000 + "/e/\n",
    }
    for kind, text in dockerfiles.items():
        root = tree(tmp_path / kind, {
            "compose.yaml": compose_text,
            "p/Dockerfile": "FROM envoyproxy/envoy:v1.30\n" + text,
        })
        ctx, files = files_of(root)
        limit = 0.7 * time_limit()
        found, took = timed(partial(compose.parse, files, ctx), limit)
        assert took < limit, f"{kind}: {took:.2f} с"
        assert len(found.hints) <= 200
