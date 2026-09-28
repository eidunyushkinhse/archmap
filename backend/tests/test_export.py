"""Тесты экспорта схемы в YAML для LLM (GET /export, /export/{id}).

Проверяем сериализатор build_export через эндпоинты (как в test_alerts —
вызываем функции роутера напрямую с сессией, минуя auth). Ассерты по
распарсенному YAML, а не по тексту, — устойчивы к форматированию.
"""

import io
import uuid
import zipfile

import pytest
import yaml
from conftest import ensure_project
from fastapi import HTTPException

from app.archive_export import build_archive, build_archive_ordered
from app.export import build_export_ordered
from app.import_yaml import parse_import
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


def _edge(db, src, tgt, label=None, technology=None, channel=None):
    e = Edge(
        id=uuid.uuid4(),
        source_id=src.id,
        target_id=tgt.id,
        label=label,
        technology=technology,
        channel=channel,
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


def test_тёзкам_с_якорем_путь_дописывается_уточнителем(db):
    """Путь не различает тёзок одного родителя — к нему дописывается ключ якоря
    (« @ git:…»). Тёзка без якоря и все прочие узлы пишутся по-прежнему."""
    корень = _node(db, "Ярмарка")
    orders = _node(db, "orders", корень)
    шоп = _node(db, "Каталог-БД", корень, source_ref="git:github.com/org/shop-db#db")
    сток = _node(db, "Каталог-БД", корень, source_ref="host:warehouse-db")
    голый = _node(db, "Каталог-БД", корень)
    _edge(db, orders, шоп, label="a")
    _edge(db, orders, сток, label="b")
    _edge(db, orders, голый, label="c")
    db.commit()

    doc = yaml.safe_load(export_all(db=db, project=ensure_project(db)).content)

    assert [(e["from"], e["to"]) for e in doc["edges"]] == [
        ("orders", "Ярмарка / Каталог-БД"),
        ("orders", "Ярмарка / Каталог-БД @ git:github.com/org/shop-db#db"),
        ("orders", "Ярмарка / Каталог-БД @ host:warehouse-db"),
    ]


def test_уточнитель_считает_уникальность_в_пределах_набора(db):
    """Поддерево — свой набор: тёзка вне поддерева путь не делает неоднозначным, и
    уточнителя нет (вывод прежний байт-в-байт)."""
    корень = _node(db, "Ярмарка")
    orders = _node(db, "orders", корень)
    шоп = _node(db, "Каталог-БД", корень, source_ref="git:github.com/org/shop-db")
    _node(db, "Каталог-БД", source_ref="git:github.com/org/warehouse-catalog")  # другой корень
    _edge(db, orders, шоп)
    db.commit()

    doc = yaml.safe_load(
        export_subtree(node_id=корень.id, db=db, project=ensure_project(db)).content
    )
    # Имя в наборе поддерева уникально — ссылка голым именем, как и прежде.
    assert doc["edges"] == [{"from": "orders", "to": "Каталог-БД"}]
    весь = yaml.safe_load(export_all(db=db, project=ensure_project(db)).content)
    # Во всём проекте имя повторяется, но пути разные — хватает пути.
    assert весь["edges"] == [{"from": "orders", "to": "Ярмарка / Каталог-БД"}]


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


def test_export_канал_связи_пишется_только_когда_задан(db):
    """Канал брокера (Ф3) — такая же необязательная семантика, как label/technology:
    ключ появляется, только если он есть. Иначе экспорт зашумило бы «channel: null» у
    каждой стрелки, а модель читает его как «канал существует и пуст»."""
    корень = _node(db, "Ярмарка")
    сервис = _node(db, "orders", корень, shape="service")
    брокер = _node(db, "Kafka", корень, shape="broker")
    _edge(db, сервис, брокер, label="событие", channel="orders.created")
    _edge(db, брокер, сервис)  # доставка подписчику, канал не назван
    db.commit()

    doc = yaml.safe_load(export_all(db=db, project=ensure_project(db)).content)

    публикация = next(e for e in doc["edges"] if e["from"] == "orders")
    доставка = next(e for e in doc["edges"] if e["from"] == "Kafka")
    assert публикация["channel"] == "orders.created"
    assert "channel" not in доставка


def test_порядок_id_экспорта_совпадает_с_нумерацией_разбора(db):
    """Ф3 единого импорта: build_export_ordered отдаёт id узлов в порядке документа,
    и этот порядок обязан совпадать с нумерацией parse_import — по нему догрузка
    возвращает узел разобранного C4 к его ЖИВОЙ записи.

    Полигон нарочно с ТЁЗКАМИ в одном родителе (адресация путём тут неоднозначна —
    ради этого карта и строится по порядку, а не по путям)."""
    корень = _node(db, "Ярмарка")
    _node(db, "orders", корень, technology="Python")
    _node(db, "orders", корень, technology="Go")  # тёзка того же родителя — легально
    _node(db, "Каталог-БД", корень, shape="database")
    другой = _node(db, "Внешний", shape="service")
    _edge(db, другой, корень)
    db.commit()

    узлы = db.query(Node).filter(Node.project_id == ensure_project(db).id).all()
    рёбра = db.query(Edge).filter(Edge.project_id == ensure_project(db).id).all()
    текст, порядок = build_export_ordered(узлы, рёбра)

    parsed, ошибки = parse_import(текст)
    assert ошибки == [] and parsed is not None
    assert len(порядок) == len(узлы) == len(parsed.nodes)
    # Индекс в индекс: имя и родитель разобранного узла — от узла с тем же номером.
    по_id = {n.id: n for n in узлы}
    for i, node_id in enumerate(порядок):
        живой, разобранный = по_id[node_id], parsed.nodes[i]
        assert разобранный.name == живой.name
        родитель = порядок[разобранный.parent_idx] if разобранный.parent_idx is not None else None
        assert родитель == живой.parent_id
    # Тёзки различимы только порядком: пути у них совпадают, а технологии разные.
    orders = [i for i, nid in enumerate(порядок) if по_id[nid].name == "orders"]
    assert [parsed.nodes[i].technology for i in orders] == [по_id[порядок[i]].technology
                                                            for i in orders]


def test_архив_отдаёт_порядок_узлов_своего_c4(db):
    """build_archive_ordered — тот же архив плюс порядок; байты не меняются."""
    корень = _node(db, "Ярмарка")
    _node(db, "orders", корень)
    db.commit()
    проект = ensure_project(db)

    байты, порядок = build_archive_ordered(db, проект)

    assert байты == build_archive(db, проект)  # хвост аддитивен, архив прежний
    c4 = zipfile.ZipFile(io.BytesIO(байты)).read("c4.yaml").decode()
    parsed, _ = parse_import(c4)
    assert parsed is not None
    assert [n.name for n in parsed.nodes] == [
        db.get(Node, nid).name for nid in порядок
    ] == ["Ярмарка", "orders"]
