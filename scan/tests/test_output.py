"""Файлы вывода: schema.yaml, основания, подсказки, покрытие; детерминизм."""

from __future__ import annotations

import shutil
from pathlib import Path

import pytest
import yaml

from archmap_scan import __version__, texts
from archmap_scan.output import yamlio
from archmap_scan.scan import Options, run
from tests.helpers import FIXTURES, tree


def _read(out: Path, rel: str) -> str:
    return (out / rel).read_text(encoding="utf-8")


def _scan(root: Path, out: Path, system: str | None = "Ярмарка") -> Path:
    run(Options(path=str(root), out=str(out), system=system, use_git=False))
    return out


def test_schema_shape_and_order(tmp_path: Path) -> None:
    out = _scan(FIXTURES / "compose", tmp_path / "out")
    text = _read(out, "schema.yaml")
    assert text.startswith(f"# archmap-scan {__version__}\n# repo:\n# commit:\nnodes:\n")
    doc = yaml.safe_load(text)
    root = doc["nodes"][0]
    assert list(root) == ["name", "shape", "status", "element", "children"]
    assert root["name"] == "Ярмарка" and root["element"] == "system"
    db = next(c for c in root["children"] if c["name"] == "db")
    assert list(db) == ["name", "shape", "status", "role", "technology", "source"]
    assert db["source"] == {"host": "db"}
    assert all("description" not in c and "element" not in c for c in root["children"])
    assert list(doc["edges"][0]) == ["from", "to", "label", "technology"]


def test_evidence_covers_every_record(tmp_path: Path) -> None:
    out = _scan(FIXTURES / "compose", tmp_path / "out")
    schema = yaml.safe_load(_read(out, "schema.yaml"))
    evidence = yaml.safe_load(_read(out, "agent/evidence.yaml"))
    for child in schema["nodes"][0]["children"]:
        locs = evidence[f"nodes/Ярмарка / {child['name']}"]
        assert locs and all(":" in loc for loc in locs)
    for edge in schema["edges"]:
        channel = f"#{edge['channel']}" if "channel" in edge else ""
        assert evidence[f"edges/{edge['from']}→{edge['to']}{channel}"]


def test_hints_sections_always_present(tmp_path: Path) -> None:
    out = _scan(tree(tmp_path / "repo", {"README.md": "x"}), tmp_path / "out")
    hints = yaml.safe_load(_read(out, "agent/hints.yaml"))
    assert list(hints) == [
        "depends_on", "dynamic_names", "unassigned", "unsupported", "openapi_files",
        "profiles", "dev_manifest_objects", "shared_code", "clients", "unparsed",
        "external_repos", "merged",
    ]
    assert all(v == [] for v in hints.values())


def test_name_clash_uses_path(tmp_path: Path) -> None:
    root = tree(tmp_path / "repo", {
        "docker-compose.yml": (
            "services:\n  shop:\n    image: ghcr.io/x/shop\n    environment:\n"
            "      DB: postgres://db/x\n  db:\n    image: postgres\n"
        ),
    })
    out = _scan(root, tmp_path / "out", system="shop")
    doc = yaml.safe_load(_read(out, "schema.yaml"))
    assert doc["edges"] == [
        {"from": "shop / shop", "to": "db", "label": "использует", "technology": "PostgreSQL"}
    ]


def test_double_run_is_byte_identical(tmp_path: Path) -> None:
    first = _scan(FIXTURES / "compose", tmp_path / "a")
    second = _scan(FIXTURES / "compose", tmp_path / "b")
    names = sorted(p.relative_to(first).as_posix() for p in first.rglob("*") if p.is_file())
    assert names == sorted(
        p.relative_to(second).as_posix() for p in second.rglob("*") if p.is_file()
    )
    for rel in names:
        assert (first / rel).read_bytes() == (second / rel).read_bytes(), rel


def test_colon_values_are_double_quoted() -> None:
    assert yamlio.dump({"a": "x: y", "b": "plain"}) == 'a: "x: y"\nb: plain\n'
    assert yamlio.dump({"f": yamlio.Flow(s=1, l=yamlio.FlowSeq(["a"]))}) == "f: {s: 1, l: [a]}\n"


def test_summary_words(tmp_path: Path) -> None:
    out = _scan(FIXTURES / "compose", tmp_path / "out")
    text = _read(out, "summary.txt")
    assert "Найдено: 5 контейнеров, 2 базы данных, 1 брокер, 5 связей, 8 параметров" in text
    assert "«Новый проект»" in text and "«Импорт»" in text and "«Обновить из кода»" in text
    for bad in (", " + "\u2014", "." * 3, "\u2026"):
        assert bad not in text


def test_summary_empty_repo(tmp_path: Path) -> None:
    """Находка фазы 1б на Zabbix: «Ничего не найдено.», а ниже совет импортировать пустую
    схему. Без объектов нет ни раздела «Как импортировать», ни абзаца про связи: остаётся
    только совет про .gitignore."""
    out = _scan(tree(tmp_path / "repo", {"README.md": "x"}), tmp_path / "out")
    text = _read(out, "summary.txt")
    assert "Ничего не найдено." in text
    assert "Искали и не нашли: контейнеры" in text
    for absent in ("Как импортировать", "schema.yaml", "Каталог agent", "Связи сборщик видит"):
        assert absent not in text
    assert text.endswith("\n\nКаталог с результатом стоит добавить в .gitignore репозитория.\n")


def test_summary_counts_only_written(tmp_path: Path) -> None:
    """Находка фазы 1а: сводка обещала «Найдено: 311 таблиц» и инструкцию импорта таблиц,
    а все таблицы лежали в hints.unassigned. Найденное без владельца в «Найдено» не входит,
    названо строкой в «Пояснениях», инструкции для незаписанных файлов нет."""
    root = tree(tmp_path / "repo", {
        "docker-compose.yml": (
            "services:\n  a-db:\n    image: postgres\n  b-db:\n    image: mysql\n"
        ),
        "db/migrations/V1__init.sql": "CREATE TABLE t (id int);\nCREATE TABLE u (id int);\n",
    })
    out = _scan(root, tmp_path / "out")
    summary = _read(out, "summary.txt")
    assert "Найдено: 2 базы данных." in summary
    assert "таблиц" not in summary.split("\n\n")[1]
    assert "Искали и не нашли" in summary and "таблицы" not in summary.split("Не разобрано")[0]
    assert "  Таблиц без владельца: 2, перечень в agent/hints.yaml." in summary
    assert "facts/*.tables.yaml" not in summary
    assert not (out / "facts").exists()
    coverage = yaml.safe_load(_read(out, "coverage.yaml"))
    assert coverage["families"]["tables"] == {
        "status": "covered", "parsers": ["sql"], "unassigned": 2,
    }


def test_texts_lists_and_partial() -> None:
    from archmap_scan import texts

    assert texts.and_list([]) == "" and texts.and_list(["a"]) == "a"
    assert texts.and_list(["a", "b", "c"]) == "a, b и c"
    assert texts.family_partial("Параметры конфигурации", ["Node.js", "Python"], True, False) == (
        "Параметры конфигурации: найдено в манифестах, код на Node.js и Python сборщик пока "
        "не читает."
    )
    assert texts.family_partial("Маршруты HTTP", ["Next.js"], True, True) == (
        "Маршруты HTTP: найдено не всё, Next.js сборщик пока не читает."
    )
    assert texts.family_partial("Контейнеры", ["Helm templates"], False, False) == (
        "Контейнеры: найдено не всё, Helm templates сборщик пока не читает."
    )


def test_shared_params_counted_by_name(tmp_path: Path) -> None:
    """Находка фазы 1б на Zulip: 26 имён общего кода записаны каждому из 8 контейнеров, а
    сводка говорила «140 параметров». «Найдено» считает имена, записи названы строкой в
    «Пояснениях», в coverage found — записи, distinct — имена (ТЗ §7)."""
    root = tree(tmp_path / "repo", {
        "docker-compose.yml": (
            "services:\n  web:\n    build: ./app\n  worker:\n    build: ./app\n"
            "    environment:\n      ONLY_WORKER: '1'\n"
        ),
        "app/requirements.txt": "flask\n",
        "app/main.py": 'import os\nA = os.getenv("A", "1")\nB = os.environ["B"]\n',
    })
    result = run(Options(path=str(root), out=str(tmp_path / "out"), use_git=False))
    summary = result.summary
    assert "3 параметра конфигурации" in summary.split("\n\n")[1]
    # Свой параметр worker в число записей общего кода не входит.
    assert "  Параметры общего кода записаны каждому из 2 контейнеров: записей 4." in summary
    coverage = yaml.safe_load(_read(tmp_path / "out", "coverage.yaml"))
    assert coverage["families"]["config"]["found"] == 5
    assert coverage["families"]["config"]["distinct"] == 3
    as_json = result.coverage.as_json()["families"]
    assert isinstance(as_json, dict)
    assert as_json["config"]["found"] == 5 and as_json["config"]["distinct"] == 3


def test_distinct_absent_when_names_equal_records(tmp_path: Path) -> None:
    out = _scan(FIXTURES / "compose", tmp_path / "out")
    coverage = yaml.safe_load(_read(out, "coverage.yaml"))
    assert "distinct" not in coverage["families"]["config"]
    assert "Параметры общего кода" not in _read(out, "summary.txt")


def test_hints_share_one_key_set(tmp_path: Path) -> None:
    """У записи любого раздела hints.yaml один набор ключей (ТЗ §5.3): kind, name, reason,
    source, при необходимости object, затем ключи раздела; порядок постоянный."""
    from archmap_scan.output.agent import HINT_KEYS

    seen: set[str] = set()
    for fixture in (
        "yarmarka", "compose", "supervisor", "k8s", "helm", "openapi", "manifests", "procfile",
        "alembic", "django", "celery", "kafka",
    ):
        out = _scan(FIXTURES / fixture, tmp_path / fixture)
        hints = yaml.safe_load(_read(out, "agent/hints.yaml"))
        for section, items in hints.items():
            for item in items:
                keys = list(item)
                assert {"kind", "name", "reason", "source"} <= set(keys), (fixture, section, item)
                common = [k for k in keys if k in HINT_KEYS]
                assert keys[: len(common)] == [k for k in HINT_KEYS if k in item], item
                seen.add(section)
    # Проверка не пустая: подсказки нашлись в большинстве разделов.
    assert {"depends_on", "dynamic_names", "unassigned", "profiles", "openapi_files", "clients",
            "unparsed", "shared_code"} <= seen


HINT_APP = """from fastapi import APIRouter, FastAPI
app = FastAPI()
router = APIRouter()
STATUS = "/status"


@app.get(STATUS)
def status():
    return 1


@router.api_route(STATUS, methods=METHODS)
def any_status():
    return 1
"""
HINT_BEAT = (
    "from celery import Celery\n"
    'app = Celery("proj")\n'
    'app.conf.beat_schedule = {"close-day": {"task": "proj.close", "schedule": 300},\n'
    "    NAME: {'task': 'proj.open', 'schedule': crontab(hour=6)}}\n"
)


def test_hint_record_fields(tmp_path: Path) -> None:
    """Поля записи в подсказке (ТЗ §15 п. 16 П3): маршрут с путём выражением несёт метод,
    если регистрация его называет (ANY не пишется), маршрут без владельца — метод,
    расписание без владельца — настоящее расписание и задачу. Ключи после общих в порядке
    method, schedule, task."""
    out = _scan(tree(tmp_path / "repo", {
        "docker-compose.yml": (
            "services:\n  web:\n    build: ./app\n    command: uvicorn proj.api:app\n"
            "  worker:\n    build: ./app\n    command: celery -A proj worker\n"
        ),
        "app/requirements.txt": "fastapi\ncelery\n",
        "app/proj/api.py": HINT_APP,
        "app/proj/celery_app.py": HINT_BEAT,
        "lib/requirements.txt": "fastapi\n",
        "lib/shared.py": 'from fastapi import FastAPI\napp = FastAPI()\n\n@app.post("/x")\ndef x():\n    return 1\n',
    }), tmp_path / "out")
    hints = yaml.safe_load(_read(out, "agent/hints.yaml"))
    routes = [h for h in hints["dynamic_names"] if h["kind"] == "route"]
    assert routes == [
        {"kind": "route", "name": "STATUS", "reason": texts.REASON_DYNAMIC_ROUTE,
         "source": "app/proj/api.py:12"},
        {"kind": "route", "name": "STATUS", "reason": texts.REASON_DYNAMIC_ROUTE,
         "source": "app/proj/api.py:7", "method": "GET"},
    ]
    unassigned = {h["kind"]: h for h in hints["unassigned"]}
    assert list(unassigned["route"].items()) == [
        ("kind", "route"), ("name", "POST /x"), ("reason", texts.REASON_SHARED_LIB),
        ("source", "lib/shared.py:4"), ("method", "POST"),
    ]
    assert list(unassigned["schedule"].items()) == [
        ("kind", "schedule"), ("name", "close-day"), ("reason", texts.REASON_MANY_OWNERS),
        ("source", "app/proj/celery_app.py:3"), ("schedule", "300"), ("task", "proj.close"),
    ]
    # Имя выражением: расписание и задача известны и записаны.
    assert [h for h in hints["dynamic_names"] if h["kind"] == "schedule"] == [{
        "kind": "schedule", "name": "NAME", "reason": texts.REASON_DYNAMIC_SCHEDULE,
        "source": "app/proj/celery_app.py:4", "schedule": "crontab(hour=6)", "task": "proj.open",
    }]


ROUTE_METHOD_CASES: dict[str, tuple[str, dict[str, str | bytes], list[tuple[str, str | None]]]] = {
    # Метод назван регистрацией — пишется; app.all, HandleFunc, match, MapMethods, @All и
    # #[route] метода не называют (ANY), поле не пишется.
    "express": ("express", {
        "package.json": '{"dependencies": {"express": "4"}}\n',
        "app.js": "const express = require('express');\nconst app = express();\n"
        "app.get(PATH, h);\napp.all(OTHER, h);\n",
    }, [("PATH", "GET"), ("OTHER", None)]),
    "nest": ("nest", {
        "package.json": '{"dependencies": {"@nestjs/core": "10"}}\n',
        "src/a.controller.ts": "@Controller('a')\nexport class A {\n  @Post(ROUTE)\n  create() {}\n"
        "  @All(OTHER)\n  any() {}\n}\n",
    }, [("ROUTE", "POST"), ("OTHER", None)]),
    "gohttp": ("gohttp", {
        "go.mod": "module x\n\nrequire github.com/go-chi/chi/v5 v5.0.0\n",
        "main.go": "package main\nfunc main() {\n\tr := chi.NewRouter()\n\tr.Put(pathVar, h)\n"
        "\tr.HandleFunc(other, h)\n}\n",
    }, [("pathVar", "PUT"), ("other", None)]),
    "rails_routes": ("rails_routes", {
        "Gemfile": 'gem "rails"\n',
        "config/routes.rb": "Rails.application.routes.draw do\n  delete path_var, to: 'a#b'\n"
        "  match other, to: 'a#c', via: :get\nend\n",
    }, [("path_var", "DELETE"), ("other", None)]),
    "aspnet": ("aspnet", {
        "App/App.csproj": '<Project Sdk="Microsoft.NET.Sdk.Web"></Project>\n',
        "App/Program.cs": "app.MapPatch(Route, () => 1);\n"
        'app.MapMethods(Other, new[] { "GET" }, () => 1);\n',
    }, [("Route", "PATCH"), ("Other", None)]),
    "actix": ("actix", {
        "Cargo.toml": '[package]\nname = "x"\n\n[dependencies]\nactix-web = "4"\n',
        "src/main.rs": '#[get(PATH)]\nasync fn a() {}\n#[route(OTHER, method = "GET")]\nasync fn b() {}\n',
    }, [("PATH", "GET"), ("OTHER", None)]),
}


@pytest.mark.parametrize("case", sorted(ROUTE_METHOD_CASES))
def test_route_hint_method(tmp_path: Path, case: str) -> None:
    """Метод в подсказке о маршруте с путём выражением у каждого разборщика маршрутов кода
    (ТЗ §15 п. 16 П3)."""
    import importlib

    from tests.helpers import files_of

    module, files_, want = ROUTE_METHOD_CASES[case]
    parser = importlib.import_module(f"archmap_scan.parsers.{module}")
    ctx, files = files_of(tree(tmp_path, files_))
    found = parser.parse(files, ctx)
    assert found.routes == []
    assert [(h.data["name"], h.data.get("method")) for h in found.hints] == want


def test_summary_dynamic_only_family(tmp_path: Path) -> None:
    """Семья, в которой нашлись только записи с выражением (immich: расписания из
    конфигурации), в «Искали и не нашли» не входит: о ней говорит строка «заданным
    выражением в коде»; статус в coverage.yaml остаётся empty (ТЗ §15 п. 16 П3)."""
    out = _scan(tree(tmp_path / "repo", {
        "package.json": '{"dependencies": {"cron": "3"}}\n',
        "Dockerfile": 'FROM node:22\nCOPY . /app\nCMD ["node", "index.js"]\n',
        "src/jobs.ts": (
            "import { CronJob } from 'cron';\n"
            "const job = new CronJob(this.config.backup.cron, this.backup);\n"
        ),
    }), tmp_path / "out")
    summary = _read(out, "summary.txt")
    empty = [line for line in summary.splitlines() if line.startswith("Искали и не нашли")]
    assert not any("расписания" in line for line in empty), empty
    assert texts.dynamic_line("schedules", 1) in summary
    coverage = yaml.safe_load(_read(out, "coverage.yaml"))
    assert coverage["families"]["schedules"]["status"] == "empty"
    hints = yaml.safe_load(_read(out, "agent/hints.yaml"))
    assert hints["dynamic_names"] == [{
        "kind": "schedule", "name": "this.config.backup.cron",
        "reason": texts.REASON_SCHEDULE_CONFIG, "source": "src/jobs.ts:2",
        "schedule": "this.config.backup.cron", "task": "backup",
    }]


def test_shared_params_line_only_for_shared_code(tmp_path: Path) -> None:
    """Строка «Параметры общего кода» считает только записи из кода и примеров окружения в
    каталоге, общем у нескольких контейнеров (ТЗ §15 п. 10 А10). Имена из якоря YAML у
    трёх сервисов общим кодом не считаются; без записей из общего каталога строки нет."""
    out = tmp_path / "out"
    run(Options(path=str(FIXTURES / "compose-anchors"), out=str(out), system="Ярмарка",
                use_git=False))
    summary = (out / "summary.txt").read_text(encoding="utf-8")
    assert "Параметры общего кода записаны каждому из 2 контейнеров: записей 2." in summary

    repo = tmp_path / "repo"
    shutil.copytree(FIXTURES / "compose-anchors", repo)
    compose = repo / "docker-compose.yml"
    text = compose.read_text(encoding="utf-8")
    compose.write_text(text.replace("    build: api\n    command", "    build: billing\n    command"),
                       encoding="utf-8")
    out2 = tmp_path / "out2"
    run(Options(path=str(repo), out=str(out2), system="Ярмарка", use_git=False))
    assert "Параметры общего кода" not in (out2 / "summary.txt").read_text(encoding="utf-8")


def test_stage_two_objects_from_dev_manifests(tmp_path: Path) -> None:
    """Ступень 2 политики (ТЗ §15 п. 10 Б3): боевых манифестов нет, сервисы devservices
    становятся объектами, каждый с записью в hints.dev_manifest_objects, а coverage и
    сводка говорят об этом прямо. bigtable только в режиме backend-ci и отладочный
    spotlight уходят в подсказки. Ловушка: memcached не в режиме default, но со своим
    режимом memcached, остаётся объектом."""
    out = _scan(FIXTURES / "devservices", tmp_path / "out")
    hints = yaml.safe_load(_read(out, "agent/hints.yaml"))
    assert [(h["kind"], h["name"], h["source"]) for h in hints["dev_manifest_objects"]] == [
        ("container", "relay", "devservices/config.yml:18"),
        ("database", "memcached", "devservices/config.yml:20"),
    ]
    assert {h["name"]: (h["reason"], h["profiles"]) for h in hints["profiles"]} == {
        "bigtable": (texts.dev_manifest(texts.dev_sign_modes(["backend-ci"])), ["backend-ci"]),
        "spotlight": (
            texts.dev_manifest(texts.dev_sign_debug("devservices/config.yml:11")), ["default"],
        ),
    }
    families = yaml.safe_load(_read(out, "coverage.yaml"))["families"]
    assert families["containers"]["from_dev_manifests"] == 1
    assert families["databases"]["from_dev_manifests"] == 1
    assert texts.dev_objects_line(2) in _read(out, "summary.txt")
