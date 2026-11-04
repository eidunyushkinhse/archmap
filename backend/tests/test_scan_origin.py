"""Пометка «собрано сборщиком фактов» у входов (app/scan_origin.py, фаза 3
docs/tasks/fact-collector.md): разбор шапки, превью единого ввоза, план обновления из кода и
отчёты фактов. Фикстура — настоящий вывод сборщика на «Ярмарке» (scan/fixtures/
yarmarka.expected): шапка, которую пишет сборщик, и шапка, которую читает ArchMap, обязаны
совпасть, иначе пометка молча пропадёт.
"""

import time
from pathlib import Path

from conftest import ensure_architect, make_project

from app.data_import import build_data_plan
from app.routers.projects import sync_preview
from app.scan_origin import ScanOrigin, facts_note, scan_origin, schema_note
from app.schemas.project import SyncPreviewIn
from app.unified_import import build_unified_plan
from app.unified_preview import preview_from_plan

EXPECTED = Path(__file__).resolve().parents[2] / "scan" / "fixtures" / "yarmarka.expected"
SCHEMA = (EXPECTED / "schema.yaml").read_text(encoding="utf-8")
TABLES = (EXPECTED / "facts" / "orders-db.tables.yaml").read_text(encoding="utf-8")

TAIL = (
    "у объектов и связей есть основание в манифестах и коде, описаний и связей по смыслу нет, "
    "их добавит агент или человек"
)
# Фикстура собрана с --no-git: repo и commit пусты, строка короткая.
NOTE = f"Собрано сборщиком фактов ArchMap 0.1.0: {TAIL}"


def _head(repo: str, commit: str, version: str = "0.1.0") -> str:
    return f"# archmap-scan {version}\n# repo: {repo}\n# commit: {commit}\nnodes: []\n"


def test_шапка_с_репозиторием_и_коммитом():
    text = _head("https://github.com/getsentry/sentry.git", "49ce20c3" + "a" * 32)
    assert scan_origin(text) == ScanOrigin("0.1.0", "github.com/getsentry/sentry", "49ce20c3")
    assert schema_note(text) == (
        "Собрано сборщиком фактов ArchMap 0.1.0 по коммиту 49ce20c3 репозитория "
        f"github.com/getsentry/sentry: {TAIL}"
    )


def test_шапка_без_git_и_частичные_значения():
    assert schema_note(_head("", "")) == NOTE
    assert schema_note(_head("git@github.com:org/yarmarka.git", "")) == (
        f"Собрано сборщиком фактов ArchMap 0.1.0 по репозиторию github.com/org/yarmarka: {TAIL}"
    )
    assert schema_note(_head("", "ABCDEF1234")) == (
        f"Собрано сборщиком фактов ArchMap 0.1.0 по коммиту abcdef12: {TAIL}"
    )
    # Не хэш в строке commit — коммита не называем, а не печатаем мусор.
    assert scan_origin(_head("", "рм -rf")) == ScanOrigin("0.1.0", "", "")


def test_не_шапка_сборщика():
    assert scan_origin("nodes: []\n") is None
    assert scan_origin("# archmap-scan\nnodes: []\n") is None  # без версии
    assert scan_origin("# archmap-scan 0.1.0 лишнее\n") is None
    assert scan_origin("# archmap-scan ../../x\n") is None
    # Шапка ищется только в начале: пять строк и не больше 1 КБ.
    assert scan_origin("\n" * 5 + _head("", "")) is None
    assert scan_origin("#" + " " * 1100 + "\n" + _head("", "")) is None
    assert scan_origin("﻿" + _head("", "")) == ScanOrigin("0.1.0", "", "")


def test_шапка_файла_фактов_после_адреса():
    assert facts_note("orders-db.tables.yaml", TABLES) == (
        "Файл orders-db.tables.yaml собран сборщиком фактов ArchMap 0.1.0: у записей есть "
        "основание в манифестах и коде, описаний нет, их добавит агент или человек"
    )


def test_враждебный_вход_не_тормозит():
    text = "# archmap-scan " + "9" * 2_000_000 + "\n" + "# repo: " + "/" * 2_000_000
    started = time.perf_counter()
    assert scan_origin(text) is None
    assert time.perf_counter() - started < 0.1


def test_превью_единого_ввоза_фикстуры_несёт_пометку():
    plan = build_unified_plan([
        ("schema.yaml", SCHEMA.encode("utf-8")),
        ("agent.yaml", b"nodes:\n- name: X\n  element: system\n  children:\n  - name: a\n"),
    ])
    out = preview_from_plan(plan)
    assert out.ok, out.errors
    assert out.c4 is not None
    assert [f.scanner for f in out.c4.file_remarks] == [NOTE, None]
    assert out.c4.file_remarks[0].errors == []


def test_пометка_и_при_отказе_разбора():
    broken = SCHEMA.replace("nodes:", "nodes: [oops", 1)
    out = preview_from_plan(build_unified_plan([("schema.yaml", broken.encode("utf-8"))]))
    assert not out.ok
    assert out.c4 is not None and out.c4.file_remarks[0].scanner == NOTE


def test_обновление_из_кода_пустого_проекта_файлом_сборщика(db):
    user = ensure_architect(db)
    p = make_project(db, "Ярмарка")

    out = sync_preview(
        p.id, SyncPreviewIn(contents=[SCHEMA, "nodes:\n- name: Z\n"]), db=db, user=user
    )

    assert out.ok, out.errors
    assert out.scanner == [NOTE, None]
    assert out.summary.get("nodes_create", 0) >= 7
    bad = sync_preview(p.id, SyncPreviewIn(contents=["# archmap-scan 0.1.0\nnodes: [oops"]), db=db, user=user)
    assert not bad.ok and bad.scanner == [f"Собрано сборщиком фактов ArchMap 0.1.0: {TAIL}"]


def test_отчёт_фактов_называет_файлы_сборщика(db):
    plan = build_data_plan(
        db, [], [("orders-db.tables.yaml", TABLES), ("agent.yaml", "tables: []\n")], None, False
    )
    assert plan.report.scanner == [
        "Файл orders-db.tables.yaml собран сборщиком фактов ArchMap 0.1.0: у записей есть "
        "основание в манифестах и коде, описаний нет, их добавит агент или человек"
    ]
