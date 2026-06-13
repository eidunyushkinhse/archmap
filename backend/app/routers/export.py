"""Экспорт схемы в текстовый формат (YAML) для скармливания LLM.

Read-only поверх существующего хранения. Доступен любому залогиненному
пользователю (в т.ч. viewer) — это выгрузка, не правка.
"""

import uuid

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session

from app import tree
from app.auth import get_current_user
from app.database import get_db
from app.export import build_export
from app.models.edge import Edge
from app.models.node import Node
from app.models.user import User
from app.schemas.export import ExportResponse

router = APIRouter(prefix="/export", tags=["export"])


@router.get("", response_model=ExportResponse)
def export_all(
    db: Session = Depends(get_db),
    _user: User = Depends(get_current_user),
) -> ExportResponse:
    """Экспорт ВСЕЙ схемы."""
    nodes = db.query(Node).all()
    edges = db.query(Edge).all()
    return ExportResponse(format="yaml", content=build_export(nodes, edges))


@router.get("/{node_id}", response_model=ExportResponse)
def export_subtree(
    node_id: uuid.UUID,
    db: Session = Depends(get_db),
    _user: User = Depends(get_current_user),
) -> ExportResponse:
    """Экспорт поддерева от узла (сам узел + все потомки + связи внутри поддерева)."""
    nodes = db.query(Node).all()
    by_id = {n.id: n for n in nodes}
    if node_id not in by_id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Узел не найден")
    sub_ids = tree.subtree_ids(by_id, node_id)
    sub_nodes = [by_id[i] for i in sub_ids]
    # Связи берём только внутри поддерева (build_export всё равно отфильтрует, но
    # не тянем в сериализатор заведомо лишнее).
    edges = [
        e
        for e in db.query(Edge).all()
        if e.source_id in sub_ids and e.target_id in sub_ids
    ]
    return ExportResponse(format="yaml", content=build_export(sub_nodes, edges, root_id=node_id))
