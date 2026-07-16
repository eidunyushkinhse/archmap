import uuid

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session

from app import restore
from app.auth import get_current_user, require_architect
from app.database import get_db
from app.deps import get_current_project, scoped_edge, scoped_node, touch_project
from app.models.edge import Edge
from app.models.project import Project
from app.models.user import User
from app.schemas.edge import EdgeCreate, EdgeResponse, EdgeUpdate
from app.schemas.restore import DeletionSnapshot
from app.view_state import bump_graph_rev

router = APIRouter(prefix="/edges", tags=["edges"])


@router.get("/", response_model=list[EdgeResponse])
def list_edges(
    db: Session = Depends(get_db),
    project: Project = Depends(get_current_project),
    _: User = Depends(get_current_user),
) -> list[Edge]:
    return db.query(Edge).filter(Edge.project_id == project.id).all()


@router.post("/", response_model=EdgeResponse, status_code=status.HTTP_201_CREATED)
def create_edge(
    payload: EdgeCreate,
    db: Session = Depends(get_db),
    project: Project = Depends(get_current_project),
    user: User = Depends(require_architect),
) -> Edge:
    for node_id in (payload.source_id, payload.target_id):
        if not scoped_node(db, node_id, project):
            raise HTTPException(status_code=404, detail=f"Узел {node_id} не найден")
    # project_id проставляем сервером из текущего проекта (концы уже проверены в нём).
    edge = Edge(**payload.model_dump(), project_id=project.id)
    db.add(edge)
    bump_graph_rev(db, project)  # курсор поллинга: связь меняет картинку уровней
    touch_project(db, project, user.id)
    db.commit()
    db.refresh(edge)
    return edge


@router.get("/{edge_id}", response_model=EdgeResponse)
def get_edge(
    edge_id: uuid.UUID,
    db: Session = Depends(get_db),
    project: Project = Depends(get_current_project),
    _: User = Depends(get_current_user),
) -> Edge:
    edge = scoped_edge(db, edge_id, project)
    if not edge:
        raise HTTPException(status_code=404, detail="Связь не найдена")
    return edge


@router.patch("/{edge_id}", response_model=EdgeResponse)
def update_edge(
    edge_id: uuid.UUID,
    payload: EdgeUpdate,
    db: Session = Depends(get_db),
    project: Project = Depends(get_current_project),
    user: User = Depends(require_architect),
) -> Edge:
    edge = scoped_edge(db, edge_id, project)
    if not edge:
        raise HTTPException(status_code=404, detail="Связь не найдена")
    data = payload.model_dump(exclude_unset=True)
    # CAS: правка от устаревшей версии не затирает чужую (base_version — не поле связи)
    base_version = data.pop("base_version", None)
    if base_version is not None and base_version != edge.version:
        raise HTTPException(status_code=409, detail="Связь изменена в другой сессии")

    # Смена концов: проверяем существование узлов (в этом же проекте) и запрещаем петлю.
    # Геометрия (хэндлы/изломы/плашка) на связи больше не живёт (R3) — при смене конца
    # прежняя геометрия пучка сама перестаёт применяться (другой ключ "b:<src>><tgt>").
    new_source = data.get("source_id", edge.source_id)
    new_target = data.get("target_id", edge.target_id)
    for node_id in {new_source, new_target}:
        if not scoped_node(db, node_id, project):
            raise HTTPException(status_code=404, detail=f"Узел {node_id} не найден")
    if new_source == new_target:
        raise HTTPException(status_code=400, detail="Связь не может вести из узла в него же")

    for field, value in data.items():
        setattr(edge, field, value)
    if data:
        edge.version += 1
        bump_graph_rev(db, project)
    touch_project(db, project, user.id)
    db.commit()
    db.refresh(edge)
    return edge


@router.get("/{edge_id}/deletion-snapshot", response_model=DeletionSnapshot)
def edge_deletion_snapshot(
    edge_id: uuid.UUID,
    db: Session = Depends(get_db),
    project: Project = Depends(get_current_project),
    _: User = Depends(require_architect),
) -> DeletionSnapshot:
    """Снимок связи для отката удаления/создания (Undo).

    Клиент берёт его ПЕРЕД delete (откат удаления связи) либо при undo создания связи,
    чтобы потом восстановить связь с исходным id через POST /nodes/restore. Геометрия
    пучка живёт в view_layout и удаление связи её не сносит (R3) — снимок несёт
    только само ребро.
    """
    if not scoped_edge(db, edge_id, project):
        raise HTTPException(status_code=404, detail="Связь не найдена")
    return restore.build_edge_deletion_snapshot(db, edge_id)


@router.delete("/{edge_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_edge(
    edge_id: uuid.UUID,
    db: Session = Depends(get_db),
    project: Project = Depends(get_current_project),
    user: User = Depends(require_architect),
) -> None:
    edge = scoped_edge(db, edge_id, project)
    if not edge:
        raise HTTPException(status_code=404, detail="Связь не найдена")
    bump_graph_rev(db, project)
    touch_project(db, project, user.id)
    db.delete(edge)
    db.commit()
