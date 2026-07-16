"""Тесты импорта YAML (app/import_yaml.py + ветка start="import" + dry-run).

Главная гарантия — roundtrip с экспортом: вывод build_export импортируется без
ошибок с той же семантикой (имя, форма, статус, роль, технология, external,
описание, вложенность, связи). Плюс валидация: битый YAML, неизвестные/
неоднозначные ссылки в edges, неверный shape, лимит глубины; dry-run превью
ничего не пишет в БД.
"""

import uuid

import pytest
import yaml
from conftest import ensure_architect
from fastapi import HTTPException

from app.export import build_export
from app.import_yaml import MAX_DEPTH, parse_import, seed_import
from app.models.edge import Edge
from app.models.node import Node
from app.models.project import Project
from app.routers.projects import create_project, import_preview
from app.schemas.project import ImportPreviewIn, ProjectCreate


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
        (path_of(n), n.shape, n.status, n.role, n.technology, n.is_external, n.description)
        for n in nodes
    }
    edges = db.query(Edge).filter(Edge.project_id == project_id).all()
    edge_sig = {
        (path_of(by_id[e.source_id]), path_of(by_id[e.target_id]), e.label, e.technology)
        for e in edges
    }
    return node_sig, edge_sig


def test_roundtrip_export_import_same_semantics(db):
    """Экспорт схемы с вложенностью, дублями имён, статусами и external импортируется
    в новый проект бит-в-бит по семантике."""
    src = _project(db, "Источник")
    platform = _node(
        db, src.id, "Платформа", role="система", technology="K8s",
        description="Первая строка\nвторая строка",
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


def test_import_via_create_project(db):
    """Полный цикл через роутер: start="import" сидит схему из YAML."""
    user = ensure_architect(db)
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
    p = create_project(
        ProjectCreate(name="Импортированный", start="import", import_yaml=content),
        db=db, user=user,
    )
    assert (p.object_count, p.edge_count) == (3, 1)
    ext = {n.name: n.is_external for n in db.query(Node).filter(Node.project_id == p.id)}
    assert ext == {"Ядро": False, "БД": False, "Клиент": True}


def test_import_without_yaml_400(db):
    user = ensure_architect(db)
    with pytest.raises(HTTPException) as ei:
        create_project(ProjectCreate(name="X", start="import"), db=db, user=user)
    assert ei.value.status_code == 400


def test_import_broken_yaml_400(db):
    user = ensure_architect(db)
    with pytest.raises(HTTPException) as ei:
        create_project(
            ProjectCreate(name="X", start="import", import_yaml="nodes:\n  - name: [оборвано"),
            db=db, user=user,
        )
    assert ei.value.status_code == 400
    assert "YAML" in ei.value.detail


def test_unknown_edge_ref_is_error():
    parsed, errors = parse_import("nodes:\n  - name: A\nedges:\n  - from: A\n    to: B\n")
    assert parsed is None
    assert any('узел "B" не найден' in e and "edges[0]" in e for e in errors)


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
    user = ensure_architect(db)
    ok = import_preview(
        ImportPreviewIn(content="nodes:\n  - name: A\n  - name: B\nedges:\n  - from: A\n    to: B\n"),
        _user=user,
    )
    assert (ok.ok, ok.node_count, ok.edge_count, ok.roots) == (True, 2, 1, ["A", "B"])

    bad = import_preview(ImportPreviewIn(content="nodes:\n  - name: [x"), _user=user)
    assert bad.ok is False and bad.errors and bad.node_count == 0

    # Dry-run ничего не пишет: ни проектов, ни узлов.
    assert db.query(Project).count() == 0
    assert db.query(Node).count() == 0


def test_preview_roots_capped_at_8(db):
    user = ensure_architect(db)
    content = yaml.dump({"nodes": [{"name": f"R{i}"} for i in range(10)]}, allow_unicode=True)
    out = import_preview(ImportPreviewIn(content=content), _user=user)
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
    user = ensure_architect(db)
    b = "nodes:\n  - name: Система\n    children:\n      - name: orders\n        technology: Go\n"
    out = import_preview(ImportPreviewIn(contents=[_MULTI_A, b]), _user=user)
    assert out.ok and out.files == 2
    assert out.node_count == 3  # Система + payments + orders (склеены)
    assert out.merged_count == 2 and "Система" in out.merged
    assert out.conflicts == [] and out.errors == []


def test_preview_multi_errors_prefixed_by_file(db):
    user = ensure_architect(db)
    out = import_preview(
        ImportPreviewIn(contents=[_MULTI_A, "nodes:\n  - name: [оборвано"]), _user=user
    )
    assert out.ok is False and out.files == 2
    assert any(e.startswith("файл 2: ") for e in out.errors)


def test_preview_requires_some_content(db):
    user = ensure_architect(db)
    with pytest.raises(HTTPException) as ei:
        import_preview(ImportPreviewIn(), _user=user)
    assert ei.value.status_code == 400


def test_create_project_with_import_yamls(db):
    """Полный цикл мульти-репо: два YAML сливаются в одну схему проекта."""
    user = ensure_architect(db)
    b = "nodes:\n  - name: Система\n    children:\n      - name: orders\n        technology: Go\n"
    p = create_project(
        ProjectCreate(name="Мульти", start="import", import_yamls=[_MULTI_A, b]),
        db=db, user=user,
    )
    assert (p.object_count, p.edge_count) == (3, 1)
    tech = {n.name: n.technology for n in db.query(Node).filter(Node.project_id == p.id)}
    assert tech == {"Система": None, "payments": "Python", "orders": "Go"}
