"""Тесты применения синхронизации (app/sync_apply.py + POST /sync/apply, Фаза 2).

Главное здесь — не «записалось ли», а ЧТО ПЕРЕЖИЛО запись: схемы логики, спецификации,
раскладка и ручные правки. Ради этого синк и делался вместо пересоздания проекта.
Плюс сквозной фикспойнт: применили прогон → превью на том же входе пусто.
"""

import inspect
import uuid

import pytest
from conftest import ensure_architect, make_project, seed_project_from_yaml
from fastapi import HTTPException

from app.models.deployment_instance import DeploymentInstance
from app.models.deployment_site import DeploymentSite
from app.models.edge import Edge
from app.models.node import Node
from app.models.node_doc import NodeDoc
from app.models.view_layout import ViewLayoutItem
from app.routers.projects import sync_apply, sync_preview
from app.schemas.project import SyncApplyIn, SyncPreviewIn

RUN = """
nodes:
  - name: Система
    children:
      - name: payments
        role: сервис
        source: {repo: github.com/org/payments, host: payments}
      - name: orders
        source: {repo: github.com/org/orders, host: orders}
      - name: orders-db
        shape: database
        source: {host: orders-db}
edges:
  - {from: orders, to: payments, label: платит}
  - {from: orders, to: orders-db, label: хранит}
"""

# Тот же прогон месяц спустя: payments переименован в billing, добавился cache.
NEXT_RUN = """
nodes:
  - name: Система
    children:
      - name: billing
        role: сервис
        source: {repo: github.com/org/payments, host: payments}
      - name: orders
        source: {repo: github.com/org/orders, host: orders}
      - name: orders-db
        shape: database
        source: {host: orders-db}
      - name: cache
        source: {host: cache}
edges:
  - {from: orders, to: billing, label: платит}
  - {from: orders, to: orders-db, label: хранит}
  - {from: billing, to: cache, label: кэширует}
"""


def _project(db, yaml_text: str = RUN):
    user = ensure_architect(db)
    return seed_project_from_yaml(db, [yaml_text]), user


def _node(db, project_id, name: str) -> Node:
    return db.query(Node).filter(Node.project_id == project_id, Node.name == name).one()


def test_apply_creates_and_updates(db):
    """Новый узел и новая связь появляются; переименование по умолчанию не
    применяется, но узел опознан якорем — не создан заново."""
    p, user = _project(db)
    before = _node(db, p.id, "payments").id

    out = sync_apply(p.id, SyncApplyIn(contents=[NEXT_RUN]), db=db, user=user)

    assert out.created_nodes == ["Система / cache"]
    assert out.created_edges == ["Система / billing → Система / cache"]
    assert out.skipped == []
    # Тот же узел, а не пересозданный: id сохранился, имя не тронуто политикой.
    assert _node(db, p.id, "payments").id == before
    assert db.query(Node).filter(Node.project_id == p.id).count() == 5


def test_apply_preserves_docs_specs_and_layout(db):
    """ГЛАВНОЕ обещание синка: обновление не теряет нажитое поверх импорта."""
    p, user = _project(db)
    payments = _node(db, p.id, "payments")
    db.add(NodeDoc(id=uuid.uuid4(), node_id=payments.id, name="Оплата", kind="обзор", content="graph TD;A-->B"))
    payments.openapi_spec = "openapi: 3.0.0"
    db.add(
        ViewLayoutItem(
            project_id=p.id, view_id=None, item_id=str(payments.id), payload={"x": 120, "y": 340}
        )
    )
    db.commit()

    sync_apply(p.id, SyncApplyIn(contents=[NEXT_RUN], update_names=True), db=db, user=user)

    renamed = _node(db, p.id, "billing")  # имя обновилось по политике
    assert renamed.id == payments.id
    assert renamed.openapi_spec == "openapi: 3.0.0"
    assert [d.name for d in renamed.docs] == ["Оплата"]
    layout = (
        db.query(ViewLayoutItem)
        .filter(ViewLayoutItem.project_id == p.id, ViewLayoutItem.item_id == str(payments.id))
        .one()
    )
    assert layout.payload == {"x": 120, "y": 340}


def test_apply_is_fixpoint(db):
    """Сквозной критерий фазы: применили — превью на том же входе пусто."""
    p, user = _project(db)
    sync_apply(p.id, SyncApplyIn(contents=[NEXT_RUN]), db=db, user=user)

    again = sync_preview(p.id, SyncPreviewIn(contents=[NEXT_RUN]), db=db, user=user)
    assert again.is_noop, again.summary

    # И повторное применение ничего не делает.
    twice = sync_apply(p.id, SyncApplyIn(contents=[NEXT_RUN]), db=db, user=user)
    assert (twice.created_nodes, twice.updated_nodes, twice.created_edges) == ([], [], [])


def test_apply_never_deletes(db):
    """Пропавший узел не удаляется; по политике помечается deprecated — наравне с
    узлом, заведённым руками (решение пользователя 2026-08-07: так прозрачнее)."""
    p, user = _project(db)
    manual = Node(id=uuid.uuid4(), project_id=p.id, name="ручной", parent_id=_node(db, p.id, "Система").id)
    db.add(manual)
    db.commit()
    without_db = RUN.replace(
        "      - name: orders-db\n        shape: database\n        source: {host: orders-db}\n", ""
    ).replace("  - {from: orders, to: orders-db, label: хранит}\n", "")

    out = sync_apply(
        p.id, SyncApplyIn(contents=[without_db], mark_missing_deprecated=True), db=db, user=user
    )

    assert sorted(out.deprecated_nodes) == ["Система / orders-db", "Система / ручной"]
    assert _node(db, p.id, "orders-db").status == "deprecated"  # не удалён
    assert db.query(Edge).filter(Edge.project_id == p.id).count() == 2  # связи целы


def test_apply_bumps_graph_rev_and_guards_stale_preview(db):
    """Курсор схемы двигается (поллинг чужих сессий), а применение с устаревшим
    курсором отклоняется — пользователь не пишет вслепую то, чего не видел."""
    p, user = _project(db)
    preview = sync_preview(p.id, SyncPreviewIn(contents=[NEXT_RUN]), db=db, user=user)
    rev_before = preview.graph_rev

    out = sync_apply(
        p.id, SyncApplyIn(contents=[NEXT_RUN], base_graph_rev=rev_before), db=db, user=user
    )
    assert out.graph_rev > rev_before

    with pytest.raises(HTTPException) as exc:
        sync_apply(
            p.id, SyncApplyIn(contents=[NEXT_RUN], base_graph_rev=rev_before), db=db, user=user
        )
    assert exc.value.status_code == 409


def test_apply_rejects_broken_yaml_and_unknown_project(db):
    p, user = _project(db)
    with pytest.raises(HTTPException) as exc:
        sync_apply(p.id, SyncApplyIn(contents=["nodes: [oops"]), db=db, user=user)
    assert exc.value.status_code == 400

    with pytest.raises(HTTPException) as exc:
        sync_apply(uuid.uuid4(), SyncApplyIn(contents=[RUN]), db=db, user=user)
    assert exc.value.status_code == 404


# ── Прямые тесты apply_sync_plan (аудит Q-48): без HTTP, на настоящем плане ──────
# Политики и поля обновления раньше проверялись только через ручку синка; после
# разбора применения на помощники (Q-16) каждая ветка держится здесь отдельно.


def _apply(db, p, text: str, **policies: bool):
    from app.import_merge import parse_and_merge
    from app.sync_apply import apply_sync_plan
    from app.sync_plan import SyncPolicies, plan_for

    merged, _report, errors = parse_and_merge([text])
    assert merged is not None, errors
    plan = plan_for(db, p.id, merged, SyncPolicies(**policies))
    report = apply_sync_plan(db, p, merged, plan)
    db.commit()
    return report


def test_apply_переносит_имя_и_описание_по_политикам(db):
    p, _user = _project(db)
    payments = _node(db, p.id, "payments")
    version = payments.version
    text = NEXT_RUN.replace("role: сервис\n", "role: сервис\n        description: Платежи\n", 1)

    report = _apply(db, p, text, update_names=True, update_descriptions=True)

    db.refresh(payments)
    assert (payments.name, payments.description) == ("billing", "Платежи")
    assert payments.version == version + 1
    assert "Система / billing" in report.updated_nodes


BROKER_RUN = """
nodes:
  - name: Система
    children:
      - name: producer
        source: {host: producer}
      - name: consumer
        source: {host: consumer}
      - name: bus
        shape: broker
        source: {host: bus}
edges:
  - {from: producer, to: bus, label: публикует A, technology: AMQP, channel: topic.a}
  - {from: producer, to: bus, label: публикует B, technology: AMQP, channel: topic.b}
  - {from: bus, to: consumer, label: доставляет A, technology: AMQP, channel: topic.a, sync: false}
"""


def _edges(db, project_id) -> dict[str, Edge]:
    return {e.label: e for e in db.query(Edge).filter(Edge.project_id == project_id).all()}


def test_apply_пишет_канал_и_тип_канала_новой_связи(db):
    """Репорт 2026-10-28: синк создавал связи без канала и типа — связи с брокером
    горели алертом AL31, а асинхронный канал молча становился синхронным."""
    user = ensure_architect(db)
    p = make_project(db, owner=user)

    out = sync_apply(p.id, SyncApplyIn(contents=[BROKER_RUN], sync_components=True), db=db, user=user)

    assert len(out.created_edges) == 3 and out.updated_edges == []
    edges = _edges(db, p.id)
    assert (edges["публикует A"].channel, edges["публикует B"].channel) == ("topic.a", "topic.b")
    assert edges["доставляет A"].is_synchronous is False
    assert edges["публикует A"].is_synchronous is None  # sync не прислан — дефолт
    # Фикспойнт: повторное превью на том же входе пусто, две связи пары не путаются.
    assert sync_preview(p.id, SyncPreviewIn(contents=[BROKER_RUN], sync_components=True), db=db, user=user).is_noop


def test_apply_лечит_связи_без_канала_повторным_синком(db):
    """Проект, заполненный синком до фикса: повторный синк тех же файлов заполняет
    пустые каналы и тип действием update — без дублей, с ответом, что обновлено."""
    user = ensure_architect(db)
    p = seed_project_from_yaml(db, [BROKER_RUN], owner=user)
    for e in _edges(db, p.id).values():
        e.channel = None
        e.is_synchronous = None
    db.commit()
    versions = {label: e.version for label, e in _edges(db, p.id).items()}

    out = sync_apply(p.id, SyncApplyIn(contents=[BROKER_RUN], sync_components=True), db=db, user=user)

    assert out.created_edges == [] and len(out.updated_edges) == 3
    assert "Система / producer → Система / bus" in out.updated_edges
    edges = _edges(db, p.id)
    assert len(edges) == 3
    assert (edges["публикует A"].channel, edges["публикует B"].channel) == ("topic.a", "topic.b")
    assert edges["доставляет A"].is_synchronous is False
    assert all(e.version == versions[label] + 1 for label, e in edges.items())
    assert sync_preview(p.id, SyncPreviewIn(contents=[BROKER_RUN], sync_components=True), db=db, user=user).is_noop


def test_превью_называет_канал_связи(db):
    """Строке плана нужен не только список полей, но и значение: какой канал
    получит новая связь и чем заполнится пустой."""
    user = ensure_architect(db)
    p = seed_project_from_yaml(db, [BROKER_RUN], owner=user)
    edges = _edges(db, p.id)
    edges["публикует B"].channel = None
    db.commit()
    grown = BROKER_RUN + "  - {from: producer, to: bus, label: публикует C, technology: AMQP, channel: topic.c}\n"

    pv = sync_preview(p.id, SyncPreviewIn(contents=[grown], sync_components=True), db=db, user=user)

    by = {(e.action, e.channel): e for e in pv.edges}
    assert by[("update", "topic.b")].fields == ["channel"]
    assert by[("create", "topic.c")].fields == []
    assert pv.summary["edges_update"] == 1 and pv.summary["edges_create"] == 1


def test_apply_без_политик_имя_не_трогает(db):
    p, _user = _project(db)
    report = _apply(db, p, NEXT_RUN)
    assert _node(db, p.id, "payments").name == "payments"
    assert report.updated_nodes == []


def test_apply_проставляет_якорь_узлу_без_него(db):
    p, _user = _project(db, RUN.replace("        source: {host: orders-db}\n", ""))
    db_node = _node(db, p.id, "orders-db")
    assert db_node.source_ref is None

    report = _apply(db, p, RUN)

    db.refresh(db_node)
    assert db_node.source_ref == "host:orders-db"
    assert report.updated_nodes == ["Система / orders-db"]


def test_apply_помечает_пропавшее_только_по_политике(db):
    p, _user = _project(db)
    без_orders_db = RUN.replace(
        "      - name: orders-db\n        shape: database\n        source: {host: orders-db}\n", ""
    ).replace("  - {from: orders, to: orders-db, label: хранит}\n", "")

    report = _apply(db, p, без_orders_db)
    assert report.deprecated_nodes == []
    assert _node(db, p.id, "orders-db").status == "existing"

    report = _apply(db, p, без_orders_db, mark_missing_deprecated=True)
    assert report.deprecated_nodes == ["Система / orders-db"]
    assert _node(db, p.id, "orders-db").status == "deprecated"
    # Повторный прогон: уже устаревший узел второй раз не помечается.
    assert _apply(db, p, без_orders_db, mark_missing_deprecated=True).deprecated_nodes == []


# ── Размещение синк не трогает (Ф4 эпика развёртывания) ──────────────────────


def test_синк_размещения_не_трогает(db):
    """Агент размещения не знает (ТЗ развёртывания §4): прогон с разделом deployment и
    sites у узлов не даёт плану ни одного поля размещения, а применение не создаёт ни
    площадок, ни экземпляров — ни живым узлам, ни созданным синком."""
    from app.import_merge import parse_and_merge
    from app.sync_plan import SyncPolicies, plan_for

    p, _user = _project(db)
    text = (
        NEXT_RUN.replace("      - name: cache\n", "      - name: cache\n        sites: [prod]\n")
        .replace("      - name: orders\n", "      - name: orders\n        sites: [prod]\n")
        + "deployment:\n  sites:\n    - {name: prod, kind: kubernetes}\n"
    )
    policies = {
        "update_descriptions": True, "update_names": True, "sync_components": True,
        "mark_missing_deprecated": True, "restore_returned": True,
    }
    merged, _report, errors = parse_and_merge([text])
    assert merged is not None and merged.sites, errors

    plan = plan_for(db, p.id, merged, SyncPolicies(**policies))
    report = _apply(db, p, text, **policies)

    полей = {"name", "description", "role", "technology", "shape", "status", "source_ref"}
    assert all(set(a.fields) <= полей for a in plan.nodes)
    assert report.created_nodes == ["Система / cache"]
    assert db.query(DeploymentSite).count() == 0
    assert db.query(DeploymentInstance).count() == 0


def test_модули_синка_размещение_не_читают():
    """Сторож структуры: ключ sites разобранного узла синку не нужен вовсе."""
    from app import sync_apply, sync_plan

    for module in (sync_plan, sync_apply):
        assert ".sites" not in inspect.getsource(module)


# ── Элемент архитектуры: синк доливает пустое и создаёт с элементом (Ф2, Р30) ─

RUN_ЭЛЕМЕНТ = NEXT_RUN.replace(
    "      - name: orders\n", "      - name: orders\n        element: container\n"
).replace("      - name: cache\n", "      - name: cache\n        element: container\n")


def test_apply_доливает_элемент_и_создаёт_с_элементом_фикспойнт(db):
    """Пустой элемент живого узла доливается, новый узел создаётся с элементом (лист-
    контейнер без компонентов — норма, Р3), и повторный план на том же входе пуст."""
    p, user = _project(db)

    out = sync_apply(p.id, SyncApplyIn(contents=[RUN_ЭЛЕМЕНТ]), db=db, user=user)

    assert "Система / orders" in out.updated_nodes
    assert out.created_nodes == ["Система / cache"]
    assert _node(db, p.id, "orders").element == "container"
    assert _node(db, p.id, "cache").element == "container"
    assert _node(db, p.id, "payments").element is None

    again = sync_preview(p.id, SyncPreviewIn(contents=[RUN_ЭЛЕМЕНТ]), db=db, user=user)
    assert again.is_noop, again.summary


# ── База и брокер в живом контейнере: создаются у его родителя (Р6) ─────────

def _plan(db, p, text: str, **policies: bool):
    from app.import_merge import parse_and_merge
    from app.sync_plan import SyncPolicies, plan_for

    merged, _report, errors = parse_and_merge([text])
    assert merged is not None, errors
    return plan_for(db, p.id, merged, SyncPolicies(**policies))


def test_apply_создаёт_базу_уровнем_выше_живого_контейнера_фикспойнт(db):
    """Прогон кладёт базу в живой контейнер: она создаётся у родителя контейнера, связь
    к ней находит конец по пути прогона, повторный план пуст по действиям."""
    p, _user = _project(db, RUN_ЭЛЕМЕНТ)
    прогон = RUN_ЭЛЕМЕНТ.replace(
        "      - name: orders\n        element: container\n",
        "      - name: orders\n        children:\n          - name: api\n"
        "          - name: orders-cache\n            shape: database\n",
    ) + "  - {from: api, to: orders-cache, label: кэширует}\n"

    report = _apply(db, p, прогон, sync_components=True)

    assert "Система / orders / orders-cache" in report.created_nodes
    кэш, система = _node(db, p.id, "orders-cache"), _node(db, p.id, "Система")
    assert кэш.parent_id == система.id
    assert _node(db, p.id, "api").parent_id == _node(db, p.id, "orders").id
    assert _node(db, p.id, "orders").element == "container"
    связь = db.query(Edge).filter(Edge.project_id == p.id, Edge.target_id == кэш.id).one()
    assert связь.source_id == _node(db, p.id, "api").id

    again = _plan(db, p, прогон, sync_components=True)
    assert again.is_noop, again.summary
    assert again.conflicts == [
        "«orders-cache»: база данных не может входить в состав контейнера «orders» — в "
        "схеме она лежит уровнем выше, в «Система»"
    ]


def test_apply_брокер_корневого_контейнера_на_верхнем_уровне(db):
    живой = "nodes:\n  - name: orders\n    element: container\n    children:\n      - name: api\n"
    прогон = (
        "nodes:\n  - name: orders\n    children:\n      - name: api\n"
        "      - name: scheduler\n"
        "      - name: Kafka\n        shape: broker\n"
    )
    p, _user = _project(db, живой)

    report = _apply(db, p, прогон)

    # Брокер компонентом не бывает — выносится и без галочки; новый сервис-компонент
    # scheduler без галочки не создаётся.
    assert report.created_nodes == ["orders / Kafka"]
    assert _node(db, p.id, "Kafka").parent_id is None
    assert _plan(db, p, прогон).is_noop
