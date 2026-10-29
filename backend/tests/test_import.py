"""Тесты импорта YAML (app/import_yaml.py + слияние + dry-run превью).

Главная гарантия — roundtrip с экспортом: вывод build_export импортируется без
ошибок с той же семантикой (имя, форма, статус, роль, технология, external,
описание, вложенность, связи). Плюс валидация: битый YAML, неизвестные/
неоднозначные ссылки в edges, неверный shape, лимит глубины; dry-run превью
ничего не пишет в БД.
"""

import uuid

import pytest
import yaml
from conftest import seed_project_from_yaml

from app.deployment import ordered_instances, project_sites
from app.element_marks import project_element_rows
from app.element_rules import element_change_refusal
from app.export import build_export
from app.import_element import (
    CHILDLESS_LIFTED_NOTE,
    COMPONENT_NOTE,
    ONLY_SERVICE_NOTE,
    STORE_KEPT_NOTE,
    STORE_LIFTED_NOTE,
    sanitize_elements,
)
from app.import_merge import parse_and_merge
from app.import_yaml import MAX_DEPTH, parse_import, seed_import
from app.models.deployment_instance import DeploymentInstance
from app.models.deployment_site import DeploymentSite
from app.models.edge import Edge
from app.models.node import Node
from app.models.project import Project
from app.schemas.project import ImportPreviewOut
from app.unified_import import MAX_INPUTS, UnifiedImportError, build_unified_plan
from app.unified_preview import preview_from_plan
from app.unified_remarks import _remark_class, friendly_remark, remainder_from_plan


def _preview(*texts: str) -> ImportPreviewOut:
    """C4-сводка dry-run для N текстов — единым путём ввоза (build_unified_plan +
    preview_from_plan). Старый POST /projects/import/preview снесён 2026-09-05,
    но сборщик C4-части превью остался тем же, так что проверки не осиротели."""
    plan = build_unified_plan([(f"f{i + 1}.yaml", t.encode()) for i, t in enumerate(texts)])
    return preview_from_plan(plan).c4


def _project(db, name="Проект") -> Project:
    p = Project(id=uuid.uuid4(), name=name)
    db.add(p)
    db.flush()
    return p


def _node(db, project_id, name, parent=None, **kw) -> Node:
    n = Node(
        id=uuid.uuid4(),
        name=name,
        parent_id=parent.id if parent else None,
        project_id=project_id,
        **kw,
    )
    db.add(n)
    db.flush()
    return n


def _semantic_signature(db, project_id) -> tuple[set, set]:
    """Семантика схемы независимо от id: узлы с полным путём, рёбра по путям концов."""
    nodes = db.query(Node).filter(Node.project_id == project_id).all()
    by_id = {n.id: n for n in nodes}

    def path_of(n: Node) -> str:
        parts = [n.name]
        cur = n
        while cur.parent_id is not None:
            cur = by_id[cur.parent_id]
            parts.append(cur.name)
        return " / ".join(reversed(parts))

    node_sig = {
        (path_of(n), n.shape, n.element, n.status, n.role, n.technology, n.is_external,
         n.description, n.source_ref)
        for n in nodes
    }
    edges = db.query(Edge).filter(Edge.project_id == project_id).all()
    edge_sig = {
        (
            path_of(by_id[e.source_id]),
            path_of(by_id[e.target_id]),
            e.label,
            e.technology,
            e.channel,
            e.is_synchronous,
        )
        for e in edges
    }
    return node_sig, edge_sig


def test_roundtrip_export_import_same_semantics(db):
    """Экспорт схемы с вложенностью, дублями имён, статусами и external импортируется
    в новый проект бит-в-бит по семантике."""
    src = _project(db, "Источник")
    # Элемент архитектуры (Ф2 эпика) едет как есть.
    platform = _node(
        db, src.id, "Платформа", role="система", technology="K8s",
        description="Первая строка\nвторая строка", element="system",
    )
    pdb = _node(db, src.id, "БД", platform, shape="database", technology="PostgreSQL")
    svc = _node(db, src.id, "Сервис A", platform, status="planned", role="сервис")
    sdb = _node(db, src.id, "БД", svc, shape="database")  # дубль имени → путь в edges
    ext = _node(db, src.id, "Внешний партнёр", shape="person", is_external=True)
    db.add(Edge(id=uuid.uuid4(), project_id=src.id, source_id=ext.id, target_id=svc.id,
                label="дёргает", technology="HTTPS"))
    db.add(Edge(id=uuid.uuid4(), project_id=src.id, source_id=svc.id, target_id=sdb.id))
    db.add(Edge(id=uuid.uuid4(), project_id=src.id, source_id=platform.id, target_id=pdb.id,
                label="хранит"))
    db.commit()

    nodes = db.query(Node).filter(Node.project_id == src.id).all()
    edges = db.query(Edge).filter(Edge.project_id == src.id).all()
    content = build_export(nodes, edges)

    parsed, errors = parse_import(content)
    assert errors == [] and parsed is not None
    dst = _project(db, "Приёмник")
    seed_import(db, dst.id, parsed)
    db.commit()

    assert _semantic_signature(db, src.id) == _semantic_signature(db, dst.id)
    # Раскладку импорт не тащит — строк view_layout в новом проекте нет.
    from app.models.view_layout import ViewLayoutItem
    assert db.query(ViewLayoutItem).filter(ViewLayoutItem.project_id == dst.id).count() == 0


def test_import_seeds_project_schema(db):
    """Полный цикл: разбор YAML + сидинг заводят схему проекта целиком."""
    content = yaml.dump(
        {
            "nodes": [
                {"name": "Ядро", "shape": "service",
                 "children": [{"name": "БД", "shape": "database"}]},
                {"name": "Клиент", "shape": "person", "external": True},
            ],
            "edges": [{"from": "Клиент", "to": "Ядро", "label": "пользуется"}],
        },
        allow_unicode=True,
    )
    p = seed_project_from_yaml(db, [content], name="Импортированный")
    assert db.query(Node).filter(Node.project_id == p.id).count() == 3
    assert db.query(Edge).filter(Edge.project_id == p.id).count() == 1
    ext = {n.name: n.is_external for n in db.query(Node).filter(Node.project_id == p.id)}
    assert ext == {"Ядро": False, "БД": False, "Клиент": True}


def test_import_broken_yaml_не_сидится():
    """Битый YAML до сидинга не доходит: разбор возвращает ошибку с диагнозом."""
    merged, _report, errors = parse_and_merge(["nodes:\n  - name: [оборвано"])
    assert merged is None and any("YAML" in e for e in errors)


def test_ошибка_yaml_подсказывает_лечение():
    # Полевой QA: на «ошибка в строке N» слабая модель добросовестно перепечатывает
    # документ с той же ошибкой. Диагноз обязан идти вместе с лечением.
    parsed, errors = parse_import(
        "nodes:\n  - name: A\n    description: Обработка действий: отправка\n"
    )
    assert parsed is None
    assert any("возьмите такое значение в кавычки" in e for e in errors)


def test_unknown_edge_ref_is_error():
    parsed, errors = parse_import("nodes:\n  - name: A\nedges:\n  - from: A\n    to: B\n")
    assert parsed is None
    assert any('узел "B" не найден' in e and "edges[0]" in e for e in errors)
    # СЕНТИНЕЛ: уверенного кандидата нет («B» против «A») — текст ошибки прежний
    # байт-в-байт, did-you-mean ничего к нему не приписал.
    assert errors == ['edges[0]: узел "B" не найден']


def test_подсказка_находит_тот_же_компонент_в_другом_контейнере():
    """Полевой промах агента (docs/qa-federation-matrix.md, находка 2): имя
    компонента взято верное, привязка потеряна. Ошибка называет правильный путь —
    и его можно вписать в документ как есть, без второго круга переписки."""
    doc = (
        "nodes:\n"
        "  - name: zabbix-ui\n"
        "    children:\n"
        "      - name: web-api\n"
        "  - name: zabbix-server\n"
        "    children:\n"
        "      - name: poller\n"
        "edges:\n"
        "  - from: zabbix-server / poller\n"
        "    to: "
    )
    parsed, errors = parse_import(doc + "zabbix-server / web-api\n")
    assert parsed is None
    assert errors == [
        'edges[0]: узел "zabbix-server / web-api" не найден — есть "zabbix-ui / web-api"'
    ]
    # Подсказка резолвится: агент чинит связь копированием предложенного пути.
    parsed, errors = parse_import(doc + "zabbix-ui / web-api\n")
    assert errors == [] and parsed is not None and len(parsed.edges) == 1


def test_подсказка_на_опечатку_и_молчание_на_далёком_имени():
    """Порог Ф8ж дословно: мелкое расхождение (опечатка) — подсказка; далёкое имя —
    МОЛЧАНИЕ. Ложная подсказка хуже отсутствия: слабая модель копирует
    предложенное не глядя, и ссылка становится битой по-другому."""
    doc = (
        "nodes:\n"
        "  - name: zabbix-server\n"
        "    children:\n"
        "      - name: api-gateway\n"
        "  - name: gate\n"
        "edges:\n"
        "  - from: gate\n"
        "    to: "
    )
    parsed, errors = parse_import(doc + "zabbix-server / api-gatewey\n")
    assert parsed is None
    assert errors == [
        'edges[0]: узел "zabbix-server / api-gatewey" не найден'
        ' — есть "zabbix-server / api-gateway"'
    ]
    # «cache» не похоже ни на один узел документа — текст прежний байт-в-байт.
    parsed, errors = parse_import(doc + "cache\n")
    assert parsed is None
    assert errors == ['edges[0]: узел "cache" не найден']


def test_подсказка_детерминирована_при_нескольких_одноимённых_листьях():
    """Одноимённых листьев несколько — подсказка одна и та же от прогона к прогону:
    ближайший по полному пути, при равенстве — первый в порядке документа
    (а не по алфавиту: «aaa» лежит ниже «bbb»)."""
    doc = (
        "nodes:\n"
        "  - name: bbb\n"
        "    children:\n"
        "      - name: api\n"
        "  - name: aaa\n"
        "    children:\n"
        "      - name: api\n"
        "  - name: x\n"
        "edges:\n"
        "  - from: x\n"
        "    to: "
    )
    runs = {parse_import(doc + "ccc / api\n")[1][0] for _ in range(3)}
    assert runs == {'edges[0]: узел "ccc / api" не найден — есть "bbb / api"'}
    # Когда кандидаты неравноудалены, выигрывает ближайший, а не первый.
    _, errors = parse_import(doc + "aaa-legacy / api\n")
    assert errors == ['edges[0]: узел "aaa-legacy / api" не найден — есть "aaa / api"']


def test_qualified_path_resolves_and_bare_duplicate_is_ambiguous(db):
    """Дубль имени: голая ссылка — ошибка неоднозначности, путь «Предок / Имя» работает."""
    content = (
        "nodes:\n"
        "  - name: A\n"
        "    children:\n"
        "      - name: БД\n"
        "        shape: database\n"
        "  - name: B\n"
        "    children:\n"
        "      - name: БД\n"
        "        shape: database\n"
    )
    parsed, errors = parse_import(content + 'edges:\n  - from: A\n    to: "БД"\n')
    assert parsed is None
    assert any("неоднозначно" in e for e in errors)

    parsed, errors = parse_import(content + 'edges:\n  - from: A\n    to: "A / БД"\n')
    assert errors == [] and parsed is not None
    dst = _project(db, "Импорт путей")
    seed_import(db, dst.id, parsed)
    db.commit()
    edge = db.query(Edge).filter(Edge.project_id == dst.id).one()
    target = db.get(Node, edge.target_id)
    parent = db.get(Node, target.parent_id)
    assert (target.name, parent.name) == ("БД", "A")


def _dup_doc(first: str, second: str, ref: str) -> str:
    """Документ с двумя одноимёнными листьями «api» под разными корнями + связь на ref."""
    return (
        "nodes:\n"
        f"  - name: {first}\n"
        "    children:\n"
        "      - name: api\n"
        f"  - name: {second}\n"
        "    children:\n"
        "      - name: api\n"
        "  - name: x\n"
        "edges:\n"
        "  - from: x\n"
        f"    to: {ref}\n"
    )


def test_неоднозначность_называет_кандидатов():
    """Кандидатов резолвер уже посчитал (ими он неоднозначность и обнаружил) — они
    едут в замечание: агент видит, МЕЖДУ ЧЕМ выбирать, и чинит ссылку копированием
    готового пути, а не вторым кругом переписки. Образец формы — поток каналов;
    формулировка утвердительная, цель несёт ответ, а не выбор способа записи."""
    parsed, errors = parse_import(_dup_doc("zzz", "aaa", "api"))
    assert parsed is None
    assert errors == [
        'edges[0]: имя "api" неоднозначно (есть "aaa / api", "zzz / api")'
        " — укажите один из них"
    ]


def test_порядок_кандидатов_не_зависит_от_порядка_узлов():
    """Перестановка узлов во входном документе НЕ шевелит текст замечания: иначе
    одно и то же замечание дрожит между прогонами агента (порядок — по алфавиту,
    а не по документу)."""
    straight = parse_import(_dup_doc("aaa", "zzz", "api"))[1]
    swapped = parse_import(_dup_doc("zzz", "aaa", "api"))[1]
    assert straight == swapped
    assert straight == [
        'edges[0]: имя "api" неоднозначно (есть "aaa / api", "zzz / api")'
        " — укажите один из них"
    ]


def test_единственное_совпадение_молчит_о_кандидатах():
    """Совпадение одно — неоднозначности нет: связь резолвится, ни слова о кандидатах."""
    parsed, errors = parse_import(_dup_doc("aaa", "zzz", "aaa / api"))
    assert errors == [] and parsed is not None and len(parsed.edges) == 1


def test_одинаковые_пути_кандидатов_не_печатаются():
    """Узел-близнец повторён в документе: полные пути совпадают, называть нечего —
    перечень вёл бы обратно в «неоднозначно», а это хуже молчания (порог Ф8ж).
    СЕНТИНЕЛ: текст остаётся прежним байт-в-байт."""
    parsed, errors = parse_import(_dup_doc("aaa", "aaa", "aaa / api"))
    assert parsed is None
    assert errors == ['edges[0]: имя "aaa / api" неоднозначно, укажите путь через " / "']


# ── Уточнитель-якорь: «путь @ ключ» различает законных тёзок (app/node_ref.py) ──


def _тёзки_doc(*refs: str, name: str = "Каталог-БД") -> str:
    """«Ярмарка» с двумя якорными тёзками + по связи из «orders» на каждую ссылку."""
    return (
        "nodes:\n"
        "  - name: Ярмарка\n"
        "    children:\n"
        "      - name: orders\n"
        f"      - name: {name}\n"
        "        source: {repo: github.com/org/shop-db}\n"
        f"      - name: {name}\n"
        "        source: {repo: github.com/org/warehouse-catalog}\n"
        "edges:\n"
        + "".join(f"  - from: orders\n    to: '{r}'\n" for r in refs)
    )


def _цели(parsed) -> list[list[str]]:
    return [parsed.nodes[e.target_idx].source_keys for e in parsed.edges]


def test_уточнитель_якоря_различает_тёзок():
    parsed, errors = parse_import(_тёзки_doc(
        "Ярмарка / Каталог-БД @ git:github.com/org/warehouse-catalog",
        "Ярмарка / Каталог-БД @ git:github.com/org/shop-db",
    ))
    assert errors == [] and parsed is not None
    assert _цели(parsed) == [
        ["git:github.com/org/warehouse-catalog"], ["git:github.com/org/shop-db"]
    ]


def test_уточнитель_переживает_слэш_фолбэк_и_хвост_пути():
    """Слэши ключа (git:github.com/org/x) не должны попасть под нормализацию пути:
    уточнитель отрезается ДО неё. Голова понимает всё то же, что обычная ссылка —
    путь слэшем без пробелов и однозначный хвост пути."""
    parsed, errors = parse_import(_тёзки_doc(
        "Ярмарка/Каталог-БД @ git:github.com/org/shop-db",
        "Каталог-БД @ git:github.com/org/warehouse-catalog",
    ))
    assert errors == [] and parsed is not None
    assert _цели(parsed) == [
        ["git:github.com/org/shop-db"], ["git:github.com/org/warehouse-catalog"]
    ]


def test_имя_с_собакой_по_прежнему_находится_точным_путём():
    """Точный путь — первым, как всегда: имя, в котором законно стоит « @ », не
    принимается за уточнитель, даже если хвост похож на ключ."""
    имя = "Каталог @ host:catalog"
    doc = (
        "nodes:\n  - name: Ярмарка\n    children:\n      - name: orders\n"
        f"      - name: '{имя}'\n"
        f"edges:\n  - from: orders\n    to: 'Ярмарка / {имя}'\n  - from: orders\n    to: '{имя}'\n"
    )
    parsed, errors = parse_import(doc)
    assert errors == [] and parsed is not None
    assert [parsed.nodes[e.target_idx].name for e in parsed.edges] == [имя, имя]


def test_незнакомый_или_чужой_ключ_уточнителя_не_находит_узел():
    """Хвост — не ключ якоря (снятый вид «img:») или ключ, которого нет ни у одного
    кандидата: узел не найден, угадывать тёзку нельзя."""
    parsed, errors = parse_import(_тёзки_doc(
        "Ярмарка / Каталог-БД @ img:org/catalog:1",
        "Ярмарка / Каталог-БД @ git:github.com/org/billing",
    ))
    assert parsed is None
    assert errors[0].startswith('edges[0]: узел "Ярмарка / Каталог-БД @ img:org/catalog:1" не найден')
    assert errors[1].startswith('edges[1]: узел "Ярмарка / Каталог-БД @ git:github.com/org/billing" не найден')


def test_неоднозначность_тёзок_называет_готовые_ссылки_с_уточнителем():
    """Путь указан, а тёзки его не различают — «укажите путь через " / "» тут
    бесполезен. Перечень — готовые ссылки с уточнителем, по алфавиту."""
    parsed, errors = parse_import(_тёзки_doc("Ярмарка / Каталог-БД"))
    assert parsed is None
    assert errors == [
        'edges[0]: имя "Ярмарка / Каталог-БД" неоднозначно (есть '
        '"Ярмарка / Каталог-БД @ git:github.com/org/shop-db", '
        '"Ярмарка / Каталог-БД @ git:github.com/org/warehouse-catalog") — укажите один из них'
    ]


def _безъякорные_doc(*refs: str) -> str:
    """«Ярмарка» с двумя «api» без якорей (Go раньше Python) + связи из «orders»."""
    return (
        "nodes:\n"
        "  - name: Ярмарка\n"
        "    children:\n"
        "      - name: orders\n"
        "      - name: api\n"
        "        technology: Go\n"
        "      - name: api\n"
        "        technology: Python\n"
        "edges:\n"
        + "".join(f"  - from: orders\n    to: '{r}'\n" for r in refs)
    )


def test_порядковый_уточнитель_берёт_n_го_тёзку_по_документу():
    """«путь @ #N» — N-й (с единицы) из узлов этого пути в порядке документа. Голова
    понимает всё то же, что обычная ссылка, — здесь однозначный хвост пути."""
    parsed, errors = parse_import(_безъякорные_doc(
        "Ярмарка / api @ #2", "Ярмарка / api @ #1", "api @ #2",
    ))
    assert errors == [] and parsed is not None
    assert [parsed.nodes[e.target_idx].technology for e in parsed.edges] == [
        "Python", "Go", "Python",
    ]


def test_порядковый_номер_вне_группы_или_кривой_не_находит_узел():
    """Номера за пределами группы и записи не канона («#0», «#01») — не уточнитель:
    узел не найден, угадывать соседа нельзя."""
    parsed, errors = parse_import(_безъякорные_doc(
        "Ярмарка / api @ #3", "Ярмарка / api @ #0", "Ярмарка / api @ #01",
    ))
    assert parsed is None
    assert [e.split(" не найден")[0] for e in errors] == [
        'edges[0]: узел "Ярмарка / api @ #3"',
        'edges[1]: узел "Ярмарка / api @ #0"',
        'edges[2]: узел "Ярмарка / api @ #01"',
    ]


def _дети_тёзок_doc(*refs: str, anchors: bool = True) -> str:
    """Два «Каталог-БД» в «Ярмарка», у каждого свой «reader». Якоря контейнеров —
    с решёткой и слэшами внутри ключа (git:repo#a/b) либо их нет вовсе (тогда
    контейнеры различает только технология: MySQL раньше Postgres)."""
    шоп = "        source: {repo: github.com/org/shop-db, path: a/b}\n" if anchors else ""
    сток = "        source: {repo: github.com/org/warehouse-catalog}\n" if anchors else ""
    return (
        "nodes:\n"
        "  - name: Ярмарка\n"
        "    children:\n"
        "      - name: orders\n"
        "      - name: Каталог-БД\n"
        "        technology: MySQL\n"
        + шоп
        + "        children:\n"
        "          - name: reader\n"
        "            technology: Go\n"
        "      - name: Каталог-БД\n"
        "        technology: Postgres\n"
        + сток
        + "        children:\n"
        "          - name: reader\n"
        "            technology: Python\n"
        "edges:\n"
        + "".join(f"  - from: orders\n    to: '{r}'\n" for r in refs)
    )


def test_уточнитель_на_сегменте_предка_различает_детей_тёзок():
    """Уточнитель стоит на ТОМ сегменте, где тёзка; путь режется по « / » с
    пробелами, и слэши с решёткой ключа («git:…#a/b») разрез не ломают. Голова
    понимает и однозначный хвост пути."""
    parsed, errors = parse_import(_дети_тёзок_doc(
        "Ярмарка / Каталог-БД @ git:github.com/org/shop-db#a/b / reader",
        "Ярмарка / Каталог-БД @ git:github.com/org/warehouse-catalog / reader",
        "Каталог-БД @ git:github.com/org/shop-db#a/b / reader",
    ))
    assert errors == [] and parsed is not None
    assert [parsed.nodes[e.target_idx].technology for e in parsed.edges] == [
        "Go", "Python", "Go",
    ]


def test_порядковый_уточнитель_на_сегменте_предка():
    parsed, errors = parse_import(_дети_тёзок_doc(
        "Ярмарка / Каталог-БД @ #2 / reader", "Ярмарка / Каталог-БД @ #1 / reader",
        anchors=False,
    ))
    assert errors == [] and parsed is not None
    assert [parsed.nodes[e.target_idx].technology for e in parsed.edges] == ["Python", "Go"]


def test_неоднозначность_детей_тёзок_называет_ссылки_с_уточнителем_предка():
    """Путь детей тёзок один на двоих — перечень готовых ссылок несёт уточнитель на
    сегменте предка. Без якорей называть кандидатов агенту нечем (порядковый
    номер ему не объявляется) — текст прежний."""
    parsed, errors = parse_import(_дети_тёзок_doc("Ярмарка / Каталог-БД / reader"))
    assert parsed is None
    assert errors == [
        'edges[0]: имя "Ярмарка / Каталог-БД / reader" неоднозначно (есть '
        '"Ярмарка / Каталог-БД @ git:github.com/org/shop-db#a/b / reader", '
        '"Ярмарка / Каталог-БД @ git:github.com/org/warehouse-catalog / reader")'
        " — укажите один из них"
    ]
    parsed, errors = parse_import(
        _дети_тёзок_doc("Ярмарка / Каталог-БД / reader", anchors=False)
    )
    assert errors == [
        'edges[0]: имя "Ярмарка / Каталог-БД / reader" неоднозначно, укажите путь через " / "'
    ]


def test_перечень_кандидатов_обрезан_с_честным_хвостом():
    """Кап — как у соседних перечней слияния: на проекте с полусотней одноимённых
    узлов список вытеснил бы остальные замечания. Хвост считаем, а не молчим о нём."""
    doc = (
        "nodes:\n"
        + "".join(f"  - name: c{i}\n    children:\n      - name: api\n" for i in range(8))
        + "  - name: x\nedges:\n  - from: x\n    to: api\n"
    )
    parsed, errors = parse_import(doc)
    assert parsed is None
    shown = ", ".join(f'"c{i} / api"' for i in range(6))
    assert errors == [
        f'edges[0]: имя "api" неоднозначно (есть {shown} и ещё 2) — укажите один из них'
    ]


def test_invalid_shape_and_type_errors_carry_paths():
    parsed, errors = parse_import(
        "nodes:\n"
        "  - name: A\n"
        "    children:\n"
        "      - name: B\n"
        "        shape: circle\n"
        "  - name: C\n"
        "    role: 5\n"
    )
    assert parsed is None
    assert any(e.startswith("nodes[0].children[0]: shape") for e in errors)
    assert any(e.startswith("nodes[1].role: ожидается строка") for e in errors)


def test_depth_limit():
    # Цепочка глубже MAX_DEPTH — ошибка с координатой места.
    doc: dict = {"name": "N0"}
    cur = doc
    for i in range(1, MAX_DEPTH + 1):
        kid = {"name": f"N{i}"}
        cur["children"] = [kid]
        cur = kid
    parsed, errors = parse_import(yaml.dump({"nodes": [doc]}, allow_unicode=True))
    assert parsed is None
    assert any(f"глубже {MAX_DEPTH}" in e for e in errors)


def test_empty_nodes_ok_and_unknown_keys_ignored():
    parsed, errors = parse_import("nodes: []\n")
    assert errors == [] and parsed is not None
    assert parsed.nodes == [] and parsed.edges == []
    # Неизвестные ключи (форвард-совместимость) молча игнорируются.
    parsed, errors = parse_import("nodes:\n  - name: A\n    color: red\nfuture_key: 1\n")
    assert errors == [] and parsed is not None and len(parsed.nodes) == 1


def test_edge_ref_resolves_by_path_suffix():
    """Хвост пути («svc / api») находит узел «Система / svc / api» — ИИ-агенты
    пишут пути от контейнера, а не от корня. Неоднозначный хвост — ошибка."""
    content = (
        "nodes:\n"
        "  - name: Система\n"
        "    children:\n"
        "      - name: svc\n"
        "        children:\n"
        "          - name: api\n"
        "      - name: gate\n"
        "edges:\n"
        "  - from: gate\n"
        "    to: svc / api\n"
    )
    parsed, errors = parse_import(content)
    assert errors == [] and parsed is not None
    assert len(parsed.edges) == 1
    # неоднозначный хвост: два «svc / api» под разными корнями
    dup = (
        "nodes:\n"
        "  - name: A\n"
        "    children:\n"
        "      - name: svc\n"
        "        children:\n"
        "          - name: api\n"
        "  - name: B\n"
        "    children:\n"
        "      - name: svc\n"
        "        children:\n"
        "          - name: api\n"
        "  - name: x\n"
        "edges:\n"
        "  - from: x\n"
        "    to: svc / api\n"
    )
    parsed, errors = parse_import(dup)
    assert parsed is None and any("неоднозначно" in e for e in errors)


def test_parse_tolerates_agent_fenced_output():
    """Вывод ИИ-агента: преамбула + ```yaml-блок (реальное поведение слабой модели
    в dogfood-прогоне) — вынимаем содержимое блока. Валидный документ с ``` внутри
    description фолбэк не задевает (сырой парс успешен)."""
    fenced = (
        "Теперь у меня достаточно информации.\n\n"
        "```yaml\nnodes:\n  - name: A\n  - name: B\nedges:\n  - from: A\n    to: B\n```\n"
    )
    parsed, errors = parse_import(fenced)
    assert errors == [] and parsed is not None
    assert [n.name for n in parsed.nodes] == ["A", "B"] and len(parsed.edges) == 1
    # преамбула БЕЗ fence (стресс-тест: встречается и такое) — срез от «nodes:»
    bare = "Now I have enough information.\n\nnodes:\n  - name: A\n  - name: B\nedges:\n  - from: A\n    to: B\n"
    parsed, errors = parse_import(bare)
    assert errors == [] and parsed is not None and len(parsed.nodes) == 2
    # совсем без yaml — ошибка остаётся
    parsed, errors = parse_import("просто текст без yaml")
    assert parsed is None and errors
    # валидный документ, в description которого встречаются ```
    raw = 'nodes:\n  - name: A\n    description: "пример: ```code``` внутри"\n'
    parsed, errors = parse_import(raw)
    assert errors == [] and parsed is not None and parsed.nodes[0].description is not None


def test_preview_reports_and_writes_nothing(db):
    ok = _preview("nodes:\n  - name: A\n  - name: B\nedges:\n  - from: A\n    to: B\n")
    assert (ok.ok, ok.node_count, ok.edge_count, ok.roots) == (True, 2, 1, ["A", "B"])

    bad = _preview("nodes:\n  - name: [x")
    assert bad.ok is False and bad.errors and bad.node_count == 0

    # Dry-run ничего не пишет: ни проектов, ни узлов.
    assert db.query(Project).count() == 0
    assert db.query(Node).count() == 0


def test_preview_lists_all_node_names(db):
    """node_names — ВСЕ узлы слитого дерева, включая вложенные: по ним фронт
    сравнивает попытки агента и показывает, что исчезло между ними."""
    content = (
        "nodes:\n"
        "  - name: Система\n"
        "    children:\n"
        "      - name: orders\n"
        "        children:\n"
        "          - name: api\n"
        "      - name: orders-db\n"
        "        shape: database\n"
        "  - name: Покупатель\n"
        "    shape: person\n"
    )
    out = _preview(content)
    assert out.ok and out.node_count == 5
    # Порядок обхода дерева: родитель раньше детей (корни — в порядке документа).
    assert out.node_names == ["Система", "orders", "api", "orders-db", "Покупатель"]

    # Битый YAML — узлов нет вовсе, сравнивать не с чем.
    bad = _preview("nodes:\n  - name: [x")
    assert bad.ok is False and bad.node_names == []


def test_preview_roots_capped_at_8(db):
    content = yaml.dump({"nodes": [{"name": f"R{i}"} for i in range(10)]}, allow_unicode=True)
    out = _preview(content)
    assert out.ok and out.node_count == 10
    assert out.roots == [f"R{i}" for i in range(8)]


# ── Мульти-файловый импорт (contents / import_yamls → merge_imports) ─────────

_MULTI_A = (
    "nodes:\n"
    "  - name: Система\n"
    "    children:\n"
    "      - name: payments\n"
    "        technology: Python\n"
    "      - name: orders\n"
    "edges:\n"
    "  - from: orders\n"
    "    to: payments\n"
    "    label: REST\n"
)
def test_preview_multi_contents_merges(db):
    b = "nodes:\n  - name: Система\n    children:\n      - name: orders\n        technology: Go\n"
    out = _preview(_MULTI_A, b)
    assert out.ok and out.files == 2
    assert out.node_count == 3  # Система + payments + orders (склеены)
    assert out.merged_count == 2 and "Система" in out.merged
    assert out.conflicts == [] and out.errors == []


def test_preview_node_names_include_merged_children(db):
    """Мульти-репо: имена собираются из СЛИТОГО дерева (дети второго файла тоже)."""
    b = (
        "nodes:\n"
        "  - name: Система\n"
        "    children:\n"
        "      - name: orders\n"
        "        children:\n"
        "          - name: worker\n"
    )
    out = _preview(_MULTI_A, b)
    assert out.ok and out.node_names == ["Система", "payments", "orders", "worker"]
    assert len(out.node_names) == out.node_count


def test_preview_multi_errors_prefixed_by_file(db):
    out = _preview(_MULTI_A, "nodes:\n  - name: [оборвано")
    assert out.ok is False and out.files == 2
    # Единый путь адресует бедой ВХОД (чип панели), а не «файл»: нумерация та же.
    assert any(e.startswith("вход 2: ") for e in out.errors)


def test_preview_splits_remarks_by_file_and_schema(db):
    """Ф6: те же замечания превью дополнительно разложены по природе — что уносят
    агенту конкретного репозитория (он видит только свой код) и что решает человек,
    видящий весь ландшафт.

    Плоские conflicts/warnings/errors — прежний контракт (их читают MCP-тулза
    archmap_import_preview и нынешний фронт): новые поля лишь повторяют их разбивкой,
    объединение корзин обязано совпасть со списком.
    """
    b = (
        "nodes:\n"
        "  - name: Система\n"
        "    children:\n"
        "      - name: payments\n"
        "        technology: Go\n"
        "      - name: Оператор\n"
        "        shape: person\n"
    )
    out = _preview(_MULTI_A, b)

    assert out.ok and out.files == 2
    assert [f.file for f in out.file_remarks] == [1, 2]
    # Человек внутри системы и объект без связей — содержимое файла 2, его агенту.
    assert out.file_remarks[0].warnings == []
    assert any("человек" in w for w in out.file_remarks[1].warnings)
    assert any("без единой связи" in w for w in out.file_remarks[1].warnings)
    # Расхождение technology между файлами — только пользователю.
    assert any("оставлено «Python»" in w for w in out.schema_warnings)
    assert out.schema_errors == []
    # Совместимость: плоские списки — те же строки, ничего не потеряно и не удвоено.
    assert sorted(
        [w for f in out.file_remarks for w in f.warnings] + out.schema_warnings
    ) == sorted(out.conflicts + out.warnings)


def test_preview_single_file_keeps_everything_in_one_bucket(db):
    """Одно-файловый режим не меняется ничем: агент видит всю систему и чинит всё,
    поэтому схемные корзины пусты, а замечания лежат единственным списком."""
    content = (
        "nodes:\n"
        "  - name: Система\n"
        "    children:\n"
        "      - name: vote\n"
        "      - name: redis\n"
        "      - name: Оператор\n"
        "        shape: person\n"
        "      - name: Админка\n"
        "edges:\n"
        "  - from: vote\n"
        "    to: redis\n"
        "  - from: Оператор\n"
        "    to: Админка\n"
    )
    out = _preview(content)

    assert out.ok and out.files == 1
    assert (out.schema_errors, out.schema_warnings) == ([], [])
    assert len(out.file_remarks) == 1 and out.file_remarks[0].file == 1
    assert out.file_remarks[0].warnings == out.conflicts + out.warnings
    # В том числе изоляция — при нескольких файлах она схемная, здесь чинит агент.
    assert any("не связана с остальной схемой" in w for w in out.file_remarks[0].warnings)

    bad = _preview("nodes:\n  - name: [x")
    # Те же ошибки: в корзине файла — как есть, в плоском списке — с адресом входа.
    assert bad.ok is False and bad.file_remarks[0].errors
    assert bad.errors == [f"вход 1: {e}" for e in bad.file_remarks[0].errors]


def test_preview_requires_some_content():
    """Ни одного входа — внятный отказ, а не пустая сводка «ноль узлов»."""
    with pytest.raises(UnifiedImportError):
        build_unified_plan([])


def test_seed_project_from_multiple_yamls(db):
    """Полный цикл мульти-репо: два YAML сливаются в одну схему проекта."""
    b = "nodes:\n  - name: Система\n    children:\n      - name: orders\n        technology: Go\n"
    p = seed_project_from_yaml(db, [_MULTI_A, b], name="Мульти")
    assert db.query(Node).filter(Node.project_id == p.id).count() == 3
    assert db.query(Edge).filter(Edge.project_id == p.id).count() == 1
    tech = {n.name: n.technology for n in db.query(Node).filter(Node.project_id == p.id)}
    assert tech == {"Система": None, "payments": "Python", "orders": "Go"}


# ── Лимит числа файлов (MAX_INPUTS единого пути) ──────────────────────────────
def test_preview_many_files_merges(db):
    """Лимит поднят под крупные мульти-репо: десятки файлов (здесь 20) сливаются."""
    files = [
        f"nodes:\n  - name: Система\n    children:\n      - name: svc{i}\n"
        for i in range(20)
    ]
    out = _preview(*files)
    assert out.ok and out.files == 20
    assert out.node_count == 21  # общий корень «Система» + 20 сервисов


def test_import_over_file_limit_rejected():
    """Больше MAX_INPUTS документов за раз — отказ ещё до разбора."""
    with pytest.raises(UnifiedImportError):
        build_unified_plan([(f"f{i}.yaml", b"nodes: []") for i in range(MAX_INPUTS + 1)])


def test_source_block_parsed_into_keys():
    """Блок source узла → канонические ключи идентичности (Фаза 0 синка).
    Форма записи git-remote роли не играет — ключ один и тот же."""
    content = (
        "nodes:\n"
        "  - name: payments\n"
        "    source:\n"
        "      repo: git@github.com:Org/Payments.git\n"
        "      host: payments\n"
    )
    parsed, errors = parse_import(content)
    assert errors == [] and parsed is not None
    assert parsed.nodes[0].source_keys == [
        "git:github.com/org/payments",
        "host:payments",
    ]
    assert parsed.warnings == []


def test_source_снятые_виды_якоря_игнорируются_с_предупреждением():
    """Образ и объект k8s перестали быть якорями 2026-09-04 (docs/plan-anchor-ux.md),
    но пакеты, собранные прежним промптом, обязаны ввозиться: поля не ошибка, они
    просто не дают ключа — и об этом одно предупреждение на узел."""
    content = (
        "nodes:\n"
        "  - name: payments\n"
        "    source:\n"
        "      image: reg.io/org/payments:1.4\n"
        "      deployment: prod/payments\n"
        "      host: payments\n"
    )
    parsed, errors = parse_import(content)
    assert errors == [] and parsed is not None
    assert parsed.nodes[0].source_keys == ["host:payments"]
    assert parsed.warnings == [
        "nodes[0].source: образ и деплоймент больше не источник — поле проигнорировано"
    ]


def test_source_block_optional_and_tolerant():
    """Якорей нет — узел живёт как раньше (пустой набор ключей). Кривой блок —
    ошибка формата, но узел не пропадает: якоря необязательны."""
    parsed, errors = parse_import("nodes:\n  - name: A\n")
    assert errors == [] and parsed is not None
    assert parsed.nodes[0].source_keys == []

    parsed, errors = parse_import("nodes:\n  - name: A\n    source: github.com/org/a\n")
    assert parsed is None  # ошибки формата валят импорт целиком
    assert any("source: ожидается словарь" in e for e in errors)


def test_source_unknown_subkeys_ignored():
    """Неизвестные вложенные ключи — как и на верхнем уровне, молча игнорируются
    (формат форвард-совместим: агент мог прислать больше, чем мы читаем)."""
    content = "nodes:\n  - name: A\n    source:\n      repo: github.com/org/a\n      branch: main\n"
    parsed, errors = parse_import(content)
    assert errors == [] and parsed is not None
    assert parsed.nodes[0].source_keys == ["git:github.com/org/a"]


def test_source_ref_persisted_on_import(db):
    """Якорь доезжает до БД: в nodes.source_ref ложится сильнейший ключ прогона —
    по нему будущий синк узнает узел даже после переименования сервиса."""
    content = (
        "nodes:\n"
        "  - name: Система\n"
        "    children:\n"
        "      - name: payments\n"
        "        source: {repo: git@github.com:Org/Payments.git, host: payments}\n"
        "      - name: legacy\n"
    )
    p = seed_project_from_yaml(db, [content])
    refs = {n.name: n.source_ref for n in db.query(Node).filter(Node.project_id == p.id)}
    assert refs == {
        "Система": None,  # у корня-системы якоря нет
        "payments": "git:github.com/org/payments",
        "legacy": None,  # узел без блока source
    }


def test_связь_путём_со_слэшем_без_пробелов_находит_узел():
    # Слабые модели пишут «worker/queue-reader» вместо «worker / queue-reader».
    # Стало важно, когда промпт начал требовать адресовать связи компонентов:
    # до этого рёбра ссылались на голые имена и слэшей в них не бывало.
    parsed, errors = parse_import(
        "nodes:\n"
        "- name: Система\n"
        "  children:\n"
        "  - name: worker\n"
        "    children:\n"
        "    - name: queue-reader\n"
        "  - name: redis\n"
        "edges:\n"
        "- from: worker/queue-reader\n"
        "  to: redis\n"
    )

    assert errors == [] and parsed is not None
    src = parsed.nodes[parsed.edges[0].source_idx].name
    assert src == "queue-reader"


def test_roundtrip_канала_связи(db):
    """Канал брокера (Ф3) переживает экспорт→импорт: связь по имени канала — часть
    семантики схемы, а не служебное поле. Без разбора в import_yaml экспорт вернулся
    бы обезличенным, и «откуда взялось событие» снова стало бы неотвечаемым."""
    src = _project(db, "Источник")
    ярмарка = _node(db, src.id, "Ярмарка")
    orders = _node(db, src.id, "orders", ярмарка)
    kafka = _node(db, src.id, "Kafka", ярмарка, shape="broker")
    db.add(Edge(id=uuid.uuid4(), project_id=src.id, source_id=orders.id, target_id=kafka.id,
                label="событие", channel="orders.created"))
    db.add(Edge(id=uuid.uuid4(), project_id=src.id, source_id=kafka.id, target_id=orders.id))
    db.commit()

    nodes = db.query(Node).filter(Node.project_id == src.id).all()
    edges = db.query(Edge).filter(Edge.project_id == src.id).all()
    parsed, errors = parse_import(build_export(nodes, edges))

    assert errors == [] and parsed is not None
    dst = _project(db, "Приёмник")
    seed_import(db, dst.id, parsed)
    db.commit()

    assert _semantic_signature(db, src.id) == _semantic_signature(db, dst.id)
    каналы = {
        e.channel for e in db.query(Edge).filter(Edge.project_id == dst.id).all()
    }
    assert каналы == {"orders.created", None}


def test_канал_не_строка_это_ошибка_разбора(db):
    """Толерантность формата не означает молчания о кривом типе: «channel: 42» —
    ошибка с адресом, как у label/technology (иначе поле тихо потерялось бы)."""
    content = yaml.dump(
        {
            "nodes": [{"name": "orders"}, {"name": "Kafka", "shape": "broker"}],
            "edges": [{"from": "orders", "to": "Kafka", "channel": 42}],
        },
        allow_unicode=True,
    )

    parsed, errors = parse_import(content)

    assert parsed is None
    assert errors == ["edges[0].channel: ожидается строка"]


def test_roundtrip_якоря_источника_и_типа_канала(db):
    """Ф0 архива (Д1, Д2). Якорь source_ref обязан пережить экспорт→импорт: без
    него перенесённый проект теряет идентичность узлов для синка, и переименованный
    сервис задвоится. Тип канала — только ЯВНЫЙ: NULL значит «дефолт синхронный»,
    его не пишем, иначе дефолт затвердел бы в true."""
    src = _project(db, "Источник")
    ярмарка = _node(db, src.id, "Ярмарка")
    orders = _node(db, src.id, "orders", ярмарка)
    orders.source_ref = "git:github.com/shop/orders#services/orders"
    витрина = _node(db, src.id, "web", ярмарка)
    витрина.source_ref = "git:github.com/shop/web"
    kafka = _node(db, src.id, "Kafka", ярмарка, shape="broker")
    kafka.source_ref = "host:kafka"
    db.add(Edge(id=uuid.uuid4(), project_id=src.id, source_id=orders.id, target_id=kafka.id,
                channel="orders.created", is_synchronous=False))
    db.add(Edge(id=uuid.uuid4(), project_id=src.id, source_id=витрина.id, target_id=orders.id,
                label="создать заказ", is_synchronous=True))
    db.add(Edge(id=uuid.uuid4(), project_id=src.id, source_id=ярмарка.id, target_id=kafka.id))
    db.commit()

    nodes = db.query(Node).filter(Node.project_id == src.id).all()
    edges = db.query(Edge).filter(Edge.project_id == src.id).all()
    content = build_export(nodes, edges)
    parsed, errors = parse_import(content)

    assert errors == [] and parsed is not None
    dst = _project(db, "Приёмник")
    seed_import(db, dst.id, parsed)
    db.commit()

    # Сигнатура сверяет и source_ref, и is_synchronous (расширена этой же фазой).
    assert _semantic_signature(db, src.id) == _semantic_signature(db, dst.id)
    # Явная сверка формы: канонический ключ собрался в ТОТ ЖЕ вид, что хранился.
    новые = {n.name: n.source_ref for n in db.query(Node).filter(Node.project_id == dst.id)}
    assert новые["orders"] == "git:github.com/shop/orders#services/orders"
    assert новые["web"] == "git:github.com/shop/web"
    assert новые["Kafka"] == "host:kafka"
    # NULL остался NULL — дефолт не затвердел.
    syncs = {(e.label, e.is_synchronous)
             for e in db.query(Edge).filter(Edge.project_id == dst.id)}
    assert syncs == {(None, False), ("создать заказ", True), (None, None)}


def test_sync_не_булево_это_ошибка_разбора(db):
    """Толерантность — не молчание: «sync: да» — ошибка с адресом, поле не
    теряется тихо (та же норма, что у channel)."""
    content = yaml.dump(
        {
            "nodes": [{"name": "a"}, {"name": "b"}],
            "edges": [{"from": "a", "to": "b", "sync": "да"}],
        },
        allow_unicode=True,
    )

    parsed, errors = parse_import(content)

    # Ошибка типа не роняет разбор целиком: поле обнуляется, ошибка в списке.
    assert errors == ["edges[0].sync: ожидается true/false"]
    assert parsed is None


# ── Основание склейки и якоря в превью импорта (Ф2 docs/plan-anchor-ux.md) ───


def test_preview_называет_основание_каждой_склейки(db):
    """Три склейки трёх видов в одном пакете: по коду, по имени зависимости и по
    имени. До Ф2 превью говорило «склеено узлов: 3», не называя почему."""
    a = (
        "nodes:\n"
        "  - name: Система\n"
        "    children:\n"
        "      - name: payments\n"
        "        source: {repo: github.com/org/payments}\n"
        "      - name: Каталог-БД\n"
        "        source: {host: catalog-db}\n"
        "      - name: orders\n"
    )
    b = (
        "nodes:\n"
        "  - name: Система\n"
        "    children:\n"
        "      - name: payments\n"
        "        technology: Go\n"
        "        source: {repo: github.com/org/payments}\n"
        "      - name: Каталог-БД\n"
        "        source: {host: catalog-db}\n"
        "      - name: orders\n"
    )
    out = _preview(a, b)

    assert out.ok and out.merged_count == 4
    assert {m.path: m.basis for m in out.merged_nodes} == {
        "Система": "name",
        "Система / payments": "code",
        "Система / Каталог-БД": "dependency",
        "Система / orders": "name",
    }
    # Старое поле путей осталось прежним — контракты превью только дополняются.
    assert out.merged == [m.path for m in out.merged_nodes]


def test_preview_считает_узлы_без_якоря(db):
    """Счётчик «будут опознаваться по имени» — про СЛИТОЕ дерево, а не про файл."""
    один = (
        "nodes:\n"
        "  - name: Система\n"
        "    children:\n"
        "      - name: payments\n"
        "        source: {repo: github.com/org/payments}\n"
        "      - name: orders\n"
    )
    out = _preview(один)

    assert out.ok and out.node_count == 3
    assert out.nodes_without_anchor == 2  # корень «Система» и «orders»
    assert out.merged_nodes == []  # один файл — склеек нет


# ── Площадки развёртывания: раздел deployment и sites у узла (Ф4) ─────────────

РАЗМЕЩЕНИЕ = """
nodes:
  - name: Витрина
    sites: [Облако]
    children:
      - name: API
        sites: [Кластер prod, ВМ-2, Кластер prod]
      - name: Корзина
  - name: Покупатель
    shape: person
edges: []
deployment:
  sites:
    - name: Кластер prod
      kind: kubernetes
      technology: k3s
      parent: Облако
    - name: Облако
      kind: cloud
      description: прод
    - name: ВМ-2
      kind: vm
"""


def test_площадки_разбираются_родители_раньше_детей():
    parsed, ошибки = parse_import(РАЗМЕЩЕНИЕ)

    assert ошибки == [] and parsed is not None and parsed.warnings == []
    # Кластер объявлен раньше облака, но в разборе родитель идёт первым.
    assert [(s.name, s.kind, s.parent_idx) for s in parsed.sites] == [
        ("Облако", "cloud", None),
        ("Кластер prod", "kubernetes", 0),
        ("ВМ-2", "vm", None),
    ]
    assert (parsed.sites[1].technology, parsed.sites[0].description) == ("k3s", "прод")
    # Повтор имени у одного узла схлопнут молча; у ребёнка без ключа — пусто.
    assert [(n.name, n.sites) for n in parsed.nodes] == [
        ("Витрина", ["Облако"]),
        ("API", ["Кластер prod", "ВМ-2"]),
        ("Корзина", []),
        ("Покупатель", []),
    ]


def test_неявная_площадка_создаётся_с_предупреждением():
    parsed, ошибки = parse_import("nodes:\n  - name: API\n    sites: [prod, prod]\n")

    assert ошибки == [] and parsed is not None
    assert [(s.name, s.kind, s.declared) for s in parsed.sites] == [("prod", "other", False)]
    assert parsed.warnings == [
        "площадка «prod» не объявлена в deployment — создана с видом «другое»"
    ]


def test_размещение_пользователя_игнорируется_с_замечанием():
    parsed, ошибки = parse_import(
        "nodes:\n  - name: Клиент\n    shape: person\n    sites: [prod]\n"
    )

    assert ошибки == [] and parsed is not None
    assert parsed.nodes[0].sites == [] and parsed.sites == []
    assert parsed.warnings == [
        "nodes[0].sites: у пользователя нет размещения — список проигнорирован"
    ]


@pytest.mark.parametrize(
    ("площадки", "ошибка"),
    [
        ("[{name: A, kind: dc}]",
         "deployment.sites[0]: kind 'dc' не поддерживается "
         "(cloud | kubernetes | vm | physical | other)"),
        ("[{name: A, parent: Б}]",
         "deployment.sites[0].parent: площадка «Б» не объявлена в deployment.sites"),
        ("[{name: A, parent: A}]",
         "deployment.sites[0].parent: площадка не может быть вложена сама в себя"),
        ("[{name: A, parent: B}, {name: B, parent: C}, {name: C, parent: A}]",
         "deployment.sites[0].parent: цикл вложенности площадок («A» → «B» → «C» → «A»)"),
        ("[{name: A}, {name: A}]", "deployment.sites[1]: площадка «A» объявлена дважды"),
        ("[{name: '  '}]", "deployment.sites[0]: name — обязательная непустая строка"),
        ("[{name: A, technology: [k3s]}]", "deployment.sites[0].technology: ожидается строка"),
        ("{name: A}", "deployment.sites: ожидается список площадок"),
    ],
)
def test_ошибки_раздела_площадок(площадки, ошибка):
    parsed, ошибки = parse_import(f"nodes: []\ndeployment:\n  sites: {площадки}\n")

    assert parsed is None
    assert ошибки == [ошибка]


def test_ошибки_ключа_sites_у_узла():
    parsed, ошибки = parse_import(
        "nodes:\n  - name: A\n    sites: prod\n  - name: B\n    sites: [prod, 3]\n"
    )

    assert parsed is None
    assert ошибки == [
        "nodes[0].sites: ожидается список имён площадок",
        "nodes[1].sites[1]: ожидается имя площадки строкой",
    ]


def test_документ_без_раздела_и_ключа_разбирается_по_прежнему():
    parsed, ошибки = parse_import("nodes:\n  - name: A\nedges: []\n")

    assert ошибки == [] and parsed is not None
    assert parsed.sites == [] and parsed.nodes[0].sites == [] and parsed.warnings == []


def test_посев_создаёт_площадки_и_экземпляры(db):
    parsed, _ = parse_import(РАЗМЕЩЕНИЕ)
    assert parsed is not None
    p = _project(db)

    ids = seed_import(db, p.id, parsed)
    db.commit()

    площадки = {s.name: s for s in db.query(DeploymentSite).filter(DeploymentSite.project_id == p.id)}
    assert set(площадки) == {"Облако", "Кластер prod", "ВМ-2"}
    assert площадки["Кластер prod"].parent_id == площадки["Облако"].id
    assert (площадки["Кластер prod"].kind, площадки["Кластер prod"].technology) == (
        "kubernetes", "k3s"
    )
    имя_площадки = {s.id: name for name, s in площадки.items()}
    имя_узла = dict(zip(ids, (n.name for n in parsed.nodes), strict=True))
    экземпляры = {
        (имя_узла[i.node_id], имя_площадки[i.site_id])
        for i in db.query(DeploymentInstance).filter(DeploymentInstance.project_id == p.id)
    }
    # Размещение — у объектов: API — своё объявление, Корзина — объявление контейнера
    # «Витрина» (размещается целиком), у самой «Витрины» экземпляров нет.
    assert экземпляры == {("Корзина", "Облако"), ("API", "Кластер prod"), ("API", "ВМ-2")}


РАЗМЕЩЕНИЕ_C4 = """
nodes:
  - name: shop
    sites: [ВМ]
    children:
      - name: orders
        element: container
        sites: [Облако]
        children:
          - name: api
            sites: [ВМ]
          - name: worker
      - name: billing
      - name: mail
        element: container
        children:
          - name: sender
deployment:
  sites:
    - name: Облако
    - name: ВМ
"""


def _экземпляры(db, project_id, ids, parsed) -> set[tuple[str, str]]:
    имя_узла = dict(zip(ids, (n.name for n in parsed.nodes), strict=True))
    площадки = {s.id: s.name for s in db.query(DeploymentSite).filter(DeploymentSite.project_id == project_id)}
    return {
        (имя_узла[i.node_id], площадки[i.site_id])
        for i in db.query(DeploymentInstance).filter(DeploymentInstance.project_id == project_id)
    }


def test_посев_размещения_по_единицам(db):
    """Единица — контейнер (Р16): своё объявление orders — ему самому; объявление
    системы shop — её единицам без своего (billing и mail целиком, не sender);
    объявление компонента api — замечание, площадки пропущены, экземпляров нет."""
    parsed, ошибки = parse_import(РАЗМЕЩЕНИЕ_C4)
    assert ошибки == [] and parsed is not None
    assert parsed.warnings == [
        "shop / orders / api: размещение задаётся контейнеру «orders» — площадки у компонента "
        "пропущены",
    ]
    assert {n.name: n.sites for n in parsed.nodes}["api"] == []
    p = _project(db)

    ids = seed_import(db, p.id, parsed)
    db.commit()

    assert _экземпляры(db, p.id, ids, parsed) == {
        ("orders", "Облако"), ("billing", "ВМ"), ("mail", "ВМ"),
    }


def test_roundtrip_площадок_байт_в_байт(db):
    """Экспорт → импорт → экспорт: раздел deployment и sites узлов возвращаются теми
    же байтами (у нового проекта другие id, а документ — тот же)."""
    parsed, _ = parse_import(РАЗМЕЩЕНИЕ)
    assert parsed is not None
    src = _project(db, "Источник")
    seed_import(db, src.id, parsed)
    db.commit()

    def экспорт(project_id) -> str:
        nodes = db.query(Node).filter(Node.project_id == project_id).all()
        edges = db.query(Edge).filter(Edge.project_id == project_id).all()
        sites = project_sites(db, project_id)
        return build_export(nodes, edges, sites=sites,
                            instances=ordered_instances(db, project_id, sites))

    первый = экспорт(src.id)
    повтор, ошибки = parse_import(первый)
    assert ошибки == [] and повтор is not None
    dst = _project(db, "Приёмник")
    seed_import(db, dst.id, повтор)
    db.commit()

    assert "deployment:" in первый and "sites:" in первый
    assert экспорт(dst.id) == первый


# --- Элемент архитектуры (эпик «Элемент архитектуры», Ф2: Р29, Р3, Р5, Р6) ---


def _yaml(nodes: list) -> str:
    return yaml.safe_dump({"nodes": nodes}, allow_unicode=True, sort_keys=False)


def test_элемент_разбирается_и_сеется(db):
    """element берётся как есть: у узла с детьми и у листа-сервиса (намерение, Р3) —
    без замечаний; без ключа — «не сказано» (None)."""
    текст = _yaml([{
        "name": "Ярмарка", "element": "system", "children": [
            {"name": "orders", "element": "container", "children": [{"name": "api"}]},
            {"name": "billing", "element": "container"},
            {"name": "orders-db", "shape": "database"},
        ],
    }])
    parsed, errors = parse_import(текст)
    assert errors == [] and parsed is not None
    assert parsed.warnings == []
    assert [(n.name, n.element) for n in parsed.nodes] == [
        ("Ярмарка", "system"), ("orders", "container"), ("api", None),
        ("billing", "container"), ("orders-db", None),
    ]
    p = _project(db)
    ids = seed_import(db, p.id, parsed)
    db.commit()
    by_id = {n.id: n for n in db.query(Node).filter(Node.project_id == p.id)}
    assert [by_id[i].element for i in ids] == ["system", "container", None, "container", None]


def test_чужой_элемент_ошибка_как_у_формы():
    parsed, errors = parse_import(_yaml([
        {"name": "Ярмарка", "element": "component"},
        {"name": "Склад", "element": 5},
    ]))
    assert parsed is None
    assert errors == [
        "nodes[0]: element 'component' не поддерживается (system | container)",
        "nodes[1]: element 5 не поддерживается (system | container)",
    ]


def test_элемент_у_не_сервиса_снят_с_замечанием():
    parsed, errors = parse_import(_yaml([{
        "name": "Ярмарка", "children": [
            {"name": "orders-db", "shape": "database", "element": "container"},
            {"name": "Покупатель", "shape": "person", "element": "system"},
        ],
    }]))
    assert errors == [] and parsed is not None
    assert [n.element for n in parsed.nodes] == [None, None, None]
    assert parsed.warnings == [
        "Ярмарка / orders-db: элемент архитектуры задаётся только у сервиса — значение пропущено",
        "Ярмарка / Покупатель: элемент архитектуры задаётся только у сервиса — значение пропущено",
    ]


def _родители(parsed) -> dict[str, str | None]:
    return {
        n.name: None if n.parent_idx is None else parsed.nodes[n.parent_idx].name
        for n in parsed.nodes
    }


def test_база_и_брокер_из_контейнера_вынесены_уровнем_выше_текстом_владельца(db):
    """Решение владельца Р6: база и брокер внутри контейнера выносятся к его родителю,
    контейнер остаётся контейнером; замечание — адресом контейнера и новым местом."""
    parsed, errors = parse_import(_yaml([{
        "name": "Ярмарка", "children": [
            {"name": "orders", "element": "container", "children": [
                {"name": "api"}, {"name": "orders-db", "shape": "database"},
            ]},
            {"name": "events", "element": "container", "children": [
                {"name": "relay"}, {"name": "Kafka", "shape": "broker"},
            ]},
        ],
    }]))
    assert errors == [] and parsed is not None
    assert {n.name: n.element for n in parsed.nodes} == {
        "Ярмарка": None, "orders": "container", "api": None, "orders-db": None,
        "events": "container", "relay": None, "Kafka": None,
    }
    assert _родители(parsed) == {
        "Ярмарка": None, "orders": "Ярмарка", "api": "orders", "orders-db": "Ярмарка",
        "events": "Ярмарка", "relay": "events", "Kafka": "Ярмарка",
    }
    assert parsed.warnings == [
        "Ярмарка / orders: внутри лежит база данных «orders-db», она не может входить в "
        "состав контейнера — вынесена на уровень выше, в «Ярмарка»",
        "Ярмарка / events: внутри лежит брокер «Kafka», он не может входить в состав "
        "контейнера — вынесен на уровень выше, в «Ярмарка»",
    ]
    # Документ входа помнит, где база была записана: по этому адресу её находят
    # файлы семей своего архива (unified_import._Resolver).
    assert [None if p is None else parsed.nodes[p].name for p in parsed.doc_parents] == [
        None, "Ярмарка", "orders", "orders", "Ярмарка", "events", "events",
    ]
    # Посев кладёт базу туда, куда её вынес разбор.
    p = _project(db)
    ids = seed_import(db, p.id, parsed)
    db.commit()
    by_id = {n.id: n for n in db.query(Node).filter(Node.project_id == p.id)}
    база = by_id[ids[3]]
    assert база.name == "orders-db" and база.parent_id == ids[0]
    assert by_id[ids[1]].element == "container"


def test_база_корневого_контейнера_вынесена_на_верхний_уровень():
    parsed, errors = parse_import(_yaml([{
        "name": "orders", "element": "container", "children": [
            {"name": "api"}, {"name": "orders-db", "shape": "database"},
        ],
    }]))
    assert errors == [] and parsed is not None
    assert _родители(parsed) == {"orders": None, "api": "orders", "orders-db": None}
    assert parsed.nodes[0].element == "container"
    assert parsed.warnings == [
        "orders: внутри лежит база данных «orders-db», она не может входить в состав "
        "контейнера — вынесена на верхний уровень",
    ]


def test_база_глубже_в_составном_компоненте_тоже_вынесена_а_её_ребёнок_поднят_раньше():
    """База внутри составного компонента контейнера — тоже в его составе: выносится к
    родителю контейнера. Вложенный в базу объект поднимается раньше (у базы вложенных
    объектов не бывает) — к её родителю «api» — и дальше судится по новому месту: он
    компонент «orders» и остаётся в контейнере."""
    parsed, errors = parse_import(_yaml([{
        "name": "Ярмарка", "children": [
            {"name": "orders", "element": "container", "children": [
                {"name": "api", "children": [
                    {"name": "handlers"},
                    {"name": "orders-db", "shape": "database", "children": [
                        {"name": "orders-schema"},
                    ]},
                ]},
            ]},
        ],
    }]))
    assert errors == [] and parsed is not None
    assert _родители(parsed) == {
        "Ярмарка": None, "orders": "Ярмарка", "api": "orders", "handlers": "api",
        "orders-db": "Ярмарка", "orders-schema": "api",
    }
    assert parsed.nodes[1].element == "container"
    assert parsed.warnings == [
        "Ярмарка / orders / api / orders-db: у базы данных «orders-db» вложенных объектов "
        "не бывает — «orders-schema» поднят на уровень выше, в «Ярмарка / orders / api»",
        STORE_LIFTED_NOTE["database"].format(
            path="Ярмарка / orders", name="orders-db", where="на уровень выше, в «Ярмарка»",
        ),
    ]


@pytest.mark.parametrize(("shape", "holder", "word"), [
    ("database", "orders-db", "у базы данных"), ("broker", "Kafka", "у брокера"),
    ("person", "Покупатель", "у пользователя"),
])
def test_у_базы_брокера_и_пользователя_вложенный_объект_поднят_с_поддеревом(shape, holder, word):
    """Вложенных объектов у базы, брокера и «Пользователя» не бывает (API отказывает, N4):
    ввоз файла не отвергается — ребёнок с поддеревом поднимается к родителю такого
    объекта и становится его соседом, с замечанием."""
    parsed, errors = parse_import(_yaml([{
        "name": "Ярмарка", "children": [
            {"name": holder, "shape": shape, "children": [
                {"name": "orders-schema", "children": [{"name": "tables"}]},
            ]},
        ],
    }]))
    assert errors == [] and parsed is not None
    assert _родители(parsed) == {
        "Ярмарка": None, holder: "Ярмарка", "orders-schema": "Ярмарка",
        "tables": "orders-schema",
    }
    assert parsed.doc_parents == [None, 0, 1, 2]
    assert parsed.warnings == [
        f"Ярмарка / {holder}: {word} «{holder}» вложенных объектов не бывает — "
        "«orders-schema» поднят на уровень выше, в «Ярмарка»",
    ]


def test_корневой_брокер_отдаёт_вложенный_объект_на_верхний_уровень():
    parsed, errors = parse_import(_yaml([
        {"name": "Kafka", "shape": "broker", "children": [{"name": "events"}, {"name": "audit"}]},
    ]))
    assert errors == [] and parsed is not None
    assert _родители(parsed) == {"Kafka": None, "events": None, "audit": None}
    assert parsed.roots == ["Kafka", "events", "audit"]
    assert parsed.warnings == [
        CHILDLESS_LIFTED_NOTE["broker"].format(
            path="Kafka", name="Kafka", child=c, where="на верхний уровень",
        )
        for c in ("events", "audit")
    ]


def test_поднятая_из_базы_база_дальше_выносится_из_контейнера():
    """Подъём идёт первым, поднятый судится по новому месту: база из базы оказывается в
    контейнере — и правило контейнера выносит её на уровень выше вместе с первой."""
    parsed, errors = parse_import(_yaml([{
        "name": "orders", "element": "container", "children": [
            {"name": "api"},
            {"name": "orders-db", "shape": "database", "children": [
                {"name": "orders-replica", "shape": "database"},
            ]},
        ],
    }]))
    assert errors == [] and parsed is not None
    assert _родители(parsed) == {
        "orders": None, "api": "orders", "orders-db": None, "orders-replica": None,
    }
    assert parsed.nodes[0].element == "container"
    assert parsed.warnings == [
        CHILDLESS_LIFTED_NOTE["database"].format(
            path="orders / orders-db", name="orders-db", child="orders-replica",
            where="на уровень выше, в «orders»",
        ),
        STORE_LIFTED_NOTE["database"].format(path="orders", name="orders-db", where="на верхний уровень"),
        STORE_LIFTED_NOTE["database"].format(
            path="orders", name="orders-replica", where="на верхний уровень",
        ),
    ]


def test_поднятый_из_базы_берёт_её_размещение_но_не_внутри_контейнера():
    """База с вложенным объектом читалась системой и отдавала ему своё объявление площадок
    (unit_placements): поднятый без своих площадок берёт объявление базы, своё не трогается.
    Внутри контейнера размещения не было ни у базы, ни у её детей — брать нечего."""
    parsed, errors = parse_import(_yaml([{
        "name": "Ярмарка", "children": [
            {"name": "orders-db", "shape": "database", "sites": ["prod"], "children": [
                {"name": "migrator"}, {"name": "backup", "sites": ["dr"]},
            ]},
            {"name": "billing", "element": "container", "children": [
                {"name": "api"},
                {"name": "ledger", "shape": "service", "children": [
                    {"name": "ledger-db", "shape": "database", "sites": ["prod"], "children": [
                        {"name": "ledger-migrator"},
                    ]},
                ]},
            ]},
        ],
    }]))
    assert errors == [] and parsed is not None
    sites = {n.name: n.sites for n in parsed.nodes}
    assert sites["migrator"] == ["prod"] and sites["backup"] == ["dr"]
    assert sites["ledger-migrator"] == []
    assert _родители(parsed)["ledger-migrator"] == "ledger"


def test_закреплённый_ребёнок_базы_не_поднимается():
    """Живое против живого ввоз не судит: закреплённый (живой при догрузке) объект под
    базой остаётся на месте без замечания; новый под живой базой — поднимается."""
    parsed, _ = parse_import(_yaml([{"name": "Ярмарка"}, {"name": "orders-db", "shape": "database"},
                                    {"name": "orders-schema"}, {"name": "migrator"}]))
    assert parsed is not None
    parsed.nodes[2].parent_idx = 1
    parsed.nodes[3].parent_idx = 1
    заметки = sanitize_elements(
        parsed.nodes, ["Ярмарка", "orders-db", "orders-db / orders-schema", "orders-db / migrator"],
        pinned=lambda i: i in (1, 2), live_element=lambda _i: False,
    )
    assert _родители(parsed) == {
        "Ярмарка": None, "orders-db": None, "orders-schema": "orders-db", "migrator": None,
    }
    assert заметки == [
        CHILDLESS_LIFTED_NOTE["database"].format(
            path="orders-db", name="orders-db", child="migrator", where="на верхний уровень",
        ),
    ]


def test_вынесенная_база_наследует_размещение_с_пути_до_контейнера():
    """Своих площадок у вынесенной нет — она берёт объявление ближайшего узла на пути
    от прежнего родителя до контейнера: иначе потеряла бы площадки, которые получала
    через предка (unit_placements). Своё объявление не трогается."""
    parsed, errors = parse_import(_yaml([{
        "name": "Ярмарка", "children": [
            {"name": "orders", "element": "container", "sites": ["prod"], "children": [
                {"name": "api", "sites": ["stage"], "children": [
                    {"name": "cache", "shape": "database"},
                ]},
                {"name": "orders-db", "shape": "database"},
                {"name": "audit-db", "shape": "database", "sites": ["dr"]},
            ]},
        ],
    }]))
    assert errors == [] and parsed is not None
    assert {n.name: n.sites for n in parsed.nodes if n.shape == "database"} == {
        "cache": ["stage"], "orders-db": ["prod"], "audit-db": ["dr"],
    }
    assert _родители(parsed)["cache"] == "Ярмарка"


def test_виновник_замечания_тот_же_что_у_отказа_api(db):
    """Выносятся все виновники, первый — в обходе в глубину с детьми по имени, как у
    отказа правки узла (element_rules): разбор и API называют одну и ту же базу."""
    дерево = {"name": "orders", "children": [
        {"name": "z-db", "shape": "database"},
        {"name": "api", "children": [{"name": "a-broker", "shape": "broker"}]},
    ]}
    parsed, _ = parse_import(_yaml([{**дерево, "element": "container"}]))
    assert parsed is not None
    assert parsed.warnings == [
        STORE_LIFTED_NOTE["broker"].format(path="orders", name="a-broker", where="на верхний уровень"),
        STORE_LIFTED_NOTE["database"].format(path="orders", name="z-db", where="на верхний уровень"),
    ]

    # Тот же проект живым: отказ API называет того же виновника.
    p = _project(db)
    живой, _ = parse_import(_yaml([дерево]))
    assert живой is not None
    ids = seed_import(db, p.id, живой)
    db.flush()
    orders = db.get(Node, ids[0])
    assert orders is not None
    отказ = element_change_refusal(
        project_element_rows(db, p.id), node_id=orders.id, name=orders.name,
        parent_id=None, shape="service", value="container",
    )
    assert отказ is not None and "брокер «a-broker»" in отказ


def test_элемент_внутри_контейнера_снят_компонент():
    """Внутри контейнера всё — компоненты: заданный элемент у потомка (и составного,
    и контейнер внутри контейнера) снимается, наружный контейнер остаётся."""
    parsed, errors = parse_import(_yaml([{
        "name": "orders", "element": "container", "children": [
            {"name": "api", "element": "system", "children": [
                {"name": "inner", "element": "container", "children": [{"name": "x"}]},
            ]},
            {"name": "worker", "element": "container"},
        ],
    }]))
    assert errors == [] and parsed is not None
    assert [(n.name, n.element) for n in parsed.nodes] == [
        ("orders", "container"), ("api", None), ("inner", None), ("x", None), ("worker", None),
    ]
    assert parsed.warnings == [
        COMPONENT_NOTE.format(path=p, container="orders")
        for p in ("orders / api", "orders / api / inner", "orders / worker")
    ]
    assert parsed.warnings[0] == (
        "orders / api: объект лежит внутри контейнера «orders» и считается его "
        "компонентом — элемент архитектуры пропущен"
    )


def test_база_во_внутреннем_контейнере_вынесена_за_наружный():
    """Контейнер в контейнере, а внутри внутреннего — база: она в составе наружного и
    выносится за него; внутренний остаётся его компонентом (правило 3)."""
    parsed, errors = parse_import(_yaml([{
        "name": "orders", "element": "container", "children": [
            {"name": "api", "element": "container", "children": [
                {"name": "orders-db", "shape": "database"},
            ]},
        ],
    }]))
    assert errors == [] and parsed is not None
    assert [n.element for n in parsed.nodes] == ["container", None, None]
    assert _родители(parsed) == {"orders": None, "api": "orders", "orders-db": None}
    assert parsed.warnings == [
        STORE_LIFTED_NOTE["database"].format(
            path="orders", name="orders-db", where="на верхний уровень",
        ),
        COMPONENT_NOTE.format(path="orders / api", container="orders"),
    ]


def test_живой_разбор_живое_место_не_трогает():
    """Вход №0 догрузки — снимок живого проекта (live): живое дерево ввоз не
    перестраивает и живое не судит. База в живом контейнере (данные в обход API)
    остаётся на месте, контейнер — контейнером, замечания нет."""
    parsed, errors = parse_import(_yaml([{
        "name": "orders", "element": "container", "children": [
            {"name": "api"}, {"name": "orders-db", "shape": "database"},
        ],
    }]), live=True)
    assert errors == [] and parsed is not None
    assert parsed.nodes[0].element == "container"
    assert _родители(parsed) == {"orders": None, "api": "orders", "orders-db": "orders"}
    assert parsed.doc_parents == []
    assert parsed.warnings == []


def test_закреплённая_база_снимает_ввезённый_контейнер():
    """Закреплённую (живую) базу вынести нельзя, а элемент контейнера пришёл из ввоза:
    контейнер снимается, узел остаётся системой — замечание это и говорит."""
    parsed, _ = parse_import(_yaml([{
        "name": "orders", "children": [{"name": "api"}, {"name": "orders-db", "shape": "database"}],
    }]))
    assert parsed is not None
    parsed.nodes[0].element = "container"
    заметки = sanitize_elements(
        parsed.nodes, ["orders", "orders / api", "orders / orders-db"],
        pinned=lambda i: i == 2, live_element=lambda _i: False,
    )
    assert parsed.nodes[0].element is None
    assert _родители(parsed)["orders-db"] == "orders"
    assert заметки == [STORE_KEPT_NOTE["database"].format(path="orders", name="orders-db")]


def test_файл_без_элемента_разбирается_как_прежде():
    parsed, errors = parse_import(_yaml([{
        "name": "Ярмарка", "children": [
            {"name": "orders", "children": [{"name": "api"}]},
            {"name": "orders-db", "shape": "database"},
        ],
    }]))
    assert errors == [] and parsed is not None
    assert parsed.warnings == []
    assert all(n.element is None for n in parsed.nodes)


def test_замечания_элемента_не_попадают_в_чужой_класс_остатка():
    """Класс замечания остаток узнаёт подстрокой (камень 5): новые тексты не несут
    ни одного маркера и едут в свёртку «Придется подправить вручную» как есть."""
    тексты = [
        ONLY_SERVICE_NOTE.format(path="Ярмарка / orders-db"),
        STORE_LIFTED_NOTE["database"].format(
            path="Ярмарка / orders", name="orders-db", where="на уровень выше, в «Ярмарка»",
        ),
        STORE_LIFTED_NOTE["broker"].format(
            path="Ярмарка / events", name="Kafka", where="на верхний уровень",
        ),
        STORE_KEPT_NOTE["database"].format(path="Ярмарка / orders", name="orders-db"),
        STORE_KEPT_NOTE["broker"].format(path="Ярмарка / events", name="Kafka"),
        COMPONENT_NOTE.format(path="orders / api", container="orders"),
        *(
            CHILDLESS_LIFTED_NOTE[shape].format(
                path="Ярмарка / orders-db", name="orders-db", child="orders-schema",
                where="на уровень выше, в «Ярмарка»",
            )
            for shape in ("database", "broker", "person")
        ),
    ]
    for текст in тексты:
        assert _remark_class(текст) == ("", False)
        assert friendly_remark(текст) == текст

    # И сквозь превью: строка разбора — пунктом свёртки своего файла, дословно.
    plan = build_unified_plan([("shop.yaml", _yaml([{
        "name": "Ярмарка", "children": [
            {"name": "orders-db", "shape": "database", "element": "container"},
        ],
    }]).encode())])
    assert plan.ok
    пункты = [(u.text, u.file) for u in remainder_from_plan(plan).unfixable]
    assert (тексты[0], 0) in пункты

    # Подъём из базы — тем же разбором единого ввоза (архив идёт им же): дерево плана
    # уже поднятое, замечание — пунктом свёртки дословно.
    plan = build_unified_plan([("shop.yaml", _yaml([{
        "name": "Ярмарка", "children": [
            {"name": "orders-db", "shape": "database", "children": [{"name": "orders-schema"}]},
        ],
    }]).encode())])
    assert plan.ok and plan.merged is not None
    assert _родители(plan.merged)["orders-schema"] == "Ярмарка"
    пункты = [(u.text, u.file) for u in remainder_from_plan(plan).unfixable]
    assert (тексты[-3], 0) in пункты


def test_круг_экспорта_с_элементами_байт_в_байт(db):
    """Экспорт → импорт → экспорт: элемент архитектуры возвращается теми же байтами."""
    src = _project(db, "Источник")
    корень = _node(db, src.id, "Ярмарка", element="system")
    orders = _node(db, src.id, "orders", корень, element="container")
    _node(db, src.id, "api", orders)
    _node(db, src.id, "billing", корень, element="container")
    db.commit()

    def экспорт(project_id) -> str:
        nodes = db.query(Node).filter(Node.project_id == project_id).all()
        edges = db.query(Edge).filter(Edge.project_id == project_id).all()
        return build_export(nodes, edges)

    первый = экспорт(src.id)
    parsed, errors = parse_import(первый)
    assert errors == [] and parsed is not None and parsed.warnings == []
    dst = _project(db, "Приёмник")
    seed_import(db, dst.id, parsed)
    db.commit()
    assert первый.count("element:") == 3
    assert экспорт(dst.id) == первый
