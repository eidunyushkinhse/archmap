"""Тесты дозаливки доков (docs_import, этап 2 plan-agent-docs.md).

parse_manifest: структура/enum'ы/лимиты/дубли + толерантность к обёртке
(fenced-блок, срез от «docs:»). build_docs_plan: резолв узлов (путь/имя/хвост/
неоднозначно/не найден), политика перезаписи (create/overwrite/skip/unchanged),
мердж нескольких манифестов (дубль в одном файле — ошибка, между файлами —
первый побеждает + конфликт), файлы спек (file/inline/не найден/не использован),
эвристика OpenAPI. apply_docs_plan: запись + версии + идемпотентность.
"""

import uuid

import pytest
from conftest import ensure_architect, ensure_project
from fastapi import HTTPException

from app.docs_import import (
    apply_docs_plan,
    build_docs_plan,
    looks_like_manifest,
    parse_manifest,
)
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


MANIFEST = """
docs:
  - node: "Ярмарка / orders"
    logic:
      - name: "POST /orders"
        kind: operation
        operation: "POST /orders"
        mermaid: |
          graph TD
            A["Приём"] --> B["Запись"]
    openapi:
      file: orders-api.yaml
      origin: found
"""

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


def _plan_one(db, manifest_text, assets=None, overwrite=False):
    parsed, errors = parse_manifest(manifest_text)
    assert errors == [], errors
    return build_docs_plan(_nodes(db), [("manifest.yaml", parsed)], assets or {}, overwrite)


# ── parse_manifest ──────────────────────────────────────────────────────────────

def test_parse_valid_and_wrappers():
    for text in (
        MANIFEST,
        f"Вот манифест:\n```yaml\n{MANIFEST}\n```",  # fenced + преамбула
        f"Собрал документацию по репозиторию.\n{MANIFEST.lstrip()}",  # голая преамбула
    ):
        parsed, errors = parse_manifest(text)
        assert errors == [] and parsed is not None
        assert parsed.entries[0].node_ref == "Ярмарка / orders"
        assert parsed.entries[0].logic[0].kind == "operation"
        assert parsed.entries[0].openapi.file == "orders-api.yaml"


def test_parse_unknown_keys_ignored():
    parsed, errors = parse_manifest(
        'docs:\n  - node: "X"\n    comment: мусор\n    logic:\n'
        '      - name: "Л"\n        mermaid: "graph TD; A"\n        extra: 1\n'
    )
    assert errors == [] and parsed.entries[0].logic[0].name == "Л"


def test_parse_errors_collected():
    parsed, errors = parse_manifest(
        "docs:\n"
        "  - logic: []\n"  # нет node
        '  - node: "A"\n    logic:\n'
        '      - name: "Л"\n        kind: чертёж\n        mermaid: "graph TD; A"\n'
        '      - name: "Л2"\n'  # нет mermaid
        '      - name: "Л"\n        mermaid: "graph TD; B"\n'  # дубль имени
        '  - node: "B"\n    openapi:\n      origin: found\n'  # ни file, ни inline
        '  - node: "C"\n    openapi: {file: a.yaml, inline: "x"}\n'  # и то и то
    )
    assert parsed is None
    joined = "\n".join(errors)
    assert "node — обязательная" in joined
    assert "kind 'чертёж' не поддерживается" in joined
    assert "mermaid — обязательный" in joined
    assert 'дубль имени схемы "Л"' in joined
    assert joined.count("ровно одно из file | inline") == 2


def test_parse_empty_openapi_dict_means_no_spec():
    # «openapi: {}» — способ слабой модели сказать «спеки нет» (стресс-тест
    # 2/8 прогонов): не ошибка, а отсутствие спеки; файл не бракуется.
    parsed, errors = parse_manifest(
        'docs:\n  - node: "X"\n    logic: [{name: "Л", mermaid: "graph TD; A"}]\n'
        "    openapi: {}\n"
    )
    assert errors == [] and parsed.entries[0].openapi is None


def test_looks_like_manifest_sniff():
    assert looks_like_manifest(MANIFEST)
    # Битый YAML, но со строкой docs: — манифест (должен дать ошибки, не уйти в ресурсы)
    assert looks_like_manifest("docs:\n  - node: [битый\n")
    assert not looks_like_manifest(SPEC)
    assert not looks_like_manifest('{"openapi": "3.0.0", "paths": {}}')


# ── build_docs_plan: резолв и политика ─────────────────────────────────────────

def test_plan_resolve_and_create(db):
    _tree(db)
    plan = _plan_one(db, MANIFEST, assets={"orders-api.yaml": SPEC})
    assert plan.errors == [] and plan.conflicts == []
    assert [a.action for a in plan.logic] == ["create"]
    assert plan.logic[0].node_path == "Ярмарка / orders"
    [spec] = plan.specs
    assert (spec.action, spec.valid_yaml, spec.looks_openapi, spec.oas_version) == (
        "create", True, True, "3.0.0",
    )


def test_plan_resolve_bare_suffix_ambiguous(db):
    _tree(db)
    parsed, _ = parse_manifest(
        "docs:\n"
        '  - node: "orders"\n    logic: [{name: "А", mermaid: "graph TD; A"}]\n'
        '  - node: "billing / api"\n    logic: [{name: "Б", mermaid: "graph TD; B"}]\n'
        '  - node: "api"\n    logic: [{name: "В", mermaid: "graph TD; C"}]\n'
        '  - node: "нет-такого"\n    logic: [{name: "Г", mermaid: "graph TD; D"}]\n'
    )
    plan = build_docs_plan(_nodes(db), [("m.yaml", parsed)], {}, overwrite=False)
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
    parsed, _ = parse_manifest(
        "docs:\n"
        '  - node: "Ярмарка/billing/api"\n    logic: [{name: "А", mermaid: "graph TD; A"}]\n'
        '  - node: "shipping/api"\n    logic: [{name: "Б", mermaid: "graph TD; B"}]\n'
    )
    plan = build_docs_plan(_nodes(db), [("m.yaml", parsed)], {}, overwrite=False)
    assert plan.errors == []
    assert sorted(a.node_path for a in plan.logic) == [
        "Ярмарка / billing / api",
        "Ярмарка / shipping / api",
    ]


def test_plan_overwrite_policy(db):
    root, orders, *_ = _tree(db)
    db.add(NodeDoc(node_id=orders.id, name="POST /orders", kind="operation",
                   operation="POST /orders", content="graph TD; OLD"))
    orders.openapi_spec = "openapi: 3.0.0\npaths: {}\n"
    db.commit()

    skip = _plan_one(db, MANIFEST, assets={"orders-api.yaml": SPEC}, overwrite=False)
    assert [a.action for a in skip.logic] == ["skip"]
    assert [s.action for s in skip.specs] == ["skip"]

    over = _plan_one(db, MANIFEST, assets={"orders-api.yaml": SPEC}, overwrite=True)
    assert [a.action for a in over.logic] == ["overwrite"]
    assert over.logic[0].doc_id is not None
    assert [s.action for s in over.specs] == ["overwrite"]


def test_plan_unchanged(db):
    root, orders, *_ = _tree(db)
    parsed, _ = parse_manifest(MANIFEST)
    mermaid = parsed.entries[0].logic[0].mermaid
    db.add(NodeDoc(node_id=orders.id, name="POST /orders", kind="operation",
                   operation="POST /orders", content=mermaid))
    orders.openapi_spec = SPEC
    db.commit()
    plan = _plan_one(db, MANIFEST, assets={"orders-api.yaml": SPEC})
    assert [a.action for a in plan.logic] == ["unchanged"]
    assert [s.action for s in plan.specs] == ["unchanged"]


def test_plan_merge_two_files_first_wins(db):
    _tree(db)
    a, _ = parse_manifest('docs:\n  - node: "orders"\n    logic: [{name: "Л", mermaid: "graph TD; A"}]\n')
    b, _ = parse_manifest('docs:\n  - node: "orders"\n    logic: [{name: "Л", mermaid: "graph TD; B"}]\n')
    plan = build_docs_plan(_nodes(db), [("один.yaml", a), ("два.yaml", b)], {}, False)
    assert len(plan.logic) == 1 and plan.logic[0].mermaid == "graph TD; A"
    assert plan.errors == []
    assert any("уже задана файлом один.yaml" in c for c in plan.conflicts)


def test_plan_duplicate_slot_same_file_error(db):
    _tree(db)
    # Два entries одного файла резолвятся в ОДИН узел (путь и голое имя) — дубль слота
    parsed, _ = parse_manifest(
        "docs:\n"
        '  - node: "Ярмарка / orders"\n    logic: [{name: "Л", mermaid: "graph TD; A"}]\n'
        '  - node: "orders"\n    logic: [{name: "Л", mermaid: "graph TD; B"}]\n'
    )
    plan = build_docs_plan(_nodes(db), [("m.yaml", parsed)], {}, False)
    assert any("дубль схемы" in e for e in plan.errors)


def test_plan_spec_file_missing_and_unused(db):
    _tree(db)
    plan = _plan_one(db, MANIFEST, assets={"другой.yaml": SPEC})
    assert any('"orders-api.yaml" не найден' in e for e in plan.errors)
    assert any('"другой.yaml" не использован' in w for w in plan.warnings)


def test_plan_spec_inline_and_heuristics(db):
    _tree(db)
    parsed, _ = parse_manifest(
        "docs:\n"
        '  - node: "orders"\n    openapi: {inline: "просто текст: без paths"}\n'
    )
    plan = build_docs_plan(_nodes(db), [("m.yaml", parsed)], {}, False)
    [spec] = plan.specs
    assert spec.source == "inline" and spec.action == "create"
    assert spec.valid_yaml and not spec.looks_openapi
    joined = "\n".join(plan.warnings)
    assert "не похожа на OpenAPI" in joined
    assert "не указано происхождение" in joined


def test_plan_operation_kind_warning(db):
    _tree(db)
    parsed, _ = parse_manifest(
        'docs:\n  - node: "orders"\n    logic: [{name: "Л", kind: operation, mermaid: "graph TD; A"}]\n'
    )
    plan = build_docs_plan(_nodes(db), [("m.yaml", parsed)], {}, False)
    assert any("kind=operation без поля operation" in w for w in plan.warnings)


# ── apply_docs_plan ─────────────────────────────────────────────────────────────

def test_apply_and_idempotent(db):
    root, orders, *_ = _tree(db)
    db.add(NodeDoc(node_id=orders.id, name="POST /orders", kind="operation",
                   operation="POST /orders", content="graph TD; OLD"))
    db.commit()
    orders_id = orders.id

    plan = _plan_one(db, MANIFEST, assets={"orders-api.yaml": SPEC}, overwrite=True)
    created, updated, specs = apply_docs_plan(db, plan)
    db.commit()
    assert (created, updated, specs) == (0, 1, 1)

    doc = db.query(NodeDoc).filter(NodeDoc.node_id == orders_id).one()
    assert "Приём" in doc.content and doc.version == 2  # перезапись бампает CAS-версию
    node = db.get(Node, orders_id)
    assert node.openapi_spec == SPEC and node.version == 2

    # Повторный прогон того же пакета — всё «без изменений», ничего не пишется
    again = _plan_one(db, MANIFEST, assets={"orders-api.yaml": SPEC}, overwrite=True)
    assert [a.action for a in again.logic] == ["unchanged"]
    assert [s.action for s in again.specs] == ["unchanged"]
    assert apply_docs_plan(db, again) == (0, 0, 0)


# ── Эндпоинты ──────────────────────────────────────────────────────────────────

def _payload(*files, overwrite=False, only=None):
    return DocsImportIn(
        files=[DocsFileIn(name=n, content=c) for n, c in files], overwrite=overwrite, only=only
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
    _tree(db)
    report = docs_import_preview(
        _payload(("manifest.yaml", MANIFEST), ("orders-api.yaml", SPEC)),
        db=db, project=ensure_project(db), _=ensure_architect(db),
    )
    assert report.applied is False and report.errors == []
    assert [a.action for a in report.logic] == ["create"]
    assert report.logic[0].mermaid.startswith("graph TD")  # текст для фронт-валидации
    assert db.query(NodeDoc).count() == 0


def test_endpoint_apply_writes_and_bumps(db):
    _tree(db)
    project = ensure_project(db)
    rev0 = project.meta_rev
    graph0 = project.graph_rev
    report = docs_import_apply(
        _payload(("manifest.yaml", MANIFEST), ("orders-api.yaml", SPEC)),
        db=db, project=project, user=ensure_architect(db),
    )
    assert report.applied is True
    assert (report.created_docs, report.updated_docs, report.specs_written) == (1, 0, 1)
    assert db.query(NodeDoc).count() == 1
    db.refresh(project)
    # Доки/спеки — мета узла: двигают meta_rev, НЕ graph_rev (тост страницы, не схемы)
    assert project.meta_rev == rev0 + 1
    assert project.graph_rev == graph0

    # Идемпотентный повтор: applied=True, но нули и БЕЗ бампа курсоров
    again = docs_import_apply(
        _payload(("manifest.yaml", MANIFEST), ("orders-api.yaml", SPEC)),
        db=db, project=project, user=ensure_architect(db),
    )
    assert again.applied is True
    assert (again.created_docs, again.updated_docs, again.specs_written) == (0, 0, 0)
    db.refresh(project)
    assert project.meta_rev == rev0 + 1


def test_endpoint_apply_blocked_by_errors(db):
    _tree(db)
    broken = "docs:\n  - logic: []\n"  # нет node → ошибка парсинга манифеста
    report = docs_import_apply(
        _payload(("manifest.yaml", broken)),
        db=db, project=ensure_project(db), user=ensure_architect(db),
    )
    assert report.applied is False
    assert any("manifest.yaml: " in e for e in report.errors)
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
    _tree(db)
    files = (("manifest.yaml", MANIFEST), ("orders-api.yaml", SPEC))

    logic_only = docs_import_preview(
        _payload(*files, only="logic"),
        db=db, project=ensure_project(db), _=ensure_architect(db),
    )
    assert len(logic_only.logic) == 1 and logic_only.specs == []

    api_only = docs_import_preview(
        _payload(*files, only="api"),
        db=db, project=ensure_project(db), _=ensure_architect(db),
    )
    assert api_only.logic == [] and len(api_only.specs) == 1

    # Применение с фильтром пишет только своё (спека не создаётся)
    applied = docs_import_apply(
        _payload(*files, only="logic"),
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
    # ни шапки, ни начала диаграммы.
    _, orders, *_ = _tree(db)

    report = docs_import_preview(
        _mmd_payload(db, ("orders-create.mmd", MMD), ("orders-api.yaml", SPEC), node=orders),
        db=db, project=ensure_project(db), _=ensure_architect(db),
    )

    assert len(report.logic) == 1
    assert any("не использован" in w for w in report.warnings)


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
