"""Карточки проектов для списка «Проекты»: счётчики, мини-граф корневого уровня,
кто менял, владелец и действующая роль — батчем, без N+1 (аудит Q-11: алгоритм жил в
routers/projects.py). Роутер только отдаёт их наружу."""

import uuid
from collections import defaultdict

from sqlalchemy import func
from sqlalchemy.orm import Session

from app.access import effective_roles, owner_usernames
from app.models.edge import Edge
from app.models.node import Node
from app.models.project import Project
from app.models.user import User
from app.models.view_layout import ViewLayoutItem
from app.schemas.project import (
    ProjectPreview,
    ProjectPreviewEdge,
    ProjectPreviewNode,
    ProjectResponse,
)

# Сколько корневых узлов максимум кладём в превью карточки (миниатюра ~280×132).
# Больше — берём узлы с наибольшим числом связей (самые «центральные»).
MAX_PREVIEW_NODES = 12


def _counts(
    db: Session, project_ids: list[uuid.UUID]
) -> tuple[dict[uuid.UUID, int], dict[uuid.UUID, int]]:
    """Счётчики объектов и связей по проектам одним запросом на тип (без N+1)."""
    if not project_ids:
        return {}, {}
    # Comprehension с распаковкой строк: dict(Row...) не типизируется (Row не
    # подтип tuple для mypy), а {pid: cnt for ...} выводится чисто.
    node_counts: dict[uuid.UUID, int] = {
        pid: cnt
        for pid, cnt in (
            db.query(Node.project_id, func.count(Node.id))
            .filter(Node.project_id.in_(project_ids))
            .group_by(Node.project_id)
            .all()
        )
    }
    edge_counts: dict[uuid.UUID, int] = {
        pid: cnt
        for pid, cnt in (
            db.query(Edge.project_id, func.count(Edge.id))
            .filter(Edge.project_id.in_(project_ids))
            .group_by(Edge.project_id)
            .all()
        )
    }
    return node_counts, edge_counts


def _previews(db: Session, project_ids: list[uuid.UUID]) -> dict[uuid.UUID, ProjectPreview]:
    """Мини-граф корневого уровня для каждого проекта — батчем, без N+1.

    Топология как на холсте корневого уровня: узлы = корни дерева (parent_id is
    null), связи = все рёбра проекта с концами, спроецированными на корневого
    предка (как ghost-проекция сквозных связей). Петли (оба конца под одним корнем)
    отбрасываются. При переборе MAX_PREVIEW_NODES оставляем самые связные корни.
    """
    if not project_ids:
        return {}

    # Все узлы проектов (только нужные для превью/проекции поля).
    node_rows = (
        db.query(Node.id, Node.project_id, Node.parent_id, Node.is_external)
        .filter(Node.project_id.in_(project_ids))
        .all()
    )
    by_project: dict[uuid.UUID, list] = defaultdict(list)
    parent_of: dict[uuid.UUID, uuid.UUID | None] = {}
    for r in node_rows:
        by_project[r.project_id].append(r)
        parent_of[r.id] = r.parent_id

    # Позиции корневых узлов — из view_layout (корневой вид, view IS NULL): батчем
    # по всем проектам, ключ (project_id, item_id=str(node_id)) → {x, y}.
    pos_of: dict[tuple[uuid.UUID, str], tuple[float, float]] = {}
    for it in (
        db.query(ViewLayoutItem)
        .filter(ViewLayoutItem.project_id.in_(project_ids), ViewLayoutItem.view_id.is_(None))
        .all()
    ):
        x, y = it.payload.get("x"), it.payload.get("y")
        if x is not None and y is not None:
            pos_of[(it.project_id, it.item_id)] = (x, y)

    # Корневой предок узла (подъём по parent_id) с мемоизацией по цепочке.
    root_cache: dict[uuid.UUID, uuid.UUID] = {}

    def root_of(node_id: uuid.UUID) -> uuid.UUID:
        path: list[uuid.UUID] = []
        cur = node_id
        while True:
            if cur in root_cache:
                root = root_cache[cur]
                break
            path.append(cur)
            par = parent_of.get(cur)
            if par is None or par not in parent_of or par in path:
                # корень дерева, родитель вне проекта или цикл в данных — обрываемся
                root = cur
                break
            cur = par
        for c in path:
            root_cache[c] = root
        return root

    # Рёбра, спроецированные на корневых предков, по проектам (множество пар).
    edge_rows = (
        db.query(Edge.project_id, Edge.source_id, Edge.target_id)
        .filter(Edge.project_id.in_(project_ids))
        .all()
    )
    project_edges: dict[uuid.UUID, set[tuple[uuid.UUID, uuid.UUID]]] = defaultdict(set)
    for e in edge_rows:
        rs, rt = root_of(e.source_id), root_of(e.target_id)
        if rs != rt:
            project_edges[e.project_id].add((rs, rt))

    out: dict[uuid.UUID, ProjectPreview] = {}
    for pid in project_ids:
        roots = [r for r in by_project.get(pid, []) if r.parent_id is None]
        edges = project_edges.get(pid, set())
        degree: dict[uuid.UUID, int] = defaultdict(int)
        for s, t in edges:
            degree[s] += 1
            degree[t] += 1
        # Самые связные корни вперёд; tie-break по id для детерминизма.
        roots.sort(key=lambda r: (-degree[r.id], str(r.id)))
        kept = roots[:MAX_PREVIEW_NODES]
        kept_ids = {r.id for r in kept}
        out[pid] = ProjectPreview(
            nodes=[
                ProjectPreviewNode(
                    id=r.id,
                    is_external=r.is_external,
                    x=pos_of.get((pid, str(r.id)), (None, None))[0],
                    y=pos_of.get((pid, str(r.id)), (None, None))[1],
                )
                for r in kept
            ],
            edges=[
                ProjectPreviewEdge(source=s, target=t)
                for (s, t) in edges
                if s in kept_ids and t in kept_ids
            ],
        )
    return out


def _users_map(db: Session, projects: list[Project]) -> dict[uuid.UUID, str]:
    """id → username для редакторов проектов (одним запросом)."""
    ids = {p.updated_by_id for p in projects if p.updated_by_id is not None}
    if not ids:
        return {}
    return {u.id: u.username for u in db.query(User).filter(User.id.in_(ids)).all()}


def project_cards(db: Session, user: User, projects: list[Project]) -> list[ProjectResponse]:
    """Карточки проектов глазами пользователя: счётчики, превью, кто менял, владелец
    и действующая роль — всё батчем, без N+1. Проекты сюда приходят уже доступные
    (роль не None): список фильтруется запросом, одиночные — через project_for."""
    ids = [p.id for p in projects]
    nc, ec = _counts(db, ids)
    users = _users_map(db, projects)
    previews = _previews(db, ids)
    roles = effective_roles(db, user, projects)
    owners = owner_usernames(db, ids)
    out: list[ProjectResponse] = []
    for p in projects:
        role = roles.get(p.id)
        if role is None:  # недоступный проект в выдачу не попадает (страховка)
            continue
        out.append(
            ProjectResponse(
                id=p.id,
                name=p.name,
                description=p.description,
                archived_at=p.archived_at,
                created_at=p.created_at,
                updated_at=p.updated_at,
                object_count=nc.get(p.id, 0),
                edge_count=ec.get(p.id, 0),
                updated_by=users.get(p.updated_by_id) if p.updated_by_id else None,
                preview=previews.get(p.id) or ProjectPreview(nodes=[], edges=[]),
                my_role=role,
                owner_username=owners.get(p.id),
                visible_to_all=p.visible_to_all,
            )
        )
    return out


def project_card(db: Session, user: User, p: Project) -> ProjectResponse:
    """Одна карточка проекта (см. project_cards)."""
    [one] = project_cards(db, user, [p])
    return one
