"""Сентинелы измерителя сверки C4.

Две опоры:
1. Эталон против себя — 100/100 и нули во всех классах ошибок (на настоящих
   экспортах, включая Zabbix с тёзками и путями в ссылках рёбер).
2. Синтетические возмущения маленькой схемы — каждый класс расхождения ловится
   ИМЕННО своим классом (переименование по синонимам, удаление узла, дубль,
   разворот ребра, смена канала, перенос в другой контейнер, потеря якоря).

Запуск: cd backend && ./venv/bin/python -m pytest ../scripts/c4-compare -q
"""

from __future__ import annotations

import copy
import sys
from pathlib import Path
from typing import Any

import pytest
import yaml

sys.path.insert(0, str(Path(__file__).resolve().parent))

from compare import (  # noqa: E402 — путь к модулю добавляется выше
    CompareError,
    build_report,
    load_model,
    match_edges,
    match_nodes,
    parse_model,
)

ETALONS = Path("/home/eidunyushkin/archmap-etalons-2026-08-19/exports-2026-09-04")

BASE_YAML = """
nodes:
- name: Магазин
  shape: service
  role: система
  children:
  - name: Сервер платежей
    shape: service
    role: сервер
    technology: Go
  - name: Очередь событий
    shape: broker
    role: брокер
    technology: Kafka
  - name: БД заказов
    shape: database
    role: база данных
    technology: PostgreSQL
  - name: Веб-интерфейс
    shape: service
    role: SPA
    technology: React
    source:
      repo: github.com/acme/shop
      path: web
- name: Клиент
  shape: person
  role: пользователь
  external: true
edges:
- from: Веб-интерфейс
  to: Сервер платежей
  label: Оформление платежа
  technology: HTTPS
- from: Сервер платежей
  to: БД заказов
  label: Пишет заказы
  technology: SQL
- from: Сервер платежей
  to: Очередь событий
  label: Публикует события платежей
  technology: Kafka
  channel: payments.events
  sync: false
- from: Клиент
  to: Веб-интерфейс
  label: Работает в браузере
  technology: HTTPS
"""


def base_doc() -> dict[str, Any]:
    """Свежая копия базового документа (тесты его мутируют)."""
    doc: dict[str, Any] = yaml.safe_load(BASE_YAML)
    return copy.deepcopy(doc)


def shop_children(doc: dict[str, Any]) -> list[dict[str, Any]]:
    """Дети контейнера «Магазин»."""
    children: list[dict[str, Any]] = doc["nodes"][0]["children"]
    return children


def find_node(doc: dict[str, Any], name: str) -> dict[str, Any]:
    """Узел по имени в любом месте дерева."""

    def walk(items: list[dict[str, Any]]) -> dict[str, Any] | None:
        for item in items:
            if item["name"] == name:
                return item
            found = walk(item.get("children") or [])
            if found is not None:
                return found
        return None

    node = walk(doc["nodes"])
    assert node is not None, name
    return node


def rename(doc: dict[str, Any], old: str, new: str) -> None:
    """Переименовывает узел И его ссылки в рёбрах (иначе документ не разберётся)."""
    find_node(doc, old)["name"] = new
    for edge in doc["edges"]:
        for key in ("from", "to"):
            parts = edge[key].split(" / ")
            edge[key] = " / ".join(new if part == old else part for part in parts)


def report_for(candidate_doc: dict[str, Any], etalon_doc: dict[str, Any] | None = None) -> dict[str, Any]:
    """Сверка базовой схемы (эталон) с изменённой копией (кандидат)."""
    etalon = parse_model(etalon_doc or base_doc(), "эталон")
    candidate = parse_model(candidate_doc, "кандидат")
    nodes = match_nodes(etalon, candidate)
    edges = match_edges(etalon, candidate, nodes)
    return build_report(etalon, candidate, nodes, edges, "тест")


# --------------------------------------------------------------------------
# 1. Эталон против себя
# --------------------------------------------------------------------------


@pytest.mark.parametrize("name", ["etalon-grafana.yaml", "etalon-zabbix.yaml"])
def test_etalon_against_itself(name: str) -> None:
    """Настоящий экспорт против себя: 100/100 и нули во всех классах ошибок."""
    path = ETALONS / name
    if not path.exists():  # pragma: no cover — каталог материалов вне репозитория
        pytest.skip(f"нет каталога материалов: {path}")
    model = load_model(path)
    other = load_model(path)
    nodes = match_nodes(model, other)
    edges = match_edges(model, other, nodes)
    report = build_report(model, other, nodes, edges, name)
    node_metrics = report["метрики"]["узлы"]
    edge_metrics = report["метрики"]["рёбра"]
    assert node_metrics["полнота_%"] == 100.0
    assert node_metrics["точность_%"] == 100.0
    assert node_metrics["пропуски"] == 0
    assert node_metrics["выдумки"] == 0
    assert node_metrics["дубли"] == 0
    assert node_metrics["флаги"] == {}
    assert edge_metrics["полнота_структурная_%"] == 100.0
    assert edge_metrics["полнота_общая_%"] == 100.0
    assert edge_metrics["точность_%"] == 100.0
    for key in (
        "направление",
        "канал",
        "синхронность",
        "пропуски",
        "пропуски_по_узлу",
        "выдумки",
        "выдумки_по_узлу",
        "дубли",
    ):
        assert edge_metrics[key] == 0, key


def test_base_against_itself() -> None:
    """Синтетическая схема против себя — тоже чистый ноль (контроль возмущений)."""
    report = report_for(base_doc())
    assert report["метрики"]["узлы"]["полнота_%"] == 100.0
    assert report["метрики"]["рёбра"]["совпало"] == 4
    assert report["метрики"]["рёбра"]["точность_%"] == 100.0


# --------------------------------------------------------------------------
# 2. Возмущения
# --------------------------------------------------------------------------


def test_synonym_rename_matches_at_stage3() -> None:
    """«Сервер платежей» → «Payments server»: матч ступенью синонимов, рёбра целы."""
    doc = base_doc()
    rename(doc, "Сервер платежей", "Payments server")
    report = report_for(doc)
    nodes = report["метрики"]["узлы"]
    assert nodes["полнота_%"] == 100.0
    assert nodes["пропуски"] == 0
    assert nodes["выдумки"] == 0
    assert nodes["по_ступеням"].get("синоним") == 1
    assert report["метрики"]["рёбра"]["совпало"] == 4


def test_deleted_node_gives_missing_and_edge_by_node() -> None:
    """Удалённый узел — ПРОПУСК, его рёбра — ПРОПУСК-ПО-УЗЛУ (вина узла, не ребра)."""
    doc = base_doc()
    doc["nodes"][0]["children"] = [c for c in shop_children(doc) if c["name"] != "БД заказов"]
    doc["edges"] = [e for e in doc["edges"] if e["to"] != "БД заказов"]
    report = report_for(doc)
    nodes = report["метрики"]["узлы"]
    edges = report["метрики"]["рёбра"]
    assert nodes["пропуски"] == 1
    assert nodes["выдумки"] == 0
    assert report["списки"]["узлы_пропуски"][0]["путь"] == "Магазин / БД заказов"
    assert edges["пропуски_по_узлу"] == 1
    assert edges["пропуски"] == 0
    assert edges["совпало"] == 3


def test_missing_container_counted_separately() -> None:
    """Пропущенный контейнер считается отдельно от прочих пропусков."""
    doc = base_doc()
    # Убираем контейнер «Магазин», подняв его детей в корень.
    doc["nodes"] = shop_children(doc) + [n for n in doc["nodes"] if n["name"] == "Клиент"]
    report = report_for(doc)
    nodes = report["метрики"]["узлы"]
    assert nodes["пропуски"] == 1
    assert nodes["пропуски_контейнеры"] == 1
    assert nodes["флаги"].get("уровень") == 4


def test_twin_node_is_duplicate() -> None:
    """Близнец сматченного узла — ДУБЛЬ с указанием, на кого претендует."""
    doc = base_doc()
    shop_children(doc).append(
        {"name": "Payments server", "shape": "service", "role": "сервер", "technology": "Go"}
    )
    report = report_for(doc)
    nodes = report["метрики"]["узлы"]
    assert nodes["дубли"] == 1
    assert nodes["выдумки"] == 0
    assert nodes["полнота_%"] == 100.0
    dup = report["списки"]["узлы_дубли"][0]
    assert dup["путь"] == "Магазин / Payments server"
    assert dup["претендует_на"] == "Магазин / Сервер платежей"


def test_unrelated_node_is_invention() -> None:
    """Незнакомый узел — ВЫДУМКА, а не дубль."""
    doc = base_doc()
    shop_children(doc).append({"name": "Antivirus daemon", "shape": "service", "role": "демон"})
    report = report_for(doc)
    assert report["метрики"]["узлы"]["выдумки"] == 1
    assert report["метрики"]["узлы"]["дубли"] == 0


def test_reversed_edge_is_direction_class() -> None:
    """Развёрнутое ребро — класс НАПРАВЛЕНИЕ, а не пропуск+выдумка."""
    doc = base_doc()
    for edge in doc["edges"]:
        if edge["from"] == "Сервер платежей" and edge["to"] == "БД заказов":
            edge["from"], edge["to"] = edge["to"], edge["from"]
    report = report_for(doc)
    edges = report["метрики"]["рёбра"]
    assert edges["направление"] == 1
    assert edges["пропуски"] == 0
    assert edges["выдумки"] == 0
    assert edges["совпало"] == 3


def test_changed_channel_is_channel_class() -> None:
    """Другой канал брокера — класс КАНАЛ (ребро найдено, семантика разошлась)."""
    doc = base_doc()
    for edge in doc["edges"]:
        if edge.get("channel"):
            edge["channel"] = "orders.events"
    report = report_for(doc)
    edges = report["метрики"]["рёбра"]
    assert edges["канал"] == 1
    assert edges["пропуски"] == 0
    assert edges["выдумки"] == 0
    assert edges["найдено_в_направлении"] == 4


def test_dropped_channel_is_channel_class() -> None:
    """Ребро без канала у кандидата при канале у эталона — тоже КАНАЛ."""
    doc = base_doc()
    for edge in doc["edges"]:
        edge.pop("channel", None)
    report = report_for(doc)
    assert report["метрики"]["рёбра"]["канал"] == 1


def test_changed_sync_is_sync_class() -> None:
    """Асинхронный канал, ставший синхронным, — класс СИНХРОННОСТЬ."""
    doc = base_doc()
    for edge in doc["edges"]:
        if edge.get("sync") is False:
            edge["sync"] = True
    report = report_for(doc)
    edges = report["метрики"]["рёбра"]
    assert edges["синхронность"] == 1
    assert edges["канал"] == 0
    assert edges["совпало"] == 3


def test_duplicate_edge_is_edge_duplicate() -> None:
    """Второе ребро на той же паре с тем же каналом — ДУБЛЬ, не выдумка."""
    doc = base_doc()
    doc["edges"].append(
        {
            "from": "Сервер платежей",
            "to": "БД заказов",
            "label": "Читает заказы",
            "technology": "SQL",
        }
    )
    report = report_for(doc)
    edges = report["метрики"]["рёбра"]
    assert edges["дубли"] == 1
    assert edges["выдумки"] == 0
    assert edges["совпало"] == 4


def test_moved_node_is_level_flag_not_miss() -> None:
    """Перенос узла в другой контейнер — сматчен, флаг «уровень», рёбра целы."""
    doc = base_doc()
    moved = find_node(doc, "БД заказов")
    doc["nodes"][0]["children"] = [c for c in shop_children(doc) if c["name"] != "БД заказов"]
    doc["nodes"].append(moved)
    report = report_for(doc)
    nodes = report["метрики"]["узлы"]
    assert nodes["полнота_%"] == 100.0
    assert nodes["пропуски"] == 0
    assert nodes["флаги"].get("уровень") == 1
    assert report["метрики"]["рёбра"]["совпало"] == 4
    flagged = [item for item in report["списки"]["узлы_флаги"] if "уровень" in item["флаги"]]
    assert flagged[0]["эталон"] == "Магазин / БД заказов"


def test_lost_anchor_is_flag() -> None:
    """Кандидат потерял source у сматченного узла — флаг «нет якоря»."""
    doc = base_doc()
    find_node(doc, "Веб-интерфейс").pop("source")
    report = report_for(doc)
    nodes = report["метрики"]["узлы"]
    assert nodes["полнота_%"] == 100.0
    assert nodes["флаги"].get("нет якоря") == 1
    assert nodes["якоря_потеряно"] == 1
    assert nodes["якоря_кандидат"] == 0


def test_anchor_beats_renaming() -> None:
    """Якорь сильнее имени: переименованный узел с тем же source сматчен ступенью 1."""
    doc = base_doc()
    rename(doc, "Веб-интерфейс", "Storefront SPA")
    report = report_for(doc)
    assert report["метрики"]["узлы"]["по_ступеням"].get("якорь") == 1
    assert report["метрики"]["узлы"]["пропуски"] == 0


def test_shape_and_technology_stage() -> None:
    """БД с другим именем, но той же технологией — ступень «форма+технология»."""
    doc = base_doc()
    rename(doc, "БД заказов", "Основное хранилище")
    report = report_for(doc)
    stages = report["метрики"]["узлы"]["по_ступеням"]
    assert stages.get("форма+технология") == 1
    assert report["метрики"]["узлы"]["пропуски"] == 0


def test_labels_to_check_not_in_metrics() -> None:
    """Непохожая подпись сматченного ребра идёт в список «проверить», не в ошибки."""
    doc = base_doc()
    for edge in doc["edges"]:
        if edge["label"] == "Пишет заказы":
            edge["label"] = "Хранит корзины и сессии"
    report = report_for(doc)
    edges = report["метрики"]["рёбра"]
    assert edges["совпало"] == 4
    assert edges["подписей_проверить"] == 1
    assert report["списки"]["подписи_проверить"]


# --------------------------------------------------------------------------
# 3. Разбор ссылок рёбер
# --------------------------------------------------------------------------

HOMONYM_DOC = """
nodes:
- name: Система
  shape: service
  children:
  - name: Сервер
    shape: service
    children:
    - name: poller
      shape: service
  - name: Прокси
    shape: service
    children:
    - name: poller
      shape: service
  - name: БД
    shape: database
edges:
- from: Система / Сервер / poller
  to: БД
  label: Пишет значения
"""


def test_parse_resolves_path_and_unique_name() -> None:
    """Ссылка путём резолвится в нужного тёзку, ссылка именем — в уникальный узел."""
    model = parse_model(yaml.safe_load(HOMONYM_DOC), "тест")
    assert len(model.edges) == 1
    edge = model.edges[0]
    assert model.nodes[edge.source].path == "Система / Сервер / poller"
    assert model.nodes[edge.target].name == "БД"


def test_parse_reports_ambiguous_reference() -> None:
    """Неоднозначное имя в ссылке ребра — ошибка разбора с внятным текстом."""
    doc = yaml.safe_load(HOMONYM_DOC)
    doc["edges"][0]["from"] = "poller"
    with pytest.raises(CompareError) as exc:
        parse_model(doc, "тест")
    message = str(exc.value)
    assert "неоднозначна" in message
    assert "Система / Сервер / poller" in message


def test_parse_reports_unknown_reference() -> None:
    """Ссылка в никуда — тоже ошибка разбора, а не молча потерянное ребро."""
    doc = yaml.safe_load(HOMONYM_DOC)
    doc["edges"][0]["to"] = "Отсутствующий узел"
    with pytest.raises(CompareError) as exc:
        parse_model(doc, "тест")
    assert "не найден" in str(exc.value)
