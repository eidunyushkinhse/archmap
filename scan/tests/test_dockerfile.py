"""Разборщик Dockerfile: стадии, ссылки на стадии, переносы, команды."""

from __future__ import annotations

from archmap_scan import texts
from archmap_scan.parsers import dockerfile
from archmap_scan.walk import Excluded, list_files, template_rule
from tests.helpers import FIXTURES, ctx_of, files_of, model_of


def test_fixture() -> None:
    ctx, files = files_of(FIXTURES / "dockerfile")
    found = dockerfile.parse(files, ctx)
    by_path = {d.path: d for d in found.dockerfiles}
    assert set(by_path) == {"Dockerfile-postgresql", "tools/ci/Dockerfile", "web/Dockerfile"}
    web = by_path["web/Dockerfile"]
    assert web.images == ["node:20-alpine", "nginx:1.27-alpine"]
    assert web.dir == "web" and str(web.from_loc) == "web/Dockerfile:2"
    assert web.command == "/docker-entrypoint.sh nginx -g daemon off;"
    assert str(web.command_loc) == "web/Dockerfile:8"


def test_stage_reference_and_shell_form() -> None:
    info = dockerfile.parse_text(
        "Dockerfile",
        "FROM python:3.12 AS base\nFROM base AS final\nCMD gunicorn app:wsgi\n",
    )
    assert info is not None
    assert info.images == ["python:3.12", "python:3.12"]
    assert info.command == "gunicorn app:wsgi" and str(info.command_loc) == "Dockerfile:3"


def test_entrypoint_only_and_bad_json() -> None:
    info = dockerfile.parse_text("D", "FROM go\nENTRYPOINT [not json\n")
    assert info is not None and info.command == "[not json"
    assert dockerfile.parse_text("D", "# только комментарий\nRUN x\n") is None


def test_continuation_at_end_of_file() -> None:
    info = dockerfile.parse_text("D", "FROM a\nCMD run \\")
    assert info is not None and info.command == "run"


def test_names() -> None:
    for name in ("Dockerfile", "a/Dockerfile.prod", "worker.Dockerfile", "Dockerfile-db"):
        assert dockerfile.is_dockerfile(name)
    assert not dockerfile.is_dockerfile("Dockerfiles.md")


def test_templates_and_name_forms() -> None:
    """Шаблон Dockerfile не Dockerfile (ТЗ §15 п. 12 С2): Dockerfile.j2 роли Ansible AWX
    (tools/ansible/roles/dockerfile/templates/Dockerfile.j2) стал объектом «j2». Такой файл
    не читается, в покрытии причина «template». Форма «<имя>.Dockerfile» равна
    «Dockerfile.<имя>»: debug.Dockerfile рядом с Dockerfile — тот же вариант разработки, что
    Dockerfile.debug. Ловушка: Dockerfile-fpm Monica (дефис) остаётся Dockerfile варианта fpm."""
    root = FIXTURES / "dockerfile-forms"
    listing = list_files(ctx_of(root))
    assert set(listing.excluded) == {
        Excluded("php/Dockerfile.template", 1, "template"),
        Excluded("roles/dockerfile/templates/Dockerfile.j2", 1, "template"),
    }
    model = model_of(root)
    assert sorted(o.name for o in model.objects) == ["api", "fpm", "worker"]
    merged = {h["name"]: (h["object"], h["reason"]) for h in model.hints["merged"]}
    assert merged == {
        "api/Dockerfile.debug": ("api", texts.REASON_DOCKERFILE_VARIANT),
        "worker/debug.Dockerfile": ("worker", texts.REASON_DOCKERFILE_VARIANT),
    }
    assert template_rule("Dockerfile.in") == "Dockerfile.in"
    assert template_rule("a/app.Dockerfile.tpl") == "a/app.Dockerfile.tpl"
    assert template_rule("supervisor.conf.template") is None
    assert template_rule("Dockerfile-fpm") is None


def test_language_by_last_stage() -> None:
    """Язык по образу у последней стадии (ТЗ §15 п. 12 С4): scripts/docker/Dockerfile-fpm
    Monica собирает ресурсы на node:22 (стадия yarn), а итоговый образ php:8.3-fpm, и
    объект fpm получил Node.js. Стадии сборки язык не задают. Ловушки: одностадийный
    node:22 остаётся Node.js; последняя стадия scratch или alpine языка не задаёт, тогда язык
    у предыдущей стадии с языком (Go-бинарь из builder)."""
    model = model_of(FIXTURES / "dockerfile-stages")
    kinds = {o.name: o.technology for o in model.objects}
    assert kinds == {"fpm": "PHP", "web": "Node.js", "gosvc": "Go", "edge": "Go"}


def test_copies_whole_context() -> None:
    """«COPY . ./» и «ADD . /src» копируют весь контекст сборки (ТЗ §15 п. 12 С5б:
    scripts/docker/Dockerfile Monica): код образа — каталог контекста. Ловушки: копия из
    стадии (--from), копия одного файла и подкаталога весь контекст не копируют."""
    def ctx(body: str) -> bool:
        info = dockerfile.parse_text("D", "FROM php:8.3\n" + body)
        assert info is not None
        return info.copies_context

    assert ctx("COPY --chown=www-data:www-data . ./\n")
    assert ctx('ADD [".", "/src"]\n')
    assert ctx("COPY ./ /app\n")
    assert not ctx("COPY --from=yarn . ./public\n")
    assert not ctx("COPY composer.json ./\nCOPY src/ ./src\n")
    assert not ctx("COPY .\n")


def test_copy_sources_of_last_stage() -> None:
    """Источники COPY и ADD последней стадии из контекста сборки (ТЗ §15 п. 16 С1): флаги
    и назначение отбрасываются, форма JSON читается. Ловушки: COPY ранней стадии, --from,
    адрес URL и шаблон с «*» источниками не считаются."""
    text = (
        "FROM node:22 AS build\n"
        "COPY package.json ./\n"
        "FROM envoyproxy/envoy:v1.30\n"
        "COPY --from=build /app/dist /srv\n"
        "COPY --chown=envoy:envoy envoy.yaml \\\n"
        "     clusters/ /etc/envoy/\n"
        'ADD ["conf/extra.yaml", "/etc/envoy/extra.yaml"]\n'
        "ADD https://example.com/certs.pem /etc/ssl/\n"
        "COPY *.lua /etc/envoy/lua/\n"
    )
    assert list(dockerfile.copy_sources(text)) == [
        (5, "envoy.yaml"), (5, "clusters/"), (7, "conf/extra.yaml"),
    ]


def test_technology_by_final_image() -> None:
    """Технология сервиса без языка по образу итоговой стадии (ТЗ §15 п. 18 Т1): у
    grafana-server и prometheus-server Petclinic (docker/grafana/Dockerfile:1
    grafana/grafana:11.4.0), frontend-proxy и image-provider OpenTelemetry Demo (Envoy и
    nginx-unprivileged с дайджестом), executors Airflow (apache/airflow:latest) технологии не
    было. Основание — строка последнего FROM; ссылка на стадию берёт образ стадии (ui).
    Ловушки: базовый образ ОС (alpine, ubi9-micro), подстановка ${BASE_IMAGE} и имя без
    стадии и образа в словаре (builder) технологии не дают; язык предыдущей стадии (python
    перед nginx у site) остаётся старше образа."""
    model = model_of(FIXTURES / "dockerfile-final")
    techs = {o.name: o.technology for o in model.objects}
    assert techs == {
        "airflow": "Airflow", "base": None, "builder": None, "grafana": "Grafana",
        "proxy": "Envoy", "site": "Python", "subst": None, "ui": "nginx",
    }
    locs = {o.name: sorted(str(loc) for loc in o.locs) for o in model.objects}
    assert locs["proxy"] == ["proxy/Dockerfile:2"]
    assert locs["ui"] == ["ui/Dockerfile:1", "ui/Dockerfile:3"]
    # Роль «прокси» по тому же словарю образов (ТЗ §15 п. 19 Т3): у Envoy и nginx итоговой
    # стадии; программа (Grafana, Airflow) и язык (site) — «сервис».
    roles = {o.name: o.role for o in model.objects}
    assert roles == {
        "airflow": "сервис", "base": "сервис", "builder": "сервис", "grafana": "сервис",
        "proxy": "прокси", "site": "сервис", "subst": "сервис", "ui": "прокси",
    }


def test_proxy_role_by_final_image() -> None:
    """Роль «прокси» по итоговой стадии своего Dockerfile (ТЗ §15 п. 19 Т3): otel-demo
    frontend-proxy (src/frontend-proxy/Dockerfile, FROM envoyproxy/envoy) и image-provider
    (FROM nginxinc/nginx-unprivileged) были «сервис», а сервис compose на том же образе —
    «прокси». Основание — строка FROM, как у технологии. Ловушки: роль по команде старше
    (jobs на nginx с командой воркера), программа не прокси (Grafana)."""
    model = model_of(FIXTURES / "dockerfile-proxy-role")
    kinds = {o.name: (o.role, o.technology) for o in model.objects}
    assert kinds == {
        "edge": ("прокси", "Envoy"), "images": ("прокси", "nginx"), "jobs": ("воркер", "nginx"),
        "stats": ("сервис", "Grafana"),
    }
    edge = next(o for o in model.objects if o.name == "edge")
    assert "edge/Dockerfile:1" in {str(loc) for loc in edge.locs}
    info = dockerfile.parse_text("D", "FROM a AS b\nRUN x\nFROM b\n")
    assert info is not None and str(info.final_loc) == "D:3" and str(info.from_loc) == "D:1"
