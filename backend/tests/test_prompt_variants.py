"""Параметр variant у четырёх BYOA-ручек промптов (Ф0 docs/plan-skeptic-audit.md).

Одна и та же кнопка отдаёт три текста: строительный промпт (дефолт), оркестраторную
обёртку с аудитом и один промпт аудита. Здесь проверяется контракт переключателя, а не
содержание промптов (оно — в test_skeptic_prompt.py и тестах самих генераторов):

- ⚠ дефолт БАЙТ-В-БАЙТ равен прямому вызову генератора: на нём сидят MCP-тулзы
  (archmap_import_prompt, archmap_docs_prompt) и нынешний фронт, и тихая подмена текста
  сломала бы их без единой ошибки;
- в обёртке блок А — строительный промпт ЭТОЙ ручки со всеми её подстановками (срез
  схемы, каталоги имён, перечни узлов), а не «промпт вообще»: обёртка вшивает живой
  вызов генератора, а не копию;
- невалидный variant отвергается схемой, а не молча деградирует в дефолт.
"""

import uuid

import pytest
from conftest import ensure_architect, ensure_project
from fastapi.testclient import TestClient

from app.auth import require_architect
from app.channels_import import edge_channel_minimum
from app.channels_prompt import build_channels_prompt
from app.data_prompt import build_data_prompt
from app.database import get_db
from app.deps import get_current_project
from app.docs_import import _node_paths
from app.docs_prompt import build_docs_prompt
from app.export import build_export
from app.import_prompt import build_import_prompt
from app.main import app
from app.models.broker_channel import BrokerChannel
from app.models.db_table import DbTable
from app.models.edge import Edge
from app.models.node import Node
from app.routers.channels_import import channels_prompt
from app.routers.data_import import data_prompt
from app.routers.docs_import import _name_catalogs, docs_prompt
from app.routers.projects import import_prompt
from app.skeptic_prompt import (
    BLOCK_A_END,
    BLOCK_A_START,
    BLOCK_B_END,
    BLOCK_B_START,
)

# Порог V1 — маркер того, что перед нами именно промпт аудита (литерал, а не импорт
# константы: см. шапку test_skeptic_prompt.py).
ПОРОГ_V1 = (
    "Сомнение записывается ТОЛЬКО при конкретном доказательстве: процитированная "
    "строка кода, доказывающая обратное"
)

ВАРИАНТЫ = ("builder", "orchestrated", "skeptic")


def _блок_А(текст: str) -> str:
    return текст.split(BLOCK_A_START)[1].split(BLOCK_A_END)[0]


def _схема(db):
    """Проект с сервисом, базой, брокером и связью в брокер + описанные таблица и
    канал: так у КАЖДОЙ из четырёх ручек в промпте есть свои подстановки."""
    p = ensure_project(db)
    система = Node(id=uuid.uuid4(), name="Ярмарка", shape="service", project_id=p.id)
    db.add(система)
    db.flush()
    бд = Node(
        id=uuid.uuid4(), name="orders-db", shape="database", project_id=p.id,
        parent_id=система.id,
    )
    брокер = Node(
        id=uuid.uuid4(), name="events", shape="broker", project_id=p.id,
        parent_id=система.id,
    )
    сервис = Node(
        id=uuid.uuid4(), name="orders", shape="service", project_id=p.id,
        parent_id=система.id,
    )
    db.add_all([бд, брокер, сервис])
    db.flush()
    db.add(
        Edge(
            id=uuid.uuid4(), project_id=p.id, source_id=сервис.id, target_id=брокер.id,
            label="публикует", channel="orders.created",
        )
    )
    db.add(DbTable(id=uuid.uuid4(), node_id=бд.id, name="orders", schema_name="public"))
    db.add(BrokerChannel(id=uuid.uuid4(), node_id=брокер.id, name="orders.created", group_name=""))
    db.flush()
    return p


# ── GET /projects/import/prompt ───────────────────────────────────────────────


@pytest.mark.parametrize("variant", ВАРИАНТЫ)
def test_импорт_все_варианты_отдают_текст(db, variant):
    out = import_prompt(
        system_name="Ярмарка", depth=3, lang="ru", hints=None, variant=variant,
        _user=ensure_architect(db),
    )
    assert out.prompt.strip()


def test_импорт_дефолт_байт_в_байт(db):
    user = ensure_architect(db)
    прямой = build_import_prompt("Ярмарка", depth=3, lang="ru", hints=None)
    без = import_prompt(system_name="Ярмарка", depth=3, lang="ru", hints=None, _user=user)
    явный = import_prompt(
        system_name="Ярмарка", depth=3, lang="ru", hints=None, variant="builder", _user=user
    )
    assert без.prompt == прямой
    assert явный.prompt == прямой


def test_импорт_обёртка_несёт_строительный_промпт_дословно(db):
    """Параметры ручки (depth, lang, hints) обязаны доехать внутрь блока А: обёртка
    вшивает живой вызов генератора со ВСЕМИ подстановками, а не «промпт импорта»."""
    прямой = build_import_prompt("Ярмарка", depth=2, lang="en", hints="монорепо")
    out = import_prompt(
        system_name="Ярмарка", depth=2, lang="en", hints="монорепо", variant="orchestrated",
        _user=ensure_architect(db),
    )
    assert _блок_А(out.prompt) == f"\n{прямой}\n"
    assert ПОРОГ_V1 in out.prompt.split(BLOCK_B_START)[1].split(BLOCK_B_END)[0]
    # Имя системы доехало и до аудитора — он ищет в модели тот же корень.
    assert "архитектурная модель системы «Ярмарка»" in out.prompt


def test_импорт_скептик_это_аудит_а_не_стройка(db):
    out = import_prompt(
        system_name="Ярмарка", depth=3, lang="ru", hints=None, variant="skeptic",
        _user=ensure_architect(db),
    )
    assert ПОРОГ_V1 in out.prompt
    assert "archmap-skeptic-report.md" in out.prompt
    assert "Порядок обследования" not in out.prompt  # строительного промпта здесь нет


# ── GET /docs-import/prompt ───────────────────────────────────────────────────


def _прямой_доковый(db, project) -> str:
    """Тот же промпт, что собирает ручка: срез схемы + каталоги имён проекта."""
    nodes = db.query(Node).filter(Node.project_id == project.id).all()
    edges = db.query(Edge).filter(Edge.project_id == project.id).all()
    tables, channels = _name_catalogs(db, project.id)
    return build_docs_prompt(
        build_export(nodes, edges, root_id=None), "both", "ru", None, None, tables, channels
    )


# Отличает «variant не передан» от переданного значения: подставить дефолт самим
# тестом значило бы проверять свой же дефолт, а не дефолт ручки (мутация «дефолт =
# orchestrated» такой тест НЕ ломает — проверено фальсификацией).
_БЕЗ_VARIANT = object()


def _ручка_доков(db, project, variant=_БЕЗ_VARIANT):
    """Вызов ручки доков с остальными параметрами явно: у прямого вызова функции
    дефолты Query(...) остаются объектами Query, а не значениями (в проде их
    подставляет FastAPI). Значения — те же, что у дефолтов ручки."""
    прочие = {
        "node_id": None,
        "include": "both",
        "lang": "ru",
        "hints": None,
        "target": None,
        "db": db,
        "project": project,
        "_": ensure_architect(db),
    }
    if variant is _БЕЗ_VARIANT:
        return docs_prompt(**прочие)
    return docs_prompt(variant=variant, **прочие)


@pytest.mark.parametrize("variant", ВАРИАНТЫ)
def test_доки_все_варианты_отдают_текст(db, variant):
    p = _схема(db)
    out = _ручка_доков(db, p, variant=variant)
    assert out.prompt.strip()


def test_доки_дефолт_байт_в_байт(db):
    p = _схема(db)
    прямой = _прямой_доковый(db, p)
    без = _ручка_доков(db, p)
    явный = _ручка_доков(db, p, variant="builder")
    assert без.prompt == прямой
    assert явный.prompt == прямой


def test_доки_обёртка_несёт_каталоги_проекта(db):
    """Внутри блока А — промпт С КАТАЛОГАМИ этого проекта (перечни таблиц и каналов):
    именно они лечат находку №1 полевого QA, и потерять их в обёртке нельзя."""
    p = _схема(db)
    out = _ручка_доков(db, p, variant="orchestrated")

    блок = _блок_А(out.prompt)
    assert блок == f"\n{_прямой_доковый(db, p)}\n"
    assert "public.orders" in блок  # каталог таблиц
    assert "orders.created" in блок  # каталог каналов
    assert ПОРОГ_V1 in out.prompt


def test_доки_скептик(db):
    p = _схема(db)
    out = _ручка_доков(db, p, variant="skeptic")
    assert ПОРОГ_V1 in out.prompt
    assert "в ЭТОМ сценарии" in out.prompt  # чек-лист именно доков


# ── GET /data-import/prompt ───────────────────────────────────────────────────


@pytest.mark.parametrize("variant", ВАРИАНТЫ)
def test_данные_все_варианты_отдают_текст(db, variant):
    p = _схема(db)
    out = data_prompt(variant=variant, db=db, project=p, _=ensure_architect(db))
    assert out.prompt.strip()


def test_данные_дефолт_байт_в_байт_и_обёртка_с_узлами(db):
    p = _схема(db)
    прямой = build_data_prompt(["Ярмарка / orders-db"])
    assert data_prompt(db=db, project=p, _=ensure_architect(db)).prompt == прямой
    assert (
        data_prompt(variant="builder", db=db, project=p, _=ensure_architect(db)).prompt == прямой
    )

    out = data_prompt(variant="orchestrated", db=db, project=p, _=ensure_architect(db))
    assert _блок_А(out.prompt) == f"\n{прямой}\n"
    assert ПОРОГ_V1 in out.prompt


def test_данные_скептик(db):
    p = _схема(db)
    out = data_prompt(variant="skeptic", db=db, project=p, _=ensure_architect(db))
    assert ПОРОГ_V1 in out.prompt
    assert "abstract" in out.prompt  # чек-лист именно структуры БД


# ── GET /channels-import/prompt ───────────────────────────────────────────────


def _прямой_канальный(db, project) -> str:
    nodes = db.query(Node).filter(Node.project_id == project.id).all()
    flat, fulls, _bare, _path = _node_paths(nodes)
    broker_paths = {n.id: fulls[i] for i, n in enumerate(flat) if n.shape == "broker"}
    edges = db.query(Edge).filter(Edge.project_id == project.id).all()
    minimum = edge_channel_minimum(edges, set(broker_paths))
    return build_channels_prompt(
        list(broker_paths.values()),
        {broker_paths[nid]: list(names) for nid, names in minimum.items()},
    )


@pytest.mark.parametrize("variant", ВАРИАНТЫ)
def test_каналы_все_варианты_отдают_текст(db, variant):
    p = _схема(db)
    out = channels_prompt(variant=variant, db=db, project=p, _=ensure_architect(db))
    assert out.prompt.strip()


def test_каналы_дефолт_байт_в_байт_и_обёртка_с_минимумом(db):
    p = _схема(db)
    прямой = _прямой_канальный(db, p)
    assert channels_prompt(db=db, project=p, _=ensure_architect(db)).prompt == прямой
    assert (
        channels_prompt(variant="builder", db=db, project=p, _=ensure_architect(db)).prompt
        == прямой
    )

    out = channels_prompt(variant="orchestrated", db=db, project=p, _=ensure_architect(db))
    блок = _блок_А(out.prompt)
    assert блок == f"\n{прямой}\n"
    # Минимум пакета из связей схемы доехал внутрь обёртки.
    assert "уже называет схема" in блок and "orders.created" in блок
    assert ПОРОГ_V1 in out.prompt


def test_каналы_скептик(db):
    p = _схема(db)
    out = channels_prompt(variant="skeptic", db=db, project=p, _=ensure_architect(db))
    assert ПОРОГ_V1 in out.prompt
    assert "точка публикации или потребления" in out.prompt  # чек-лист именно каналов


# ── Валидация значения ────────────────────────────────────────────────────────

РУЧКИ = (
    "/api/v1/projects/import/prompt?system_name=Ярмарка",
    "/api/v1/docs-import/prompt",
    "/api/v1/data-import/prompt",
    "/api/v1/channels-import/prompt",
)


@pytest.fixture()
def клиент(db):
    """HTTP-клиент с подменёнными зависимостями: значение query-параметра валидирует
    FastAPI, и увидеть это можно только через настоящий запрос."""
    p = _схема(db)
    user = ensure_architect(db)
    app.dependency_overrides[get_db] = lambda: db
    app.dependency_overrides[get_current_project] = lambda: p
    app.dependency_overrides[require_architect] = lambda: user
    try:
        yield TestClient(app)
    finally:
        app.dependency_overrides.clear()


@pytest.mark.parametrize("ручка", РУЧКИ)
def test_невалидный_variant_отвергается(клиент, ручка):
    разделитель = "&" if "?" in ручка else "?"
    r = клиент.get(f"{ручка}{разделитель}variant=скептик-лайт")
    assert r.status_code == 422
    # А валидные значения проходят — 422 не от чего-то другого.
    for v in ВАРИАНТЫ:
        ok = клиент.get(f"{ручка}{разделитель}variant={v}")
        assert ok.status_code == 200, (ручка, v, ok.text)
        assert ok.json()["prompt"].strip()
