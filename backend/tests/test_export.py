"""Тесты экспорта схемы в YAML для LLM (GET /export, /export/{id}).

Проверяем сериализатор build_export через эндпоинты (как в test_alerts —
вызываем функции роутера напрямую с сессией, минуя auth). Ассерты по
распарсенному YAML, а не по тексту, — устойчивы к форматированию.
"""

import uuid

import pytest
import yaml
from conftest import ensure_project
from fastapi import HTTPException

from app.models.edge import Edge
from app.models.node import Node
from app.models.node_doc import NodeDoc
from app.routers.export import export_all, export_subtree


def _node(db, name, parent=None, **kw):
    n = Node(
        id=uuid.uuid4(),
        name=name,
        parent_id=parent.id if parent else None,
        project_id=ensure_project(db).id,
        **kw,
    )
    db.add(n)
    return n


def _edge(db, src, tgt, label=None, technology=None):
    e = Edge(
        id=uuid.uuid4(),
        source_id=src.id,
        target_id=tgt.id,
        label=label,
        technology=technology,
        project_id=ensure_project(db).id,
    )
    db.add(e)
    return e


def test_export_all_tree_and_edges(db):
    # Корень-сервис с двумя детьми, связь между детьми с label/technology.
    root = _node(db, "ObsCore", shape="service", role="сервис", technology="Python")
    a = _node(db, "HelixMon", root, shape="service", role="сборщик")
    b = _node(db, "Kafka", root, shape="broker")
    _edge(db, a, b, label="события", technology="Kafka")
    db.commit()

    res = export_all(db=db, project=ensure_project(db))
    assert res.format == "yaml"
    doc = yaml.safe_load(res.content)

    # Дерево: один корень с детьми (дети отсортированы по имени).
    assert [n["name"] for n in doc["nodes"]] == ["ObsCore"]
    mon = doc["nodes"][0]
    assert mon["shape"] == "service"
    assert mon["role"] == "сервис"
    assert mon["technology"] == "Python"
    assert [c["name"] for c in mon["children"]] == ["HelixMon", "Kafka"]
    # У ребёнка без role/technology лишних ключей нет.
    kafka = next(c for c in mon["children"] if c["name"] == "Kafka")
    assert "role" not in kafka and "technology" not in kafka

    # Связь — по именам узлов, с label/technology.
    assert doc["edges"] == [
        {"from": "HelixMon", "to": "Kafka", "label": "события", "technology": "Kafka"}
    ]


def test_export_omits_layout_and_documents(db):
    # Поля раскладки и вложенные документы в экспорт НЕ попадают.
    n = _node(
        db,
        "Узел",
        shape="service",
        openapi_spec="openapi: 3.0.0",
        is_external=True,
        description="Первая строка\nвторая строка",
    )
    db.add(NodeDoc(node_id=n.id, name="Логика", content="graph TD; A-->B"))
    db.commit()

    doc = yaml.safe_load(export_all(db=db, project=ensure_project(db)).content)
    node = doc["nodes"][0]
    assert set(node) == {"name", "shape", "external", "description"}
    assert node["external"] is True
    # Многострочное описание сохраняется как есть (литеральный блок).
    assert node["description"] == "Первая строка\nвторая строка"


def test_export_omits_internal_node_without_external_flag(db):
    # is_external=False → ключа external нет вовсе (не external: false).
    _node(db, "Внутренний", shape="service")
    db.commit()
    node = yaml.safe_load(export_all(db=db, project=ensure_project(db)).content)["nodes"][0]
    assert "external" not in node


def test_export_includes_non_default_status_only(db):
    # planned/deprecated попадают в семантику; дефолтный existing — шум, не печатаем.
    _node(db, "Существующий", shape="service")  # status по умолчанию existing
    _node(db, "Проектируемый", shape="service", status="planned")
    _node(db, "Выводимый", shape="service", status="deprecated")
    db.commit()

    nodes = yaml.safe_load(export_all(db=db, project=ensure_project(db)).content)["nodes"]
    by_name = {n["name"]: n for n in nodes}
    assert "status" not in by_name["Существующий"]
    assert by_name["Проектируемый"]["status"] == "planned"
    assert by_name["Выводимый"]["status"] == "deprecated"


def test_duplicate_name_uses_qualified_path_in_edges(db):
    # Два узла с одинаковым именем "БД" под разными родителями: в edges конец
    # дизамбигуируется путём «Предок / Имя», в дереве имя остаётся голым.
    svc1 = _node(db, "Сервис A", shape="service")
    svc2 = _node(db, "Сервис B", shape="service")
    db1 = _node(db, "БД", svc1, shape="database")
    db2 = _node(db, "БД", svc2, shape="database")
    _edge(db, svc1, db1)
    _edge(db, svc2, db2)
    db.commit()

    doc = yaml.safe_load(export_all(db=db, project=ensure_project(db)).content)
    # В дереве — голое имя.
    a = next(n for n in doc["nodes"] if n["name"] == "Сервис A")
    assert [c["name"] for c in a["children"]] == ["БД"]
    # В связях — квалифицированный путь до конкретной "БД".
    targets = {e["to"] for e in doc["edges"]}
    assert targets == {"Сервис A / БД", "Сервис B / БД"}


def test_export_subtree_scopes_nodes_and_edges(db):
    # Поддерево контейнера: только его узлы + связи ВНУТРИ; связь наружу отброшена.
    box = _node(db, "Контейнер", shape="service")
    child1 = _node(db, "Ребёнок 1", box, shape="service")
    child2 = _node(db, "Ребёнок 2", box, shape="service")
    outsider = _node(db, "Чужой", shape="service")
    _edge(db, child1, child2, label="внутри")
    _edge(db, child1, outsider, label="наружу")
    db.commit()

    doc = yaml.safe_load(export_subtree(node_id=box.id, db=db, project=ensure_project(db)).content)
    # Корень поддерева — сам контейнер; "Чужой" отсутствует.
    assert [n["name"] for n in doc["nodes"]] == ["Контейнер"]
    names = {c["name"] for c in doc["nodes"][0]["children"]}
    assert names == {"Ребёнок 1", "Ребёнок 2"}
    # Только внутренняя связь.
    assert doc["edges"] == [{"from": "Ребёнок 1", "to": "Ребёнок 2", "label": "внутри"}]


def test_export_subtree_unknown_id_404(db):
    with pytest.raises(HTTPException) as exc:
        export_subtree(node_id=uuid.uuid4(), db=db, project=ensure_project(db))
    assert exc.value.status_code == 404


def test_export_empty_schema(db):
    doc = yaml.safe_load(export_all(db=db, project=ensure_project(db)).content)
    assert doc == {"nodes": [], "edges": []}
