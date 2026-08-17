"""CRUD именованных схем логики узла (node_docs, этап 1 plan-agent-docs.md).

Мутации — только архитектору; чтение — обеим ролям (наблюдатель смотрит доки в
оверлее). Каждая мутация бампает meta_rev: доки — МЕТА узла (видны на странице
объекта, не на схеме), поллинг страницы отличает их от изменений схемы
(graph_rev). PATCH под optimistic CAS — паттерн update_node (устаревший
base_version → 409, None = компенсация undo без проверки).
"""

import uuid

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session, undefer

from app.auth import get_current_user, require_architect
from app.database import get_db
from app.deps import get_current_project, scoped_node, touch_project
from app.models.node import Node
from app.models.node_doc import NodeDoc
from app.models.project import Project
from app.models.user import User
from app.schemas.node import DistributeDocsIn, DistributeDocsOut
from app.schemas.node_doc import NodeDocCreate, NodeDocResponse, NodeDocUpdate
from app.view_state import bump_meta_rev

router = APIRouter(prefix="/nodes/{node_id}/docs", tags=["node-docs"])


def _scoped_doc(db: Session, node: Node, doc_id: uuid.UUID, *, body: bool = False) -> NodeDoc:
    """Док по id в пределах узла (узел уже проверен на принадлежность проекту).

    body=True — ответу нужен текст схемы (NodeDocResponse.content): тело —
    отложенная колонка, и без явного undefer оно приехало бы вторым запросом.
    db.get здесь не годится: узел уже загружен, его доки лежат в identity map
    (Node.docs selectin), и db.get вернул бы их из карты, не применив опции.
    """
    q = db.query(NodeDoc).filter(NodeDoc.id == doc_id)
    if body:
        q = q.options(undefer(NodeDoc.content))
    doc = q.first()
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
    # Ровно то место, ради которого тело схемы отложено: здесь оно НУЖНО (ответ —
    # NodeDocResponse с content), и его надо запросить явно. Через node.docs тела
    # приехали бы по одному запросу на схему; порядок повторяет relationship
    # (order_by name) — фронт группирует по kind сам.
    return (
        db.query(NodeDoc)
        .options(undefer(NodeDoc.content))
        .filter(NodeDoc.node_id == node.id)
        .order_by(NodeDoc.name)
        .all()
    )


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
    doc = _scoped_doc(db, node, doc_id, body=True)
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


@router.post("/distribute", response_model=DistributeDocsOut)
def distribute_docs(
    node_id: uuid.UUID,
    payload: DistributeDocsIn,
    db: Session = Depends(get_db),
    project: Project = Depends(get_current_project),
    user: User = Depends(require_architect),
) -> DistributeDocsOut:
    """«Распределить по детям» (правила контейнеров, grandfather): переносит
    СОБСТВЕННЫЕ доки контейнера на его непосредственных детей, а также (опц.)
    его openapi_spec — целиком одному ребёнку. Вызывается из модалки
    распределения на странице контейнера. Доки — МЕТА узла: бампаем meta_rev."""
    node = _get_node(db, node_id, project)
    children = db.query(Node).filter(Node.parent_id == node.id).all()
    child_ids = {c.id for c in children}
    if not child_ids:
        raise HTTPException(status_code=409, detail="У контейнера нет детей для распределения")

    moved_docs = 0
    for a in payload.doc_assignments:
        doc = db.get(NodeDoc, a.doc_id)
        # Переносим только СВОИ доки контейнера (grandfather), не чужие/детские.
        if doc is None or doc.node_id != node.id:
            raise HTTPException(status_code=404, detail=f"Схема {a.doc_id} не найдена среди собственных доков узла")
        if a.child_id not in child_ids:
            raise HTTPException(status_code=409, detail=f"Цель {a.child_id} не является непосредственным ребёнком узла")
        if _name_taken(db, a.child_id, doc.name, None):
            raise HTTPException(status_code=409, detail=f"У ребёнка уже есть схема с именем «{doc.name}»")
        doc.node_id = a.child_id
        doc.version += 1
        moved_docs += 1

    spec_moved = False
    if payload.spec_child_id is not None:
        if not node.openapi_spec:
            raise HTTPException(status_code=409, detail="У узла нет OpenAPI-спеки для переноса")
        if payload.spec_child_id not in child_ids:
            raise HTTPException(status_code=409, detail="Цель для спеки не является непосредственным ребёнком узла")
        child = next(c for c in children if c.id == payload.spec_child_id)
        if child.openapi_spec:
            raise HTTPException(status_code=409, detail="У выбранного ребёнка уже есть OpenAPI-спека")
        child.openapi_spec = node.openapi_spec
        node.openapi_spec = None
        child.version += 1
        node.version += 1
        spec_moved = True

    if moved_docs or spec_moved:
        bump_meta_rev(db, project)
    touch_project(db, project, user.id)
    db.commit()
    return DistributeDocsOut(moved_docs=moved_docs, spec_moved=spec_moved)
