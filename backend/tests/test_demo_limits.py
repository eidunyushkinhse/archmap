"""Сторож центральной проверки пределов демо-стенда (docs/tasks/demo-mode.md, шаг 2).

Проверка висит на сессии SQLAlchemy (app/demo_limits.py), а не на ручках, поэтому
сторож прогоняет ПИШУЩИЕ ручки всех семей сверх предела и ждёт 409 с признаком
demo_limit, а проект — нетронутым. Пределы подменены маленькими: сцена стоит ровно
на них (4 объекта, 2 связи, 2 схемы логики, 1 процесс), любая добавка их превышает.

Семьи: объекты (создание, восстановление), связи, схемы логики (создание, правка,
дозаливка доков, разведка), факты (параметры, таблицы, колонки, каналы, поля,
ввоз данных, каналов, конфигурации), процессы (создание, дубль, импорт), описания
(узла, проекта), импорт нового проекта, догрузка архива, синк, копия проекта.
Плюс превью с превышением, размер файла и «удаление и уменьшение проходят всегда».
"""

import uuid

import pytest
from conftest import ensure_architect, seed_project_from_yaml
from fastapi.testclient import TestClient

from app import demo
from app.archive_export import build_archive
from app.auth import create_access_token
from app.config import settings
from app.database import get_db
from app.demo_limits import (
    DEMO_LIMIT_CODE,
    Excess,
    ProjectSize,
    file_too_large_detail,
    find_excess,
    measure,
)
from app.main import app
from app.models.business_process import BusinessProcess
from app.models.edge import Edge
from app.models.node import Node
from app.models.node_doc import NodeDoc
from app.models.project import Project

API = "/api/v1"

SCENE = """
nodes:
  - name: Ярмарка
    children:
      - name: orders
      - name: orders-db
        shape: database
      - name: bus
        shape: broker
edges:
  - {from: orders, to: orders-db}
  - {from: orders, to: bus}
"""

# Тот же прогон с двумя новыми сервисами: синк и ввоз дадут 6 объектов при пределе 4.
GROWN = """
nodes:
  - name: Ярмарка
    children:
      - name: orders
      - name: orders-db
        shape: database
      - name: bus
        shape: broker
      - name: billing
      - name: search
edges:
  - {from: orders, to: orders-db}
  - {from: orders, to: bus}
"""

DIAGRAM = """sequenceDiagram
    participant P1 as Покупатель
    participant P2 as orders
    P1->>P2: создать заказ
"""

# 4000 байт UTF-8 при пределе текста 3000.
BIG = "я" * 2000


@pytest.fixture()
def client(db):
    def _db():
        try:
            yield db
        except Exception:
            # Сессию тестов делят все запросы: откатываем её, как прод закрывает свою.
            db.rollback()
            raise

    app.dependency_overrides[get_db] = _db
    try:
        yield TestClient(app)
    finally:
        app.dependency_overrides.clear()


@pytest.fixture()
def scene(db) -> dict:
    """Проект ровно на пределах: 4 объекта, 2 связи, 2 схемы логики, 1 процесс."""
    p = seed_project_from_yaml(db, [SCENE], name="Сцена")
    by_name = {n.name: n for n in db.query(Node).filter(Node.project_id == p.id)}
    orders = by_name["orders"]
    docs = [
        NodeDoc(node_id=orders.id, name=f"GET /{x}", content="graph TD\n  A --> B\n")
        for x in ("a", "b")
    ]
    db.add_all(docs)
    proc = BusinessProcess(project_id=p.id, name="Оплата")
    db.add(proc)
    db.commit()
    owner = ensure_architect(db)
    token = create_access_token({"sub": owner.username, "role": owner.role})
    return {
        "p": p,
        "pid": str(p.id),
        "n": {k: str(v.id) for k, v in by_name.items()},
        "doc": str(docs[0].id),
        "proc": str(proc.id),
        "h": {"Authorization": f"Bearer {token}", "X-Project-Id": str(p.id)},
    }


@pytest.fixture()
def small(scene, monkeypatch):
    """Демо-режим с маленькими пределами (сцена уже стоит на них)."""
    monkeypatch.setattr(settings, "demo_mode", True)
    monkeypatch.setattr(demo, "MAX_NODES", 4)
    monkeypatch.setattr(demo, "MAX_EDGES", 2)
    monkeypatch.setattr(demo, "MAX_DOCS", 2)
    monkeypatch.setattr(demo, "MAX_PROCESSES", 1)
    monkeypatch.setattr(demo, "MAX_TEXT_BYTES", 3000)
    monkeypatch.setattr(demo, "MAX_FILE_BYTES", 2000)
    return scene


DETAIL = {
    "nodes": "Демо-проект поддерживает до 4 объектов. Удалите ненужные, чтобы добавить новые.",
    "edges": "Демо-проект поддерживает до 2 связей. Удалите ненужные, чтобы добавить новые.",
    "docs": "Демо-проект поддерживает до 2 схем логики. Удалите ненужные, чтобы добавить новые.",
    "processes": "Демо-проект поддерживает до 1 процессов. Удалите ненужные, чтобы добавить новые.",
    "text": "Текста в проекте стало больше 2 КБ, это предел демо. "
    "Сократите схему или удалите ненужные.",
}


def _size(db, scene) -> ProjectSize:
    db.expire_all()
    return measure(db, scene["p"].id)


def _refused(res, kind: str) -> None:
    assert res.status_code == 409, res.text
    body = res.json()
    assert body["code"] == DEMO_LIMIT_CODE
    assert body["detail"] == DETAIL[kind]


# ── Чистая логика превышения ────────────────────────────────────────────────


def test_превышение_только_когда_итог_за_пределом_и_вырос(monkeypatch):
    monkeypatch.setattr(demo, "MAX_NODES", 4)
    assert find_excess(ProjectSize(nodes=4)) is None
    assert find_excess(ProjectSize(nodes=5)) == Excess("nodes", 5, 4)
    # Уже был сверх предела и не вырос — уменьшение и правка проходят.
    assert find_excess(ProjectSize(nodes=5), ProjectSize(nodes=6)) is None
    assert find_excess(ProjectSize(nodes=6), ProjectSize(nodes=6)) is None
    assert find_excess(ProjectSize(nodes=7), ProjectSize(nodes=6)) == Excess("nodes", 7, 4)


def test_размер_сцены_меряется(db, scene):
    size = _size(db, scene)
    assert (size.nodes, size.edges, size.docs, size.processes) == (4, 2, 2, 1)
    assert 0 < size.text_bytes < 3000


# ── Ручная правка: каждая семья сверх предела → 409, проект цел ─────────────


def test_объект(client, db, small):
    before = _size(db, small)
    _refused(client.post(f"{API}/nodes", json={"name": "search"}, headers=small["h"]), "nodes")
    assert _size(db, small) == before


def test_восстановление_объекта(client, db, small):
    h, bus = small["h"], small["n"]["bus"]
    snap = client.get(f"{API}/nodes/{bus}/deletion-snapshot", headers=h).json()
    assert client.delete(f"{API}/nodes/{bus}", headers=h).status_code == 204
    assert client.post(f"{API}/nodes", json={"name": "search"}, headers=h).status_code == 201
    _refused(client.post(f"{API}/nodes/restore", json=snap, headers=h), "nodes")
    assert _size(db, small).nodes == 4


def test_связь(client, db, small):
    n = small["n"]
    body = {"source_id": n["orders-db"], "target_id": n["bus"]}
    _refused(client.post(f"{API}/edges", json=body, headers=small["h"]), "edges")
    assert _size(db, small).edges == 2


def test_схема_логики_числом(client, db, small):
    orders = small["n"]["orders"]
    res = client.post(f"{API}/nodes/{orders}/docs", json={"name": "GET /c"}, headers=small["h"])
    _refused(res, "docs")
    assert _size(db, small).docs == 2


def test_схема_логики_объёмом_правка_не_теряет_старое(client, db, small):
    orders, doc = small["n"]["orders"], small["doc"]
    res = client.patch(
        f"{API}/nodes/{orders}/docs/{doc}", json={"content": BIG}, headers=small["h"]
    )
    _refused(res, "text")
    db.expire_all()
    assert db.get(NodeDoc, uuid.UUID(doc)).content == "graph TD\n  A --> B\n"


def test_описание_узла_и_спека(client, small):
    orders = small["n"]["orders"]
    for field in ("description", "openapi_spec"):
        res = client.patch(f"{API}/nodes/{orders}", json={field: BIG}, headers=small["h"])
        _refused(res, "text")


def test_описание_проекта(client, small):
    res = client.patch(f"{API}/projects/{small['pid']}", json={"description": BIG},
                       headers=small["h"])
    _refused(res, "text")


def test_факты_вручную(client, small):
    h, n = small["h"], small["n"]
    _refused(client.post(f"{API}/nodes/{n['orders']}/config",
                         json={"name": "BIG", "description": BIG}, headers=h), "text")
    _refused(client.post(f"{API}/nodes/{n['orders-db']}/tables",
                         json={"name": "big", "description": BIG}, headers=h), "text")
    table = client.post(f"{API}/nodes/{n['orders-db']}/tables", json={"name": "t"}, headers=h)
    assert table.status_code == 201
    _refused(client.post(f"{API}/nodes/{n['orders-db']}/tables/{table.json()['id']}/columns",
                         json={"name": "c", "description": BIG}, headers=h), "text")
    _refused(client.post(f"{API}/nodes/{n['bus']}/channels",
                         json={"name": "big", "description": BIG}, headers=h), "text")
    channel = client.post(f"{API}/nodes/{n['bus']}/channels", json={"name": "c"}, headers=h)
    assert channel.status_code == 201
    _refused(client.post(f"{API}/nodes/{n['bus']}/channels/{channel.json()['id']}/fields",
                         json={"name": "f", "description": BIG}, headers=h), "text")


def test_процессы(client, db, small):
    h = small["h"]
    _refused(client.post(f"{API}/processes", json={"name": "Возврат"}, headers=h), "processes")
    _refused(client.post(f"{API}/processes/{small['proc']}/duplicate", headers=h), "processes")
    res = client.post(f"{API}/processes/import",
                      json={"text": DIAGRAM, "name": "Импорт", "mapping": {}}, headers=h)
    _refused(res, "processes")
    assert _size(db, small).processes == 1


# ── Ввоз и синк ─────────────────────────────────────────────────────────────


def test_дозаливка_доков_и_разведка(client, db, small):
    h, orders = small["h"], small["n"]["orders"]
    files = [{"name": "a.mmd", "content": "%% archmap-name: Приём\ngraph TD\n  A --> B\n"}]
    res = client.post(f"{API}/docs-import/apply",
                      json={"files": files, "node_id": orders, "only": "logic"}, headers=h)
    _refused(res, "docs")
    recon = [{"name": "archmap-recon.yaml",
              "content": "# archmap-recon\nnode: orders\noperations:\n  - GET /x\n"}]
    _refused(client.post(f"{API}/recon/apply", json={"files": recon}, headers=h), "docs")
    assert _size(db, small).docs == 2


@pytest.mark.parametrize(
    ("path", "content"),
    [
        ("data-import", f"# archmap-node: orders-db\ntables:\n  - name: big\n    description: {BIG}\n"),
        ("channels-import", f"# archmap-node: bus\nchannels:\n  - name: big\n    description: {BIG}\n"),
        ("config-import", f"# archmap-node: orders\nconfig:\n  - name: BIG\n    description: {BIG}\n"),
    ],
)
def test_ввоз_фактов(client, db, small, monkeypatch, path, content):
    monkeypatch.setattr(demo, "MAX_FILE_BYTES", 100_000)  # проверяем объём, а не файл
    before = _size(db, small)
    res = client.post(f"{API}/{path}/apply",
                      json={"files": [{"name": "f.yaml", "content": content}]}, headers=small["h"])
    _refused(res, "text")
    assert _size(db, small) == before


def test_импорт_нового_проекта(client, db, small):
    projects = db.query(Project).count()
    res = client.post(f"{API}/projects/import-unified",
                      files=[("files", ("run.yaml", GROWN.encode(), "text/yaml"))],
                      data={"name": "Большой"}, headers=small["h"])
    _refused(res, "nodes")
    assert db.query(Project).count() == projects


def test_синк(client, db, small):
    res = client.post(f"{API}/projects/{small['pid']}/sync/apply",
                      json={"contents": [GROWN]}, headers=small["h"])
    _refused(res, "nodes")
    assert _size(db, small).nodes == 4


def _donor_archive(db) -> bytes:
    """Архив другого проекта с двумя объектами — догрузка даст 6 при пределе 4."""
    donor = seed_project_from_yaml(
        db, ["nodes:\n  - name: Склад\n    children:\n      - name: receiving\n"], name="Донор"
    )
    return build_archive(db, donor)


def test_догрузка_архива(client, db, small):
    archive = _donor_archive(db)
    res = client.post(f"{API}/projects/{small['pid']}/import-archive/apply",
                      files=[("files", ("donor.zip", archive, "application/zip"))],
                      headers=small["h"])
    _refused(res, "nodes")
    assert _size(db, small).nodes == 4


def test_копия_проекта_сверх_предела(client, db, small, monkeypatch):
    monkeypatch.setattr(demo, "MAX_NODES", 3)  # сцена теперь сверх предела
    projects = db.query(Project).count()
    res = client.post(f"{API}/projects", json={"name": "Копия", "start": f"copy:{small['pid']}"},
                      headers=small["h"])
    assert res.status_code == 409 and res.json()["code"] == DEMO_LIMIT_CODE
    assert db.query(Project).count() == projects


# ── Удаление и уменьшение проходят всегда ───────────────────────────────────


def test_сверх_предела_удаление_и_уменьшение_проходят(client, db, small, monkeypatch):
    monkeypatch.setattr(demo, "MAX_NODES", 2)
    monkeypatch.setattr(demo, "MAX_DOCS", 1)
    monkeypatch.setattr(demo, "MAX_TEXT_BYTES", 10)
    h, n = small["h"], small["n"]
    # Проект уже сверх всех трёх пределов, но правка, не увеличивающая итог, проходит.
    assert client.delete(f"{API}/nodes/{n['bus']}", headers=h).status_code == 204
    res = client.patch(f"{API}/nodes/{n['orders']}/docs/{small['doc']}",
                       json={"content": "graph TD\n"}, headers=h)
    assert res.status_code == 200
    res = client.patch(f"{API}/nodes/{n['orders']}", json={"role": "сервис"}, headers=h)
    assert res.status_code == 409  # текст вырос, а предел текста уже пройден
    assert client.delete(f"{API}/edges/{_edge_id(db, small)}", headers=h).status_code == 204


def _edge_id(db, scene) -> str:
    return str(db.query(Edge.id).filter(Edge.project_id == scene["p"].id).first()[0])


def test_вне_демо_пределов_нет(client, db, scene):
    h = scene["h"]
    for name in ("a", "b", "c"):
        assert client.post(f"{API}/nodes", json={"name": name}, headers=h).status_code == 201
    assert client.post(f"{API}/processes", json={"name": "Ещё"}, headers=h).status_code == 201
    assert _size(db, scene).nodes == 7


# ── Превью: превышение видно до «Создать» ───────────────────────────────────


def test_превью_нового_проекта(client, db, small):
    projects = db.query(Project).count()
    res = client.post(f"{API}/projects/import/unified-preview",
                      files=[("files", ("run.yaml", GROWN.encode(), "text/yaml"))],
                      headers=small["h"])
    assert res.status_code == 200, res.text
    assert res.json()["demo_excess"] == {"kind": "nodes", "actual": 6, "limit": 4}
    assert db.query(Project).count() == projects  # превью ничего не записало


def test_превью_нового_проекта_в_пределах(client, small):
    res = client.post(f"{API}/projects/import/unified-preview",
                      files=[("files", ("run.yaml", SCENE.encode(), "text/yaml"))],
                      headers=small["h"])
    assert res.status_code == 200 and res.json()["demo_excess"] is None


def test_превью_синка_и_догрузки(client, db, small):
    res = client.post(f"{API}/projects/{small['pid']}/sync/preview",
                      json={"contents": [GROWN]}, headers=small["h"])
    assert res.json()["demo_excess"] == {"kind": "nodes", "actual": 6, "limit": 4}
    archive = _donor_archive(db)
    res = client.post(f"{API}/projects/{small['pid']}/import-archive/preview",
                      files=[("files", ("donor.zip", archive, "application/zip"))],
                      headers=small["h"])
    assert res.json()["demo_excess"] == {"kind": "nodes", "actual": 6, "limit": 4}
    assert _size(db, small).nodes == 4


def test_превью_вне_демо_без_превышения(client, scene):
    res = client.post(f"{API}/projects/import/unified-preview",
                      files=[("files", ("run.yaml", GROWN.encode(), "text/yaml"))],
                      headers=scene["h"])
    assert res.status_code == 200 and res.json()["demo_excess"] is None


# ── Размер файла ────────────────────────────────────────────────────────────


def test_файл_больше_предела_413(client, small):
    h = small["h"]
    big = ("# " + "x" * 3000 + "\n" + GROWN).encode()
    for path in ("projects/import/unified-preview", "projects/import-unified"):
        res = client.post(f"{API}/{path}", files=[("files", ("billing-full.yaml", big, "text/yaml"))],
                          data={"name": "Б"}, headers=h)
        assert res.status_code == 413
        assert res.json()["detail"] == (
            "Файл слишком большой для демо. «billing-full.yaml» весит 4 КБ, "
            "а в демо можно загрузить до 1 КБ."
        )
    res = client.post(f"{API}/docs-import/preview",
                      json={"files": [{"name": "a.mmd", "content": "%%" + "я" * 1500}]}, headers=h)
    assert res.status_code == 413
    res = client.post(f"{API}/projects/{small['pid']}/sync/preview",
                      json={"contents": [big.decode()]}, headers=h)
    assert res.status_code == 413 and "«Файл 1»" in res.json()["detail"]


def test_размер_файла_по_русски():
    # КБ округляются вверх: файл чуть больше предела не «весит 250 КБ».
    assert file_too_large_detail("billing-full.zip", int(1.4 * 1024 * 1024)) == (
        "Файл слишком большой для демо. «billing-full.zip» весит 1,4 МБ, "
        "а в демо можно загрузить до 250 КБ."
    )
    assert "весит 251 КБ" in file_too_large_detail("a.yaml", 250 * 1024 + 1)
