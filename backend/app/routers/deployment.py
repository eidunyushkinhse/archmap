"""Схема развёртывания: площадки, размещение объектов и граф вида «Развёртывание»
(docs/tasks/deployment-view.md).

Площадки — плоский CRUD с CAS и проверкой вложенности; размещение — НАБОР площадок
объекта целиком (PUT /placements, а со страницы объекта — PATCH /nodes/{id} site_ids);
граф — листья поддерева уровня с их экземплярами. Правила предметной области живут в
app/deployment, здесь — HTTP: 404/409/422 и курсоры поллинга.

Курсоры: площадки и размещение видны на холсте развёртывания — graph_rev; строка
«Размещение» на странице объекта меняется от размещения, удаления площадки и правки
площадки, на которой кто-то стоит, — тогда и meta_rev.
"""

import uuid
from collections import Counter

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import func
from sqlalchemy.orm import Session

from app import tree
from app.approval import effective_approvals
from app.auth import get_current_user
from app.database import get_db
from app.deployment import (
    PARENT_NOT_FOUND,
    SITE_NOT_FOUND,
    PlacementError,
    check_site_parent,
    effective_instances,
    ordered_instances,
    project_sites,
    set_placements,
    site_refs,
)
from app.deps import (
    check_cas,
    commit_change,
    get_current_project,
    name_taken,
    node_or_404,
    owned_or_404,
    require_project_editor,
)
from app.graph_queries import read_view_layout
from app.models.deployment_instance import DeploymentInstance
from app.models.deployment_site import DeploymentSite
from app.models.edge import Edge
from app.models.node import Node
from app.models.project import Project
from app.models.user import User
from app.models.view_layout import DEPLOY_KEY_PREFIX, ViewLayoutItem
from app.schemas.deployment import (
    DeploymentGraph,
    DeploymentNodeOut,
    EffectiveInstanceOut,
    PlacementsIn,
    SiteCreate,
    SiteOut,
    SiteUpdate,
)
from app.schemas.node import GraphEdgeResponse, NodeResponse
from app.view_state import current_version

router = APIRouter(prefix="/deployment", tags=["deployment"])

NAME_TAKEN = "Площадка с таким именем уже есть"
EMPTY_NAME = "Имя площадки не может быть пустым"
HAS_CHILDREN = "Сначала перенесите вложенные площадки"


def _site_or_404(db: Session, project: Project, site_id: uuid.UUID) -> DeploymentSite:
    return owned_or_404(db, DeploymentSite, site_id, "project_id", project.id, SITE_NOT_FOUND)


def _name_taken(db: Session, project_id: uuid.UUID, name: str, except_id: uuid.UUID | None) -> bool:
    return name_taken(
        db,
        DeploymentSite.id,
        except_id,
        DeploymentSite.project_id == project_id,
        DeploymentSite.name == name,
    )


def _clean_name(name: str) -> str:
    """Имя без краевых пробелов; пустое — 422 (на площадку ссылаются именем)."""
    cleaned = name.strip()
    if not cleaned:
        raise HTTPException(status_code=422, detail=EMPTY_NAME)
    return cleaned


def _instance_counts(db: Session, project_id: uuid.UUID) -> dict[uuid.UUID, int]:
    """Число своих экземпляров на каждой площадке проекта — одним запросом."""
    return {
        site_id: count
        for site_id, count in db.query(DeploymentInstance.site_id, func.count(DeploymentInstance.id))
        .filter(DeploymentInstance.project_id == project_id)
        .group_by(DeploymentInstance.site_id)
    }


def _site_out(site: DeploymentSite, counts: dict[uuid.UUID, int]) -> SiteOut:
    out = SiteOut.model_validate(site)
    out.instance_count = counts.get(site.id, 0)
    return out


@router.get("/sites", response_model=list[SiteOut])
def list_sites(
    db: Session = Depends(get_db),
    project: Project = Depends(get_current_project),
    _: User = Depends(get_current_user),
) -> list[SiteOut]:
    """Площадки проекта плоским списком по имени; дерево фронт строит по parent_id."""
    counts = _instance_counts(db, project.id)
    return [_site_out(site, counts) for site in project_sites(db, project.id)]


@router.post("/sites", response_model=SiteOut, status_code=status.HTTP_201_CREATED)
def create_site(
    payload: SiteCreate,
    db: Session = Depends(get_db),
    project: Project = Depends(get_current_project),
    user: User = Depends(require_project_editor),
) -> SiteOut:
    name = _clean_name(payload.name)
    if payload.parent_id is not None:
        parent = db.get(DeploymentSite, payload.parent_id)
        if parent is None or parent.project_id != project.id:
            raise HTTPException(status_code=404, detail=PARENT_NOT_FOUND)
    if _name_taken(db, project.id, name, None):
        raise HTTPException(status_code=409, detail=NAME_TAKEN)
    site = DeploymentSite(project_id=project.id, **payload.model_dump(exclude={"name"}), name=name)
    db.add(site)
    commit_change(db, project, user.id, graph=True)
    db.refresh(site)
    return _site_out(site, {})


@router.patch("/sites/{site_id}", response_model=SiteOut)
def update_site(
    site_id: uuid.UUID,
    payload: SiteUpdate,
    db: Session = Depends(get_db),
    project: Project = Depends(get_current_project),
    user: User = Depends(require_project_editor),
) -> SiteOut:
    site = _site_or_404(db, project, site_id)
    data = payload.model_dump(exclude_unset=True)
    base_version = data.pop("base_version", None)
    check_cas(site.version, base_version, "Площадка изменена в другой сессии")
    # Имя и вид в БД обязательны: null в них — «не прислано», а не «очистить».
    for required in ("name", "kind"):
        if data.get(required, "") is None:
            data.pop(required)
    if "name" in data:
        data["name"] = _clean_name(data["name"])
        if _name_taken(db, project.id, data["name"], site.id):
            raise HTTPException(status_code=409, detail=NAME_TAKEN)
    if "parent_id" in data and data["parent_id"] != site.parent_id:
        sites_by_id = {s.id: s for s in project_sites(db, project.id)}
        reason = check_site_parent(sites_by_id, site, data["parent_id"])
        if reason == PARENT_NOT_FOUND:
            raise HTTPException(status_code=404, detail=reason)
        if reason:
            raise HTTPException(status_code=400, detail=reason)
    counts = _instance_counts(db, project.id)
    if data:
        for field, value in data.items():
            setattr(site, field, value)
        site.version += 1
    # Строку «Размещение» правка площадки меняет, только если на ней кто-то стоит.
    commit_change(db, project, user.id, graph=bool(data), meta=bool(data) and site.id in counts)
    db.refresh(site)
    return _site_out(site, counts)


@router.delete("/sites/{site_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_site(
    site_id: uuid.UUID,
    db: Session = Depends(get_db),
    project: Project = Depends(get_current_project),
    user: User = Depends(require_project_editor),
) -> None:
    """Удалить площадку; её экземпляры уходят каскадом БД (окно подтверждения на
    фронте называет их число — SiteOut.instance_count). С вложенными — 422."""
    site = _site_or_404(db, project, site_id)
    if db.query(DeploymentSite.id).filter(DeploymentSite.parent_id == site.id).first() is not None:
        raise HTTPException(status_code=422, detail=HAS_CHILDREN)
    # Раскладка развёртывания с этой площадкой — карточки её экземпляров и сама рамка —
    # больше ничего не значит: ключи без FK, каскад их не снимет.
    db.query(ViewLayoutItem).filter(
        ViewLayoutItem.project_id == project.id,
        ViewLayoutItem.item_id.like(f"{DEPLOY_KEY_PREFIX}%{site.id}%"),
    ).delete(synchronize_session=False)
    db.delete(site)
    commit_change(db, project, user.id, graph=True, meta=True)


@router.put("/placements", status_code=status.HTTP_204_NO_CONTENT)
def put_placements(
    payload: PlacementsIn,
    db: Session = Depends(get_db),
    project: Project = Depends(get_current_project),
    user: User = Depends(require_project_editor),
) -> None:
    """Каждому объекту из node_ids — ровно набор площадок site_ids (пустой — снять).
    Объект или площадка не из проекта — 404, «Пользователь» среди объектов — 422;
    при отказе не записывается ничего."""
    nodes = [node_or_404(db, nid, project) for nid in dict.fromkeys(payload.node_ids)]
    try:
        changed = set_placements(db, project, nodes, set(payload.site_ids))
    except PlacementError as e:
        raise HTTPException(status_code=e.status, detail=e.detail) from None
    commit_change(db, project, user.id, graph=bool(changed), meta=bool(changed))


@router.get("/graph", response_model=DeploymentGraph)
def get_deployment_graph(
    level: uuid.UUID | None = None,
    db: Session = Depends(get_db),
    project: Project = Depends(get_current_project),
    _: User = Depends(get_current_user),
) -> DeploymentGraph:
    """Граф вида «Развёртывание» уровня level (пусто — весь проект).

    Объекты — ЛИСТЬЯ поддерева уровня (сам контейнер уровня не входит — он рамка, а
    не объект), кроме «Пользователей»: они живут вне системы. Контейнер размещается
    через листья — у них действует его размещение по наследству. Связи — сырые, у
    которых оба конца среди показанных листьев (правило «к ближайшему экземпляру»
    применяет фронт). Площадки — все площадки проекта: рамка нужна и пустой площадке.
    """
    if level is not None:
        node_or_404(db, level, project)
    all_nodes = {n.id: n for n in db.query(Node).filter(Node.project_id == project.id)}
    scope = tree.subtree_ids(all_nodes, level) - {level} if level is not None else set(all_nodes)
    child_counts = Counter(n.parent_id for n in all_nodes.values() if n.parent_id is not None)
    leaves = sorted(
        (
            all_nodes[nid]
            for nid in scope
            if child_counts.get(nid, 0) == 0 and all_nodes[nid].shape != "person"
        ),
        key=lambda n: (n.name, str(n.id)),
    )
    leaf_ids = {n.id for n in leaves}

    sites = project_sites(db, project.id)
    sites_by_id = {site.id: site for site in sites}
    pairs = ordered_instances(db, project.id, sites)
    effective = effective_instances({n.id: n.parent_id for n in all_nodes.values()}, pairs)
    own: dict[uuid.UUID, list[uuid.UUID]] = {}
    for node_id, site_id in pairs:
        own.setdefault(node_id, []).append(site_id)
    approvals = effective_approvals((n.id, n.parent_id, n.approval) for n in all_nodes.values())

    nodes_out: list[DeploymentNodeOut] = []
    for n in leaves:
        # Вычисляемые поля NodeResponse по уже загруженным картам, без запросов на узел.
        n.approval_effective = approvals.get(n.id, n.approval)
        n.sites = site_refs(n, effective.get(n.id, []), sites_by_id)
        nodes_out.append(
            DeploymentNodeOut(
                **NodeResponse.model_validate(n).model_dump(),
                instances=own.get(n.id, []),
                effective=[
                    EffectiveInstanceOut(site_id=e.site_id, inherited_from_id=e.inherited_from_id)
                    for e in effective.get(n.id, [])
                ],
            )
        )

    edges = [
        GraphEdgeResponse(
            id=e.id,
            label=e.label,
            technology=e.technology,
            channel=e.channel,
            source_id=e.source_id,
            target_id=e.target_id,
            version=e.version,
        )
        for e in db.query(Edge).filter(Edge.project_id == project.id).order_by(Edge.id)
        if e.source_id in leaf_ids and e.target_id in leaf_ids
    ]
    counts = _instance_counts(db, project.id)
    return DeploymentGraph(
        sites=[_site_out(site, counts) for site in sites],
        nodes=nodes_out,
        edges=edges,
        layout=read_view_layout(db, project.id, level, deploy=True),
        version=current_version(db, project.id, level),
        graph_rev=project.graph_rev,
        meta_rev=project.meta_rev,
    )
