"""API проектов: /api/v1/projects.

Управление изолированными схемами: список с метаданными (счётчики объектов/связей,
кто и когда менял), создание (пустой / шаблон / копия), переименование, мягкое
архивирование/восстановление и необратимое удаление. Доменные данные эти эндпоинты
НЕ скоупят через X-Project-Id — они оперируют самими проектами.
"""

import json
import uuid
from collections import defaultdict
from datetime import UTC, datetime
from typing import Literal

from fastapi import (
    APIRouter,
    Depends,
    File,
    Form,
    HTTPException,
    Query,
    UploadFile,
    status,
)
from sqlalchemy import func
from sqlalchemy.orm import Session

from app.auth import get_current_user, require_architect
from app.database import get_db
from app.identity import source_ref_dict
from app.import_merge import parse_and_merge
from app.import_prompt import build_import_prompt
from app.models.edge import Edge
from app.models.node import Node
from app.models.project import Project
from app.models.user import User
from app.models.view_layout import ViewLayoutItem
from app.projects import copy_project_schema
from app.schemas.archive import ArchiveImportResult
from app.schemas.node import NodeSource
from app.schemas.project import (
    ImportPromptOut,
    ProjectCreate,
    ProjectPreview,
    ProjectPreviewEdge,
    ProjectPreviewNode,
    ProjectResponse,
    ProjectUpdate,
    SyncApplyIn,
    SyncApplyOut,
    SyncEdgeActionOut,
    SyncNodeActionOut,
    SyncPreviewIn,
    SyncPreviewOut,
    TemplateOut,
)
from app.schemas.unified_import import IntoApplyOut, IntoPreviewOut, UnifiedPreviewOut
from app.skeptic_prompt import PromptVariant, prompt_for_variant
from app.sync_apply import apply_sync_plan
from app.sync_plan import SyncPolicies, build_sync_plan
from app.templates import (
    is_package_template,
    list_templates,
    seed_package_template,
    seed_template,
)
from app.unified_apply import apply_unified_plan, parse_decisions
from app.unified_import import UnifiedImportError, build_unified_plan, preview_from_plan
from app.unified_into import apply_into_plan, build_into_plan, into_preview

router = APIRouter(prefix="/projects", tags=["projects"])

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
    variant: PromptVariant = "builder",
    _user: User = Depends(require_architect),
) -> ImportPromptOut:
    """Универсальный промпт «Из репозитория» для ИИ-агента пользователя (BYOA):
    один и тот же промпт запускается в каждом репозитории системы, YAML-ответы
    сливает merge_imports. Параметры вшиваются в текст (docs/archive/plan-repo-import.md).

    variant — что отдать кнопке: строительный промпт (дефолт, байт-в-байт прежний —
    на нём сидят MCP-тулзы), оркестраторную обёртку с аудитом или один промпт аудита
    (docs/plan-skeptic-audit.md). Федеративного варианта нет: федерация — те же
    одиночные прогоны и мердж (docs/plan-byoa-quality.md, 2026-09-06)."""
    return ImportPromptOut(
        prompt=prompt_for_variant(
            variant,
            "import",
            build_import_prompt(system_name, depth=depth, lang=lang, hints=hints),
            system_name=system_name,
        )
    )


def _parse_resolutions(raw: str | None) -> dict[str, str]:
    """Решения пользователя по спорам: JSON-объект «id спора → выбор» в поле формы.

    Форма multipart несёт файлы, поэтому словарь едет текстом — разбираем и
    валидируем здесь, одинаково для создания и догрузки: кривое поле это 400 с
    человеческим текстом, а не 500 внутри применения."""
    try:
        chosen = json.loads(raw) if raw else {}
    except json.JSONDecodeError as e:
        raise HTTPException(
            status_code=400, detail="Поле resolutions не разбирается как JSON"
        ) from e
    if not isinstance(chosen, dict) or not all(
        isinstance(k, str) and isinstance(v, str) for k, v in chosen.items()
    ):
        raise HTTPException(
            status_code=400, detail="Поле resolutions должно быть объектом «id спора → выбор»"
        )
    return chosen


@router.post("/import/unified-preview", response_model=UnifiedPreviewOut)
async def import_unified_preview(
    files: list[UploadFile] = File(default=[]),
    _user: User = Depends(require_architect),
) -> UnifiedPreviewOut:
    """Dry-run ЕДИНОГО ввоза: N входов ЛЮБОГО типа (YAML C4 и/или zip-архив знания)
    вперемешку — C4 всех входов сливается, семьи фактов архивов переезжают на
    смердженные узлы, споры о телах показываются пользователю (Ф1,
    docs/plan-unified-import.md). БД не трогаем: проекта ещё нет, применение — Ф2.

    Тип входа определяется ПО СОДЕРЖИМОМУ (магия zip), а не по имени файла: чип
    может приехать из буфера обмена, а расширение — соврать. Беда отдельного
    входа не 400-ит запрос, а едет ошибкой, адресованной этому входу."""
    if not files:
        raise HTTPException(status_code=400, detail="Не передан ни один файл")
    inputs = [(f.filename or f"вход {i + 1}", await f.read()) for i, f in enumerate(files)]
    try:
        plan = build_unified_plan(inputs)
    except UnifiedImportError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    return preview_from_plan(plan)


@router.post(
    "/import-unified", response_model=ArchiveImportResult, status_code=status.HTTP_201_CREATED
)
async def import_project_unified(
    files: list[UploadFile] = File(default=[]),
    name: str | None = Form(default=None),
    description: str | None = Form(default=None),
    resolutions: str | None = Form(default=None),
    decisions: str | None = Form(default=None),
    db: Session = Depends(get_db),
    user: User = Depends(require_architect),
) -> ArchiveImportResult:
    """Создать НОВЫЙ проект из N входов ЛЮБОГО типа (Ф2а, docs/plan-unified-import.md).

    Протокол стейтлесс: план считается заново по тем же файлам (мердж
    детерминирован), а решения пользователя приезжают словарём «id спора → выбор»
    JSON-объектом в поле resolutions. Резолюция не из плана — 400 «превью
    устарело»: молча применить «не то» хуже, чем попросить пересобрать превью.

    Вторым словарём (decisions, JSON) приезжают ответы на вопросы ОСТАТКА слияния
    (Ф-E): выбранные значения полей, перевешенные концы связей, дорисованные связи
    и склейки похожих имён. Ни один ответ не обязателен — без них создаётся ровно
    тот же проект, что и раньше.

    Имя и описание берутся из полей; при ЕДИНСТВЕННОМ входе-архиве их можно не
    передавать — тогда они приедут из манифеста (П3)."""
    if not files:
        raise HTTPException(status_code=400, detail="Не передан ни один файл")
    chosen = _parse_resolutions(resolutions)
    inputs = [(f.filename or f"вход {i + 1}", await f.read()) for i, f in enumerate(files)]
    try:
        ответы = parse_decisions(decisions)
        plan = build_unified_plan(inputs)
        _, result = apply_unified_plan(
            db, plan, chosen, name, description, user.id, decisions=ответы
        )
    except UnifiedImportError as e:
        db.rollback()
        raise HTTPException(status_code=400, detail=str(e)) from e
    db.commit()
    return result


@router.post("/{project_id}/import-archive/preview", response_model=IntoPreviewOut)
async def import_archive_preview(
    project_id: uuid.UUID,
    files: list[UploadFile] = File(default=[]),
    db: Session = Depends(get_db),
    _user: User = Depends(require_architect),
) -> IntoPreviewOut:
    """Dry-run ДОГРУЗКИ архивов к живому проекту (Ф3, docs/plan-unified-import.md):
    что появится и о чём придётся выбрать. БД не пишем.

    Текущий проект участвует входом №0 (его собственный архив в память), поэтому
    сравнение «живое vs привозное» делает то же ядро, что и федерацию архивов.
    Только zip: YAML в существующий проект заливается синком («Импорт схемы») —
    это другая механика, и подменять её мерджем нельзя."""
    project = db.get(Project, project_id)
    if project is None:
        raise HTTPException(status_code=404, detail="Проект не найден")
    if not files:
        raise HTTPException(status_code=400, detail="Не передан ни один файл")
    inputs = [(f.filename or f"вход {i + 1}", await f.read()) for i, f in enumerate(files)]
    try:
        into = build_into_plan(db, project, inputs)
    except UnifiedImportError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    return into_preview(into)


@router.post("/{project_id}/import-archive/apply", response_model=IntoApplyOut)
async def import_archive_apply(
    project_id: uuid.UUID,
    files: list[UploadFile] = File(default=[]),
    resolutions: str | None = Form(default=None),
    decisions: str | None = Form(default=None),
    base_graph_rev: int | None = Form(default=None),
    base_meta_rev: int | None = Form(default=None),
    db: Session = Depends(get_db),
    user: User = Depends(require_architect),
) -> IntoApplyOut:
    """Применить догрузку к живому проекту.

    Протокол тот же, что у создания: план считается ЗАНОВО (мердж детерминирован),
    решения приезжают словарём «id спора → выбор». Чтобы применение не разошлось с
    увиденным в превью, клиент возвращает base_graph_rev и base_meta_rev —
    разошлись хоть один, 409 «обновите превью». Курсоров два: догрузка меняет и
    схему (узлы, связи), и мету (схемы логики, факты, спеки).

    Ответы на вопросы ОСТАТКА слияния (Ф-E) приезжают тем же протоколом, полем
    decisions: перевес концов привозных связей, дорисованные связи, склейка
    привозного объекта с живым (живой при этом выживает) и выбор значения поля.

    Аддитивность: живая запись перетирается ТОЛЬКО там, где пользователь явно
    выбрал архивного кандидата; ничего никогда не удаляется."""
    project = db.get(Project, project_id)
    if project is None:
        raise HTTPException(status_code=404, detail="Проект не найден")
    if (base_graph_rev is not None and base_graph_rev != project.graph_rev) or (
        base_meta_rev is not None and base_meta_rev != project.meta_rev
    ):
        raise HTTPException(
            status_code=409,
            detail="Проект изменился после расчёта — обновите превью и повторите",
        )
    if not files:
        raise HTTPException(status_code=400, detail="Не передан ни один файл")
    chosen = _parse_resolutions(resolutions)
    inputs = [(f.filename or f"вход {i + 1}", await f.read()) for i, f in enumerate(files)]
    try:
        ответы = parse_decisions(decisions)
        into = build_into_plan(db, project, inputs)
        result = apply_into_plan(db, project, into, chosen, decisions=ответы)
    except UnifiedImportError as e:
        db.rollback()
        raise HTTPException(status_code=400, detail=str(e)) from e
    project.updated_at = datetime.now(UTC)
    project.updated_by_id = user.id
    db.commit()
    return result


def _action_source(ref: str | None) -> NodeSource | None:
    """Якорь действия синка в виде контракта — тем же разбором, что у карточки узла.

    Ключ снятого вида (архив прежней модели якоря) якорем не притворяется:
    source_ref_dict вернёт пусто, и превью честно скажет «якоря нет» — ровно то,
    что запишет применение (гвард known_key на точках записи)."""
    d = source_ref_dict(ref) if ref else {}
    return NodeSource(**d) if d else None


@router.post("/{project_id}/sync/preview", response_model=SyncPreviewOut)
def sync_preview(
    project_id: uuid.UUID,
    payload: SyncPreviewIn,
    db: Session = Depends(get_db),
    _user: User = Depends(require_architect),
) -> SyncPreviewOut:
    """Dry-run синхронизации ЖИВОГО проекта со свежим прогоном агента: что
    изменится, если применить. БД не пишем (применение — отдельным вызовом).

    Вход тот же, что у импорта (мульти-репо сливается merge_imports), поэтому
    ошибки разбора и предупреждения слияния возвращаются в той же форме — фронт
    показывает их до плана. Проект скоупится ПУТЁМ (не заголовком X-Project-Id):
    синк адресует конкретный проект, а не «текущий» сеанса."""
    project = db.get(Project, project_id)
    if project is None:
        raise HTTPException(status_code=404, detail="Проект не найден")

    merged, report, errors = parse_and_merge(list(payload.contents))
    if merged is None:
        return SyncPreviewOut(ok=False, errors=errors, files=len(payload.contents))

    nodes = db.query(Node).filter(Node.project_id == project_id).all()
    edges = db.query(Edge).filter(Edge.project_id == project_id).all()
    plan = build_sync_plan(
        nodes,
        edges,
        merged,
        SyncPolicies(
            update_descriptions=payload.update_descriptions,
            update_names=payload.update_names,
            sync_components=payload.sync_components,
            mark_missing_deprecated=payload.mark_missing_deprecated,
            restore_returned=payload.restore_returned,
        ),
    )
    return SyncPreviewOut(
        ok=True,
        files=len(payload.contents),
        nodes=[
            SyncNodeActionOut(
                path=a.path,
                action=a.action,  # type: ignore[arg-type]  # значения из фиксированного набора sync_plan
                node_id=a.node_id,
                source_ref=a.source_ref,
                fields=a.fields,
                matched_by=a.matched_by,  # type: ignore[arg-type]
                source=_action_source(a.source_ref),
                returned=a.returned,
            )
            for a in plan.nodes
        ],
        edges=[
            SyncEdgeActionOut(
                source_path=e.source_path,
                target_path=e.target_path,
                action=e.action,  # type: ignore[arg-type]
            )
            for e in plan.edges
        ],
        # Предупреждения слияния файлов и предупреждения матчинга — один список:
        # для человека это одна категория «посмотри глазами».
        conflicts=report.conflicts + plan.conflicts,
        warnings=report.warnings + plan.warnings,
        summary=plan.summary,
        is_noop=plan.is_noop,
        graph_rev=project.graph_rev,
    )


@router.post("/{project_id}/sync/apply", response_model=SyncApplyOut)
def sync_apply(
    project_id: uuid.UUID,
    payload: SyncApplyIn,
    db: Session = Depends(get_db),
    _user: User = Depends(require_architect),
) -> SyncApplyOut:
    """Применить прогон агента к живому проекту.

    План ПЕРЕСЧИТЫВАЕТСЯ здесь же из присланных YAML — клиентскому плану не
    доверяем (иначе подменённый план писал бы что угодно). Чтобы применение не
    разошлось с тем, что человек видел в превью, клиент возвращает base_graph_rev:
    схема изменилась с тех пор — 409, обновите превью. Это тот же курсор, которым
    живёт поллинг конкурентных сессий.

    НЕ ТРОГАЕМ: схемы логики, OpenAPI-спеки, раскладку и бизнес-процессы —
    ради этого синк и существует. Удаления нет ни в каком режиме."""
    project = db.get(Project, project_id)
    if project is None:
        raise HTTPException(status_code=404, detail="Проект не найден")
    if payload.base_graph_rev is not None and payload.base_graph_rev != project.graph_rev:
        raise HTTPException(
            status_code=409,
            detail="Схема изменилась после расчёта — обновите превью и повторите",
        )

    merged, _report, errors = parse_and_merge(list(payload.contents))
    if merged is None:
        raise HTTPException(status_code=400, detail="; ".join(errors[:5]))

    nodes = db.query(Node).filter(Node.project_id == project_id).all()
    edges = db.query(Edge).filter(Edge.project_id == project_id).all()
    plan = build_sync_plan(
        nodes,
        edges,
        merged,
        SyncPolicies(
            update_descriptions=payload.update_descriptions,
            update_names=payload.update_names,
            sync_components=payload.sync_components,
            mark_missing_deprecated=payload.mark_missing_deprecated,
            restore_returned=payload.restore_returned,
        ),
    )
    report = apply_sync_plan(db, project, merged, plan)
    project.updated_at = datetime.now(UTC)
    project.updated_by_id = _user.id
    db.commit()
    return SyncApplyOut(
        created_nodes=report.created_nodes,
        updated_nodes=report.updated_nodes,
        deprecated_nodes=report.deprecated_nodes,
        created_edges=report.created_edges,
        skipped=report.skipped,
        graph_rev=project.graph_rev,
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
    """Создать проект. start: "blank" — пусто; "template:<id>" — шаблон (каркас
    либо ПАКЕТНЫЙ шаблон — готовый проект с процессами, логикой, спеками и фактами);
    "copy:<projectId>" — глубокая копия схемы другого проекта.

    Ввоз схемы из файлов сюда не ходит: у него единый путь /projects/import-unified
    (multipart, YAML и архивы вперемешку)."""
    start = payload.start or "blank"
    template_id = start.split(":", 1)[1] if start.startswith("template:") else None

    # ПАКЕТНЫЙ шаблон создаёт проект САМ — его сеет единый импорт (тот же приёмник,
    # что у ввоза архива пользователем). Пустой Project заранее не заводим: при
    # отказе ввоза он остался бы сиротой в списке проектов.
    if template_id is not None and is_package_template(template_id):
        seeded = seed_package_template(db, template_id, payload.name, payload.description, user.id)
        if seeded is None:
            raise HTTPException(status_code=404, detail="Шаблон не найден")
        db.commit()
        db.refresh(seeded)
        nc, ec = _counts(db, [seeded.id])
        return _to_response(seeded, nc, ec, _users_map(db, [seeded]), _previews(db, [seeded.id]))

    project = Project(
        id=uuid.uuid4(),
        name=payload.name,
        description=payload.description,
        created_by_id=user.id,
        updated_by_id=user.id,
    )
    db.add(project)
    db.flush()  # нужен project.id для сидинга/копии

    if start == "blank":
        pass
    elif template_id is not None:
        if not seed_template(db, project.id, template_id):
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
