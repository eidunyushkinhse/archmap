"""Тесты правил контейнеров (эпик «Правила контейнеров»).

1) Алерт «Системы и контейнеры со своей документацией» (AL24) по элементу архитектуры
   (docs/plan-c4-elements.md, раздел 0а): у системы (service с детьми, элемент не
   «контейнер») — собственные node_docs, openapi_spec или параметры; у контейнера с
   компонентами — только собственные node_docs. Атомарные узлы с доками и узлы с
   детьми без своих доков не алертятся. Рядом — класс «Конфигурация и спецификации у
   компонентов» (AL36): спецификация или параметры у компонента.
2) Эндпоинт distribute_docs («Распределить по детям»): перенос собственных доков
   контейнера на непосредственных детей + перенос openapi_spec одному ребёнку.
   Валидации: цель не ребёнок, имя занято у ребёнка, спецификации нет / у ребёнка уже есть.
"""

import uuid

import pytest
from conftest import ensure_architect, ensure_project
from fastapi import HTTPException

from app.alerts import compute_alerts
from app.models.config_param import ConfigParam
from app.models.deployment_instance import DeploymentInstance
from app.models.deployment_site import DeploymentSite
from app.models.node import Node
from app.models.node_doc import NodeDoc
from app.routers.node_docs import distribute_docs
from app.schemas.node import DistributeDocAssignment, DistributeDocsIn


def _node(db, name, parent=None, shape="service", openapi_spec=None, element=None):
    n = Node(
        id=uuid.uuid4(),
        name=name,
        parent_id=parent.id if parent else None,
        project_id=ensure_project(db).id,
        shape=shape,
        openapi_spec=openapi_spec,
        element=element,
    )
    db.add(n)
    return n


def _param(db, node, name="LOG_LEVEL"):
    db.add(ConfigParam(
        id=uuid.uuid4(), node_id=node.id, name=name,
        value_type="string", required=False, default_value="info",
    ))


def _doc(db, node, name="Схема", kind="operation"):
    d = NodeDoc(id=uuid.uuid4(), node_id=node.id, name=name, kind=kind, content="graph TD\nA-->B")
    db.add(d)
    return d


# ── Алерт container_own_docs ────────────────────────────────────────────────

def test_alert_container_with_own_docs(db):
    root = _node(db, "Контейнер")
    _node(db, "Дети", parent=root)  # у root есть дети → контейнер
    _doc(db, root)  # свой док → grandfather
    db.commit()

    rep = compute_alerts(db, ensure_project(db).id)
    assert len(rep.container_own_docs) == 1
    a = rep.container_own_docs[0]
    assert a.node_id == root.id
    # Элемент не задан — узел с детьми читается системой, как до эпика.
    assert a.element_effective == "system"
    assert a.has_docs is True
    assert a.has_spec is False
    assert a.has_config is False


def test_alert_system_with_config_only(db):
    """Система — группа и для конфигурации (полевой репорт 2026-10-28): параметры на ней
    зажигают тот же алерт, что доки и спецификация, — их читают её контейнеры."""
    root = _node(db, "Система")
    _node(db, "Дети", parent=root)
    _param(db, root)
    db.commit()

    rep = compute_alerts(db, ensure_project(db).id)
    assert len(rep.container_own_docs) == 1
    a = rep.container_own_docs[0]
    assert (a.element_effective, a.has_docs, a.has_spec, a.has_config) == (
        "system", False, False, True,
    )


def test_alert_system_with_spec_only(db):
    root = _node(db, "Система", openapi_spec="openapi: 3.0.0")
    _node(db, "Дети", parent=root)
    db.commit()

    rep = compute_alerts(db, ensure_project(db).id)
    assert len(rep.container_own_docs) == 1
    assert rep.container_own_docs[0].element_effective == "system"
    assert rep.container_own_docs[0].has_spec is True
    assert rep.container_own_docs[0].has_docs is False


def test_alert_container_with_components_spec_and_config_are_norm(db):
    # Р14/0а: спецификация и конфигурация у контейнера с компонентами — его факты.
    orders = _node(db, "orders", openapi_spec="openapi: 3.0.0", element="container")
    _node(db, "orders/api", parent=orders)
    _param(db, orders)
    db.commit()

    rep = compute_alerts(db, ensure_project(db).id)
    assert rep.container_own_docs == []
    assert rep.component_facts == []


def test_alert_container_with_components_own_docs(db):
    # Схемы логики описывают код, а код — у компонентов (Р9): совет контейнера.
    orders = _node(db, "orders", openapi_spec="openapi: 3.0.0", element="container")
    _node(db, "orders/api", parent=orders)
    _doc(db, orders)
    db.commit()

    rep = compute_alerts(db, ensure_project(db).id)
    assert len(rep.container_own_docs) == 1
    a = rep.container_own_docs[0]
    assert (a.node_id, a.element_effective) == (orders.id, "container")
    # Флаги — как есть: спецификация в записи видна, хоть сама по себе и норма.
    assert (a.has_docs, a.has_spec, a.has_config) == (True, True, False)


def test_alert_composite_component_not_in_own_docs(db):
    # Узел с детьми внутри контейнера — составной компонент: его схемы — факт кода,
    # а спецификацию ловит класс компонентов, а не AL24.
    orders = _node(db, "orders", element="container")
    api = _node(db, "orders/api", parent=orders, openapi_spec="openapi: 3.0.0")
    _node(db, "orders/api/handlers", parent=api)
    _doc(db, api)
    db.commit()

    rep = compute_alerts(db, ensure_project(db).id)
    assert rep.container_own_docs == []
    assert [(c.node_id, c.container_id, c.has_spec, c.has_config) for c in rep.component_facts] == [
        (api.id, orders.id, True, False),
    ]


# ── Класс component_facts (AL36) ────────────────────────────────────────────

def test_component_with_config_names_its_container(db):
    shop = _node(db, "shop")
    orders = _node(db, "orders", parent=shop, element="container")
    api = _node(db, "orders/api", parent=orders)
    _param(db, api)
    db.commit()

    rep = compute_alerts(db, ensure_project(db).id)
    assert [c.model_dump() for c in rep.component_facts] == [{
        "node_id": api.id, "node_name": "orders/api",
        "container_id": orders.id, "container_name": "orders",
        "has_spec": False, "has_config": True, "has_sites": False,
    }]
    assert rep.container_own_docs == []


def test_component_with_spec_and_order_by_name(db):
    orders = _node(db, "orders", element="container")
    worker = _node(db, "worker", parent=orders, openapi_spec="openapi: 3.0.0")
    api = _node(db, "api", parent=orders, openapi_spec="openapi: 3.0.0")
    _param(db, api)
    _node(db, "clean", parent=orders)  # компонент без фактов процесса — норма
    db.commit()

    rep = compute_alerts(db, ensure_project(db).id)
    assert [(c.node_id, c.has_spec, c.has_config) for c in rep.component_facts] == [
        (api.id, True, True), (worker.id, True, False),
    ]


def test_component_with_sleeping_instance_has_sites(db):
    # Экземпляр у компонента (прежние данные, перенос) размещение не считает — «спящий»;
    # класс его видит. Экземпляр у контейнера и у листа вне контейнера — норма.
    project = ensure_project(db)
    orders = _node(db, "orders", element="container")
    api = _node(db, "orders/api", parent=orders)
    billing = _node(db, "billing")
    site = DeploymentSite(id=uuid.uuid4(), project_id=project.id, name="Облако")
    db.add(site)
    db.flush()
    for n in (orders, api, billing):
        db.add(DeploymentInstance(id=uuid.uuid4(), project_id=project.id, node_id=n.id, site_id=site.id))
    db.commit()

    rep = compute_alerts(db, project.id)
    assert [c.model_dump() for c in rep.component_facts] == [{
        "node_id": api.id, "node_name": "orders/api",
        "container_id": orders.id, "container_name": "orders",
        "has_spec": False, "has_config": False, "has_sites": True,
    }]


def test_leaf_outside_container_with_config_is_silent(db):
    # Лист вне контейнера — сам контейнер: параметры на нём — норма, как до эпика.
    shop = _node(db, "shop")
    billing = _node(db, "billing", parent=shop, openapi_spec="openapi: 3.0.0")
    _param(db, billing)
    db.commit()

    rep = compute_alerts(db, ensure_project(db).id)
    assert rep.component_facts == []
    assert rep.container_own_docs == []


def test_alert_container_without_own_docs_is_silent(db):
    root = _node(db, "Контейнер")
    child = _node(db, "Дети", parent=root)
    _doc(db, child)  # док на ребёнке — норма, не grandfather
    db.commit()

    rep = compute_alerts(db, ensure_project(db).id)
    assert rep.container_own_docs == []


def test_alert_atomic_node_with_docs_is_not_container_alert(db):
    leaf = _node(db, "Атомарный")  # без детей
    _doc(db, leaf)
    db.commit()

    rep = compute_alerts(db, ensure_project(db).id)
    # Атомарный узел с доками — это норма (не контейнер), в container_own_docs не попадает.
    assert rep.container_own_docs == []


def test_alert_non_service_with_children_not_flagged(db):
    # По правилам контейнером становится только service; БД с детьми не алертится.
    db_node = _node(db, "База", shape="database")
    _node(db, "Вложенный", parent=db_node)
    _doc(db, db_node)
    db.commit()

    rep = compute_alerts(db, ensure_project(db).id)
    assert rep.container_own_docs == []


# ── distribute_docs ─────────────────────────────────────────────────────────

def test_distribute_moves_docs_to_child(db):
    root = _node(db, "Контейнер")
    c1 = _node(db, "Дитя-1", parent=root)
    c2 = _node(db, "Дитя-2", parent=root)
    d1 = _doc(db, root, name="Док-A")
    d2 = _doc(db, root, name="Док-B")
    db.commit()

    out = distribute_docs(
        root.id,
        DistributeDocsIn(doc_assignments=[
            DistributeDocAssignment(doc_id=d1.id, child_id=c1.id),
            DistributeDocAssignment(doc_id=d2.id, child_id=c2.id),
        ]),
        db=db, project=ensure_project(db), user=ensure_architect(db),
    )
    assert out.moved_docs == 2
    assert out.spec_moved is False
    db.expire_all()
    assert db.get(NodeDoc, d1.id).node_id == c1.id
    assert db.get(NodeDoc, d2.id).node_id == c2.id


def test_distribute_moves_spec_to_child(db):
    root = _node(db, "Контейнер", openapi_spec="openapi: 3.0.0")
    c1 = _node(db, "Дитя", parent=root)
    db.commit()

    out = distribute_docs(
        root.id,
        DistributeDocsIn(spec_child_id=c1.id),
        db=db, project=ensure_project(db), user=ensure_architect(db),
    )
    assert out.spec_moved is True
    db.expire_all()
    assert db.get(Node, c1.id).openapi_spec == "openapi: 3.0.0"
    assert db.get(Node, root.id).openapi_spec is None


def test_distribute_rejects_non_child_target(db):
    root = _node(db, "Контейнер")
    _node(db, "Дитя", parent=root)
    stranger = _node(db, "Чужой")  # не ребёнок root
    d = _doc(db, root, name="Док")
    db.commit()

    with pytest.raises(HTTPException) as e:
        distribute_docs(
            root.id,
            DistributeDocsIn(doc_assignments=[
                DistributeDocAssignment(doc_id=d.id, child_id=stranger.id),
            ]),
            db=db, project=ensure_project(db), user=ensure_architect(db),
        )
    assert e.value.status_code == 409


def test_distribute_rejects_name_conflict_at_child(db):
    root = _node(db, "Контейнер")
    c1 = _node(db, "Дитя", parent=root)
    _doc(db, c1, name="Док")  # у ребёнка уже есть схема с именем «Док»
    d = _doc(db, root, name="Док")  # у контейнера — с тем же именем
    db.commit()

    with pytest.raises(HTTPException) as e:
        distribute_docs(
            root.id,
            DistributeDocsIn(doc_assignments=[
                DistributeDocAssignment(doc_id=d.id, child_id=c1.id),
            ]),
            db=db, project=ensure_project(db), user=ensure_architect(db),
        )
    assert e.value.status_code == 409


def test_distribute_spec_conflict_at_child(db):
    root = _node(db, "Контейнер", openapi_spec="openapi: 3.0.0")
    c1 = _node(db, "Дитя", parent=root, openapi_spec="openapi: 3.1.0")  # уже есть спека
    db.commit()

    with pytest.raises(HTTPException) as e:
        distribute_docs(
            root.id,
            DistributeDocsIn(spec_child_id=c1.id),
            db=db, project=ensure_project(db), user=ensure_architect(db),
        )
    assert e.value.status_code == 409
