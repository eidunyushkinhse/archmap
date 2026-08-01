"""API проектов: /api/v1/projects.

Управление изолированными схемами: список с метаданными (счётчики объектов/связей,
кто и когда менял), создание (пустой / шаблон / копия), переименование, мягкое
архивирование/восстановление и необратимое удаление. Доменные данные эти эндпоинты
НЕ скоупят через X-Project-Id — они оперируют самими проектами.
"""

import uuid
from collections import defaultdict
from datetime import UTC, datetime
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import func
from sqlalchemy.orm import Session

from app.auth import get_current_user, require_architect
from app.database import get_db
from app.import_merge import parse_and_merge
from app.import_prompt import build_import_prompt
from app.import_yaml import seed_import
from app.models.edge import Edge
from app.models.node import Node
from app.models.project import Project
from app.models.user import User
from app.models.view_layout import ViewLayoutItem
from app.projects import copy_project_schema
from app.schemas.project import (
    ImportPreviewIn,
    ImportPreviewOut,
    ImportPromptOut,
    ProjectCreate,
    ProjectPreview,
    ProjectPreviewEdge,
    ProjectPreviewNode,
    ProjectResponse,
    ProjectUpdate,
    TemplateOut,
)
from app.templates import list_templates, seed_template

router = APIRouter(prefix="/projects", tags=["projects"])

# Сколько корневых узлов максимум кладём в превью карточки (миниатюра ~280×132).
# Больше — берём узлы с наибольшим числом связей (самые «центральные»).
MAX_PREVIEW_NODES = 12


def _counts(db: Session, project_ids: list[uuid.UUID]) -> tuple[dict, dict]:
    """Счётчики объектов и связей по проектам одним запросом на тип (без N+1)."""
    if not project_ids:
        return {}, {}
    node_counts = dict(
        db.query(Node.project_id, func.count(Node.id))
        .filter(Node.project_id.in_(project_ids))
        .group_by(Node.project_id)
        .all()
    )
    edge_counts = dict(
        db.query(Edge.project_id, func.count(Edge.id))
        .filter(Edge.project_id.in_(project_ids))
        .group_by(Edge.project_id)
        .all()
    )
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
            if par is None or par not in parent_of:
                root = cur  # корень дерева (либо родитель вне проекта — обрываемся)
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


def _to_response(
    p: Project,
    node_counts: dict,
    edge_counts: dict,
    users: dict,
    previews: dict[uuid.UUID, ProjectPreview],
) -> ProjectResponse:
    return ProjectResponse(
        id=p.id,
        name=p.name,
        description=p.description,
        archived_at=p.archived_at,
        created_at=p.created_at,
        updated_at=p.updated_at,
        object_count=node_counts.get(p.id, 0),
        edge_count=edge_counts.get(p.id, 0),
        updated_by=users.get(p.updated_by_id) if p.updated_by_id else None,
        preview=previews.get(p.id) or ProjectPreview(nodes=[], edges=[]),
    )


def _users_map(db: Session, projects: list[Project]) -> dict[uuid.UUID, str]:
    """id → username для редакторов проектов (одним запросом)."""
    ids = {p.updated_by_id for p in projects if p.updated_by_id is not None}
    if not ids:
        return {}
    return {u.id: u.username for u in db.query(User).filter(User.id.in_(ids)).all()}


@router.get("", response_model=list[ProjectResponse])
def list_projects(
    archived: bool = False,
    db: Session = Depends(get_db),
    _: User = Depends(get_current_user),
) -> list[ProjectResponse]:
    """Список проектов: активные (archived=false) или архив, сорт. по дате изменения."""
    q = db.query(Project)
    q = q.filter(Project.archived_at.isnot(None)) if archived else q.filter(Project.archived_at.is_(None))
    projects = q.order_by(Project.updated_at.desc()).all()
    ids = [p.id for p in projects]
    nc, ec = _counts(db, ids)
    users = _users_map(db, projects)
    previews = _previews(db, ids)
    return [_to_response(p, nc, ec, users, previews) for p in projects]


# ⚠️ Статические пути — ДО параметрического GET /{project_id}, иначе он их перехватит
# (та же норма, что /search|/all|/graph в nodes.py).
@router.get("/templates", response_model=list[TemplateOut])
def get_templates(_user: User = Depends(get_current_user)) -> list[dict]:
    # Статический каталог стартовых шаблонов для витрины создания проекта.
    return list_templates()


@router.get("/import/prompt", response_model=ImportPromptOut)
def import_prompt(
    system_name: str = Query(min_length=1, max_length=256),
    depth: int = Query(default=3, ge=2, le=3),
    lang: Literal["ru", "en"] = "ru",
    hints: str | None = Query(default=None, max_length=2_000),
    _user: User = Depends(require_architect),
) -> ImportPromptOut:
    """Универсальный промпт «Из репозитория» для ИИ-агента пользователя (BYOA):
    один и тот же промпт запускается в каждом репозитории системы, YAML-ответы
    сливает merge_imports. Параметры вшиваются в текст (docs/archive/plan-repo-import.md)."""
    return ImportPromptOut(
        prompt=build_import_prompt(system_name, depth=depth, lang=lang, hints=hints)
    )


@router.post("/import/preview", response_model=ImportPreviewOut)
def import_preview(
    payload: ImportPreviewIn,
    _user: User = Depends(require_architect),
) -> ImportPreviewOut:
    """Dry-run импорта YAML для живой сводки в модалке: парсинг/валидация каждого
    документа + слияние (contents; один content — вырожденный случай), БД не
    трогаем. Скоуп X-Project-Id не нужен — проекта ещё нет."""
    texts = payload.contents if payload.contents is not None else (
        [payload.content] if payload.content is not None else []
    )
    if not texts:
        raise HTTPException(status_code=400, detail="Не передан YAML для проверки")
    merged, report, errors = parse_and_merge(texts)
    if merged is None:
        return ImportPreviewOut(
            ok=False, errors=errors, node_count=0, edge_count=0, roots=[], files=len(texts)
        )
    return ImportPreviewOut(
        ok=True,
        errors=[],
        node_count=len(merged.nodes),
        edge_count=len(merged.edges),
        roots=merged.roots[:8],
        files=len(texts),
        merged_count=len(report.merged_paths),
        merged=report.merged_paths[:8],
        conflicts=report.conflicts,
        warnings=report.warnings,
        dropped_edges=report.dropped_edges,
    )


@router.get("/{project_id}", response_model=ProjectResponse)
def get_project(
    project_id: uuid.UUID,
    db: Session = Depends(get_db),
    _: User = Depends(get_current_user),
) -> ProjectResponse:
    p = db.get(Project, project_id)
    if p is None:
        raise HTTPException(status_code=404, detail="Проект не найден")
    nc, ec = _counts(db, [p.id])
    return _to_response(p, nc, ec, _users_map(db, [p]), _previews(db, [p.id]))


@router.post("", response_model=ProjectResponse, status_code=status.HTTP_201_CREATED)
def create_project(
    payload: ProjectCreate,
    db: Session = Depends(get_db),
    user: User = Depends(require_architect),
) -> ProjectResponse:
    """Создать проект. start: "blank" — пусто; "template:<id>" — каркас из шаблона;
    "copy:<projectId>" — глубокая копия схемы другого проекта; "import" — схема
    из YAML в формате экспорта: import_yamls (N документов, сливаются
    merge_imports) либо одиночный import_yaml."""
    project = Project(
        id=uuid.uuid4(),
        name=payload.name,
        description=payload.description,
        created_by_id=user.id,
        updated_by_id=user.id,
    )
    db.add(project)
    db.flush()  # нужен project.id для сидинга/копии

    start = payload.start or "blank"
    if start == "blank":
        pass
    elif start.startswith("template:"):
        if not seed_template(db, project.id, start.split(":", 1)[1]):
            raise HTTPException(status_code=404, detail="Шаблон не найден")
    elif start.startswith("copy:"):
        try:
            src_id = uuid.UUID(start.split(":", 1)[1])
        except ValueError:
            raise HTTPException(status_code=400, detail="Некорректный источник копии") from None
        src = db.get(Project, src_id)
        if src is None:
            raise HTTPException(status_code=404, detail="Исходный проект не найден")
        copy_project_schema(db, src_id, project.id)
    elif start == "import":
        texts = payload.import_yamls if payload.import_yamls is not None else (
            [payload.import_yaml] if payload.import_yaml else []
        )
        if not texts:
            raise HTTPException(status_code=400, detail="Не передан YAML для импорта")
        merged, _report, errors = parse_and_merge(texts)
        if merged is None:
            raise HTTPException(status_code=400, detail="; ".join(errors[:10]))
        seed_import(db, project.id, merged)
    else:
        raise HTTPException(status_code=400, detail="Неизвестный способ старта проекта")

    db.commit()
    db.refresh(project)
    nc, ec = _counts(db, [project.id])
    return _to_response(project, nc, ec, _users_map(db, [project]), _previews(db, [project.id]))


@router.patch("/{project_id}", response_model=ProjectResponse)
def update_project(
    project_id: uuid.UUID,
    payload: ProjectUpdate,
    db: Session = Depends(get_db),
    user: User = Depends(require_architect),
) -> ProjectResponse:
    p = db.get(Project, project_id)
    if p is None:
        raise HTTPException(status_code=404, detail="Проект не найден")
    data = payload.model_dump(exclude_unset=True)
    for field, value in data.items():
        setattr(p, field, value)
    if data:
        p.updated_by_id = user.id
    db.commit()
    db.refresh(p)
    nc, ec = _counts(db, [p.id])
    return _to_response(p, nc, ec, _users_map(db, [p]), _previews(db, [p.id]))


@router.post("/{project_id}/archive", response_model=ProjectResponse)
def archive_project(
    project_id: uuid.UUID,
    db: Session = Depends(get_db),
    _: User = Depends(require_architect),
) -> ProjectResponse:
    """Мягкое удаление: проставляем archived_at. Данные сохраняются."""
    p = db.get(Project, project_id)
    if p is None:
        raise HTTPException(status_code=404, detail="Проект не найден")
    if p.archived_at is None:
        p.archived_at = datetime.now(UTC)
        db.commit()
        db.refresh(p)
    nc, ec = _counts(db, [p.id])
    return _to_response(p, nc, ec, _users_map(db, [p]), _previews(db, [p.id]))


@router.post("/{project_id}/restore", response_model=ProjectResponse)
def restore_project(
    project_id: uuid.UUID,
    db: Session = Depends(get_db),
    _: User = Depends(require_architect),
) -> ProjectResponse:
    """Вернуть из архива: archived_at = null."""
    p = db.get(Project, project_id)
    if p is None:
        raise HTTPException(status_code=404, detail="Проект не найден")
    p.archived_at = None
    db.commit()
    db.refresh(p)
    nc, ec = _counts(db, [p.id])
    return _to_response(p, nc, ec, _users_map(db, [p]), _previews(db, [p.id]))


@router.delete("/{project_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_project(
    project_id: uuid.UUID,
    confirm: str = "",
    db: Session = Depends(get_db),
    _: User = Depends(require_architect),
) -> None:
    """Необратимое удаление со всей схемой (БД-каскад). Разрешено только из архива
    и с ?confirm=<точное имя проекта> — двойная защита от случайного сноса."""
    p = db.get(Project, project_id)
    if p is None:
        raise HTTPException(status_code=404, detail="Проект не найден")
    if p.archived_at is None:
        raise HTTPException(status_code=409, detail="Сначала отправьте проект в архив")
    if confirm != p.name:
        raise HTTPException(status_code=400, detail="Подтвердите удаление точным именем проекта")
    db.delete(p)  # каскад сносит узлы/связи/процессы и раскладку
    db.commit()
