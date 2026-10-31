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
from app.element_marks import build_elements, element_rows_of
from app.export import build_export, build_export_ordered
from app.import_yaml import parse_import
from app.models.deployment_instance import DeploymentInstance
from app.models.deployment_site import DeploymentSite
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
    root = _node(db, "Ярмарка", shape="service", role="сервис", technology="Python")
    a = _node(db, "Collector", root, shape="service", role="сборщик")
    b = _node(db, "Kafka", root, shape="broker")
    _edge(db, a, b, label="события", technology="Kafka")
    db.commit()

    res = export_all(db=db, project=ensure_project(db))
    assert res.format == "yaml"
    doc = yaml.safe_load(res.content)

    # Дерево: один корень с детьми (дети отсортированы по имени).
    assert [n["name"] for n in doc["nodes"]] == ["Ярмарка"]
    mon = doc["nodes"][0]
    assert mon["shape"] == "service"
    assert mon["role"] == "сервис"
    assert mon["technology"] == "Python"
    assert [c["name"] for c in mon["children"]] == ["Collector", "Kafka"]
    # У ребёнка без role/technology лишних ключей нет.
    kafka = next(c for c in mon["children"] if c["name"] == "Kafka")
    assert "role" not in kafka and "technology" not in kafka

    # Связь — по именам узлов, с label/technology.
    assert doc["edges"] == [
        {"from": "Collector", "to": "Kafka", "label": "события", "technology": "Kafka"}
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
    (« @ git:…»), когда якоря есть у всей группы и различны. Прочие узлы пишутся
    по-прежнему."""
    корень = _node(db, "Ярмарка")
    orders = _node(db, "orders", корень)
    шоп = _node(db, "Каталог-БД", корень, source_ref="git:github.com/org/shop-db#db")
    сток = _node(db, "Каталог-БД", корень, source_ref="host:warehouse-db")
    _edge(db, orders, шоп, label="a")
    _edge(db, orders, сток, label="b")
    db.commit()

    doc = yaml.safe_load(export_all(db=db, project=ensure_project(db)).content)

    assert [(e["from"], e["to"]) for e in doc["edges"]] == [
        ("orders", "Ярмарка / Каталог-БД @ git:github.com/org/shop-db#db"),
        ("orders", "Ярмарка / Каталог-БД @ host:warehouse-db"),
    ]


def test_группе_тёзок_без_якоря_у_всех_пишется_порядковый_уточнитель(db):
    """Якорь есть не у всех (или совпадает) — якорем группу не развести, и ВСЕЙ
    группе пишется «@ #N»: позиция в порядке документа (тёзки — по содержательному
    ключу, в нём и якорь: голый раньше git, git раньше host)."""
    корень = _node(db, "Ярмарка")
    orders = _node(db, "orders", корень)
    сток = _node(db, "Каталог-БД", корень, source_ref="host:warehouse-db")
    шоп = _node(db, "Каталог-БД", корень, source_ref="git:github.com/org/shop-db#db")
    голый = _node(db, "Каталог-БД", корень)
    _edge(db, orders, шоп, label="a")
    _edge(db, orders, сток, label="b")
    _edge(db, orders, голый, label="c")
    db.commit()

    текст = export_all(db=db, project=ensure_project(db)).content
    doc = yaml.safe_load(текст)

    assert [(e["from"], e["to"], e["label"]) for e in doc["edges"]] == [
        ("orders", "Ярмарка / Каталог-БД @ #1", "c"),
        ("orders", "Ярмарка / Каталог-БД @ #2", "a"),
        ("orders", "Ярмарка / Каталог-БД @ #3", "b"),
    ]
    # Дерево — в том же порядке документа, по нему резолвер и считает N.
    дети = doc["nodes"][0]["children"]
    assert [c.get("source") for c in дети if c["name"] == "Каталог-БД"] == [
        None, {"repo": "github.com/org/shop-db", "path": "db"}, {"host": "warehouse-db"},
    ]
    parsed, errors = parse_import(текст)
    assert errors == [] and parsed is not None
    assert [(parsed.nodes[e.target_idx].source_keys, e.label) for e in parsed.edges] == [
        ([], "c"), (["git:github.com/org/shop-db#db"], "a"), (["host:warehouse-db"], "b"),
    ]


def test_дети_тёзок_адресуются_уточнителем_на_сегменте_предка(db):
    """Уточнитель ставится на ТОТ сегмент пути, где стоит тёзка: ребёнок тёзки
    уникален среди своих сиблингов, но путь его не различает — различает
    уточнитель предка (якорный или порядковый)."""
    корень = _node(db, "Ярмарка")
    orders = _node(db, "orders", корень)
    шоп = _node(db, "Каталог-БД", корень, source_ref="git:github.com/org/shop-db#a/b")
    сток = _node(db, "Каталог-БД", корень, source_ref="git:github.com/org/warehouse-catalog")
    go = _node(db, "api", корень, technology="Go")
    py = _node(db, "api", корень, technology="Python")
    for родитель, метка in ((шоп, "a"), (сток, "b"), (go, "c"), (py, "d")):
        _edge(db, orders, _node(db, "reader", родитель), label=метка)
    db.commit()

    текст = export_all(db=db, project=ensure_project(db)).content
    doc = yaml.safe_load(текст)

    assert [(e["to"], e["label"]) for e in doc["edges"]] == [
        ("Ярмарка / api @ #1 / reader", "c"),
        ("Ярмарка / api @ #2 / reader", "d"),
        ("Ярмарка / Каталог-БД @ git:github.com/org/shop-db#a/b / reader", "a"),
        ("Ярмарка / Каталог-БД @ git:github.com/org/warehouse-catalog / reader", "b"),
    ]
    parsed, errors = parse_import(текст)
    assert errors == [] and parsed is not None
    родитель = {e.label: parsed.nodes[parsed.nodes[e.target_idx].parent_idx or 0]
                for e in parsed.edges}
    assert родитель["a"].source_keys == ["git:github.com/org/shop-db#a/b"]
    assert родитель["b"].source_keys == ["git:github.com/org/warehouse-catalog"]
    assert (родитель["c"].technology, родитель["d"].technology) == ("Go", "Python")


def test_порядок_тёзок_не_зависит_от_выдачи_бд(db):
    """Порядок документа — по имени, тёзки по содержательному ключу: проект, где те
    же узлы созданы в обратном порядке, экспортируется теми же байтами."""
    from app.export import build_export

    def проект(обратный: bool) -> list[Node]:
        корень = Node(id=uuid.uuid4(), name="Ярмарка", project_id=ensure_project(db).id)
        тёзки = [
            Node(id=uuid.uuid4(), name="api", technology=t, parent_id=корень.id,
                 project_id=ensure_project(db).id)
            for t in ("Go", "Python", "Rust")
        ]
        return [корень, *(reversed(тёзки) if обратный else тёзки)]

    прямой, обратный = проект(False), проект(True)
    assert build_export(прямой, []) == build_export(обратный, [])


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


# ── Раздел deployment (Ф4 эпика развёртывания) ───────────────────────────────


def _site(db, name, parent=None, **kw):
    s = DeploymentSite(
        id=uuid.uuid4(),
        name=name,
        parent_id=parent.id if parent else None,
        project_id=ensure_project(db).id,
        **kw,
    )
    db.add(s)
    db.flush()
    return s


def _place(db, node, site):
    db.flush()  # узел фабрики _node ещё не записан, а FK экземпляра проверяется сразу
    db.add(DeploymentInstance(project_id=node.project_id, node_id=node.id, site_id=site.id))
    db.flush()


def _площадки(db) -> dict:
    """Облако → Кластер prod, отдельная ВМ-2 и пустая «Стойка». Размещение — только у
    объектов: API Витрины — в кластере и на ВМ, Корзина — в облаке, Платежи — на ВМ."""
    облако = _site(db, "Облако", kind="cloud", technology="Yandex Cloud")
    кластер = _site(db, "Кластер prod", облако, kind="kubernetes", description="прод")
    вм = _site(db, "ВМ-2", kind="vm")
    _site(db, "Стойка")  # пустая площадка: вид other, без технологии
    витрина = _node(db, "Витрина")
    api = _node(db, "API", витрина)
    корзина = _node(db, "Корзина", витрина)
    платежи = _node(db, "Платежи")
    _place(db, корзина, облако)
    _place(db, api, кластер)
    _place(db, api, вм)
    _place(db, платежи, вм)
    db.commit()
    return {"витрина": витрина, "api": api, "платежи": платежи, "облако": облако}


def test_экспорт_пишет_раздел_площадок_и_площадки_объектов(db):
    _площадки(db)

    doc = yaml.safe_load(export_all(db=db, project=ensure_project(db)).content)

    # Родители раньше детей, внутри — по имени; пустые поля и вид «other» не пишутся.
    assert doc["deployment"] == {
        "sites": [
            {"name": "ВМ-2", "kind": "vm"},
            {"name": "Облако", "kind": "cloud", "technology": "Yandex Cloud"},
            {"name": "Кластер prod", "kind": "kubernetes", "description": "прод",
             "parent": "Облако"},
            {"name": "Стойка"},
        ]
    }
    витрина, платежи = doc["nodes"]
    # Объекты Витрины стоят на разных площадках — у неё самой ключа sites нет.
    assert витрина["name"] == "Витрина" and "sites" not in витрина
    assert платежи["sites"] == ["ВМ-2"]
    api, корзина = витрина["children"]
    # Площадки объекта — в порядке площадок по имени.
    assert api["sites"] == ["ВМ-2", "Кластер prod"]
    assert корзина["sites"] == ["Облако"]
    assert list(витрина) == ["name", "shape", "children"]
    # Раздел — последним, после связей.
    assert list(doc) == ["nodes", "edges", "deployment"]


def test_контейнер_с_объектами_на_одном_наборе_пишет_sites_сам(db):
    """Все объекты контейнера стоят на одном наборе площадок — sites пишется у
    контейнера, а у поддерева нет (импорт раздаёт объявление контейнера объектам:
    test_import). Ключ sites — после source и до children."""
    узлы = _площадки(db)
    _place(db, узлы["api"], узлы["облако"])
    db.commit()
    # API: ВМ-2, Кластер prod, Облако — всё ещё не как у Корзины (только Облако)
    doc = yaml.safe_load(export_all(db=db, project=ensure_project(db)).content)
    assert "sites" not in doc["nodes"][0]

    db.query(DeploymentInstance).filter(DeploymentInstance.node_id == узлы["api"].id).delete()
    _place(db, узлы["api"], узлы["облако"])
    db.commit()

    doc = yaml.safe_load(export_all(db=db, project=ensure_project(db)).content)
    витрина = doc["nodes"][0]
    assert витрина["sites"] == ["Облако"]
    assert list(витрина) == ["name", "shape", "sites", "children"]
    assert all("sites" not in k for k in витрина["children"])


def test_экспорт_поддерева_берёт_нужные_площадки_с_предками(db):
    узлы = _площадки(db)

    doc = yaml.safe_load(
        export_subtree(node_id=узлы["api"].id, db=db, project=ensure_project(db)).content
    )

    # API стоит в кластере и на ВМ; облако — предок кластера и едет с ним, иначе
    # раздел сослался бы на необъявленного родителя. Пустая «Стойка» не нужна.
    assert [s["name"] for s in doc["deployment"]["sites"]] == ["ВМ-2", "Облако", "Кластер prod"]
    assert doc["nodes"][0]["sites"] == ["ВМ-2", "Кластер prod"]
    parsed, ошибки = parse_import(
        export_subtree(node_id=узлы["api"].id, db=db, project=ensure_project(db)).content
    )
    assert ошибки == [] and parsed is not None and parsed.warnings == []


def test_поддерево_без_размещения_раздела_не_пишет(db):
    _площадки(db)
    одиночка = _node(db, "Одиночка")
    db.commit()

    doc = yaml.safe_load(
        export_subtree(node_id=одиночка.id, db=db, project=ensure_project(db)).content
    )

    assert doc == {"nodes": [{"name": "Одиночка", "shape": "service"}], "edges": []}


def _c4_площадки(db) -> dict:
    """Система shop: контейнер orders с компонентами api и worker, лист billing рядом;
    площадки «Облако» и «ВМ»."""
    облако = _site(db, "Облако", kind="cloud")
    вм = _site(db, "ВМ", kind="vm")
    shop = _node(db, "shop")
    orders = _node(db, "orders", shop, element="container")
    api = _node(db, "api", orders)
    _node(db, "worker", orders)
    billing = _node(db, "billing", shop)
    return {"облако": облако, "вм": вм, "shop": shop, "orders": orders, "api": api, "billing": billing}


def test_контейнер_с_компонентами_пишет_sites_сам_а_компонент_никогда(db):
    """Единица размещения — контейнер (Р16): свои sites у orders, у его компонентов
    ключа нет, даже со «спящим» экземпляром (прежние данные); система, чьи единицы
    стоят по-разному, sites не пишет."""
    у = _c4_площадки(db)
    _place(db, у["orders"], у["облако"])
    _place(db, у["api"], у["вм"])  # спящий: размещение его не считает
    _place(db, у["billing"], у["вм"])
    db.commit()

    doc = yaml.safe_load(export_all(db=db, project=ensure_project(db)).content)
    [shop] = doc["nodes"]
    assert "sites" not in shop
    billing, orders = shop["children"]
    assert (orders["name"], orders["sites"]) == ("orders", ["Облако"])
    assert list(orders) == ["name", "shape", "element", "sites", "children"]
    assert all("sites" not in k for k in orders["children"])
    assert billing["sites"] == ["ВМ"]


def test_система_с_единицами_на_одном_наборе_пишет_sites_сама(db):
    """Все единицы системы — контейнер с компонентами и лист — на одном наборе: sites у
    системы, у поддерева нет (импорт раздаст объявление системы её единицам)."""
    у = _c4_площадки(db)
    _place(db, у["orders"], у["облако"])
    _place(db, у["billing"], у["облако"])
    db.commit()

    doc = yaml.safe_load(export_all(db=db, project=ensure_project(db)).content)
    [shop] = doc["nodes"]
    assert shop["sites"] == ["Облако"]
    assert all("sites" not in k for k in shop["children"])
    assert all("sites" not in k for k in shop["children"][1]["children"])


def test_поддерево_компонента_площадок_не_пишет(db):
    """Элемент поддерева решают предки вне набора: api — компонент контейнера orders, и
    его спящий экземпляр не пишется и в экспорте поддерева от api."""
    у = _c4_площадки(db)
    _place(db, у["api"], у["вм"])
    db.commit()

    doc = yaml.safe_load(
        export_subtree(node_id=у["api"].id, db=db, project=ensure_project(db)).content
    )

    assert doc == {"nodes": [{"name": "api", "shape": "service"}], "edges": []}


def test_без_площадок_документ_байт_в_байт_прежний(db):
    корень = _node(db, "Ярмарка", technology="Python")
    orders = _node(db, "orders", корень)
    _edge(db, orders, корень, label="зовёт")
    db.commit()
    узлы = db.query(Node).filter(Node.project_id == ensure_project(db).id).all()
    рёбра = db.query(Edge).filter(Edge.project_id == ensure_project(db).id).all()

    текст = export_all(db=db, project=ensure_project(db)).content

    # Вызов без площадок (прежняя сигнатура) и роутер с пустым проектом площадок дают
    # один и тот же текст — без раздела deployment и без ключа sites у узлов.
    assert текст == build_export(узлы, рёбра)
    assert "deployment" not in текст and "sites" not in текст


# --- Элемент архитектуры (эпик «Элемент архитектуры», Ф2, Р29) ---


def test_элемент_пишется_сразу_после_формы_и_только_заданный(db):
    """element — после shape и до status: порядок ключей узла осознанный. Не заданный
    (null, «не сказано») не пишется вовсе."""
    корень = _node(db, "Ярмарка", shape="service", element="system")
    orders = _node(db, "orders", корень, shape="service", element="container",
                   status="planned", role="сервис")
    _node(db, "api", orders, shape="service")
    db.commit()

    текст = export_all(db=db, project=ensure_project(db)).content
    doc = yaml.safe_load(текст)

    корень_d = doc["nodes"][0]
    assert list(корень_d) == ["name", "shape", "element", "children"]
    orders_d = корень_d["children"][0]
    assert list(orders_d) == ["name", "shape", "element", "status", "role", "children"]
    assert orders_d["element"] == "container"
    assert "element" not in orders_d["children"][0]
    assert "    shape: service\n    element: container\n    status: planned\n" in текст


def test_без_элементов_документ_байт_в_байт_прежний(db):
    """Проект, где элемент не задан ни у кого, экспортируется теми же байтами, что до
    эпика: эталонный текст снят с прежнего сериализатора."""
    корень = _node(db, "Ярмарка", shape="service", role="система")
    orders = _node(db, "orders", корень, shape="service", technology="Python",
                   status="planned")
    db_ = _node(db, "orders-db", корень, shape="database")
    _edge(db, orders, db_, label="пишет", technology="SQL")
    db.commit()

    текст = export_all(db=db, project=ensure_project(db)).content

    assert текст == (
        "nodes:\n"
        "- name: Ярмарка\n"
        "  shape: service\n"
        "  role: система\n"
        "  children:\n"
        "  - name: orders\n"
        "    shape: service\n"
        "    status: planned\n"
        "    technology: Python\n"
        "  - name: orders-db\n"
        "    shape: database\n"
        "edges:\n"
        "- from: orders\n"
        "  to: orders-db\n"
        "  label: пишет\n"
        "  technology: SQL\n"
    )


def test_тёзки_различающиеся_элементом_идут_в_детерминированном_порядке(db):
    """content_key знает элемент: тёзки, различающиеся только им, получают один и тот
    же порядок документа при любой выдаче БД («не задан» раньше «контейнера»), и
    порядковые уточнители ссылок указывают на тех же тёзок."""

    def проект(обратный: bool) -> tuple[list[Node], list[Edge]]:
        pid = ensure_project(db).id
        корень = Node(id=uuid.uuid4(), name="Ярмарка", project_id=pid)
        голый = Node(id=uuid.uuid4(), name="api", parent_id=корень.id, project_id=pid)
        контейнер = Node(id=uuid.uuid4(), name="api", parent_id=корень.id,
                         element="container", project_id=pid)
        шлюз = Node(id=uuid.uuid4(), name="gateway", parent_id=корень.id, project_id=pid)
        рёбра = [
            Edge(id=uuid.uuid4(), source_id=шлюз.id, target_id=голый.id, label="к голому",
                 project_id=pid),
            Edge(id=uuid.uuid4(), source_id=шлюз.id, target_id=контейнер.id,
                 label="к контейнеру", project_id=pid),
        ]
        тёзки = [голый, контейнер]
        return [корень, шлюз, *(reversed(тёзки) if обратный else тёзки)], рёбра

    прямой, обратный = проект(False), проект(True)
    текст = build_export(*прямой)
    assert текст == build_export(*обратный)
    doc = yaml.safe_load(текст)
    assert [c.get("element") for c in doc["nodes"][0]["children"] if c["name"] == "api"] == [
        None, "container",
    ]
    assert [(e["to"], e["label"]) for e in doc["edges"]] == [
        ("Ярмарка / api @ #1", "к голому"),
        ("Ярмарка / api @ #2", "к контейнеру"),
    ]


# --- Выписка промпта документации: действующий тип (Ф14, решение владельца 2026-10-31) ---


def _типовой_проект(db) -> tuple[list[Node], list[Edge]]:
    """Все случаи типа разом: система без хранимого элемента, контейнер-лист, контейнер
    с компонентом, внешний лист без элемента (Р42), пустая система (Р39), база, брокер
    и «Пользователь»."""
    корень = _node(db, "Ярмарка", shape="service")
    _node(db, "orders", корень, shape="service")
    billing = _node(db, "billing", корень, shape="service", element="container")
    _node(db, "api", billing, shape="service")
    _node(db, "склад", корень, shape="service", element="system")
    _node(db, "orders-db", корень, shape="database")
    _node(db, "events", корень, shape="broker")
    _node(db, "Stripe", shape="service", is_external=True)
    _node(db, "Покупатель", shape="person")
    db.commit()
    pid = ensure_project(db).id
    return (
        db.query(Node).filter(Node.project_id == pid).all(),
        db.query(Edge).filter(Edge.project_id == pid).all(),
    )


def _типы(doc: dict) -> dict[str, str | None]:
    """Имя узла → ключ element (None — ключа нет) по всему дереву документа."""
    out: dict[str, str | None] = {}

    def обход(узлы: list[dict]) -> None:
        for d in узлы:
            out[d["name"]] = d.get("element")
            обход(d.get("children", []))

    обход(doc["nodes"])
    return out


def test_выписка_с_типами_пишет_действующий_элемент_каждого_сервиса(db):
    узлы, рёбра = _типовой_проект(db)
    текст = build_export(узлы, рёбра, typed=build_elements(element_rows_of(узлы)))

    assert _типы(yaml.safe_load(текст)) == {
        "Ярмарка": "system",  # узел с детьми без хранимого элемента
        "orders": "container",  # свой лист
        "billing": "container",
        "api": "component",  # ребёнок контейнера
        "склад": "system",  # пустая система (Р39)
        "orders-db": None,
        "events": None,
        "Stripe": "system",  # внешний лист без элемента (Р42)
        "Покупатель": None,
    }
    # Место ключа то же, что у хранимого: сразу после формы.
    assert "  shape: service\n  element: system\n" in текст


def test_выписка_без_типов_прежняя_только_хранимый_элемент(db):
    узлы, рёбра = _типовой_проект(db)

    текст = build_export(узлы, рёбра)

    assert _типы(yaml.safe_load(текст)) == {
        "Ярмарка": None, "orders": None, "billing": "container", "api": None,
        "склад": "system", "orders-db": None, "events": None, "Stripe": None,
        "Покупатель": None,
    }
    assert текст == build_export(узлы, рёбра, typed=None)
    assert текст == export_all(db=db, project=ensure_project(db)).content


def test_выписка_поддерева_берёт_типы_проекта(db):
    """Срез поддерева компонента: контейнер над его корнем лежит вне набора, и тип
    считается по элементам ВСЕГО проекта — корень среза остаётся компонентом."""
    узлы, _ = _типовой_проект(db)
    api = next(n for n in узлы if n.name == "api")

    текст = build_export([api], [], root_id=api.id, typed=build_elements(element_rows_of(узлы)))

    assert "- name: api\n  shape: service\n  element: component\n" in текст
