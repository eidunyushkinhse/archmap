"""Тесты роутера проектов (CRUD, старт, архив/восстановление, удаление, копия).

Дёргаем функции роутера напрямую с db=db (как остальной набор). Покрываем:
счётчики и редактора в мете, три способа старта, глубокую копию (новые id,
исходник цел), мягкий архив и защиту необратимого удаления.
"""

import uuid

import pytest
from conftest import ensure_architect
from fastapi import HTTPException

from app.models.business_process import BusinessProcess
from app.models.edge import Edge
from app.models.node import Node
from app.models.process_fragment import ProcessFragment, ProcessFragmentBranch
from app.routers.projects import (
    archive_project,
    create_project,
    delete_project,
    get_project,
    list_projects,
    restore_project,
)
from app.schemas.project import ProjectCreate


def _schema(db, project_id):
    """Кладёт в проект 2 узла и 1 связь напрямую (для проверки счётчиков/копии)."""
    a = Node(id=uuid.uuid4(), name="A", project_id=project_id)
    b = Node(id=uuid.uuid4(), name="B", project_id=project_id)
    db.add_all([a, b])
    db.flush()
    db.add(Edge(id=uuid.uuid4(), source_id=a.id, target_id=b.id, project_id=project_id))
    db.commit()


def test_create_blank_lists_with_meta(db):
    user = ensure_architect(db)
    p = create_project(ProjectCreate(name="Пустой", description="опис"), db=db, user=user)
    assert p.object_count == 0 and p.edge_count == 0
    assert p.updated_by == user.username
    assert p.preview.nodes == [] and p.preview.edges == []

    active = list_projects(archived=False, db=db)
    assert [x.name for x in active] == ["Пустой"]


def test_preview_projects_edges_to_root_ancestors(db):
    """Превью карточки = корневой уровень: узлы — корни дерева, связь глубокого
    потомка проецируется на его корневого предка (как ghost на холсте)."""
    user = ensure_architect(db)
    p = create_project(ProjectCreate(name="Превью"), db=db, user=user)
    # Два корня: R1 (с ребёнком-листом) и R2.
    r1 = Node(id=uuid.uuid4(), name="R1", project_id=p.id)
    r2 = Node(id=uuid.uuid4(), name="R2", project_id=p.id)
    db.add_all([r1, r2])
    db.flush()
    # Сохранённые координаты корней — строками view_layout корневого вида (R3).
    from app.models.view_layout import ViewLayoutItem
    db.add(ViewLayoutItem(project_id=p.id, view_id=None, item_id=str(r1.id), payload={"x": 10, "y": 20}))
    db.add(ViewLayoutItem(project_id=p.id, view_id=None, item_id=str(r2.id), payload={"x": 200, "y": 20}))
    child = Node(id=uuid.uuid4(), name="C", project_id=p.id, parent_id=r1.id)
    db.add(child)
    db.flush()
    # Связь от потомка R1 к R2 — на корневом уровне это ребро R1→R2.
    db.add(Edge(id=uuid.uuid4(), source_id=child.id, target_id=r2.id, project_id=p.id))
    db.commit()

    fresh = get_project(p.id, db=db)
    node_ids = {n.id for n in fresh.preview.nodes}
    assert node_ids == {r1.id, r2.id}  # потомок в превью не попадает
    by_id = {n.id: n for n in fresh.preview.nodes}
    assert by_id[r1.id].x == 10 and by_id[r1.id].y == 20  # сохранённые координаты
    assert fresh.preview.edges == [] or (
        len(fresh.preview.edges) == 1
        and {fresh.preview.edges[0].source, fresh.preview.edges[0].target} == {r1.id, r2.id}
    )
    assert len(fresh.preview.edges) == 1  # проекция дала ровно одно ребро R1↔R2


def test_create_from_template_seeds_schema(db):
    user = ensure_architect(db)
    p = create_project(ProjectCreate(name="Веб", start="template:webapp"), db=db, user=user)
    assert p.object_count > 0 and p.edge_count > 0
    # У шаблонных узлов задана раскладка → превью карточки показывает реальные
    # координаты (а не гадает по центроидам/окружности).
    assert p.preview.nodes and all(n.x is not None and n.y is not None for n in p.preview.nodes)
    # Внешние системы шаблона (актор, вход, почта) сидятся с is_external → серые.
    ext = {n.name for n in db.query(Node).filter(Node.project_id == p.id, Node.is_external).all()}
    assert ext == {"Пользователь", "Провайдер входа", "Сервис email"}


def test_all_templates_seed_and_match_catalog(db):
    """Каждый шаблон каталога сидится, и счётчики совпадают с его описанием —
    страховка от рёбер на несуществующие ключи при правке каталога."""
    from app.templates import _TEMPLATES, template_ids

    user = ensure_architect(db)
    for tid in template_ids():
        p = create_project(ProjectCreate(name=f"T-{tid}", start=f"template:{tid}"), db=db, user=user)
        tpl = _TEMPLATES[tid]
        assert (p.object_count, p.edge_count) == (len(tpl.nodes), len(tpl.edges)), tid


def test_templates_catalog_serializes():
    """Каталог витрины проходит контракт TemplateOut: 6 шаблонов, у каждого узла
    валидная форма и обязательные координаты (превью = раскладка холста)."""
    from app.schemas.project import TemplateOut
    from app.templates import list_templates

    catalog = [TemplateOut.model_validate(t) for t in list_templates()]
    assert [t.id for t in catalog] == [
        "monolith", "webapp", "microservices", "eventdriven", "serverless", "cqrs",
    ]
    for t in catalog:
        keys = {n.key for n in t.nodes}
        assert t.tagline and t.blurb and t.techs
        assert all(e.source in keys and e.target in keys for e in t.edges)


def test_create_unknown_template_404(db):
    user = ensure_architect(db)
    with pytest.raises(HTTPException) as ei:
        create_project(ProjectCreate(name="X", start="template:нет"), db=db, user=user)
    assert ei.value.status_code == 404


def test_deep_copy_clones_schema_without_touching_source(db):
    user = ensure_architect(db)
    src = create_project(ProjectCreate(name="Источник"), db=db, user=user)
    _schema(db, src.id)
    src_after = get_project(src.id, db=db)
    assert (src_after.object_count, src_after.edge_count) == (2, 1)

    copy = create_project(
        ProjectCreate(name="Копия", start=f"copy:{src.id}"), db=db, user=user
    )
    # Копия повторяет счётчики, но это другой проект.
    assert (copy.object_count, copy.edge_count) == (2, 1)
    assert copy.id != src.id
    # Узлы копии принадлежат новому проекту и имеют новые id.
    copy_nodes = db.query(Node).filter(Node.project_id == copy.id).all()
    src_nodes = db.query(Node).filter(Node.project_id == src.id).all()
    assert len(copy_nodes) == 2 and len(src_nodes) == 2
    assert {n.id for n in copy_nodes}.isdisjoint({n.id for n in src_nodes})
    # Исходник не тронут.
    assert get_project(src.id, db=db).object_count == 2


def test_deep_copy_keeps_node_status(db):
    """Регрессия 2026-07-09: копия проекта теряла status узлов (planned/deprecated
    молча сбрасывались в existing) — copy_project_schema не переносил поле."""
    user = ensure_architect(db)
    src = create_project(ProjectCreate(name="Источник-статусы"), db=db, user=user)
    a = Node(id=uuid.uuid4(), name="Планируемый", project_id=src.id, status="planned")
    b = Node(id=uuid.uuid4(), name="Уходящий", project_id=src.id, status="deprecated")
    db.add_all([a, b])
    db.commit()

    copy = create_project(
        ProjectCreate(name="Копия-статусы", start=f"copy:{src.id}"), db=db, user=user
    )
    statuses = {
        n.name: n.status for n in db.query(Node).filter(Node.project_id == copy.id).all()
    }
    assert statuses == {"Планируемый": "planned", "Уходящий": "deprecated"}


def test_deep_copy_keeps_alt_branches(db):
    """Ветви [иначе] — часть фрагмента, а копируются они отдельными строками: без
    явного переноса копия молча теряла бы ветвления alt (тестов на это не было)."""
    user = ensure_architect(db)
    src = create_project(ProjectCreate(name="Источник-ветви"), db=db, user=user)
    proc = BusinessProcess(id=uuid.uuid4(), name="Оплата", project_id=src.id)
    db.add(proc)
    db.add(
        ProcessFragment(
            id=uuid.uuid4(), process_id=proc.id, kind="alt",
            from_order=0, to_order=2, guard="успех",
            branches=[
                ProcessFragmentBranch(start_order=1, guard="отказ"),
                ProcessFragmentBranch(start_order=2, guard="таймаут"),
            ],
        )
    )
    db.commit()

    copy = create_project(
        ProjectCreate(name="Копия-ветви", start=f"copy:{src.id}"), db=db, user=user
    )

    copy_proc = db.query(BusinessProcess).filter(BusinessProcess.project_id == copy.id).one()
    frag = db.query(ProcessFragment).filter(ProcessFragment.process_id == copy_proc.id).one()
    assert [(b.start_order, b.guard) for b in frag.branches] == [(1, "отказ"), (2, "таймаут")]


def test_copy_unknown_source_404(db):
    user = ensure_architect(db)
    with pytest.raises(HTTPException) as ei:
        create_project(
            ProjectCreate(name="К", start=f"copy:{uuid.uuid4()}"), db=db, user=user
        )
    assert ei.value.status_code == 404


def test_archive_restore_flow(db):
    user = ensure_architect(db)
    p = create_project(ProjectCreate(name="Архивируемый"), db=db, user=user)

    archive_project(p.id, db=db)
    assert [x.name for x in list_projects(archived=False, db=db)] == []
    assert [x.name for x in list_projects(archived=True, db=db)] == ["Архивируемый"]

    restore_project(p.id, db=db)
    assert [x.name for x in list_projects(archived=False, db=db)] == ["Архивируемый"]
    assert list_projects(archived=True, db=db) == []


def test_delete_requires_archive_and_exact_name(db):
    user = ensure_architect(db)
    p = create_project(ProjectCreate(name="Удаляемый"), db=db, user=user)
    _schema(db, p.id)

    # Активный — удалять нельзя.
    with pytest.raises(HTTPException) as ei:
        delete_project(p.id, confirm="Удаляемый", db=db)
    assert ei.value.status_code == 409

    archive_project(p.id, db=db)
    # Неверное подтверждение имени.
    with pytest.raises(HTTPException) as ei:
        delete_project(p.id, confirm="не то", db=db)
    assert ei.value.status_code == 400

    # Точное имя — сносит проект и его схему каскадом.
    delete_project(p.id, confirm="Удаляемый", db=db)
    assert get_project_or_none(db, p.id) is None
    assert db.query(Node).filter(Node.project_id == p.id).count() == 0


def get_project_or_none(db, pid):
    from app.models.project import Project

    return db.get(Project, pid)
