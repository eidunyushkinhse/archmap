import uuid

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session

from app.auth import get_current_user, require_architect
from app.database import get_db
from app.models.edge import Edge
from app.models.node import Node
from app.models.user import User
from app.schemas.edge import EdgeCreate, EdgeResponse, EdgeUpdate

router = APIRouter(prefix="/edges", tags=["edges"])


@router.get("/", response_model=list[EdgeResponse])
def list_edges(
    db: Session = Depends(get_db),
    _: User = Depends(get_current_user),
) -> list[Edge]:
    return db.query(Edge).all()


@router.post("/", response_model=EdgeResponse, status_code=status.HTTP_201_CREATED)
def create_edge(
    payload: EdgeCreate,
    db: Session = Depends(get_db),
    _: User = Depends(require_architect),
) -> Edge:
    for node_id in (payload.source_id, payload.target_id):
        if not db.get(Node, node_id):
            raise HTTPException(status_code=404, detail=f"Узел {node_id} не найден")
    edge = Edge(**payload.model_dump())
    db.add(edge)
    db.commit()
    db.refresh(edge)
    return edge


@router.get("/{edge_id}", response_model=EdgeResponse)
def get_edge(
    edge_id: uuid.UUID,
    db: Session = Depends(get_db),
    _: User = Depends(get_current_user),
) -> Edge:
    edge = db.get(Edge, edge_id)
    if not edge:
        raise HTTPException(status_code=404, detail="Связь не найдена")
    return edge


@router.patch("/{edge_id}", response_model=EdgeResponse)
def update_edge(
    edge_id: uuid.UUID,
    payload: EdgeUpdate,
    db: Session = Depends(get_db),
    _: User = Depends(require_architect),
) -> Edge:
    edge = db.get(Edge, edge_id)
    if not edge:
        raise HTTPException(status_code=404, detail="Связь не найдена")
    data = payload.model_dump(exclude_unset=True)

    # Смена концов: проверяем существование узлов и запрещаем петлю
    new_source = data.get("source_id", edge.source_id)
    new_target = data.get("target_id", edge.target_id)
    for node_id in {new_source, new_target}:
        if not db.get(Node, node_id):
            raise HTTPException(status_code=404, detail=f"Узел {node_id} не найден")
    if new_source == new_target:
        raise HTTPException(status_code=400, detail="Связь не может вести из узла в него же")
    # Если конец сменился, а хэндл явно не задан — сбрасываем его (старый указывал
    # на другой узел и стал невалидным; раскладка назначит новый автоматически)
    if "source_id" in data and data["source_id"] != edge.source_id and "source_handle" not in data:
        edge.source_handle = None
    if "target_id" in data and data["target_id"] != edge.target_id and "target_handle" not in data:
        edge.target_handle = None

    for field, value in data.items():
        setattr(edge, field, value)
    db.commit()
    db.refresh(edge)
    return edge


@router.delete("/{edge_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_edge(
    edge_id: uuid.UUID,
    db: Session = Depends(get_db),
    _: User = Depends(require_architect),
) -> None:
    edge = db.get(Edge, edge_id)
    if not edge:
        raise HTTPException(status_code=404, detail="Связь не найдена")
    db.delete(edge)
    db.commit()
