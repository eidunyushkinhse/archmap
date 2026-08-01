"""CRUD именованных схем логики узла (node_docs, этап 1 plan-agent-docs.md).

Мутации — только архитектору; чтение — обеим ролям (наблюдатель смотрит доки в
оверлее). Каждая мутация бампает meta_rev: доки — МЕТА узла (видны на странице
объекта, не на схеме), поллинг страницы отличает их от изменений схемы
(graph_rev). PATCH под optimistic CAS — паттерн update_node (устаревший
base_version → 409, None = компенсация undo без проверки).
"""

import uuid

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session

from app.auth import get_current_user, require_architect
from app.database import get_db
from app.deps import get_current_project, scoped_node, touch_project
from app.models.node import Node
from app.models.node_doc import NodeDoc
from app.models.project import Project
from app.models.user import User
from app.schemas.node_doc import NodeDocCreate, NodeDocResponse, NodeDocUpdate
from app.view_state import bump_meta_rev

router = APIRouter(prefix="/nodes/{node_id}/docs", tags=["node-docs"])


def _scoped_doc(db: Session, node: Node, doc_id: uuid.UUID) -> NodeDoc:
    """Док по id в пределах узла (узел уже проверен на принадлежность проекту)."""
    doc = db.get(NodeDoc, doc_id)
    if doc is None or doc.node_id != node.id:
        raise HTTPException(status_code=404, detail="Схема не найдена")
    return doc


def _get_node(db: Session, node_id: uuid.UUID, project: Project) -> Node:
    node = scoped_node(db, node_id, project)
    if not node:
        raise HTTPException(status_code=404, detail="Узел не найден")
    return node


def _name_taken(db: Session, node_id: uuid.UUID, name: str, except_id: uuid.UUID | None) -> bool:
    """Пре-чек уникальности имени в пределах узла — 409 вместо IntegrityError-500."""
    q = db.query(NodeDoc.id).filter(NodeDoc.node_id == node_id, NodeDoc.name == name)
    if except_id is not None:
        q = q.filter(NodeDoc.id != except_id)
    return db.query(q.exists()).scalar() or False


@router.get("", response_model=list[NodeDocResponse])
def list_docs(
    node_id: uuid.UUID,
    db: Session = Depends(get_db),
    project: Project = Depends(get_current_project),
    _: User = Depends(get_current_user),
) -> list[NodeDoc]:
    node = _get_node(db, node_id, project)
    # Порядок стабильный (relationship order_by name) — фронт группирует по kind сам
    return node.docs


@router.post("", response_model=NodeDocResponse, status_code=status.HTTP_201_CREATED)
def create_doc(
    node_id: uuid.UUID,
    payload: NodeDocCreate,
    db: Session = Depends(get_db),
    project: Project = Depends(get_current_project),
    user: User = Depends(require_architect),
) -> NodeDoc:
    node = _get_node(db, node_id, project)
    if _name_taken(db, node.id, payload.name, None):
        raise HTTPException(status_code=409, detail="Схема с таким именем уже есть у узла")
    doc = NodeDoc(
        node_id=node.id,
        name=payload.name,
        kind=payload.kind,
        operation=payload.operation,
        content=payload.content,
    )
    db.add(doc)
    bump_meta_rev(db, project)
    touch_project(db, project, user.id)
    db.commit()
    db.refresh(doc)
    return doc


@router.patch("/{doc_id}", response_model=NodeDocResponse)
def update_doc(
    node_id: uuid.UUID,
    doc_id: uuid.UUID,
    payload: NodeDocUpdate,
    db: Session = Depends(get_db),
    project: Project = Depends(get_current_project),
    user: User = Depends(require_architect),
) -> NodeDoc:
    node = _get_node(db, node_id, project)
    doc = _scoped_doc(db, node, doc_id)
    data = payload.model_dump(exclude_unset=True)
    # CAS: правка от устаревшей версии не затирает чужой текст (base_version — не поле)
    base_version = data.pop("base_version", None)
    if base_version is not None and base_version != doc.version:
        raise HTTPException(status_code=409, detail="Схема изменена в другой сессии")
    if data:
        new_name = data.get("name")
        if new_name is not None and _name_taken(db, node.id, new_name, doc.id):
            raise HTTPException(status_code=409, detail="Схема с таким именем уже есть у узла")
        for field, value in data.items():
            setattr(doc, field, value)
        doc.version += 1
        bump_meta_rev(db, project)
    touch_project(db, project, user.id)
    db.commit()
    db.refresh(doc)
    return doc


@router.delete("/{doc_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_doc(
    node_id: uuid.UUID,
    doc_id: uuid.UUID,
    db: Session = Depends(get_db),
    project: Project = Depends(get_current_project),
    user: User = Depends(require_architect),
) -> None:
    node = _get_node(db, node_id, project)
    doc = _scoped_doc(db, node, doc_id)
    db.delete(doc)
    bump_meta_rev(db, project)
    touch_project(db, project, user.id)
    db.commit()
