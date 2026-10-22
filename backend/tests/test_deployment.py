"""Схема развёртывания (docs/tasks/deployment-view.md): площадки, экземпляры, копия
проекта и откат удаления.

Площадка — где крутится объект (облако, кластер, ВМ, сервер), вложенная в другую
площадку; экземпляр — «объект стоит на площадке». Здесь — то, что держит модель:
копия проекта переносит площадки с вложенностью и экземпляры на новые id, снимок
удаления несёт экземпляры, а площадку с вложенными удалить нельзя.
"""

import uuid

import pytest
from conftest import ensure_architect, ensure_project
from fastapi import HTTPException
from sqlalchemy.exc import IntegrityError

from app.models.deployment_instance import DeploymentInstance
from app.models.deployment_site import DeploymentSite
from app.models.node import Node
from app.models.project import Project
from app.models.view_layout import ViewLayoutItem
from app.restore import build_deletion_snapshot
from app.routers.nodes import delete_node, restore_nodes
from app.routers.projects import create_project
from app.schemas.project import ProjectCreate
from app.schemas.restore import DeploymentInstanceSnapshot


def _node(db, project_id, name, parent=None, **kw) -> Node:
    n = Node(
        id=uuid.uuid4(),
        project_id=project_id,
        name=name,
        parent_id=parent.id if parent else None,
        **kw,
    )
    db.add(n)
    db.flush()
    return n


def _site(db, project_id, name, parent=None, **kw) -> DeploymentSite:
    s = DeploymentSite(
        id=uuid.uuid4(),
        project_id=project_id,
        name=name,
        parent_id=parent.id if parent else None,
        **kw,
    )
    db.add(s)
    db.flush()
    return s


def _place(db, node, site) -> DeploymentInstance:
    inst = DeploymentInstance(
        id=uuid.uuid4(), project_id=node.project_id, node_id=node.id, site_id=site.id
    )
    db.add(inst)
    db.flush()
    return inst


# ── Модель ───────────────────────────────────────────────────────────────────


def test_площадку_с_вложенными_удалить_нельзя_а_проект_целиком_можно(db):
    """FK родителя без каскада: вложенные не повисают. Но удаление ПРОЕКТА сносит его
    площадки одним каскадом — родитель вместе с вложенными (NO ACTION проверяется в
    конце оператора; RESTRICT в SQLite ронял бы это удаление)."""
    p = ensure_project(db)
    cloud = _site(db, p.id, "Облако")
    cluster = _site(db, p.id, "Кластер", cloud)
    _site(db, p.id, "Узел кластера", cluster)
    db.commit()

    db.delete(cloud)
    with pytest.raises(IntegrityError):
        db.commit()
    db.rollback()

    db.delete(db.get(Project, p.id))
    db.commit()
    assert db.query(DeploymentSite).count() == 0


# ── Копия проекта ────────────────────────────────────────────────────────────


def test_копия_проекта_переносит_площадки_с_вложенностью_и_экземпляры(db):
    user = ensure_architect(db)
    src = create_project(ProjectCreate(name="Источник"), db=db, user=user)
    shop = _node(db, src.id, "Витрина")
    api = _node(db, src.id, "API", shop)
    cloud = _site(db, src.id, "Облако", kind="cloud", technology="Yandex Cloud")
    cluster = _site(db, src.id, "Кластер", cloud, kind="kubernetes", description="прод")
    _place(db, shop, cluster)
    _place(db, api, cloud)
    db.add_all(
        [
            ViewLayoutItem(
                project_id=src.id, view_id=None, item_id=f"deploy:{api.id}@{cloud.id}",
                payload={"x": 1, "y": 2},
            ),
            ViewLayoutItem(
                project_id=src.id, view_id=None, item_id=f"deploy:site:{cluster.id}",
                payload={"x": 3, "y": 4},
            ),
        ]
    )
    db.commit()

    copy = create_project(ProjectCreate(name="Копия", start=f"copy:{src.id}"), db=db, user=user)

    sites = {s.name: s for s in db.query(DeploymentSite).filter(DeploymentSite.project_id == copy.id)}
    assert set(sites) == {"Облако", "Кластер"}
    assert {s.id for s in sites.values()}.isdisjoint({cloud.id, cluster.id})
    assert sites["Кластер"].parent_id == sites["Облако"].id
    assert (sites["Облако"].kind, sites["Облако"].technology) == ("cloud", "Yandex Cloud")
    assert (sites["Кластер"].kind, sites["Кластер"].description) == ("kubernetes", "прод")

    nodes = {n.name: n for n in db.query(Node).filter(Node.project_id == copy.id)}
    pairs = {
        (i.node_id, i.site_id)
        for i in db.query(DeploymentInstance).filter(DeploymentInstance.project_id == copy.id)
    }
    assert pairs == {
        (nodes["Витрина"].id, sites["Кластер"].id),
        (nodes["API"].id, sites["Облако"].id),
    }
    keys = {
        r.item_id
        for r in db.query(ViewLayoutItem).filter(ViewLayoutItem.project_id == copy.id)
    }
    assert keys == {
        f"deploy:{nodes['API'].id}@{sites['Облако'].id}",
        f"deploy:site:{sites['Кластер'].id}",
    }
    # Источник не тронут.
    assert db.query(DeploymentInstance).filter(DeploymentInstance.project_id == src.id).count() == 2


# ── Снимок удаления и откат ──────────────────────────────────────────────────


def test_снимок_удаления_несёт_экземпляры_и_откат_их_возвращает(db):
    p = ensure_project(db)
    user = ensure_architect(db)
    shop = _node(db, p.id, "Витрина")
    api = _node(db, p.id, "API", shop)
    other = _node(db, p.id, "Платежи")
    cloud = _site(db, p.id, "Облако")
    cluster = _site(db, p.id, "Кластер", cloud)
    own = _place(db, api, cluster)
    _place(db, api, cloud)
    _place(db, other, cloud)  # чужой узел — снимок его не несёт
    db.commit()
    # id — заранее: после удаления ORM-объекты каскада отвязаны от сессии.
    shop_id, api_id, own_id = shop.id, api.id, own.id

    snap = build_deletion_snapshot(db, shop_id)
    assert {(i.node_id, i.site_id) for i in snap.instances} == {
        (api_id, cluster.id),
        (api_id, cloud.id),
    }
    delete_node(shop_id, db=db, project=p, user=user)
    assert db.query(DeploymentInstance).count() == 1  # ушли каскадом, остался чужой

    restore_nodes(snap, db=db, project=p, user=user)
    restored = db.query(DeploymentInstance).filter(DeploymentInstance.node_id == api_id).all()
    assert {i.site_id for i in restored} == {cluster.id, cloud.id}
    assert own_id in {i.id for i in restored}  # тот же id — тот же экземпляр


def test_откат_без_удалённой_площадки_молча_без_её_экземпляра(db):
    p = ensure_project(db)
    user = ensure_architect(db)
    api = _node(db, p.id, "API")
    cloud = _site(db, p.id, "Облако")
    vm = _site(db, p.id, "ВМ")
    _place(db, api, cloud)
    _place(db, api, vm)
    db.commit()
    api_id, vm_id, cloud_id = api.id, vm.id, cloud.id

    snap = build_deletion_snapshot(db, api_id)
    delete_node(api_id, db=db, project=p, user=user)
    db.delete(db.get(DeploymentSite, vm_id))  # площадку удалили после объекта
    db.commit()

    restore_nodes(snap, db=db, project=p, user=user)
    assert db.get(Node, api_id) is not None
    assert [i.site_id for i in db.query(DeploymentInstance).all()] == [cloud_id]


def test_откат_с_площадкой_чужого_проекта_отказ(db):
    p = ensure_project(db)
    user = ensure_architect(db)
    api = _node(db, p.id, "API")
    stranger = Project(id=uuid.uuid4(), name="Чужой")
    db.add(stranger)
    db.flush()
    foreign_site = _site(db, stranger.id, "Чужое облако")
    db.commit()
    snap = build_deletion_snapshot(db, api.id)
    api_id = api.id
    delete_node(api_id, db=db, project=p, user=user)
    snap.instances.append(
        DeploymentInstanceSnapshot(id=uuid.uuid4(), node_id=api_id, site_id=foreign_site.id)
    )
    with pytest.raises(HTTPException) as refused:
        restore_nodes(snap, db=db, project=p, user=user)
    assert refused.value.status_code == 422
    assert db.get(Node, api_id) is None
    assert db.query(DeploymentInstance).count() == 0
