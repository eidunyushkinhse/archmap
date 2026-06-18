"""Тесты роутера проектов (CRUD, старт, архив/восстановление, удаление, копия).

Дёргаем функции роутера напрямую с db=db (как остальной набор). Покрываем:
счётчики и редактора в мете, три способа старта, глубокую копию (новые id,
исходник цел), мягкий архив и защиту необратимого удаления.
"""

import uuid

import pytest
from conftest import ensure_architect
from fastapi import HTTPException

from app.models.edge import Edge
from app.models.node import Node
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

    active = list_projects(archived=False, db=db)
    assert [x.name for x in active] == ["Пустой"]


def test_create_from_template_seeds_schema(db):
    user = ensure_architect(db)
    p = create_project(ProjectCreate(name="C4", start="template:c4"), db=db, user=user)
    assert p.object_count > 0 and p.edge_count > 0


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
