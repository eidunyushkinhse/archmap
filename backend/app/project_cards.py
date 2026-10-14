"""Карточки проектов для списка «Проекты»: счётчики, мини-граф корневого уровня,
кто менял, владелец и действующая роль — батчем, без N+1 (аудит Q-11: алгоритм жил в
routers/projects.py). Роутер только отдаёт их наружу."""

import uuid
from collections import defaultdict

from sqlalchemy import String, cast, func
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

    # Идентификаторы читаются ТЕКСТОМ (аудит Q-20): на списке всех проектов — тысячи
    # узлов и связей, и разбор каждого id в uuid.UUID стоил больше самого алгоритма.
    # В UUID переводятся только корни, попавшие в превью. Текстовая форма зависит от
    # БД (Postgres — с дефисами, SQLite в тестах — без), поэтому тексты сравниваются
    # только между собой, а наружу и с раскладкой — через UUID.
    node_rows = (
        db.query(
            cast(Node.id, String),
            cast(Node.project_id, String),
            cast(Node.parent_id, String),
            Node.is_external,
        )
        .filter(Node.project_id.in_(project_ids))
        .all()
    )
    roots_of: dict[str, list[tuple[str, bool]]] = defaultdict(list)
    parent_of: dict[str, str | None] = {}
    for nid, pid_text, parent_id, is_external in node_rows:
        parent_of[nid] = parent_id
        if parent_id is None:
            roots_of[pid_text].append((nid, is_external))
    text_of = {uuid.UUID(t): t for t in {r[1] for r in node_rows}}

    # Позиции корневых узлов — из view_layout (корневой вид, view IS NULL): батчем
    # по всем проектам, ключ (project_id, item_id=str(node_id)) → {x, y}.
    pos_of: dict[tuple[uuid.UUID, str], tuple[float, float]] = {}
    for layout_pid, item_id, payload in (
        db.query(ViewLayoutItem.project_id, ViewLayoutItem.item_id, ViewLayoutItem.payload)
        .filter(ViewLayoutItem.project_id.in_(project_ids), ViewLayoutItem.view_id.is_(None))
        .all()
    ):
        x, y = payload.get("x"), payload.get("y")
        if x is not None and y is not None:
            pos_of[(layout_pid, item_id)] = (x, y)

    # Корневой предок узла (подъём по parent_id) с мемоизацией по цепочке.
    root_cache: dict[str, str] = {}

    def root_of(node_id: str) -> str:
        path: list[str] = []
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
        db.query(cast(Edge.project_id, String), cast(Edge.source_id, String), cast(Edge.target_id, String))
        .filter(Edge.project_id.in_(project_ids))
        .all()
    )
    project_edges: dict[str, set[tuple[str, str]]] = defaultdict(set)
    for pid_text, source_id, target_id in edge_rows:
        rs, rt = root_of(source_id), root_of(target_id)
        if rs != rt:
            project_edges[pid_text].add((rs, rt))

    out: dict[uuid.UUID, ProjectPreview] = {}
    for pid in project_ids:
        pid_text = text_of.get(pid)
        roots = [(nid, uuid.UUID(nid), ext) for nid, ext in roots_of.get(pid_text, [])] if pid_text else []
        edges = project_edges.get(pid_text, set()) if pid_text else set()
        degree: dict[str, int] = defaultdict(int)
        for s, t in edges:
            degree[s] += 1
            degree[t] += 1
        # Самые связные корни вперёд; tie-break по id для детерминизма.
        roots.sort(key=lambda r: (-degree[r[0]], str(r[1])))
        kept = roots[:MAX_PREVIEW_NODES]
        kept_uuid = {nid: node_uuid for nid, node_uuid, _ext in kept}
        out[pid] = ProjectPreview(
            nodes=[
                ProjectPreviewNode(
                    id=node_uuid,
                    is_external=ext,
                    x=pos_of.get((pid, str(node_uuid)), (None, None))[0],
                    y=pos_of.get((pid, str(node_uuid)), (None, None))[1],
                )
                for _nid, node_uuid, ext in kept
            ],
            edges=[
                ProjectPreviewEdge(source=kept_uuid[s], target=kept_uuid[t])
                for (s, t) in edges
                if s in kept_uuid and t in kept_uuid
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
