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
    apply_docs_plan,
    build_docs_plan,
    pkg_from_mmd,
)
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
    db.add(NodeDoc(node_id=orders.id, name="Приём", kind="overview", content="graph TD; OLD"))
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
    db.add(NodeDoc(node_id=orders.id, name="Приём", kind="overview", content=text))
    db.commit()

    plan = _plan(db, [("a.mmd", text)], window=orders)
    assert [a.action for a in plan.logic] == ["unchanged"]


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
    db.add(NodeDoc(node_id=orders.id, name="Приём", kind="overview", content="graph TD; OLD"))
    db.commit()
    orders_id = orders.id
    files = [("a.mmd", _mmd("Приём"))]

    plan = _plan(db, files, window=orders, overwrite=True)
    created, updated, specs = apply_docs_plan(db, plan)
    db.commit()
    assert (created, updated, specs) == (0, 1, 0)

    doc = db.query(NodeDoc).filter(NodeDoc.node_id == orders_id).one()
    assert "A --> B" in doc.content and doc.version == 2  # перезапись бампает CAS-версию

    # Повторный прогон того же пакета — всё «без изменений», ничего не пишется
    again = _plan(db, files, window=orders, overwrite=True)
    assert [a.action for a in again.logic] == ["unchanged"]
    assert apply_docs_plan(db, again) == (0, 0, 0)


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


def test_без_шапки_имя_берётся_из_имени_файла_и_вид_обзорный(db):
    _, orders, *_ = _tree(db)

    report = docs_import_preview(
        _mmd_payload(db, ("Схема хранения.mmd", "graph LR\n  T1 --> T2\n"), node=orders),
        db=db, project=ensure_project(db), _=ensure_architect(db),
    )

    assert report.errors == []
    assert report.logic[0].name == "Схема хранения"
    assert report.logic[0].kind == "overview"


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
