"""Файлы вывода: schema.yaml, основания, подсказки, покрытие; детерминизм."""

from __future__ import annotations

from pathlib import Path

import yaml

from archmap_scan import __version__
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
        "profiles", "shared_code", "clients", "unparsed", "external_repos", "merged",
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
    assert "Искали и не нашли" in summary and "таблицы" not in summary.split("Не покрыто")[0]
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
