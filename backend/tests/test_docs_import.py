"""Тесты дозаливки доков (app/docs_import.py).

Пакет — самодостаточные файлы (docs/plan-docs-mmd.md): схема логики .mmd с
шапкой, спека — файлом. build_docs_plan: резолв узлов (путь/имя/хвост/
неоднозначно/не найден/вне поддерева окна), политика перезаписи
(create/overwrite/skip/unchanged), конфликты слотов между файлами, эвристика
OpenAPI, резолв пометок данных («читает:/пишет:») в текстах схем.
apply_docs_plan: запись + версии + идемпотентность. Эндпоинты — приём .mmd и
голой спеки, правки из превью (overrides).
"""

import uuid

import pytest
from conftest import ensure_architect, ensure_project
from fastapi import HTTPException

from app.docs_import import (
    MAX_DATA_REF_WARNINGS,
    MAX_NODES_HINT,
    apply_docs_plan,
    build_docs_plan,
    pkg_from_mmd,
)
from app.models.broker_channel import BrokerChannel
from app.models.channel_field import ChannelField
from app.models.db_column import DbColumn
from app.models.db_table import DbTable
from app.models.node import Node
from app.models.node_doc import NodeDoc
from app.routers.docs_import import docs_import_apply, docs_import_preview, docs_prompt
from app.schemas.docs_import import DocsFileIn, DocsImportIn


def _node(db, name, parent=None):
    n = Node(
        id=uuid.uuid4(),
        name=name,
        parent_id=parent.id if parent else None,
        project_id=ensure_project(db).id,
    )
    db.add(n)
    return n


SPEC = "openapi: 3.0.0\ninfo:\n  title: Orders\n  version: 1.0.0\npaths:\n  /orders:\n    post: {}\n"


def _tree(db):
    """Ярмарка / {orders, billing / api, shipping / api} — хватает на все виды резолва."""
    root = _node(db, "Ярмарка")
    orders = _node(db, "orders", parent=root)
    billing = _node(db, "billing", parent=root)
    shipping = _node(db, "shipping", parent=root)
    b_api = _node(db, "api", parent=billing)
    s_api = _node(db, "api", parent=shipping)
    db.commit()
    return root, orders, billing, shipping, b_api, s_api


def _nodes(db):
    return db.query(Node).all()


# ── build_docs_plan: резолв и политика ─────────────────────────────────────────

def _mmd(name: str, body: str = "graph TD\n  A --> B\n", **head) -> str:
    """Файл .mmd с шапкой: тот же путь, которым схемы приезжают в проде."""
    lines = [f"%% archmap-{k.replace('_', '-')}: {v}" for k, v in head.items()]
    return "\n".join([f"%% archmap-name: {name}", *lines, body])


def _plan(db, files, assets=None, overwrite=False, window=None, scope=None):
    """План по набору (имя файла, содержимое .mmd). db/project_id — как из роутера:
    по ним превью резолвит пометки данных в текстах схем."""
    entries = [(fname, pkg_from_mmd(fname, content)[0]) for fname, content in files]
    return build_docs_plan(
        _nodes(db), entries, assets or {}, overwrite,
        window.id if window is not None else None, scope,
        db=db, project_id=ensure_project(db).id,
    )


def test_plan_resolve_and_create(db):
    _, orders, *_ = _tree(db)
    plan = _plan(
        db,
        [("a.mmd", _mmd("POST /orders", kind="operation", operation="POST /orders"))],
        window=orders,
    )
    assert plan.errors == [] and plan.conflicts == []
    assert [a.action for a in plan.logic] == ["create"]
    assert plan.logic[0].node_path == "Ярмарка / orders"


def test_plan_resolve_bare_suffix_ambiguous(db):
    _tree(db)
    plan = _plan(db, [
        ("a.mmd", _mmd("А", node="orders")),
        ("b.mmd", _mmd("Б", node="billing / api")),
        ("c.mmd", _mmd("В", node="api")),
        ("d.mmd", _mmd("Г", node="нет-такого")),
    ])
    paths = [a.node_path for a in plan.logic]
    assert "Ярмарка / orders" in paths  # голое уникальное имя
    assert "Ярмарка / billing / api" in paths  # однозначный хвост пути
    joined = "\n".join(plan.errors)
    assert '"api" неоднозначно' in joined
    assert '"нет-такого" не найден' in joined


def test_plan_resolve_slash_without_spaces(db):
    # Слабые модели пишут путь слэшем без пробелов («microblog/api») —
    # финальный фолбэк нормализует разделитель и матчит путь/хвост.
    _tree(db)
    plan = _plan(db, [
        ("a.mmd", _mmd("А", node="Ярмарка/billing/api")),
        ("b.mmd", _mmd("Б", node="shipping/api")),
    ])
    assert plan.errors == []
    assert sorted(a.node_path for a in plan.logic) == [
        "Ярмарка / billing / api",
        "Ярмарка / shipping / api",
    ]


def test_plan_overwrite_policy(db):
    _root, orders, *_ = _tree(db)
    db.add(NodeDoc(node_id=orders.id, name="Приём", kind="operation", content="graph TD; OLD"))
    db.commit()
    files = [("a.mmd", _mmd("Приём"))]

    skip = _plan(db, files, window=orders, overwrite=False)
    assert [a.action for a in skip.logic] == ["skip"]

    over = _plan(db, files, window=orders, overwrite=True)
    assert [a.action for a in over.logic] == ["overwrite"]
    assert over.logic[0].doc_id is not None


def test_plan_unchanged(db):
    # Содержимое хранится ЦЕЛИКОМ, вместе с шапкой — потому повторная заливка
    # того же файла и даёт «без изменений».
    _root, orders, *_ = _tree(db)
    text = _mmd("Приём")
    db.add(NodeDoc(node_id=orders.id, name="Приём", kind="operation", content=text))
    db.commit()

    plan = _plan(db, [("a.mmd", text)], window=orders)
    assert [a.action for a in plan.logic] == ["unchanged"]


# ── заглушки разведки (Ф3 docs/plan-recon.md) ─────────────────────────────────
# Разведка создаёт схемы с ПУСТЫМ телом («POST /orders» без диаграммы). Политика
# «не перезаписывать» защищает РАБОТУ, а в заглушке работы нет: без отдельной ветки
# двести заглушек пропустили бы всю дозаливку с отчётом «слот занят» — и выглядело
# бы это как «уже описано».


def _stub(db, node, name, kind="operation", operation=None, content=""):
    """Заглушка разведки у объекта: тело пусто, имя — адрес операции."""
    doc = NodeDoc(node_id=node.id, name=name, kind=kind, operation=operation, content=content)
    db.add(doc)
    db.commit()
    return doc


def test_заглушка_заполняется_и_без_галки_перезаписи(db):
    _root, orders, *_ = _tree(db)
    _stub(db, orders, "POST /orders", operation="POST /orders")
    files = [("a.mmd", _mmd("POST /orders", kind="operation", operation="POST /orders"))]

    plan = _plan(db, files, window=orders, overwrite=False)
    assert [a.action for a in plan.logic] == ["fill"]
    assert plan.logic[0].doc_id is not None  # заполняем ту же строку, а не плодим вторую


def test_заглушка_из_одних_пробелов_это_та_же_заглушка(db):
    # «Пусто» считаем strip-ом — ровно как признак «описана» в БД (NodeDoc.described)
    # и резолвер пометок: схема из переводов строки документацией не становится.
    _root, orders, *_ = _tree(db)
    _stub(db, orders, "Приём", kind="operation", content=" \n\t ")

    plan = _plan(db, [("a.mmd", _mmd("Приём"))], window=orders, overwrite=False)
    assert [a.action for a in plan.logic] == ["fill"]


def test_описанная_схема_по_прежнему_под_защитой_политики(db):
    # Обратное направление: тело есть — значит есть работа, и без галки её не трогаем.
    _root, orders, *_ = _tree(db)
    _stub(db, orders, "Приём", kind="operation", content="graph TD; OLD")

    plan = _plan(db, [("a.mmd", _mmd("Приём"))], window=orders, overwrite=False)
    assert [a.action for a in plan.logic] == ["skip"]


def test_пустой_вход_поверх_описанной_схемы_не_обнуляет_тело(db):
    """Заполнение — только В заглушку. Пустая схема ОТ агента поверх описанной это не
    заполнение, а стирание работы: остаётся на прежней политике."""
    _root, orders, *_ = _tree(db)
    doc = _stub(db, orders, "Приём", kind="operation", content="graph TD; OLD")
    doc_id, orders_id = doc.id, orders.id
    files = [("a.mmd", "%% archmap-name: Приём\n\n   \n")]

    plan = _plan(db, files, window=orders, overwrite=False)
    assert [a.action for a in plan.logic] == ["skip"]
    assert apply_docs_plan(db, plan) == (0, 0, 0, 0)
    db.commit()
    assert db.get(NodeDoc, doc_id).content == "graph TD; OLD"
    assert db.query(NodeDoc).filter(NodeDoc.node_id == orders_id).count() == 1


def test_применение_считает_заполненные_отдельно_от_перезаписанных(db):
    _root, orders, *_ = _tree(db)
    _stub(db, orders, "POST /orders", operation="POST /orders")
    _stub(db, orders, "Отчёт", kind="operation", content="graph TD; OLD")
    orders_id = orders.id
    files = [
        ("a.mmd", _mmd("POST /orders", kind="operation", operation="POST /orders")),
        ("b.mmd", _mmd("Новая")),
    ]

    plan = _plan(db, files, window=orders, overwrite=False)
    # (создано, перезаписано, спек, заполнено): перезаписей нет — описанную «Отчёт»
    # пакет вообще не трогал, а заглушка ушла в своё число.
    assert apply_docs_plan(db, plan) == (1, 0, 0, 1)
    db.commit()

    filled = db.query(NodeDoc).filter(
        NodeDoc.node_id == orders_id, NodeDoc.name == "POST /orders"
    ).one()
    assert "A --> B" in filled.content and filled.version == 2  # CAS-версия бампается
    assert db.get(NodeDoc, _stub_id(db, orders_id, "Отчёт")).content == "graph TD; OLD"

    # Повтор того же пакета — уже «без изменений», заглушки кончились
    again = _plan(db, files, window=orders, overwrite=False)
    assert [a.action for a in again.logic] == ["unchanged", "unchanged"]
    assert apply_docs_plan(db, again) == (0, 0, 0, 0)


def _stub_id(db, node_id, name):
    return db.query(NodeDoc).filter(NodeDoc.node_id == node_id, NodeDoc.name == name).one().id


# ── страховка: агент назвал схему не по конвенции (Р27) ───────────────────────
# «Имя схемы — тоже METHOD /путь» это ПРАВИЛО, а правило слабее примера: агент
# вправе прислать «Создание заказа» с operation: POST /orders. По имени такая схема
# не сойдётся, рядом с заглушкой вырастет вторая схема на ту же операцию, а заглушка
# останется пустой навсегда — и счётчик «описано N из M» начнёт врать в обе стороны.


def test_схема_с_осмысленным_именем_садится_в_заглушку_своей_операции(db):
    _root, orders, *_ = _tree(db)
    заглушка = _stub(db, orders, "POST /orders", operation="POST /orders")
    stub_id, orders_id = заглушка.id, orders.id
    files = [("a.mmd", _mmd("Создание заказа", kind="operation", operation="POST /orders"))]

    plan = _plan(db, files, window=orders, overwrite=False)
    assert [a.action for a in plan.logic] == ["fill"]
    assert plan.logic[0].doc_id == stub_id
    assert apply_docs_plan(db, plan) == (0, 0, 0, 1)
    db.commit()

    # Имя берём ПРИСЛАННОЕ: осмысленное имя от агента ценнее адреса-заголовка, а
    # адрес и так виден в поле operation.
    docs = db.query(NodeDoc).filter(NodeDoc.node_id == orders_id).all()
    assert len(docs) == 1  # второй схемы на ту же операцию не появилось
    assert docs[0].name == "Создание заказа" and docs[0].operation == "POST /orders"
    assert "A --> B" in docs[0].content

    # Повтор того же пакета уже сходится по имени — и ничего не пишет
    again = _plan(db, files, window=orders, overwrite=False)
    assert [a.action for a in again.logic] == ["unchanged"]


def test_описанную_схему_с_той_же_операцией_страховка_не_трогает(db):
    """Ищем только среди ЗАГЛУШЕК: молча слить две схемы в одну нельзя."""
    _root, orders, *_ = _tree(db)
    _stub(db, orders, "Создание заказа", operation="POST /orders", content="graph TD; OLD")
    orders_id = orders.id
    files = [("a.mmd", _mmd("POST /orders", kind="operation", operation="POST /orders"))]

    plan = _plan(db, files, window=orders, overwrite=False)
    assert [a.action for a in plan.logic] == ["create"]
    assert apply_docs_plan(db, plan) == (1, 0, 0, 0)
    db.commit()

    docs = {d.name: d.content for d in db.query(NodeDoc).filter(NodeDoc.node_id == orders_id)}
    assert docs["Создание заказа"] == "graph TD; OLD"  # чужая работа цела
    assert "A --> B" in docs["POST /orders"]


def test_нескольких_заглушек_на_одну_операцию_не_угадываем(db):
    _root, orders, *_ = _tree(db)
    _stub(db, orders, "POST /orders", operation="POST /orders")
    _stub(db, orders, "Создание", operation="POST /orders")
    files = [("a.mmd", _mmd("Заведение заказа", kind="operation", operation="POST /orders"))]

    plan = _plan(db, files, window=orders, overwrite=False)
    assert [a.action for a in plan.logic] == ["create"]  # ведём себя как раньше
    предупреждение = [w for w in plan.warnings if "не угадываем" in w]
    assert len(предупреждение) == 1
    assert "«POST /orders» несколько" in предупреждение[0]
    assert "Создание" in предупреждение[0] and "POST /orders" in предупреждение[0]


def test_совпадение_по_имени_сильнее_страховки_по_операции(db):
    # Имя нашлось — заглушку по операции даже не ищем: политика описанной схемы
    # остаётся прежней, а заглушка остаётся ждать своей схемы.
    _root, orders, *_ = _tree(db)
    _stub(db, orders, "Создание заказа", operation="GET /orders", content="graph TD; OLD")
    _stub(db, orders, "POST /orders", operation="POST /orders")
    orders_id = orders.id
    files = [("a.mmd", _mmd("Создание заказа", kind="operation", operation="POST /orders"))]

    plan = _plan(db, files, window=orders, overwrite=False)
    assert [a.action for a in plan.logic] == ["skip"]
    assert apply_docs_plan(db, plan) == (0, 0, 0, 0)
    db.commit()
    assert db.get(NodeDoc, _stub_id(db, orders_id, "POST /orders")).content == ""


def test_одну_заглушку_два_файла_не_делят(db):
    # Оба файла целятся в одну заглушку по операции: первый заполняет, второй
    # получает конфликт — иначе одна из двух схем пропала бы молча.
    _root, orders, *_ = _tree(db)
    _stub(db, orders, "POST /orders", operation="POST /orders")
    orders_id = orders.id
    plan = _plan(db, [
        ("один.mmd", _mmd("Создание заказа", kind="operation", operation="POST /orders")),
        ("два.mmd", _mmd("Заведение заказа", kind="operation", operation="POST /orders")),
    ], window=orders, overwrite=False)

    assert [a.action for a in plan.logic] == ["fill", "create"]
    assert apply_docs_plan(db, plan) == (1, 0, 0, 1)
    db.commit()
    имена = {d.name for d in db.query(NodeDoc).filter(NodeDoc.node_id == orders_id)}
    assert имена == {"Создание заказа", "Заведение заказа"}


def test_endpoint_кнопка_описать_ловит_переименованную_схему(db):
    """Гранулярный путь целиком: «Описать» у строки → агент прислал ОДНУ схему под
    своим именем → она села в свою заглушку, соседние не тронуты."""
    _root, orders, *_ = _tree(db)
    project = ensure_project(db)
    for адрес in ("GET /orders", "POST /orders"):
        _stub(db, orders, адрес, operation=адрес)
    orders_id = orders.id

    report = docs_import_apply(
        _payload(
            ("a.mmd", _mmd("Создание заказа", kind="operation", operation="POST /orders")),
            node=orders, only="logic",
        ),
        db=db, project=project, user=ensure_architect(db),
    )

    assert report.applied is True and report.errors == []
    assert [a.action for a in report.logic] == ["fill"]
    assert (report.created_docs, report.filled_docs) == (0, 1)
    docs = {d.name: d.content for d in db.query(NodeDoc).filter(NodeDoc.node_id == orders_id)}
    assert set(docs) == {"GET /orders", "Создание заказа"}  # дубля не появилось
    assert docs["GET /orders"] == ""


def test_plan_merge_two_files_first_wins(db):
    _, orders, *_ = _tree(db)
    plan = _plan(db, [
        ("один.mmd", _mmd("Л", "graph TD\n  A --> B\n")),
        ("два.mmd", _mmd("Л", "graph TD\n  C --> D\n")),
    ], window=orders)
    assert len(plan.logic) == 1 and "A --> B" in plan.logic[0].mermaid
    assert plan.errors == []
    assert any("уже задана файлом один.mmd" in c for c in plan.conflicts)


def test_plan_unused_asset_warned(db):
    # Файл, не опознанный ни схемой, ни спекой окна, не должен исчезать молча.
    _, orders, *_ = _tree(db)
    plan = _plan(db, [("a.mmd", _mmd("Л"))], assets={"другой.yaml": SPEC}, window=orders)
    assert any('"другой.yaml" не пригодился' in w for w in plan.warnings)


def test_plan_operation_kind_warning(db):
    _, orders, *_ = _tree(db)
    plan = _plan(db, [("a.mmd", _mmd("Л", kind="operation"))], window=orders)
    assert any("kind=operation без поля operation" in w for w in plan.warnings)


def test_plan_доки_контейнеру_предупреждают_а_не_блокируют(db):
    # Полевой QA: агент адресовал обзоры контейнерам — итог два алерта AL24. Ошибкой
    # это делать жестоко (алерт и «распределение» — уже готовый ответ продукта), но и
    # молчать нельзя: превью обязано сказать это ДО применения.
    _tree(db)
    plan = _plan(db, [("a.mmd", _mmd("Обзор", node="billing")), ("b.mmd", _mmd("Л", node="orders"))])

    assert plan.errors == []
    assert [a.action for a in plan.logic] == ["create", "create"]  # пакет не заблокирован
    про_контейнер = [w for w in plan.warnings if "контейнер" in w]
    assert len(про_контейнер) == 1  # у листа orders предупреждения нет
    assert "a.mmd: «Ярмарка / billing» — контейнер" in про_контейнер[0]
    assert "Контейнеры со своей документацией" in про_контейнер[0]


def test_plan_адрес_вне_поддерева_окна(db):
    _root, _orders, billing, _shipping, *_ = _tree(db)
    scope = {billing.id} | {n.id for n in _nodes(db) if n.parent_id == billing.id}
    plan = _plan(db, [("a.mmd", _mmd("Л", node="shipping"))], window=billing, scope=scope)
    assert plan.logic == []
    assert any("не относится" in e for e in plan.errors)


# ── apply_docs_plan ─────────────────────────────────────────────────────────────

def test_apply_and_idempotent(db):
    _root, orders, *_ = _tree(db)
    db.add(NodeDoc(node_id=orders.id, name="Приём", kind="operation", content="graph TD; OLD"))
    db.commit()
    orders_id = orders.id
    files = [("a.mmd", _mmd("Приём"))]

    plan = _plan(db, files, window=orders, overwrite=True)
    created, updated, specs, filled = apply_docs_plan(db, plan)
    db.commit()
    assert (created, updated, specs, filled) == (0, 1, 0, 0)

    doc = db.query(NodeDoc).filter(NodeDoc.node_id == orders_id).one()
    assert "A --> B" in doc.content and doc.version == 2  # перезапись бампает CAS-версию

    # Повторный прогон того же пакета — всё «без изменений», ничего не пишется
    again = _plan(db, files, window=orders, overwrite=True)
    assert [a.action for a in again.logic] == ["unchanged"]
    assert apply_docs_plan(db, again) == (0, 0, 0, 0)


# ── Эндпоинты ──────────────────────────────────────────────────────────────────

def _payload(*files, overwrite=False, only=None, node=None):
    return DocsImportIn(
        files=[DocsFileIn(name=n, content=c) for n, c in files],
        overwrite=overwrite,
        only=only,
        node_id=node.id if node is not None else None,
    )


def test_endpoint_prompt_slices(db):
    # lang/hints/target передаём явно: прямой вызов минует DI, дефолты Query — не значения
    root, orders, billing, *_ = _tree(db)
    whole = docs_prompt(
        lang="ru", hints=None, target=None, db=db, project=ensure_project(db), _=ensure_architect(db)
    )
    assert "Ярмарка" in whole.prompt and "billing" in whole.prompt

    sub = docs_prompt(
        node_id=billing.id, lang="ru", hints=None, target=None,
        db=db, project=ensure_project(db), _=ensure_architect(db),
    )
    slice_part = sub.prompt.split("## Срез схемы")[1].split("## Что документировать")[0]
    assert "billing" in slice_part and "orders" not in slice_part

    with pytest.raises(HTTPException) as e:
        docs_prompt(
            node_id=uuid.uuid4(), lang="ru", hints=None, target=None,
            db=db, project=ensure_project(db), _=ensure_architect(db),
        )
    assert e.value.status_code == 404


def test_endpoint_prompt_target_focus(db):
    # Гранулярный режим «по одной схеме»: target фокусирует агента на одном
    # воркере/эндпоинте (приоритетный блок в промпте); без target блока нет.
    _tree(db)
    focused = docs_prompt(
        lang="ru", hints=None, target="OrderCreatedHandler",
        db=db, project=ensure_project(db), _=ensure_architect(db),
    )
    assert "Фокус этого прогона" in focused.prompt
    assert "OrderCreatedHandler" in focused.prompt

    broad = docs_prompt(
        lang="ru", hints=None, target=None,
        db=db, project=ensure_project(db), _=ensure_architect(db),
    )
    assert "Фокус этого прогона" not in broad.prompt


def test_endpoint_preview_does_not_write(db):
    _, orders, *_ = _tree(db)
    report = docs_import_preview(
        _payload(("a.mmd", _mmd("Приём")), node=orders, only="logic"),
        db=db, project=ensure_project(db), _=ensure_architect(db),
    )
    assert report.applied is False and report.errors == []
    assert [a.action for a in report.logic] == ["create"]
    assert "graph TD" in report.logic[0].mermaid  # текст для фронт-валидации
    assert db.query(NodeDoc).count() == 0


def test_endpoint_apply_writes_and_bumps(db):
    _, orders, *_ = _tree(db)
    project = ensure_project(db)
    rev0 = project.meta_rev
    graph0 = project.graph_rev
    # Спека приезжает СВОИМ окном (only="api"), поэтому здесь только логика.
    files = (("a.mmd", _mmd("Приём")),)
    report = docs_import_apply(
        _payload(*files, node=orders, only="logic"),
        db=db, project=project, user=ensure_architect(db),
    )
    assert report.applied is True
    assert (report.created_docs, report.updated_docs, report.specs_written) == (1, 0, 0)
    assert db.query(NodeDoc).count() == 1
    db.refresh(project)
    # Доки/спеки — мета узла: двигают meta_rev, НЕ graph_rev (тост страницы, не схемы)
    assert project.meta_rev == rev0 + 1
    assert project.graph_rev == graph0

    # Идемпотентный повтор: applied=True, но нули и БЕЗ бампа курсоров
    again = docs_import_apply(
        _payload(*files, node=orders, only="logic"),
        db=db, project=project, user=ensure_architect(db),
    )
    assert again.applied is True
    assert (again.created_docs, again.updated_docs, again.specs_written) == (0, 0, 0)
    db.refresh(project)
    assert project.meta_rev == rev0 + 1


def test_endpoint_кнопка_описать_заполняет_именно_свою_заглушку(db):
    """Путь из витрины: «Описать» у строки → агент прислал ОДНУ схему → она села в
    свою заглушку, соседние остались пустыми, галка перезаписи не понадобилась."""
    _root, orders, *_ = _tree(db)
    project = ensure_project(db)
    for адрес in ("GET /orders", "POST /orders", "DELETE /orders/{id}"):
        _stub(db, orders, адрес, operation=адрес)
    orders_id = orders.id

    report = docs_import_apply(
        _payload(
            ("a.mmd", _mmd("POST /orders", kind="operation", operation="POST /orders")),
            node=orders, only="logic",
        ),
        db=db, project=project, user=ensure_architect(db),
    )

    assert report.applied is True and report.errors == []
    assert [a.action for a in report.logic] == ["fill"]
    assert (report.created_docs, report.filled_docs, report.updated_docs) == (0, 1, 0)
    docs = {d.name: d.content for d in db.query(NodeDoc).filter(NodeDoc.node_id == orders_id)}
    assert len(docs) == 3  # ни одной новой схемы не появилось
    assert "A --> B" in docs["POST /orders"]
    assert docs["GET /orders"] == "" and docs["DELETE /orders/{id}"] == ""


def test_endpoint_apply_blocked_by_errors(db):
    # Схема адресована узлу, которого нет: план непригоден, не пишем ничего.
    _, orders, *_ = _tree(db)
    report = docs_import_apply(
        _payload(("a.mmd", _mmd("Л", node="нет-такого")), node=orders),
        db=db, project=ensure_project(db), user=ensure_architect(db),
    )
    assert report.applied is False
    assert any("не найден" in e for e in report.errors)
    assert db.query(NodeDoc).count() == 0


def test_endpoint_no_manifest_error(db):
    _tree(db)
    report = docs_import_preview(
        _payload(("orders-api.yaml", SPEC)),
        db=db, project=ensure_project(db), _=ensure_architect(db),
    )
    # Формулировка изменилась с переездом на .mmd: пакет теперь бывает и без
    # манифеста — из одних схем (docs/plan-docs-mmd.md).
    assert any("нет ни схемы" in e for e in report.errors)


def test_endpoint_only_filter(db):
    # Раздельные окна дозаливки: only="logic" оставляет только схемы логики,
    # only="api" — только OpenAPI-спеки (сущности не смешиваются).
    _, orders, *_ = _tree(db)
    files = (("a.mmd", _mmd("Приём")), ("orders-api.yaml", SPEC))

    logic_only = docs_import_preview(
        _payload(*files, only="logic", node=orders),
        db=db, project=ensure_project(db), _=ensure_architect(db),
    )
    assert len(logic_only.logic) == 1 and logic_only.specs == []

    api_only = docs_import_preview(
        _payload(*files, only="api", node=orders),
        db=db, project=ensure_project(db), _=ensure_architect(db),
    )
    assert api_only.logic == [] and len(api_only.specs) == 1

    # Применение с фильтром пишет только своё (спека не создаётся)
    applied = docs_import_apply(
        _payload(*files, only="logic", node=orders),
        db=db, project=ensure_project(db), user=ensure_architect(db),
    )
    assert applied.applied is True
    assert (applied.created_docs, applied.specs_written) == (1, 0)


# ── приём .mmd вместо манифеста (docs/plan-docs-mmd.md, Фаза 1) ────────────────

MMD = '%% archmap-name: Приём заказа\n%% archmap-kind: operation\n%% archmap-operation: POST /orders\ngraph TD\n  A["Приём"] --> B["Запись"]\n'


def _mmd_payload(db, *files, node=None, overwrite=False, overrides=None):
    """Пакет из .mmd: адрес по умолчанию — объект окна (node_id)."""
    return DocsImportIn(
        files=[DocsFileIn(name=n, content=c) for n, c in files],
        overwrite=overwrite,
        only="logic",
        node_id=node.id if node is not None else None,
        overrides=overrides or [],
    )


def test_mmd_едет_на_объект_окна_без_всякого_адреса(db):
    _, orders, *_ = _tree(db)

    report = docs_import_preview(
        _mmd_payload(db, ("orders-create.mmd", MMD), node=orders),
        db=db, project=ensure_project(db), _=ensure_architect(db),
    )

    assert report.errors == []
    assert len(report.logic) == 1
    item = report.logic[0]
    assert item.node_path == "Ярмарка / orders"
    assert item.name == "Приём заказа"
    assert item.kind == "operation"
    assert item.operation == "POST /orders"
    # Содержимое сохраняем ЦЕЛИКОМ, вместе с шапкой: метаданные не теряются.
    assert item.mermaid == MMD


def test_без_шапки_имя_берётся_из_имени_файла_и_вид_операционный(db):
    _, orders, *_ = _tree(db)

    report = docs_import_preview(
        _mmd_payload(db, ("Схема хранения.mmd", "graph LR\n  T1 --> T2\n"), node=orders),
        db=db, project=ensure_project(db), _=ensure_architect(db),
    )

    assert report.errors == []
    assert report.logic[0].name == "Схема хранения"
    assert report.logic[0].kind == "operation"


def test_вставка_текстом_опознаётся_по_содержимому(db):
    # У вставки из буфера имени файла нет — окно называет её само, поэтому
    # распознавание обязано работать по тексту диаграммы.
    _, orders, *_ = _tree(db)

    report = docs_import_preview(
        _mmd_payload(db, ("вставка-1", "sequenceDiagram\n  A->>B: hi\n"), node=orders),
        db=db, project=ensure_project(db), _=ensure_architect(db),
    )

    assert report.errors == []
    assert report.logic[0].name == "вставка-1"


def test_адрес_в_шапке_уводит_схему_на_ребёнка(db):
    root, _orders, billing, *_ = _tree(db)
    text = "%% archmap-node: billing / api\ngraph TD\n  A --> B\n"

    report = docs_import_preview(
        _mmd_payload(db, ("api.mmd", text), node=billing),
        db=db, project=ensure_project(db), _=ensure_architect(db),
    )

    assert report.errors == []
    assert report.logic[0].node_path == "Ярмарка / billing / api"


def test_адрес_вне_поддерева_окна_отклоняется(db):
    # Иначе схема тихо приедет чужому сервису: окно открыто для billing, а
    # шапка адресует shipping.
    _root, _orders, billing, shipping, *_ = _tree(db)
    text = "%% archmap-node: shipping\ngraph TD\n  A --> B\n"

    report = docs_import_preview(
        _mmd_payload(db, ("чужое.mmd", text), node=billing),
        db=db, project=ensure_project(db), _=ensure_architect(db),
    )

    assert report.logic == []
    assert any("не относится" in e for e in report.errors)


def test_непонятая_строка_шапки_попадает_в_замечания(db):
    _, orders, *_ = _tree(db)
    text = "%% archmap-namee: Опечатка\ngraph TD\n  A --> B\n"

    report = docs_import_preview(
        _mmd_payload(db, ("схема.mmd", text), node=orders),
        db=db, project=ensure_project(db), _=ensure_architect(db),
    )

    # Схема всё равно приезжает (имя — из файла), но пользователь предупреждён.
    assert report.errors == []
    assert report.logic[0].name == "схема"
    assert any("namee" in w for w in report.warnings)


def test_правка_из_превью_перебивает_шапку(db):
    from app.schemas.docs_import import DocsOverrideIn

    _, orders, *_ = _tree(db)

    report = docs_import_preview(
        _mmd_payload(
            db, ("orders-create.mmd", MMD), node=orders,
            overrides=[DocsOverrideIn(file="orders-create.mmd", name="Создание заказа", kind="worker")],
        ),
        db=db, project=ensure_project(db), _=ensure_architect(db),
    )

    assert report.logic[0].name == "Создание заказа"
    assert report.logic[0].kind == "worker"


def test_повторная_заливка_того_же_файла_ничего_не_меняет(db):
    _, orders, *_ = _tree(db)
    payload = _mmd_payload(db, ("orders-create.mmd", MMD), node=orders)

    first = docs_import_apply(
        payload, db=db, project=ensure_project(db), user=ensure_architect(db),
    )
    assert first.applied and first.created_docs == 1

    second = docs_import_preview(
        _mmd_payload(db, ("orders-create.mmd", MMD), node=orders),
        db=db, project=ensure_project(db), _=ensure_architect(db),
    )
    assert [i.action for i in second.logic] == ["unchanged"]


def test_спека_рядом_со_схемами_остаётся_ресурсом(db):
    # OpenAPI-файл не должен опознаться схемой логики: у него нет ни расширения,
    # ни шапки, ни начала диаграммы. В окне ЛОГИКИ он просто не пригодится.
    _, orders, *_ = _tree(db)

    report = docs_import_preview(
        _mmd_payload(db, ("orders-create.mmd", MMD), ("orders-api.yaml", SPEC), node=orders),
        db=db, project=ensure_project(db), _=ensure_architect(db),
    )

    assert len(report.logic) == 1
    assert any("не пригодился" in w for w in report.warnings)


def test_папку_целиком_можно_бросить_в_окно_спеки(db):
    # Пользователь вправе перетащить весь archmap-docs: спеку надо найти среди
    # схем логики, а не потерять (окно фильтрует план по only="api").
    _, orders, *_ = _tree(db)

    report = docs_import_preview(
        DocsImportIn(
            files=[
                DocsFileIn(name="orders-create.mmd", content=MMD),
                DocsFileIn(name="orders-api.yaml", content=SPEC),
            ],
            overwrite=True, only="api", node_id=orders.id,
        ),
        db=db, project=ensure_project(db), _=ensure_architect(db),
    )

    assert report.errors == []
    assert len(report.specs) == 1 and report.logic == []


# ── окно спеки без манифеста (docs/plan-docs-mmd.md, Фаза 4, бэковая часть) ────

SPEC_WITH_ORIGIN = "# archmap-origin: generated\n" + SPEC


def _spec_payload(*files, node=None, overwrite=True):
    return DocsImportIn(
        files=[DocsFileIn(name=n, content=c) for n, c in files],
        overwrite=overwrite,
        only="api",
        node_id=node.id if node is not None else None,
    )


def test_голая_спека_уезжает_объекту_окна(db):
    _, orders, *_ = _tree(db)

    report = docs_import_preview(
        _spec_payload(("orders-api.yaml", SPEC), node=orders),
        db=db, project=ensure_project(db), _=ensure_architect(db),
    )

    assert report.errors == []
    assert len(report.specs) == 1
    assert report.specs[0].node_path == "Ярмарка / orders"
    assert report.specs[0].looks_openapi


def test_происхождение_читается_комментарием_в_спеке(db):
    # Единственное, что манифест давал сверх самого файла, — origin; агент пишет
    # его комментарием в первых строках спеки.
    _, orders, *_ = _tree(db)

    report = docs_import_preview(
        _spec_payload(("orders-api.yaml", SPEC_WITH_ORIGIN), node=orders),
        db=db, project=ensure_project(db), _=ensure_architect(db),
    )

    assert report.specs[0].origin == "generated"


def test_две_спеки_в_пакете_это_вопрос_а_не_догадка(db):
    _, orders, *_ = _tree(db)

    report = docs_import_preview(
        _spec_payload(("a.yaml", SPEC), ("b.yaml", SPEC), node=orders),
        db=db, project=ensure_project(db), _=ensure_architect(db),
    )

    assert report.specs == []
    assert any("несколько файлов спеки" in e for e in report.errors)


def test_спека_пишется_и_повторное_применение_ничего_не_меняет(db):
    _, orders, *_ = _tree(db)
    payload = _spec_payload(("orders-api.yaml", SPEC), node=orders)

    first = docs_import_apply(
        payload, db=db, project=ensure_project(db), user=ensure_architect(db),
    )
    assert first.applied and first.specs_written == 1

    second = docs_import_preview(
        _spec_payload(("orders-api.yaml", SPEC), node=orders),
        db=db, project=ensure_project(db), _=ensure_architect(db),
    )
    assert [s.action for s in second.specs] == ["unchanged"]


# ── пометки данных в превью пакета (полевой QA docs/qa-zabbix-7.md, раунд 3) ───
# Дисциплина пометок слабой моделью высокодисперсна (46 битых пометок при том же
# промпте, что раньше дал 7) — превью обязано отдавать агенту КОНКРЕТНЫЕ битые
# ссылки, а не правило.


def _db_node(db, name, parent=None):
    n = _node(db, name, parent=parent)
    n.shape = "database"
    db.commit()
    return n


def _table(db, node, name="orders", columns=(), schema=""):
    """Таблица структуры узла-БД (прямой ORM: превью каталог читает, а не пишет)."""
    t = DbTable(id=uuid.uuid4(), node_id=node.id, name=name, schema_name=schema)
    db.add(t)
    db.flush()
    for i, col in enumerate(columns):
        db.add(DbColumn(id=uuid.uuid4(), table_id=t.id, name=col, type="text", order=i))
    db.commit()
    return t


def _refs_mmd(marks: str, name: str = "Списание") -> str:
    """Схема логики с пометкой данных в подписи вершины — так их пишет агент.
    Имя схемы разное у разных файлов: одинаковое отдало бы второй файл в конфликт
    слота, и его пометки до проверки бы не доехали."""
    return _mmd(name, f'graph TD\n  A["Списать средства<br>{marks}"] --> B\n')


def test_битая_пометка_уезжает_агенту_конкретной_ссылкой(db):
    # Через эндпоинт: проверяется и проводка db/project_id из роутера в план.
    _root, orders, *_ = _tree(db)
    хранилище = _db_node(db, "Хранилище")
    _table(db, хранилище, "orders", ["status"])

    report = docs_import_preview(
        _mmd_payload(
            db, ("списание.mmd", _refs_mmd("читает/пишет: accounts.balance")), node=orders
        ),
        db=db, project=ensure_project(db), _=ensure_architect(db),
    )

    assert report.errors == []
    # Дедуп по (файл, ссылка, статус): слитное «читает/пишет» — один промах, не два.
    assert [w for w in report.warnings if "пометка «" in w] == [
        "списание.mmd: пометка «accounts.balance» — таблица не найдена в структуре проекта"
    ]


def test_здоровая_пометка_превью_не_беспокоит(db):
    _root, orders, *_ = _tree(db)
    хранилище = _db_node(db, "Хранилище")
    _table(db, хранилище, "orders", ["status"])

    plan = _plan(db, [("a.mmd", _refs_mmd("читает: orders.status"))], window=orders)

    assert [w for w in plan.warnings if "пометка «" in w] == []


def test_без_структуры_бд_одна_заметка_вместо_шума_на_каждую_пометку(db):
    # Курица-яйцо: доки грузят раньше структуры. Предупреждение на каждую пометку
    # отправило бы агента «чинить» верные ссылки.
    _root, orders, *_ = _tree(db)

    plan = _plan(db, [
        ("a.mmd", _refs_mmd("пишет: accounts.balance", name="Списание")),
        ("b.mmd", _refs_mmd("читает: orders.status", name="Чтение")),
    ], window=orders)

    assert [w for w in plan.warnings if "пометка «" in w] == []
    заметки = [w for w in plan.warnings if "структура БД в проекте ещё не описана" in w]
    assert len(заметки) == 1

    # Пометок в пакете нет — и заметки нет: молчим о том, чего никто не писал.
    тихо = _plan(db, [("c.mmd", _mmd("Без пометок"))], window=orders)
    assert not any("структура БД" in w for w in тихо.warnings)


def test_неоднозначная_и_неизвестная_колонка_названы_своими_словами(db):
    _root, orders, *_ = _tree(db)
    хранилище = _db_node(db, "Хранилище")
    архив = _db_node(db, "Архив")
    _table(db, хранилище, "orders", ["status"])
    _table(db, архив, "orders", ["status"])
    _table(db, хранилище, "accounts")

    plan = _plan(db, [
        ("a.mmd", _refs_mmd("читает: orders", name="Чтение")),
        ("b.mmd", _refs_mmd("пишет: accounts.balance", name="Списание")),
    ], window=orders)

    тексты = [w for w in plan.warnings if "пометка «" in w]
    assert "a.mmd: пометка «orders» — имя неоднозначно, укажите «Узел-БД / таблица»" in тексты
    assert "b.mmd: пометка «accounts.balance» — колонки нет в таблице" in тексты


def test_кап_пометок_и_хвост_сколько_ещё(db):
    # Замечания уезжают агенту одним списком: сотня строк одного класса вытеснила
    # бы всё остальное.
    _root, orders, *_ = _tree(db)
    хранилище = _db_node(db, "Хранилище")
    _table(db, хранилище, "orders", ["status"])
    битых = MAX_DATA_REF_WARNINGS + 3
    marks = "пишет: " + ", ".join(f"нет{i}" for i in range(битых))

    plan = _plan(db, [("a.mmd", _refs_mmd(marks))], window=orders)

    assert len([w for w in plan.warnings if "пометка «" in w]) == MAX_DATA_REF_WARNINGS
    assert "…ещё 3 пометок не резолвится" in plan.warnings


# ── пометки каналов в превью пакета (Ф2 docs/plan-broker-docs.md) ──────────────
# Тот же механизм и тот же кап, но СВОИ слова: послать агента искать топик в
# «структуре проекта» значит гарантированно получить неверную правку.


def _broker_node(db, name, parent=None):
    n = _node(db, name, parent=parent)
    n.shape = "broker"
    db.commit()
    return n


def _channel(db, node, name="созданные", fields=(), group=""):
    c = BrokerChannel(id=uuid.uuid4(), node_id=node.id, name=name, group_name=group)
    db.add(c)
    db.flush()
    for i, f in enumerate(fields):
        db.add(ChannelField(id=uuid.uuid4(), channel_id=c.id, name=f, type="uuid", order=i))
    db.commit()
    return c


def test_битая_канальная_пометка_названа_своими_словами(db):
    _root, orders, *_ = _tree(db)
    kafka = _broker_node(db, "Kafka")
    сосед = _broker_node(db, "RabbitMQ")
    _channel(db, kafka, "созданные", ["order_id"])
    _channel(db, kafka, "события")
    _channel(db, сосед, "события")  # одноимённый → голое «события» неоднозначно

    plan = _plan(db, [
        ("a.mmd", _refs_mmd("публикует: создание", name="Публикация")),
        ("b.mmd", _refs_mmd("потребляет: события", name="Потребление")),
        ("c.mmd", _refs_mmd("публикует: созданные.total", name="Глубина")),
    ], window=orders)

    тексты = [w for w in plan.warnings if "пометка «" in w]
    # У «создание» есть уверенный сосед по каталогу — замечание несёт и подсказку
    # (Ф8б); у «созданные.total» кандидата в полях канала нет, и текст голый.
    assert (
        "a.mmd: пометка «создание» — канал не найден у брокеров проекта — "
        "похоже на «созданные»" in тексты
    )
    assert "b.mmd: пометка «события» — имя неоднозначно, укажите «Брокер / канал»" in тексты
    assert "c.mmd: пометка «созданные.total» — поля нет в канале" in тексты


def test_здоровая_канальная_пометка_превью_не_беспокоит(db):
    _root, orders, *_ = _tree(db)
    kafka = _broker_node(db, "Kafka")
    _channel(db, kafka, "созданные", ["order_id"])

    plan = _plan(db, [("a.mmd", _refs_mmd("публикует: созданные.order_id"))], window=orders)

    assert [w for w in plan.warnings if "пометка «" in w] == []


def test_заметки_о_неописанной_структуре_независимы(db):
    """Таблицы могут быть описаны, а каналы — нет (и наоборот): порядок «структура
    раньше доков» соблюдают не всегда, и молчать о своей половине нельзя."""
    _root, orders, *_ = _tree(db)
    хранилище = _db_node(db, "Хранилище")
    _table(db, хранилище, "orders", ["status"])

    plan = _plan(db, [
        ("a.mmd", _refs_mmd("читает: orders.status", name="Чтение")),
        ("b.mmd", _refs_mmd("публикует: созданные", name="Публикация")),
    ], window=orders)

    # Таблицы описаны — здоровая табличная пометка молчит; каналов нет вовсе, и
    # вместо шума на каждую канальную пометку — одна заметка на пакет.
    assert [w for w in plan.warnings if "пометка «" in w] == []
    assert not any("структура БД в проекте ещё не описана" in w for w in plan.warnings)
    каналы = [w for w in plan.warnings if "каналы брокеров в проекте ещё не описаны" in w]
    assert len(каналы) == 1

    # Пометок каналов в пакете нет — и заметки нет: молчим о том, чего не писали.
    тихо = _plan(db, [("c.mmd", _refs_mmd("читает: orders.status", name="Только данные"))],
                 window=orders)
    assert not any("каналы брокеров" in w for w in тихо.warnings)


def test_счётчики_пометок_считают_обе_семьи_отдельно(db):
    """Число пометок в отчёте — машинный гвард против ампутации (находка №2
    docs/qa-sentry-brokers.md): по списку из семи битых пометок агент удалил все
    восемьдесят три, и превью стало «идеальным». Окно сравнивает эти числа между
    попытками, поэтому считаются они ДО резолва — числу всё равно, битая пометка
    или здоровая."""
    _root, orders, *_ = _tree(db)
    хранилище = _db_node(db, "Хранилище")
    _table(db, хранилище, "orders", ["status"])

    report = docs_import_preview(
        _mmd_payload(
            db,
            ("a.mmd", _refs_mmd("читает: orders.status, accounts<br>публикует: созданные")),
            node=orders,
        ),
        db=db, project=ensure_project(db), _=ensure_architect(db),
    )

    # Два обращения к данным (одно из них битое — «accounts» нет) и одно к каналам.
    assert (report.data_refs_total, report.channel_refs_total) == (2, 1)


def test_счётчики_пометок_не_зависят_от_резолва(db):
    # Каталогов в проекте нет вовсе (структура ещё не описана) — резолв выключен, а
    # считать пометки надо всё равно: иначе гвард молчал бы ровно в том прогоне, где
    # доки грузят раньше структуры.
    _root, orders, *_ = _tree(db)

    plan = _plan(db, [("a.mmd", _refs_mmd("пишет: orders<br>потребляет: событие"))],
                 window=orders)

    assert (plan.data_refs_total, plan.channel_refs_total) == (1, 1)


def test_пакет_без_пометок_даёт_нули(db):
    # Ноль — законное значение, а не «не считали»: он и есть база сравнения попыток.
    _root, orders, *_ = _tree(db)

    plan = _plan(db, [("a.mmd", _mmd("Без пометок"))], window=orders)

    assert (plan.data_refs_total, plan.channel_refs_total) == (0, 0)


def test_счётчики_доезжают_и_до_применения(db):
    # Отчёт применения — тот же объект: если бы счётчики жили только в превью, окно
    # сравнивало бы попытки с дырой ровно на применённой.
    _root, orders, *_ = _tree(db)

    report = docs_import_apply(
        _mmd_payload(
            db, ("a.mmd", _refs_mmd("пишет: orders<br>публикует: созданные")), node=orders
        ),
        db=db, project=ensure_project(db), user=ensure_architect(db),
    )

    assert report.applied
    assert (report.data_refs_total, report.channel_refs_total) == (1, 1)


def test_общий_кап_на_обе_семьи_пометок(db):
    # Замечания уезжают агенту одним списком: кап общий, иначе один класс вытеснит
    # другой ровно так же, как раньше вытеснял всё остальное.
    _root, orders, *_ = _tree(db)
    хранилище = _db_node(db, "Хранилище")
    _table(db, хранилище, "orders", ["status"])
    kafka = _broker_node(db, "Kafka")
    _channel(db, kafka, "созданные")
    половина = MAX_DATA_REF_WARNINGS
    данные = "пишет: " + ", ".join(f"нет_т{i}" for i in range(половина))
    каналы = "публикует: " + ", ".join(f"нет_к{i}" for i in range(половина))

    plan = _plan(db, [("a.mmd", _refs_mmd(f"{данные}<br>{каналы}"))], window=orders)

    assert len([w for w in plan.warnings if "пометка «" in w]) == MAX_DATA_REF_WARNINGS
    assert f"…ещё {половина} пометок не резолвится" in plan.warnings


# ── подсказка «похоже на …» в замечаниях (Ф8б, находка №1 qa-zulip-brokers.md) ─
# Замечание без ответа даёт колебательный контур: из двух путей починки («сверь имя»
# и «добавь квалификатор») слабая модель оба круга выбирала дешёвый механический —
# добавила квалификатор, потом сняла, а имя так и не сверила. Каталог у превью уже
# есть: назвать ближайшее имя машина умеет точнее, чем агент.


def test_битая_пометка_подсказывает_ближайшее_описанное_имя(db):
    # Разрыв «имя ORM-класса против имени таблицы» — префикс приложения и число:
    # ровно тот случай, ради которого суффиксный матч идёт впереди difflib.
    _root, orders, *_ = _tree(db)
    хранилище = _db_node(db, "Хранилище")
    _table(db, хранилище, "zerver_message", ["content"])

    plan = _plan(db, [("a.mmd", _refs_mmd("пишет: messages"))], window=orders)

    assert [w for w in plan.warnings if "пометка «" in w] == [
        "a.mmd: пометка «messages» — таблица не найдена в структуре проекта — "
        "похоже на «zerver_message»"
    ]


def test_длинный_префикс_и_множественное_число_ловятся_суффиксом(db):
    """Почему суффиксный матч идёт ПЕРВЫМ, а не «хватит difflib».

    Чем длиннее префикс приложения в имени таблицы, тем ниже похожесть строк целиком:
    «queues» против «background_jobs_queue» — 0.37, ниже порога, и difflib промолчал
    бы. А это ровно тот разрыв, который дают ORM-имена; плюс агент пишет во
    множественном числе, а таблица названа в единственном.
    """
    _root, orders, *_ = _tree(db)
    хранилище = _db_node(db, "Хранилище")
    _table(db, хранилище, "background_jobs_queue")

    plan = _plan(db, [("a.mmd", _refs_mmd("пишет: queues"))], window=orders)

    assert [w for w in plan.warnings if "пометка «" in w] == [
        "a.mmd: пометка «queues» — таблица не найдена в структуре проекта — "
        "похоже на «background_jobs_queue»"
    ]


def test_битая_канальная_пометка_подсказывает_имя_канала(db):
    _root, orders, *_ = _tree(db)
    kafka = _broker_node(db, "Kafka")
    _channel(db, kafka, "notify_tornado")

    plan = _plan(db, [("a.mmd", _refs_mmd("публикует: notify-tornado"))], window=orders)

    assert [w for w in plan.warnings if "пометка «" in w] == [
        "a.mmd: пометка «notify-tornado» — канал не найден у брокеров проекта — "
        "похоже на «notify_tornado»"
    ]


def test_подсказка_колонки_ищется_в_найденной_таблице(db):
    # Таблица нашлась, колонки нет — кандидаты ТОЛЬКО её колонки: у соседней таблицы
    # имя похоже даже сильнее, но обращение к ней тут ни при чём, и подсказать её
    # значило бы увести агента в другую таблицу.
    _root, orders, *_ = _tree(db)
    хранилище = _db_node(db, "Хранилище")
    _table(db, хранилище, "accounts", ["balance"])
    _table(db, хранилище, "orders", ["last_balnce"])

    plan = _plan(db, [("a.mmd", _refs_mmd("пишет: accounts.balnce"))], window=orders)

    assert [w for w in plan.warnings if "пометка «" in w] == [
        "a.mmd: пометка «accounts.balnce» — колонки нет в таблице — похоже на «balance»"
    ]


def test_далёкое_имя_подсказки_не_получает(db):
    """Ложная подсказка ХУЖЕ её отсутствия: слабая модель копирует предложенное имя
    не глядя, и вместо битой пометки выходит пометка, битая по-другому. Пометка на
    кэше (находка №3) — как раз такой случай: похожего имени в структуре нет."""
    _root, orders, *_ = _tree(db)
    хранилище = _db_node(db, "Хранилище")
    _table(db, хранилище, "orders", ["status"])

    plan = _plan(db, [("a.mmd", _refs_mmd("читает: query_cache"))], window=orders)

    assert [w for w in plan.warnings if "пометка «" in w] == [
        "a.mmd: пометка «query_cache» — таблица не найдена в структуре проекта"
    ]


def test_сосед_по_префиксу_приложения_подсказки_не_получает(db):
    """Полевая валидация Ф8 (4-й круг замечаний): по СЛАБЫМ подсказкам модель
    «починила» пометки в семантически ДРУГИЕ таблицы — «…projectoptions» уехало в
    «…projectcodeowners». Похожесть там набирается общим префиксом приложения (0.79 —
    выше любого разумного порога), а расходятся имена целым словом. Ложная цель хуже
    отсутствия цели: замечание без подсказки модель хотя бы идёт проверять.
    """
    _root, orders, *_ = _tree(db)
    хранилище = _db_node(db, "Хранилище")
    for имя in ("sentry_projectcodeowners", "sentry_recentsearch", "sentry_apiapplication"):
        _table(db, хранилище, имя)

    plan = _plan(db, [
        ("a.mmd", _refs_mmd("пишет: sentry_projectoptions", name="Опции")),
        ("b.mmd", _refs_mmd("читает: sentry-cache", name="Кэш")),
        ("c.mmd", _refs_mmd("пишет: sentry_dynamicsampling", name="Сэмплирование")),
    ], window=orders)

    тексты = [w for w in plan.warnings if "пометка «" in w]
    # Сами промахи названы по-прежнему — молчать о них нельзя, нельзя лишь угадывать.
    assert len(тексты) == 3
    assert not any("похоже на" in w for w in тексты)


def test_то_же_имя_с_другими_разделителями_подсказку_даёт(db):
    """Класс, который подсказывать НАДО: то же имя, записанное иначе — склейка,
    разделитель, окончание. Такие подсказки та же слабая модель исполняла верно, и
    ужесточение порога не должно их выключить."""
    _root, orders, *_ = _tree(db)
    хранилище = _db_node(db, "Хранилище")
    _table(db, хранилище, "sentry_organizationmember_teams")
    _table(db, хранилище, "zerver_userprofile")

    plan = _plan(db, [
        ("a.mmd", _refs_mmd("пишет: sentry_organizationmemberteam", name="Склейка")),
        ("b.mmd", _refs_mmd("читает: user_profile", name="Разделители")),
    ], window=orders)

    тексты = [w for w in plan.warnings if "пометка «" in w]
    # Расхождение мелкое и абсолютное: один разделитель и окончание.
    assert any("похоже на «sentry_organizationmember_teams»" in w for w in тексты)
    # Сравниваем имена БЕЗ разделителей: на сырых строках «user_profile» не узнаёт
    # себя в склеенном DDL-имени, и подсказки бы не было.
    assert any("похоже на «zerver_userprofile»" in w for w in тексты)


def test_подсказки_не_ломают_дедуп_и_кап(db):
    # Подсказка — часть текста замечания, а не новое замечание: одна ссылка в двух
    # режимах остаётся одним промахом, а кап считает строки как считал.
    _root, orders, *_ = _tree(db)
    хранилище = _db_node(db, "Хранилище")
    _table(db, хранилище, "zerver_message", ["content"])
    marks = "читает/пишет: messages, " + ", ".join(
        f"нет{i}" for i in range(MAX_DATA_REF_WARNINGS + 3)
    )

    plan = _plan(db, [("a.mmd", _refs_mmd(marks))], window=orders)

    строки = [w for w in plan.warnings if "пометка «" in w]
    assert строки.count(
        "a.mmd: пометка «messages» — таблица не найдена в структуре проекта — "
        "похоже на «zerver_message»"
    ) == 1
    assert len(строки) == MAX_DATA_REF_WARNINGS
    assert "…ещё 4 пометок не резолвится" in plan.warnings


# ── перечни описанных имён в промпте (Ф8а, находка №1 docs/qa-zulip-brokers.md) ─
# Промпт обязан назвать имена, которые в проекте УЖЕ описаны: пометки писались
# именами ORM-классов, и петля замечаний этого не лечила. Здесь проверяется
# проводка каталогов из БД в промпт — сама раскладка перечня в test_docs_prompt.


def test_endpoint_prompt_несёт_описанные_имена_проекта(db):
    _tree(db)
    хранилище = _db_node(db, "Хранилище")
    _table(db, хранилище, "zerver_message", ["content"])
    _table(db, хранилище, "audit", schema="public")
    kafka = _broker_node(db, "Kafka")
    _channel(db, kafka, "notify_tornado")

    out = docs_prompt(
        lang="ru", hints=None, target=None,
        db=db, project=ensure_project(db), _=ensure_architect(db),
    )

    # Адрес узла — тот же полный путь, которым адресуют пометки; таблица с разделом
    # названа «раздел.имя» — ровно так её видит резолвер.
    assert "- Хранилище: public.audit, zerver_message" in out.prompt
    assert "- Kafka: notify_tornado" in out.prompt


def test_endpoint_prompt_на_проекте_без_структуры_перечней_не_несёт(db):
    # Доки часто грузят раньше структуры: заголовок над пустотой сказал бы агенту
    # «описанных имён нет», и он вычистил бы верные пометки.
    _tree(db)

    out = docs_prompt(
        lang="ru", hints=None, target=None,
        db=db, project=ensure_project(db), _=ensure_architect(db),
    )

    assert "уже описанные" not in out.prompt


# ── два перечня точек входа в промпте (Ф3 docs/plan-recon.md) ──────────────────
# Здесь проверяется ПРОВОДКА каталога из БД в промпт (раскладка — в
# test_docs_prompt): заглушка обязана попасть во второй перечень, а не в первый.


def test_endpoint_prompt_делит_точки_входа_на_описанные_и_ждущие(db):
    _root, orders, *_ = _tree(db)
    _stub(db, orders, "GET /orders", operation="GET /orders", content="graph TD; A")
    _stub(db, orders, "Создание заказа", operation="POST /orders", content="graph TD; B")
    _stub(db, orders, "DELETE /orders/{id}", operation="DELETE /orders/{id}")
    _stub(db, orders, "email_senders", kind="worker")
    # Клиентский сценарий: вид «операция», поле operation пустое — своего API у него
    # нет. После отказа от вида «обзор» он такая же точка входа, как остальные, и в
    # перечне стоит наравне: исключать из него по виду больше нечего.
    _stub(db, orders, "Просмотр витрины", kind="operation", content="graph TD; C")

    out = docs_prompt(
        lang="ru", hints=None, target=None,
        db=db, project=ensure_project(db), _=ensure_architect(db),
    )

    описано = out.prompt.index("Уже ОПИСАНЫ")
    осталось = out.prompt.index("Разведаны, но НЕ ОПИСАНЫ")
    # Схема с человеческим именем названа вместе с адресом: без него перечень не
    # отвечает на вопрос «какая операция уже закрыта».
    assert (
        "- Ярмарка / orders: GET /orders, Просмотр витрины, Создание заказа (POST /orders)"
    ) in out.prompt
    assert "- Ярмарка / orders: DELETE /orders/{id}, email_senders" in out.prompt
    # Главное: заглушки нет в половине «описанного» — иначе агент её пропустит.
    assert "DELETE /orders/{id}" not in out.prompt[описано:осталось]


def test_endpoint_prompt_на_проекте_без_схем_перечня_точек_входа_не_несёт(db):
    # Пустой раздел агенту не нужен: перечня нет, пока у объекта нет ни одной схемы.
    _root, _orders, *_ = _tree(db)

    out = docs_prompt(
        lang="ru", hints=None, target=None,
        db=db, project=ensure_project(db), _=ensure_architect(db),
    )

    assert "Точки входа этого объекта" not in out.prompt


def test_замечание_об_адресе_называет_и_синтаксис_и_допустимые_адреса(db):
    """⚠ Находка полевого прогона (docs/qa-zobnin-field.md): замечание «не указан
    объект» было ЧИСТЫМ ДИАГНОЗОМ — ни имени заголовка, ни перечня адресов. Слабая
    модель на нём выдумала заголовок «archmap-object» из слова «объект» в самом
    замечании и приписала схемы трём узлам, которых в проекте нет; круг починки
    прошёл впустую. Правило Н8 («в отказе должен быть ответ») действовало у данных,
    каналов и конфигурации, а здесь было забыто."""
    _tree(db)
    plan = _plan(db, [("a.mmd", _mmd("Проверка здоровья"))])  # окна нет и адреса нет

    [ошибка] = plan.errors
    # Имя заголовка ДОСЛОВНО: именно его модель и выдумала, когда его не назвали.
    assert "%% archmap-node:" in ошибка
    # И перечень адресов: без него починка — угадывание.
    assert "«Ярмарка»" in ошибка and "«orders»" in ошибка


def test_перечень_адресов_в_замечании_ограничен_капом(db):
    """Кап нужен: на монолите узлов сотни, и полный перечень утопил бы соседние
    замечания. Хвост назван числом — «показали не всё» обязано быть видно."""
    _tree(db)
    project = ensure_project(db)
    for i in range(MAX_NODES_HINT + 3):
        db.add(Node(id=uuid.uuid4(), name=f"svc{i}", project_id=project.id))
    db.flush()

    plan = _plan(db, [("a.mmd", _mmd("Схема"))])

    [ошибка] = plan.errors
    assert ошибка.count("«") == MAX_NODES_HINT
    assert "и ещё" in ошибка
