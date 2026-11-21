"""Шапка сборщика фактов у входов (app/scan_origin.py, фаза 3 docs/tasks/fact-collector.md):
разбор шапки, отказ схеме сборщика в едином ввозе и в обновлении из кода (золотое правило
владельца 2026-11-21: вывод сборщика документацией не становится), пометка в отчётах фактов.
Фикстура — настоящий вывод сборщика на «Ярмарке» (scan/fixtures/yarmarka.expected): шапка,
которую пишет сборщик, и шапка, которую читает ArchMap, обязаны совпасть, иначе отказ молча
пропадёт.
"""

import time
from pathlib import Path

import pytest
from conftest import ensure_architect, make_project
from fastapi import HTTPException

from app.data_import import build_data_plan
from app.routers.projects import sync_apply, sync_preview
from app.scan_origin import (
    SCHEMA_REJECTED,
    ScanOrigin,
    facts_note,
    is_scanner_schema,
    scan_origin,
)
from app.schemas.project import SyncApplyIn, SyncPreviewIn
from app.unified_import import build_unified_plan
from app.unified_preview import preview_from_plan

EXPECTED = Path(__file__).resolve().parents[2] / "scan" / "fixtures" / "yarmarka.expected"
SCHEMA = (EXPECTED / "schema.yaml").read_text(encoding="utf-8")
TABLES = (EXPECTED / "facts" / "orders-db.tables.yaml").read_text(encoding="utf-8")
# Версия сборщика берётся из шапки фикстуры: тест проверяет совпадение шапок, а не номер.
VERSION = SCHEMA.splitlines()[0].split()[-1]



def _head(repo: str, commit: str, version: str = VERSION) -> str:
    return f"# archmap-scan {version}\n# repo: {repo}\n# commit: {commit}\nnodes: []\n"


def test_шапка_с_репозиторием_и_коммитом():
    text = _head("https://github.com/getsentry/sentry.git", "49ce20c3" + "a" * 32)
    origin = scan_origin(text)
    assert origin == ScanOrigin(VERSION, "github.com/getsentry/sentry", "49ce20c3")
    assert origin.by() == (
        f"сборщиком фактов ArchMap {VERSION} по коммиту 49ce20c3 репозитория "
        "github.com/getsentry/sentry"
    )


def test_шапка_без_git_и_частичные_значения():
    assert scan_origin(_head("", "")).by() == f"сборщиком фактов ArchMap {VERSION}"
    assert scan_origin(_head("git@github.com:org/yarmarka.git", "")).by() == (
        f"сборщиком фактов ArchMap {VERSION} по репозиторию github.com/org/yarmarka"
    )
    assert scan_origin(_head("", "ABCDEF1234")).by() == (
        f"сборщиком фактов ArchMap {VERSION} по коммиту abcdef12"
    )
    # Не хэш в строке commit — коммита не называем, а не печатаем мусор.
    assert scan_origin(_head("", "рм -rf")) == ScanOrigin(VERSION, "", "")


def test_не_шапка_сборщика():
    assert scan_origin("nodes: []\n") is None
    assert scan_origin("# archmap-scan\nnodes: []\n") is None  # без версии
    assert scan_origin(f"# archmap-scan {VERSION} лишнее\n") is None
    assert scan_origin("# archmap-scan ../../x\n") is None
    # Шапка ищется только в начале: пять строк и не больше 1 КБ.
    assert scan_origin("\n" * 5 + _head("", "")) is None
    assert scan_origin("#" + " " * 1100 + "\n" + _head("", "")) is None
    assert scan_origin("﻿" + _head("", "")) == ScanOrigin(VERSION, "", "")


def test_шапка_файла_фактов_после_адреса():
    assert facts_note("orders-db.tables.yaml", TABLES) == (
        f"Файл orders-db.tables.yaml собран сборщиком фактов ArchMap {VERSION}: у записей есть "
        "основание в манифестах и коде, описаний нет, их добавит агент или человек"
    )


def test_враждебный_вход_не_тормозит():
    text = "# archmap-scan " + "9" * 2_000_000 + "\n" + "# repo: " + "/" * 2_000_000
    started = time.perf_counter()
    assert scan_origin(text) is None
    assert time.perf_counter() - started < 0.1


AGENT = b"nodes:\n- name: X\n  element: system\n  children:\n  - name: a\n"


def test_единый_ввоз_отклоняет_схему_сборщика():
    out = preview_from_plan(build_unified_plan([
        ("schema.yaml", SCHEMA.encode("utf-8")), ("agent.yaml", AGENT),
    ]))
    assert not out.ok
    assert any(SCHEMA_REJECTED in e for e in out.errors), out.errors
    # файл агента без шапки сам по себе проходит
    assert preview_from_plan(build_unified_plan([("agent.yaml", AGENT)])).ok
    # отказ и тогда, когда сам документ не разобрался бы
    broken = SCHEMA.replace("nodes:", "nodes: [oops", 1)
    bad = preview_from_plan(build_unified_plan([("schema.yaml", broken.encode("utf-8"))]))
    assert not bad.ok and any(SCHEMA_REJECTED in e for e in bad.errors), bad.errors


def test_схема_сборщика_с_описаниями_агента_проходит():
    """Агент дописал смысл прямо в schema.yaml: шапка осталась, но это уже его документ."""
    assert is_scanner_schema(SCHEMA)
    edited = SCHEMA.replace("\n- name:", "\n- description: Принимает заказы\n  name:", 1)
    assert edited != SCHEMA and not is_scanner_schema(edited)
    block = _head("", "") + "nodes:\n- name: A\n  description: >-\n    Принимает заказы\n"
    assert not is_scanner_schema(block)
    # пустое описание описанием не считается
    assert is_scanner_schema(_head("", "") + "nodes:\n- name: A\n  description:\n")
    agent = preview_from_plan(build_unified_plan([("schema.yaml", edited.encode("utf-8"))]))
    assert agent.ok, agent.errors


def test_поиск_описаний_не_тормозит_на_враждебном_входе():
    text = _head("", "") + "\n" * 2_000_000 + " " * 2_000_000 + "description:"
    started = time.perf_counter()
    assert is_scanner_schema(text)
    assert time.perf_counter() - started < 0.5


def test_обновление_из_кода_отклоняет_схему_сборщика(db):
    user = ensure_architect(db)
    p = make_project(db, "Ярмарка")

    out = sync_preview(
        p.id, SyncPreviewIn(contents=["nodes:\n- name: Z\n", SCHEMA]), db=db, user=user
    )
    assert not out.ok
    assert out.errors == [f"файл 2: {SCHEMA_REJECTED}"]

    single = sync_preview(p.id, SyncPreviewIn(contents=[SCHEMA]), db=db, user=user)
    assert single.errors == [SCHEMA_REJECTED]

    with pytest.raises(HTTPException) as e:
        sync_apply(p.id, SyncApplyIn(contents=[SCHEMA]), db=db, user=user)
    assert e.value.status_code == 400 and e.value.detail == SCHEMA_REJECTED


def test_отчёт_фактов_называет_файлы_сборщика(db):
    plan = build_data_plan(
        db, [], [("orders-db.tables.yaml", TABLES), ("agent.yaml", "tables: []\n")], None, False
    )
    assert plan.report.scanner == [
        f"Файл orders-db.tables.yaml собран сборщиком фактов ArchMap {VERSION}: у записей есть "
        "основание в манифестах и коде, описаний нет, их добавит агент или человек"
    ]
