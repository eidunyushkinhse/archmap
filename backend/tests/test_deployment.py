"""Схема развёртывания (docs/tasks/deployment-view.md): площадки, экземпляры,
действующее размещение, роутер /deployment, копия проекта и откат удаления.

Площадка — где крутится объект (облако, кластер, ВМ, сервер), вложенная в другую
площадку; экземпляр — «объект стоит на площадке». Экземпляры — только у объектов
(листьев): контейнер размещается целиком, его размещение выводится из объектов.
Сторожим модель (вложенность, копия, снимок удаления), домен (объекты контейнера,
правило импорта, вывод размещения, цикл в данных), ручки (права, CAS, отказы,
курсоры), граф вида и раздельные ключи раскладки двух холстов одного уровня.
"""

import uuid

import pytest
from conftest import ensure_architect, ensure_project, make_project
from fastapi import HTTPException
from fastapi.testclient import TestClient
from sqlalchemy.exc import IntegrityError

from app import demo, demo_limits
from app.auth import create_access_token
from app.config import settings
from app.database import get_db
from app.demo_limits import DEMO_LIMIT_CODE, Excess, excess_out
from app.deployment import SitePlace, leaf_placements, placeable_leaves, placement_map
from app.main import app
from app.models.deployment_instance import DeploymentInstance
from app.models.deployment_site import DeploymentSite
from app.models.edge import Edge
from app.models.node import Node
from app.models.project import Project
from app.models.project_member import ProjectMember
from app.models.user import User
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


# ── Размещение (домен) ───────────────────────────────────────────────────────


def _ids(n: int) -> list[uuid.UUID]:
    return [uuid.uuid4() for _ in range(n)]


def _shapes(parent_of: dict, persons: tuple = ()) -> dict:
    return {nid: ("person" if nid in persons else "service") for nid in parent_of}


def test_объекты_узла_лист_сам_а_контейнер_листья_без_пользователей():
    root, mid, leaf, deep, person = _ids(5)
    parent_of = {root: None, mid: root, leaf: mid, deep: root, person: root}
    shapes = _shapes(parent_of, (person,))
    assert placeable_leaves(parent_of, shapes, leaf) == [leaf]
    assert placeable_leaves(parent_of, shapes, root) == [leaf, deep]
    assert placeable_leaves(parent_of, shapes, person) == []
    # контейнер из одних «Пользователей» — объектов нет
    only = {root: None, person: root}
    assert placeable_leaves(only, _shapes(only, (person,)), root) == []


def test_правило_импорта_объявление_контейнера_достаётся_объектам_без_своего():
    root, mid, leaf, deep, other, person, s_root, s_mid, s_other = _ids(9)
    parent_of = {root: None, mid: root, leaf: mid, deep: leaf, other: root, person: root}
    got = leaf_placements(
        parent_of, _shapes(parent_of, (person,)),
        {root: [s_root], mid: [s_mid], other: [s_other, s_other]},
    )
    # deep — единственный объект под mid: ближайшее объявление — mid, а не root; повтор
    # площадки схлопнут; контейнеры и «Пользователь» в ответе не появляются.
    assert got == {deep: [s_mid], other: [s_other]}


def test_правило_импорта_цикл_родителей_не_вешает():
    a, b, c, site = _ids(4)
    # a ↔ b — цикл без объявлений; c под a со своим объявлением.
    got = leaf_placements({a: b, b: a, c: a}, {a: "service", b: "service", c: "service"}, {c: [site]})
    assert got == {c: [site]}


def test_размещение_контейнера_выводится_из_объектов():
    root, sub, a, b, c, person, s1, s2 = _ids(8)
    parent_of = {root: None, sub: root, a: sub, b: sub, c: root, person: root}
    shapes = _shapes(parent_of, (person,))
    rank = {s1: 0, s2: 1}
    # у root — экземпляр прежней модели: не в счёт, размещение контейнера — объекты
    got = placement_map(parent_of, shapes, {a: [s2, s1], b: [s1], c: [s1], root: [s2]}, rank)
    assert got[a] == [SitePlace(s1), SitePlace(s2)]
    assert got[sub] == [SitePlace(s1), SitePlace(s2, partial=True)]
    assert got[root] == [SitePlace(s1), SitePlace(s2, partial=True)]
    assert got[person] == []
    # объект без размещения внутри — площадка у контейнера частичная
    got = placement_map(parent_of, shapes, {a: [s1]}, rank)
    assert got[sub] == [SitePlace(s1, partial=True)] and got[b] == []
    # контейнер без объектов — пусто
    only = {root: None, person: root}
    assert placement_map(only, _shapes(only, (person,)), {}, rank)[root] == []


# ── Ручки (HTTP) ─────────────────────────────────────────────────────────────

API = "/api/v1"


@pytest.fixture()
def client(db):
    def _db():
        try:
            yield db
        except Exception:
            # Сессию делят все запросы теста: откатываем её, как прод закрывает свою.
            db.rollback()
            raise

    app.dependency_overrides[get_db] = _db
    try:
        yield TestClient(app)
    finally:
        app.dependency_overrides.clear()


def _h(user: User, project: Project) -> dict[str, str]:
    token = create_access_token({"sub": user.username, "role": user.role})
    return {"Authorization": f"Bearer {token}", "X-Project-Id": str(project.id)}


@pytest.fixture()
def scene(db) -> dict:
    """Проект «Ярмарка»: контейнер «Витрина» (API, воркер, БД), отдельный сервис
    «Платежи», «Покупатель» на верхнем уровне и читатель проекта. Связи: API → БД
    (обе внутри витрины), Покупатель → API (пользователь на холсте не показан),
    Витрина → Платежи (конец — контейнер, не лист)."""
    owner = ensure_architect(db)
    reader = User(id=uuid.uuid4(), username="reader", hashed_password="x", role="architect")
    db.add(reader)
    p = make_project(db, "Ярмарка", owner=owner)
    db.add(ProjectMember(project_id=p.id, user_id=reader.id, role="reader"))
    shop = _node(db, p.id, "Витрина")
    api = _node(db, p.id, "API", shop)
    worker = _node(db, p.id, "Воркер", shop)
    store = _node(db, p.id, "БД", shop, shape="database")
    pay = _node(db, p.id, "Платежи")
    buyer = _node(db, p.id, "Покупатель", shape="person")
    db.add_all(
        [
            Edge(id=uuid.uuid4(), project_id=p.id, source_id=api.id, target_id=store.id),
            Edge(id=uuid.uuid4(), project_id=p.id, source_id=buyer.id, target_id=api.id),
            Edge(id=uuid.uuid4(), project_id=p.id, source_id=shop.id, target_id=pay.id),
        ]
    )
    db.commit()
    return {
        "p": p,
        "h": _h(owner, p),
        "rh": _h(reader, p),
        "n": {n.name: n.id for n in (shop, api, worker, store, pay, buyer)},
    }


def _post_site(client, h, name, **kw) -> dict:
    r = client.post(f"{API}/deployment/sites", json={"name": name, **kw}, headers=h)
    assert r.status_code == 201, r.text
    return r.json()


def test_площадки_создание_список_правка_и_права(client, db, scene):
    h = scene["h"]
    cloud = _post_site(client, h, "Облако", kind="cloud", technology="Yandex Cloud")
    cluster = _post_site(client, h, "Кластер", kind="kubernetes", parent_id=cloud["id"])
    assert (cluster["parent_id"], cluster["version"], cluster["instance_count"]) == (
        cloud["id"], 1, 0,
    )
    listed = client.get(f"{API}/deployment/sites", headers=scene["rh"]).json()
    assert [s["name"] for s in listed] == ["Кластер", "Облако"]

    # Читатель видит, но не правит.
    assert client.post(f"{API}/deployment/sites", json={"name": "X"}, headers=scene["rh"]).status_code == 403

    # Имя уникально в проекте — и при создании, и при правке.
    r = client.post(f"{API}/deployment/sites", json={"name": "Облако"}, headers=h)
    assert (r.status_code, r.json()) == (409, {"detail": "Площадка с таким именем уже есть"})
    r = client.patch(f"{API}/deployment/sites/{cluster['id']}", json={"name": "Облако"}, headers=h)
    assert r.status_code == 409

    r = client.patch(
        f"{API}/deployment/sites/{cluster['id']}",
        json={"technology": "k3s", "base_version": 1},
        headers=h,
    )
    assert (r.status_code, r.json()["technology"], r.json()["version"]) == (200, "k3s", 2)
    # CAS: правка от устаревшей версии — 409.
    r = client.patch(
        f"{API}/deployment/sites/{cluster['id']}", json={"description": "x", "base_version": 1}, headers=h
    )
    assert (r.status_code, r.json()) == (409, {"detail": "Площадка изменена в другой сессии"})
    # Вынести в корень — parent_id: null.
    r = client.patch(f"{API}/deployment/sites/{cluster['id']}", json={"parent_id": None}, headers=h)
    assert r.json()["parent_id"] is None


def test_площадки_вложенность_цикл_и_чужой_родитель(client, db, scene):
    h = scene["h"]
    cloud = _post_site(client, h, "Облако")
    cluster = _post_site(client, h, "Кластер", parent_id=cloud["id"])
    node = _post_site(client, h, "Узел", parent_id=cluster["id"])
    url = f"{API}/deployment/sites/{cloud['id']}"

    r = client.patch(url, json={"parent_id": node["id"]}, headers=h)
    assert (r.status_code, r.json()) == (400, {"detail": "Площадку нельзя вложить в её же вложенную площадку"})
    r = client.patch(url, json={"parent_id": cloud["id"]}, headers=h)
    assert (r.status_code, r.json()) == (400, {"detail": "Площадку нельзя вложить в саму себя"})

    stranger = make_project(db, "Чужой")
    foreign = _site(db, stranger.id, "Чужое облако")
    db.commit()
    r = client.post(f"{API}/deployment/sites", json={"name": "Y", "parent_id": str(foreign.id)}, headers=h)
    assert (r.status_code, r.json()) == (404, {"detail": "Родительская площадка не найдена"})
    r = client.patch(url, json={"parent_id": str(foreign.id)}, headers=h)
    assert r.status_code == 404
    # Чужую площадку по прямому id не видно.
    assert client.patch(f"{API}/deployment/sites/{foreign.id}", json={"name": "Z"}, headers=h).status_code == 404


def test_удаление_площадки_с_вложенными_отказ_а_без_них_снимает_экземпляры(client, db, scene):
    h, n = scene["h"], scene["n"]
    cloud = _post_site(client, h, "Облако")
    cluster = _post_site(client, h, "Кластер", parent_id=cloud["id"])
    r = client.put(
        f"{API}/deployment/placements",
        json={"node_ids": [str(n["API"]), str(n["БД"])], "site_ids": [cluster["id"]]},
        headers=h,
    )
    assert r.status_code == 204
    db.add_all(
        [
            ViewLayoutItem(project_id=scene["p"].id, view_id=None,
                           item_id=f"deploy:{n['API']}@{cluster['id']}", payload={"x": 1, "y": 1}),
            ViewLayoutItem(project_id=scene["p"].id, view_id=None,
                           item_id=f"deploy:site:{cluster['id']}", payload={"x": 2, "y": 2}),
            ViewLayoutItem(project_id=scene["p"].id, view_id=None,
                           item_id=str(n["API"]), payload={"x": 3, "y": 3}),
        ]
    )
    db.commit()
    listed = {s["name"]: s for s in client.get(f"{API}/deployment/sites", headers=h).json()}
    assert listed["Кластер"]["instance_count"] == 2

    r = client.delete(f"{API}/deployment/sites/{cloud['id']}", headers=h)
    assert (r.status_code, r.json()) == (422, {"detail": "Сначала перенесите вложенные площадки"})

    rev = db.get(Project, scene["p"].id).meta_rev
    assert client.delete(f"{API}/deployment/sites/{cluster['id']}", headers=h).status_code == 204
    db.expire_all()
    assert db.query(DeploymentInstance).count() == 0
    # Раскладка развёртывания площадки снята, позиция на холсте объектов — нет.
    assert [r.item_id for r in db.query(ViewLayoutItem)] == [str(n["API"])]
    assert db.get(Project, scene["p"].id).meta_rev == rev + 1


def test_размещение_набором_целиком(client, db, scene):
    h, n = scene["h"], scene["n"]
    a = _post_site(client, h, "A")["id"]
    b = _post_site(client, h, "B")["id"]
    url = f"{API}/deployment/placements"

    def pairs() -> set[tuple[str, str]]:
        db.expire_all()
        return {(str(i.node_id), str(i.site_id)) for i in db.query(DeploymentInstance)}

    api, store = str(n["API"]), str(n["БД"])
    assert client.put(url, json={"node_ids": [api, store], "site_ids": [a, b]}, headers=h).status_code == 204
    assert pairs() == {(api, a), (api, b), (store, a), (store, b)}
    # Набор целиком: у API теперь только B.
    rev = db.get(Project, scene["p"].id)
    graph_rev, meta_rev = rev.graph_rev, rev.meta_rev
    assert client.put(url, json={"node_ids": [api], "site_ids": [b]}, headers=h).status_code == 204
    assert pairs() == {(api, b), (store, a), (store, b)}
    db.expire_all()
    rev = db.get(Project, scene["p"].id)
    assert (rev.graph_rev, rev.meta_rev) == (graph_rev + 1, meta_rev + 1)
    # Тот же набор ещё раз — ничего не изменилось, курсоры стоят.
    assert client.put(url, json={"node_ids": [api], "site_ids": [b]}, headers=h).status_code == 204
    db.expire_all()
    assert db.get(Project, scene["p"].id).graph_rev == graph_rev + 1
    # Пустой набор — снять.
    assert client.put(url, json={"node_ids": [store], "site_ids": []}, headers=h).status_code == 204
    assert pairs() == {(api, b)}


def test_размещение_отказы_ничего_не_пишут(client, db, scene):
    h, n = scene["h"], scene["n"]
    a = _post_site(client, h, "A")["id"]
    url = f"{API}/deployment/placements"
    api, buyer = str(n["API"]), str(n["Покупатель"])

    r = client.put(url, json={"node_ids": [api, buyer], "site_ids": [a]}, headers=h)
    assert (r.status_code, r.json()) == (422, {"detail": "У пользователя нет размещения — он живёт вне системы"})
    stranger = make_project(db, "Чужой")
    foreign_node = _node(db, stranger.id, "Чужой сервис")
    foreign_site = _site(db, stranger.id, "Чужое облако")
    db.commit()
    r = client.put(url, json={"node_ids": [str(foreign_node.id)], "site_ids": [a]}, headers=h)
    assert r.status_code == 404
    r = client.put(url, json={"node_ids": [api], "site_ids": [str(foreign_site.id)]}, headers=h)
    assert (r.status_code, r.json()) == (404, {"detail": "Площадка не найдена"})
    assert client.put(url, json={"node_ids": [api], "site_ids": [a]}, headers=scene["rh"]).status_code == 403
    db.expire_all()
    assert db.query(DeploymentInstance).count() == 0


def test_контейнер_размещается_целиком(client, db, scene):
    """Набор контейнера получает каждый объект внутри (любой глубины), своё размещение
    объектов перезаписывается; у самого контейнера экземпляров нет — его размещение
    выводится из объектов: где стоят все — обычное, где часть — partial."""
    h, n, p = scene["h"], scene["n"], scene["p"]
    a = _post_site(client, h, "A")["id"]
    b = _post_site(client, h, "B")["id"]
    url = f"{API}/deployment/placements"
    # Внук: обработчик внутри API (Витрина → API → Обработчик) — API стал контейнером.
    grand = _node(db, p.id, "Обработчик", db.get(Node, n["API"]))
    db.commit()
    shop, worker, store, gid = str(n["Витрина"]), str(n["Воркер"]), str(n["БД"]), str(grand.id)

    def pairs() -> set[tuple[str, str]]:
        db.expire_all()
        return {(str(i.node_id), str(i.site_id)) for i in db.query(DeploymentInstance)}

    def graph_nodes() -> dict:
        return {x["name"]: x for x in client.get(f"{API}/deployment/graph", headers=h).json()["nodes"]}

    assert client.put(url, json={"node_ids": [gid], "site_ids": [b]}, headers=h).status_code == 204
    assert client.put(url, json={"node_ids": [shop], "site_ids": [a]}, headers=h).status_code == 204
    assert pairs() == {(gid, a), (worker, a), (store, a)}
    nodes = graph_nodes()
    assert (nodes["Витрина"]["instances"], nodes["API"]["instances"], nodes["Обработчик"]["instances"]) == ([a], [a], [a])
    assert nodes["Витрина"]["sites"] == [
        {"id": a, "name": "A", "kind": "other", "parent_id": None, "parent_name": None, "partial": False}
    ]

    # Объект внутри переехал на B — у контейнера обе площадки частичные, целиком он нигде.
    assert client.put(url, json={"node_ids": [worker], "site_ids": [b]}, headers=h).status_code == 204
    nodes = graph_nodes()
    assert nodes["Витрина"]["instances"] == []
    assert [(s["name"], s["partial"]) for s in nodes["Витрина"]["sites"]] == [("A", True), ("B", True)]
    assert nodes["API"]["instances"] == [a]

    # Снова контейнер на A: Воркер возвращается, курсоры сдвинуты; повтор — стоят.
    db.expire_all()
    rev = db.get(Project, p.id)
    graph_rev, meta_rev = rev.graph_rev, rev.meta_rev
    assert client.put(url, json={"node_ids": [shop], "site_ids": [a]}, headers=h).status_code == 204
    assert pairs() == {(gid, a), (worker, a), (store, a)}
    db.expire_all()
    rev = db.get(Project, p.id)
    assert (rev.graph_rev, rev.meta_rev) == (graph_rev + 1, meta_rev + 1)
    assert client.put(url, json={"node_ids": [shop], "site_ids": [a]}, headers=h).status_code == 204
    db.expire_all()
    assert db.get(Project, p.id).graph_rev == graph_rev + 1

    # Пустой набор контейнеру снимает размещение всех объектов внутри.
    assert client.put(url, json={"node_ids": [shop], "site_ids": []}, headers=h).status_code == 204
    assert pairs() == set()


def test_контейнер_без_объектов_422_и_отказ_ничего_не_пишет(client, db, scene):
    """Отказ размещения (чужой узел — 404, «Пользователь» — 422, контейнер без объектов
    — 422) не трогает размещение объектов внутри: проверки идут до записи."""
    h, n, p = scene["h"], scene["n"], scene["p"]
    a = _post_site(client, h, "A")["id"]
    b = _post_site(client, h, "B")["id"]
    url = f"{API}/deployment/placements"
    shop, api, buyer = str(n["Витрина"]), str(n["API"]), str(n["Покупатель"])
    assert client.put(url, json={"node_ids": [api], "site_ids": [b]}, headers=h).status_code == 204
    stranger = make_project(db, "Чужой")
    foreign = _node(db, stranger.id, "Чужой сервис")
    # Контейнер из одних «Пользователей»: размещать нечего.
    desk = _node(db, p.id, "Поддержка")
    _node(db, p.id, "Оператор", desk, shape="person")
    db.commit()

    r = client.put(url, json={"node_ids": [shop, str(foreign.id)], "site_ids": [a]}, headers=h)
    assert r.status_code == 404
    r = client.put(url, json={"node_ids": [shop, buyer], "site_ids": [a]}, headers=h)
    assert r.status_code == 422
    r = client.put(url, json={"node_ids": [shop, str(desk.id)], "site_ids": [a]}, headers=h)
    assert (r.status_code, r.json()) == (
        422, {"detail": "В «Поддержка» нет объектов, которые можно разместить"}
    )
    db.expire_all()
    assert {(str(i.node_id), str(i.site_id)) for i in db.query(DeploymentInstance)} == {(api, b)}


def test_граф_поддерево_размещение_и_связи(client, db, scene):
    h, n = scene["h"], scene["n"]
    cloud = _post_site(client, h, "Облако", kind="cloud")["id"]
    vm = _post_site(client, h, "ВМ", kind="vm")["id"]
    put = f"{API}/deployment/placements"
    # Витрина — в облаке целиком (каждый объект внутри); API затем переехал на ВМ.
    client.put(put, json={"node_ids": [str(n["Витрина"])], "site_ids": [cloud]}, headers=h)
    client.put(put, json={"node_ids": [str(n["API"])], "site_ids": [vm]}, headers=h)

    g = client.get(f"{API}/deployment/graph", headers=scene["rh"]).json()
    nodes = {x["name"]: x for x in g["nodes"]}
    # Всё поддерево проекта (контейнер «Витрина» тоже) без «Покупателя»; порядок — по имени.
    assert [x["name"] for x in g["nodes"]] == ["API", "БД", "Витрина", "Воркер", "Платежи"]
    assert {s["name"] for s in g["sites"]} == {"Облако", "ВМ"}
    assert nodes["API"]["instances"] == [vm]
    assert (nodes["API"]["has_children"], nodes["API"]["child_count"]) == (False, 0)
    shop = str(n["Витрина"])
    # Контейнер: экземпляров нет, размещение — объекты: целиком нигде, частично на обеих.
    assert nodes["Витрина"]["instances"] == []
    assert [(s["name"], s["partial"]) for s in nodes["Витрина"]["sites"]] == [("ВМ", True), ("Облако", True)]
    assert (nodes["Витрина"]["has_children"], nodes["Витрина"]["child_count"]) == (True, 3)
    assert nodes["Воркер"]["instances"] == [cloud]
    assert nodes["Воркер"]["sites"] == [
        {"id": cloud, "name": "Облако", "kind": "cloud", "parent_id": None, "parent_name": None, "partial": False}
    ]
    assert nodes["Платежи"]["instances"] == []
    # Связи — оба конца в поддереве: API → БД и Витрина → Платежи (конец-контейнер
    # теперь тоже в ответе); Покупатель → API — нет, пользователя на холсте нет.
    assert {(e["source_id"], e["target_id"]) for e in g["edges"]} == {
        (str(n["API"]), str(n["БД"])),
        (shop, str(n["Платежи"])),
    }
    assert (g["graph_rev"], g["meta_rev"]) == (
        db.get(Project, scene["p"].id).graph_rev,
        db.get(Project, scene["p"].id).meta_rev,
    )

    # Уровень «Витрина» — её поддерево без неё самой; связь «Витрина → Платежи» ведёт
    # из объёма уровня наружу — её нет.
    g = client.get(f"{API}/deployment/graph", params={"level": shop}, headers=h).json()
    assert {x["name"] for x in g["nodes"]} == {"API", "Воркер", "БД"}
    assert [(e["source_id"], e["target_id"]) for e in g["edges"]] == [(str(n["API"]), str(n["БД"]))]
    # Чужой или несуществующий уровень — 404.
    assert client.get(f"{API}/deployment/graph", params={"level": str(uuid.uuid4())}, headers=h).status_code == 404


def test_граф_вложенный_контейнер_и_связи_в_объёме_уровня(client, db, scene):
    """Контейнер внутри контейнера: размещение внешнего получают объекты любой глубины,
    у вложенного контейнера оно выводится из них. Связь лист ↔ лист внутри одного
    контейнера приходит, связь с концом вне объёма уровня — нет, «Пользователь» внутри
    уровня не приходит."""
    p, h = scene["p"], scene["h"]
    platform = _node(db, p.id, "Платформа")
    catalog = _node(db, p.id, "Каталог", platform)
    search = _node(db, p.id, "Поиск", catalog)
    index = _node(db, p.id, "Индекс", catalog, shape="database")
    _node(db, p.id, "Оператор", platform, shape="person")
    outside = _node(db, p.id, "Почта")
    db.add_all(
        [
            Edge(id=uuid.uuid4(), project_id=p.id, source_id=search.id, target_id=index.id),
            Edge(id=uuid.uuid4(), project_id=p.id, source_id=search.id, target_id=outside.id),
        ]
    )
    db.commit()
    cloud = _post_site(client, h, "Облако", kind="cloud")["id"]
    client.put(
        f"{API}/deployment/placements",
        json={"node_ids": [str(platform.id)], "site_ids": [cloud]},
        headers=h,
    )
    db.expire_all()
    assert {str(i.node_id) for i in db.query(DeploymentInstance)} == {str(search.id), str(index.id)}

    g = client.get(f"{API}/deployment/graph", params={"level": str(platform.id)}, headers=h).json()
    nodes = {x["name"]: x for x in g["nodes"]}
    assert set(nodes) == {"Каталог", "Поиск", "Индекс"}
    assert nodes["Каталог"]["instances"] == [cloud]
    assert [(s["name"], s["partial"]) for s in nodes["Каталог"]["sites"]] == [("Облако", False)]
    assert (nodes["Каталог"]["has_children"], nodes["Каталог"]["child_count"]) == (True, 2)
    assert nodes["Поиск"]["instances"] == [cloud]
    assert [(e["source_id"], e["target_id"]) for e in g["edges"]] == [(str(search.id), str(index.id))]

    # На уровне проекта «Платформа» — сама объект, стоящий целиком в облаке, а её
    # «Пользователь» не приходит, хотя прямым ребёнком учтён.
    g = client.get(f"{API}/deployment/graph", headers=h).json()
    nodes = {x["name"]: x for x in g["nodes"]}
    assert "Оператор" not in nodes
    assert nodes["Платформа"]["instances"] == [cloud]
    assert (nodes["Платформа"]["has_children"], nodes["Платформа"]["child_count"]) == (True, 2)
    assert nodes["Почта"]["instances"] == []


def test_раскладка_двух_холстов_одного_уровня_разведена(client, db, scene):
    h, n = scene["h"], scene["n"]
    site = _post_site(client, h, "Облако")["id"]
    shop = str(n["Витрина"])
    api = str(n["API"])
    deploy_key = f"deploy:{api}@{site}"
    frame_key = f"deploy:site:{site}"
    # Ключи развёртывания пишутся тем же батчем раскладки вида.
    r = client.put(
        f"{API}/views/{shop}/layout",
        json={"items": {deploy_key: {"x": 10, "y": 20}, frame_key: {"x": 0, "y": 0}, api: {"x": 5, "y": 5}}},
        headers=h,
    )
    assert r.status_code == 200, r.text

    deploy = client.get(f"{API}/deployment/graph", params={"level": shop}, headers=h).json()
    assert set(deploy["layout"]) == {deploy_key, frame_key}
    assert deploy["version"] == r.json()["version"]
    level = client.get(f"{API}/nodes/{shop}/graph", headers=h).json()
    assert set(level["layout"]) == {api}

    # «Переразложить уровень» на холсте объектов не сбрасывает раскладку развёртывания.
    assert client.post(f"{API}/nodes/{shop}/relayout", headers=h).status_code == 204
    db.expire_all()
    assert {r.item_id for r in db.query(ViewLayoutItem)} == {deploy_key, frame_key}


def test_узел_несёт_размещение_и_правится_site_ids(client, db, scene):
    h, n = scene["h"], scene["n"]
    cloud = _post_site(client, h, "Облако", kind="cloud")
    cluster = _post_site(client, h, "Кластер", kind="kubernetes", parent_id=cloud["id"])
    shop, api = str(n["Витрина"]), str(n["API"])

    # Контейнер: набор получает каждый объект внутри; у контейнера — где стоят все.
    r = client.patch(f"{API}/nodes/{shop}", json={"site_ids": [cluster["id"]]}, headers=h)
    assert r.status_code == 200, r.text
    ref = {"id": cluster["id"], "name": "Кластер", "kind": "kubernetes", "parent_id": cloud["id"],
           "parent_name": "Облако", "partial": False}
    assert r.json()["sites"] == [ref]
    got = client.get(f"{API}/nodes/{api}", headers=scene["rh"]).json()
    assert got["sites"] == [ref]
    children = client.get(f"{API}/nodes/{shop}/children", headers=h).json()
    assert all(c["sites"] == [ref] for c in children)
    # Граф уровня размещение не заполняет.
    assert all(x["sites"] == [] for x in client.get(f"{API}/nodes/{shop}/graph", headers=h).json()["nodes"])

    # Объект переехал: у него своя площадка, у контейнера обе — частичные; CAS узла
    # не двигается, курсоры — двигаются.
    version = got["version"]
    project = db.get(Project, scene["p"].id)
    graph_rev, meta_rev = project.graph_rev, project.meta_rev
    r = client.patch(f"{API}/nodes/{api}", json={"site_ids": [cloud["id"]], "base_version": version}, headers=h)
    assert r.json()["version"] == version
    assert [s["name"] for s in r.json()["sites"]] == ["Облако"]
    db.expire_all()
    project = db.get(Project, scene["p"].id)
    assert (project.graph_rev, project.meta_rev) == (graph_rev + 1, meta_rev + 1)
    shop_sites = client.get(f"{API}/nodes/{shop}", headers=h).json()["sites"]
    assert [(s["name"], s["partial"]) for s in shop_sites] == [("Кластер", True), ("Облако", True)]
    # [] снимает размещение объекта; без site_ids — не трогаем.
    r = client.patch(f"{API}/nodes/{api}", json={"site_ids": []}, headers=h)
    assert r.json()["sites"] == []
    r = client.patch(f"{API}/nodes/{shop}", json={"description": "витрина"}, headers=h)
    assert [(s["name"], s["partial"]) for s in r.json()["sites"]] == [("Кластер", True)]

    # «Пользователь»: поставить нельзя, и размещения у него нет.
    buyer = str(n["Покупатель"])
    r = client.patch(f"{API}/nodes/{buyer}", json={"site_ids": [cloud["id"]]}, headers=h)
    assert (r.status_code, r.json()) == (422, {"detail": "У пользователя нет размещения — он живёт вне системы"})
    # Объект с размещением пользователем не становится.
    client.patch(f"{API}/nodes/{api}", json={"site_ids": [cloud["id"]]}, headers=h)
    r = client.patch(f"{API}/nodes/{api}", json={"shape": "person"}, headers=h)
    assert r.status_code == 400


def test_длинное_имя_площадки_422_текстом(client, db, scene):
    r = client.post(f"{API}/deployment/sites", json={"name": "x" * 257}, headers=scene["h"])
    assert (r.status_code, r.json()) == (422, {"detail": "Поле «name» длиннее 256 символов"})
    r = client.post(f"{API}/deployment/sites", json={"name": "   "}, headers=scene["h"])
    assert (r.status_code, r.json()) == (422, {"detail": "Имя площадки не может быть пустым"})
    assert db.query(DeploymentSite).count() == 0


def test_предел_демо_площадок(client, db, scene, monkeypatch):
    monkeypatch.setattr(settings, "demo_mode", True)
    demo_limits.install()  # в проде — main.lifespan; TestClient без with его не запускает
    monkeypatch.setattr(demo, "MAX_SITES", 1)
    h = scene["h"]
    first = _post_site(client, h, "Облако")
    r = client.post(f"{API}/deployment/sites", json={"name": "ВМ"}, headers=h)
    assert r.status_code == 409
    assert r.json()["code"] == DEMO_LIMIT_CODE
    assert r.json()["detail"] == (
        "Демо-проект поддерживает до 1 площадок. Удалите ненужные, чтобы добавить новые."
    )
    db.expire_all()
    assert db.query(DeploymentSite).count() == 1
    # Сверх предела удаление проходит.
    monkeypatch.setattr(demo, "MAX_SITES", 0)
    assert client.delete(f"{API}/deployment/sites/{first['id']}", headers=h).status_code == 204
    # Ввоз создаёт площадки (раздел deployment, Ф4) — вид входит в контракт превью.
    out = excess_out(Excess("sites", 2, 1))
    assert out is not None and out.model_dump() == {"kind": "sites", "actual": 2, "limit": 1}


# ── Ключи раскладки развёртывания при удалении узла ──────────────────────────


def test_удаление_узла_снимает_ключи_развёртывания_поддерева_и_откат_их_возвращает(db):
    """Карточки холста «Развёртывание» живут в view_layout ключами «deploy:<узел>@…».
    Удаление контейнера снимает ключи его самого и всех потомков (общая чистка по
    вхождению uuid, transition.cleanup_layout), ключи площадки и чужих узлов не трогает;
    Undo удаления возвращает их тем же снимком."""
    p = ensure_project(db)
    user = ensure_architect(db)
    витрина = _node(db, p.id, "Витрина")
    api = _node(db, p.id, "API", витрина)
    платежи = _node(db, p.id, "Платежи")
    облако = _site(db, p.id, "Облако")
    _place(db, витрина, облако)
    _place(db, платежи, облако)
    свои = {
        f"deploy:{витрина.id}@{облако.id}",
        f"deploy:{api.id}@{облако.id}",
        f"deploy:{api.id}@unplaced",
    }
    чужие = {f"deploy:site:{облако.id}", f"deploy:{платежи.id}@{облако.id}"}
    for key in sorted(свои | чужие):
        db.add(ViewLayoutItem(project_id=p.id, view_id=None, item_id=key, payload={"x": 1, "y": 2}))
    db.commit()
    витрина_id = витрина.id

    snap = build_deletion_snapshot(db, витрина_id)
    delete_node(витрина_id, db=db, project=p, user=user)

    def ключи() -> set[str]:
        return {i.item_id for i in db.query(ViewLayoutItem).filter(ViewLayoutItem.project_id == p.id)}

    assert ключи() == чужие
    restore_nodes(snap, db=db, project=p, user=user)
    assert ключи() == свои | чужие
