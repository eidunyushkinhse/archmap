"""Тесты правил контейнеров (эпик «Правила контейнеров»).

1) Алерт «Системы и контейнеры со своей документацией» (AL24) по элементу архитектуры
   (docs/plan-c4-elements.md, раздел 0а): у системы (service с детьми, элемент не
   «контейнер») — собственные node_docs, openapi_spec или параметры; у контейнера с
   компонентами — только собственные node_docs. Атомарные узлы с доками и узлы с
   детьми без своих доков не алертятся. Рядом — класс «Конфигурация и спецификации у
   компонентов» (AL36): спецификация или параметры у компонента.
2) Эндпоинт distribute_docs («Перенести документацию», Р19 эпика элементов): перенос
   собственных схем логики узла потомкам, у которых схемы на месте (компонент или
   объект без вложенных), спецификации — потомку-контейнеру, всех параметров
   конфигурации — одному потомку-контейнеру. Валидации: получатель вне поддерева, не
   того элемента, имя занято, спецификации нет / у получателя уже есть.
3) «Собрать с компонентов» (app/facts_transfer.collect_*): параметры и выбранная
   спецификация компонентов — контейнеру, одноимённые — по выбору.
"""

import uuid

import pytest
from conftest import ensure_architect, ensure_project
from fastapi import HTTPException

from app import facts_transfer
from app.alerts import compute_alerts
from app.models.config_param import ConfigParam
from app.models.deployment_instance import DeploymentInstance
from app.models.deployment_site import DeploymentSite
from app.models.node import Node
from app.models.node_doc import NodeDoc
from app.routers.facts import collect, collect_preview
from app.routers.node_docs import distribute_docs, transfer_preview
from app.schemas.node import (
    CollectFactsIn,
    CollectParamChoice,
    DistributeDocAssignment,
    DistributeDocsIn,
)


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


def _param(db, node, name="LOG_LEVEL", description=None):
    db.add(ConfigParam(
        id=uuid.uuid4(), node_id=node.id, name=name, description=description,
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


# ── «Перенести документацию» по семьям фактов (Р19) ─────────────────────────

def _distribute(db, node, **kw):
    return distribute_docs(
        node.id, DistributeDocsIn(**kw),
        db=db, project=ensure_project(db), user=ensure_architect(db),
    )


def _refusal(call) -> tuple[int, str]:
    with pytest.raises(HTTPException) as e:
        call()
    return e.value.status_code, e.value.detail


def _shop(db):
    """Система shop: контейнер orders (компоненты api и составной jobs с внуком nightly),
    лист billing, система inner с листом ledger. У shop — свои схема, спецификация и
    параметры (то, что отмечает AL24)."""
    shop = _node(db, "shop", openapi_spec="openapi: 3.0.0")
    orders = _node(db, "orders", parent=shop, element="container")
    api = _node(db, "api", parent=orders)
    jobs = _node(db, "jobs", parent=orders)
    nightly = _node(db, "nightly", parent=jobs)
    billing = _node(db, "billing", parent=shop)
    inner = _node(db, "inner", parent=shop)
    ledger = _node(db, "ledger", parent=inner)
    db.flush()
    return {n.name: n for n in (shop, orders, api, jobs, nightly, billing, inner, ledger)}


def test_схема_логики_переносится_внуку(db):
    n = _shop(db)
    d1 = _doc(db, n["shop"], name="Старт заказа")
    d2 = _doc(db, n["shop"], name="Ночной пересчёт", kind="worker")
    d3 = _doc(db, n["shop"], name="Проводка")
    db.commit()
    out = _distribute(db, n["shop"], doc_assignments=[
        DistributeDocAssignment(doc_id=d1.id, child_id=n["api"].id),       # компонент
        DistributeDocAssignment(doc_id=d2.id, child_id=n["nightly"].id),   # внук-компонент
        DistributeDocAssignment(doc_id=d3.id, child_id=n["ledger"].id),    # лист вложенной системы
    ])
    assert (out.moved_docs, out.spec_moved, out.moved_params) == (3, False, 0)
    db.expire_all()
    assert [db.get(NodeDoc, d.id).node_id for d in (d1, d2, d3)] == [
        n["api"].id, n["nightly"].id, n["ledger"].id,
    ]


def test_схемы_не_принимают_система_и_контейнер_с_компонентами(db):
    n = _shop(db)
    d = _doc(db, n["shop"], name="Старт заказа")
    db.commit()
    for target, what in (("orders", "контейнер с компонентами"), ("inner", "система")):
        code, text = _refusal(lambda t=target: _distribute(db, n["shop"], doc_assignments=[
            DistributeDocAssignment(doc_id=d.id, child_id=n[t].id),
        ]))
        assert (code, text) == (422, (
            f"Схемы логики переносятся компонентам и объектам без вложенных, а «{target}» — {what}."
        ))
    # Составной компонент — получатель: его схемы описывают код.
    out = _distribute(db, n["shop"], doc_assignments=[
        DistributeDocAssignment(doc_id=d.id, child_id=n["jobs"].id),
    ])
    assert out.moved_docs == 1


def test_спецификация_только_контейнеру(db):
    n = _shop(db)
    db.commit()
    code, text = _refusal(lambda: _distribute(db, n["shop"], spec_child_id=n["api"].id))
    assert (code, text) == (422, "Спецификация переносится только контейнеру, а «api» — компонент.")
    code, text = _refusal(lambda: _distribute(db, n["shop"], spec_child_id=n["inner"].id))
    assert (code, text) == (422, "Спецификация переносится только контейнеру, а «inner» — система.")
    # Контейнер с компонентами и лист вне контейнера — получатели.
    out = _distribute(db, n["shop"], spec_child_id=n["orders"].id)
    assert out.spec_moved is True
    db.expire_all()
    assert (db.get(Node, n["orders"].id).openapi_spec, db.get(Node, n["shop"].id).openapi_spec) == (
        "openapi: 3.0.0", None,
    )
    # Спецификации больше нет — повтор отказывается словами продукта.
    code, text = _refusal(lambda: _distribute(db, n["shop"], spec_child_id=n["billing"].id))
    assert (code, text) == (409, "У «shop» нет спецификации")


def test_база_брокер_и_пользователь_не_получатели(db):
    """Лист базы или брокера по элементу — контейнер (единица размещения), но схем логики,
    спецификации и конфигурации у него не бывает: отказ называет форму, а не элемент."""
    n = _shop(db)
    db_ = _node(db, "orders-db", parent=n["shop"], shape="database")
    kafka = _node(db, "Kafka", parent=n["shop"], shape="broker")
    buyer = _node(db, "Покупатель", parent=n["shop"], shape="person")
    d = _doc(db, n["shop"], name="Старт заказа")
    _param(db, n["shop"])
    db.commit()
    for target, what in ((db_, "база данных"), (kafka, "брокер"), (buyer, "пользователь")):
        assert _refusal(lambda t=target: _distribute(db, n["shop"], doc_assignments=[
            DistributeDocAssignment(doc_id=d.id, child_id=t.id),
        ])) == (422, (
            f"Схемы логики переносятся компонентам и объектам без вложенных, а «{target.name}» — {what}."
        ))
        assert _refusal(lambda t=target: _distribute(db, n["shop"], spec_child_id=t.id)) == (
            422, f"Спецификация переносится только контейнеру, а «{target.name}» — {what}.",
        )
        assert _refusal(lambda t=target: _distribute(db, n["shop"], params_target_id=t.id)) == (
            422, f"Конфигурация переносится только контейнеру, а «{target.name}» — {what}.",
        )


def test_параметры_переезжают_одному_контейнеру(db):
    n = _shop(db)
    _param(db, n["shop"], "LOG_LEVEL")
    _param(db, n["shop"], "FEATURE_X")
    db.commit()
    code, text = _refusal(lambda: _distribute(db, n["shop"], params_target_id=n["api"].id))
    assert (code, text) == (422, "Конфигурация переносится только контейнеру, а «api» — компонент.")
    out = _distribute(db, n["shop"], params_target_id=n["billing"].id)
    assert (out.moved_docs, out.spec_moved, out.moved_params) == (0, False, 2)
    db.expire_all()
    assert sorted(
        p.name for p in db.query(ConfigParam).filter(ConfigParam.node_id == n["billing"].id)
    ) == ["FEATURE_X", "LOG_LEVEL"]
    assert db.query(ConfigParam).filter(ConfigParam.node_id == n["shop"].id).count() == 0


def test_параметры_с_занятым_именем_409_и_ничего_не_переезжает(db):
    n = _shop(db)
    _param(db, n["shop"], "FEATURE_X")
    _param(db, n["shop"], "LOG_LEVEL")
    _param(db, n["orders"], "FEATURE_X")
    d = _doc(db, n["shop"], name="Старт заказа")
    db.commit()
    code, text = _refusal(lambda: _distribute(
        db, n["shop"], params_target_id=n["orders"].id,
        doc_assignments=[DistributeDocAssignment(doc_id=d.id, child_id=n["api"].id)],
    ))
    assert (code, text) == (409, "У «orders» уже есть параметр «FEATURE_X»")
    # Проверки — до записи: схема тоже осталась на месте.
    db.expire_all()
    assert db.get(NodeDoc, d.id).node_id == n["shop"].id


def test_отказы_словами_продукта(db):
    n = _shop(db)
    _doc(db, n["api"], name="Старт заказа")
    own = _doc(db, n["shop"], name="Старт заказа")
    stranger = _node(db, "stranger")
    db.commit()
    code, text = _refusal(lambda: _distribute(db, n["shop"], doc_assignments=[
        DistributeDocAssignment(doc_id=own.id, child_id=n["api"].id),
    ]))
    assert (code, text) == (409, "У «api» уже есть схема «Старт заказа»")
    code, text = _refusal(lambda: _distribute(db, n["shop"], doc_assignments=[
        DistributeDocAssignment(doc_id=own.id, child_id=stranger.id),
    ]))
    assert (code, text) == (409, "Получатель не входит в состав объекта")
    code, text = _refusal(lambda: _distribute(db, n["orders"], doc_assignments=[
        DistributeDocAssignment(doc_id=own.id, child_id=n["api"].id),
    ]))
    assert (code, text) == (404, "Схема не найдена среди собственных схем объекта")
    n2 = _node(db, "orders-v2", openapi_spec="openapi: 3.0.0", element="container")
    child = _node(db, "api-v2", parent=n2)
    db.commit()
    code, _ = _refusal(lambda: _distribute(db, n2, spec_child_id=child.id))
    assert code == 422  # компонент спецификацию не принимает


# ── Превью «Перенести документацию» (получатели считает сервер) ─────────────

def _transfer_preview(db, node):
    return transfer_preview(node.id, db=db, project=ensure_project(db), _=ensure_architect(db))


def _shop_with_stores(db):
    """_shop плюс база, брокер и «Пользователь» внутри системы, спецификация у billing и
    своя документация shop: схема, спецификация и два параметра."""
    n = _shop(db)
    for name, shape in (("orders-db", "database"), ("Kafka", "broker"), ("Покупатель", "person")):
        n[name] = _node(db, name, parent=n["shop"], shape=shape)
    n["billing"].openapi_spec = "openapi: billing"
    n["doc"] = _doc(db, n["shop"], name="Старт заказа")
    _param(db, n["shop"], "LOG_LEVEL")
    _param(db, n["shop"], "FEATURE_X")
    db.commit()
    return n


def test_превью_переноса_у_системы_получатели_по_элементу(db):
    n = _shop_with_stores(db)
    p = _transfer_preview(db, n["shop"])
    assert (p.name, p.element_effective, p.has_spec, p.params) == ("shop", "system", True, 2)
    assert [(d.doc_id, d.name, d.kind) for d in p.docs] == [(n["doc"].id, "Старт заказа", "operation")]
    # Обход в глубину, дети по имени; путь — от узла.
    rows = [(r.path, r.element_effective, r.takes_docs, r.takes_process_facts, r.has_spec) for r in p.receivers]
    assert rows == [
        ("Kafka", "container", False, False, False),             # брокер — ничего
        ("billing", "container", True, True, True),              # лист вне контейнера — всё
        ("inner", "system", False, False, False),                # система — ничего
        ("inner / ledger", "container", True, True, False),      # лист вложенной системы
        ("orders", "container", False, True, False),             # контейнер с компонентами
        ("orders / api", "component", True, False, False),
        ("orders / jobs", "component", True, False, False),      # составной компонент
        ("orders / jobs / nightly", "component", True, False, False),
        ("orders-db", "container", False, False, False),         # база — ничего
        ("Покупатель", None, False, False, False),               # «Пользователь» — ничего
    ]


def test_флаги_превью_совпадают_с_отказами_переноса(db):
    """Одно правило на двоих: кто по превью не берёт схемы (спецификацию), тому перенос
    отказывает 422; кто берёт — проходит проверку получателя."""
    n = _shop_with_stores(db)
    p = _transfer_preview(db, n["shop"])
    check = facts_transfer._Transfer(db, ensure_project(db), n["shop"])
    for r in p.receivers:
        assignment = DistributeDocsIn(doc_assignments=[
            DistributeDocAssignment(doc_id=n["doc"].id, child_id=r.node_id),
        ])
        if r.takes_docs:
            assert check.docs(assignment)[0][1] == r.node_id
        else:
            assert _refusal(lambda a=assignment: _distribute(db, n["shop"], **a.model_dump()))[0] == 422
        if not r.takes_process_facts:
            assert _refusal(lambda r=r: _distribute(db, n["shop"], spec_child_id=r.node_id))[0] == 422
            assert _refusal(lambda r=r: _distribute(db, n["shop"], params_target_id=r.node_id))[0] == 422


def test_превью_переноса_у_контейнера_с_компонентами(db):
    n = _shop(db)
    _doc(db, n["orders"], name="Старт заказа")
    db.commit()
    p = _transfer_preview(db, n["orders"])
    assert (p.element_effective, p.has_spec, p.params, [d.name for d in p.docs]) == (
        "container", False, 0, ["Старт заказа"],
    )
    assert [(r.path, r.takes_docs, r.takes_process_facts) for r in p.receivers] == [
        ("api", True, False), ("jobs", True, False), ("jobs / nightly", True, False),
    ]


def test_превью_переноса_у_листа_422(db):
    leaf = _node(db, "billing", openapi_spec="openapi: billing")
    db.commit()
    assert _refusal(lambda: _transfer_preview(db, leaf)) == (
        422, "Внутри «billing» нет объектов, поэтому переносить документацию некуда.",
    )


# ── «Собрать с компонентов» (Р19) ──────────────────────────────────────────

def _collect_preview(db, node):
    return collect_preview(node.id, db=db, project=ensure_project(db), _=ensure_architect(db))


def _collect(db, node, **kw):
    return collect(
        node.id, CollectFactsIn(**kw), db=db, project=ensure_project(db), user=ensure_architect(db),
    )


def _orders(db):
    orders = _node(db, "orders", element="container")
    api = _node(db, "api", parent=orders, openapi_spec="openapi: api")
    checkout = _node(db, "checkout", parent=orders, openapi_spec="openapi: checkout")
    scheduler = _node(db, "scheduler", parent=orders)
    _node(db, "clean", parent=orders)
    db.flush()
    _param(db, api, "FEATURE_NEW_CHECKOUT", "включает новый расчёт корзины")
    _param(db, api, "API_PORT")
    _param(db, checkout, "FEATURE_NEW_CHECKOUT", "новая корзина")
    _param(db, scheduler, "CRON")
    db.commit()
    return orders, api, checkout, scheduler


def test_превью_сбора(db):
    orders, *_ = _orders(db)
    p = _collect_preview(db, orders)
    assert [(c.name, c.params, c.has_spec) for c in p.components] == [
        ("api", 2, True), ("checkout", 1, True), ("scheduler", 1, False),
    ]
    assert [(c.name, [(x.node_name, x.description) for x in c.candidates]) for c in p.param_clashes] == [
        ("FEATURE_NEW_CHECKOUT", [("api", "включает новый расчёт корзины"), ("checkout", "новая корзина")]),
    ]
    assert [s.name for s in p.specs] == ["api", "checkout"]


def test_сбор_с_коллизией_и_выбором(db):
    orders, api, checkout, scheduler = _orders(db)
    code, text = _refusal(lambda: _collect(db, orders))
    assert (code, text) == (422, (
        "Параметр «FEATURE_NEW_CHECKOUT» есть у нескольких объектов. Выберите, какое описание оставить."
    ))
    code, _ = _refusal(lambda: _collect(db, orders, param_choices=[
        CollectParamChoice(name="FEATURE_NEW_CHECKOUT", node_id=scheduler.id),
    ]))
    assert code == 422
    out = _collect(db, orders, param_choices=[
        CollectParamChoice(name="FEATURE_NEW_CHECKOUT", node_id=checkout.id),
    ])
    assert (out.moved_params, out.spec_moved) == (3, False)
    db.expire_all()
    params = db.query(ConfigParam).order_by(ConfigParam.name).all()
    assert [(p.name, p.node_id, p.description) for p in params] == [
        ("API_PORT", orders.id, None),
        ("CRON", orders.id, None),
        ("FEATURE_NEW_CHECKOUT", orders.id, "новая корзина"),
    ]
    # Спецификации не тронуты (spec_from не передан) — их отметит AL36.
    assert db.get(Node, api.id).openapi_spec == "openapi: api"


def test_сбор_коллизии_с_параметром_контейнера(db):
    orders, api, _checkout, _scheduler = _orders(db)
    _param(db, orders, "CRON", "свой")
    db.commit()
    p = _collect_preview(db, orders)
    assert [c.name for c in p.param_clashes] == ["CRON", "FEATURE_NEW_CHECKOUT"]
    assert [x.node_name for x in p.param_clashes[0].candidates] == ["orders", "scheduler"]
    out = _collect(db, orders, param_choices=[
        CollectParamChoice(name="CRON", node_id=orders.id),
        CollectParamChoice(name="FEATURE_NEW_CHECKOUT", node_id=api.id),
    ])
    assert out.moved_params == 2  # API_PORT и FEATURE_NEW_CHECKOUT; CRON остался свой
    db.expire_all()
    cron = db.query(ConfigParam).filter(ConfigParam.name == "CRON").one()
    assert (cron.node_id, cron.description) == (orders.id, "свой")


def test_сбор_спецификации_с_заменой(db):
    orders, api, checkout, _scheduler = _orders(db)
    db.get(Node, orders.id).openapi_spec = "openapi: own"
    db.commit()
    assert [s.name for s in _collect_preview(db, orders).specs] == ["orders", "api", "checkout"]
    out = _collect(db, orders, spec_from=checkout.id, param_choices=[
        CollectParamChoice(name="FEATURE_NEW_CHECKOUT", node_id=api.id),
    ])
    assert out.spec_moved is True
    db.expire_all()
    assert [db.get(Node, x.id).openapi_spec for x in (orders, api, checkout)] == [
        "openapi: checkout", "openapi: api", None,
    ]
    code, text = _refusal(lambda: _collect(db, orders, spec_from=checkout.id))
    assert (code, text) == (422, "У «checkout» нет спецификации")


def test_собирать_можно_только_контейнеру_с_компонентами(db):
    shop = _node(db, "shop")
    _node(db, "api", parent=shop)
    leaf = _node(db, "billing")
    db.commit()
    for node in (shop, leaf):
        code, text = _refusal(lambda node=node: _collect_preview(db, node))
        assert (code, text) == (422, "Собирать можно только контейнеру с компонентами")
        code, _ = _refusal(lambda node=node: _collect(db, node))
        assert code == 422


def test_ручки_сбора_и_переноса_по_http(db):
    """Пути контракта: /nodes/{id}/facts/collect-preview, /facts/collect,
    /docs/transfer-preview и /docs/distribute с новым полем params_target_id."""
    from conftest import make_project
    from fastapi.testclient import TestClient

    from app.auth import create_access_token
    from app.database import get_db
    from app.main import app

    owner = ensure_architect(db)
    project = make_project(db, "Ярмарка")
    orders = Node(id=uuid.uuid4(), project_id=project.id, name="orders", element="container")
    api = Node(id=uuid.uuid4(), project_id=project.id, name="api", parent_id=orders.id)
    db.add_all([orders, api])
    db.flush()
    _param(db, api, "CRON")
    db.commit()
    orders_id, api_id = orders.id, api.id
    token = create_access_token({"sub": owner.username, "role": owner.role})
    h = {"Authorization": f"Bearer {token}", "X-Project-Id": str(project.id)}
    app.dependency_overrides[get_db] = lambda: db
    try:
        client = TestClient(app)
        r = client.get(f"/api/v1/nodes/{orders_id}/facts/collect-preview", headers=h)
        assert r.status_code == 200, r.text
        assert [c["name"] for c in r.json()["components"]] == ["api"]
        r = client.post(f"/api/v1/nodes/{orders_id}/facts/collect", headers=h, json={})
        assert r.json() == {"moved_params": 1, "spec_moved": False}
        r = client.post(f"/api/v1/nodes/{api_id}/facts/collect", headers=h, json={})
        assert (r.status_code, r.json()) == (422, {"detail": "Собирать можно только контейнеру с компонентами"})
        # Превью переноса — путь до /{doc_id}: «transfer-preview» не принимается за id схемы.
        r = client.get(f"/api/v1/nodes/{orders_id}/docs/transfer-preview", headers=h)
        assert r.status_code == 200, r.text
        assert [(x["path"], x["takes_docs"]) for x in r.json()["receivers"]] == [("api", True)]
        r = client.get(f"/api/v1/nodes/{api_id}/docs/transfer-preview", headers=h)
        assert (r.status_code, r.json()) == (
            422, {"detail": "Внутри «api» нет объектов, поэтому переносить документацию некуда."},
        )
        r = client.post(f"/api/v1/nodes/{orders_id}/docs/distribute", headers=h,
                        json={"params_target_id": str(api_id)})
        assert r.status_code == 422
        assert r.json()["detail"] == "Конфигурация переносится только контейнеру, а «api» — компонент."
    finally:
        app.dependency_overrides.clear()
