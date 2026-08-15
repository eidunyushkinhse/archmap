"""Сборка снимка удаляемого поддерева и восстановление из снимка (Undo удаления).

Снимок (build_deletion_snapshot) собирается ДО удаления и повторяет ровно то, что
исчезнет: поддерево узлов, инцидентные рёбра (источник/цель в поддереве) и строки
раскладки view_layout — свои виды поддерева (умрут каскадом view_id) плюс строки
других видов, чьи ключи ссылаются на поддерево (их чистит delete_node). Восстановление
(restore_from_snapshot) воссоздаёт всё это С СОХРАНЕНИЕМ исходных id, чтобы вернувшиеся
узлы/рёбра были теми же сущностями (ссылки извне, история, redo=повторное удаление по id).
"""

import uuid

from sqlalchemy import or_
from sqlalchemy.orm import Session

from app import tree
from app.models.edge import Edge
from app.models.node import Node
from app.models.node_doc import NodeDoc
from app.models.view_layout import ViewLayoutItem
from app.schemas.restore import (
    DeletionSnapshot,
    EdgeSnapshot,
    NodeDocSnapshot,
    NodeSnapshot,
    ViewLayoutItemSnapshot,
)


def build_deletion_snapshot(db: Session, root_id: uuid.UUID) -> DeletionSnapshot:
    """Снимок всего, что исчезнет при удалении узла root_id (вызывать ДО delete)."""
    subtree = tree.collect_subtree_ids_db(db, root_id)

    nodes = db.query(Node).filter(Node.id.in_(subtree)).all()
    # Рёбра с любым концом в поддереве — их снесёт каскад (source_id/target_id CASCADE).
    edges = (
        db.query(Edge)
        .filter(or_(Edge.source_id.in_(subtree), Edge.target_id.in_(subtree)))
        .all()
    )

    # Строки раскладки: виды поддерева (каскад view_id) + строки любых видов, чей
    # item_id содержит uuid из поддерева (гостевые позиции/пучки — их чистит delete_node).
    layout_rows = (
        db.query(ViewLayoutItem)
        .filter(
            or_(
                ViewLayoutItem.view_id.in_(subtree),
                *[ViewLayoutItem.item_id.like(f"%{sid}%") for sid in subtree],
            )
        )
        .all()
    )

    # Доки логики узлов поддерева — умрут БД-каскадом node_id вместе с узлами.
    docs = db.query(NodeDoc).filter(NodeDoc.node_id.in_(subtree)).all()

    return DeletionSnapshot(
        nodes=[NodeSnapshot.model_validate(n) for n in nodes],
        edges=[EdgeSnapshot.model_validate(e) for e in edges],
        layout_items=[ViewLayoutItemSnapshot.model_validate(r) for r in layout_rows],
        node_docs=[NodeDocSnapshot.model_validate(d) for d in docs],
    )


def build_edge_deletion_snapshot(db: Session, edge_id: uuid.UUID) -> DeletionSnapshot:
    """Снимок одной связи (Undo удаления/создания связи).

    Строки раскладки удаление связи НЕ сносит (геометрия живёт на ключе ПУЧКА и
    обслуживает всех его членов — R3), поэтому снимок несёт только само ребро.
    Восстанавливается тем же restore_from_snapshot (nodes=[]) с исходным id.
    """
    edge = db.get(Edge, edge_id)
    return DeletionSnapshot(
        nodes=[],
        edges=[EdgeSnapshot.model_validate(edge)] if edge is not None else [],
        layout_items=[],
    )


def restore_from_snapshot(
    db: Session, snapshot: DeletionSnapshot, project_id: uuid.UUID
) -> None:
    """Воссоздать узлы/рёбра/строки раскладки из снимка с сохранением исходных id.

    Узлы вставляются родителями раньше детей: FK parent_id проверяется сразу, а
    корень поддерева ссылается на уцелевший (внешний) узел уровня. Рёбра и раскладка
    — после узлов (их FK на nodes уже валидны). project_id — проект, в который
    восстанавливаем (снимок его не несёт; восстановление всегда в текущий проект).
    """
    by_id = {n.id: n for n in snapshot.nodes}

    def depth(n: NodeSnapshot) -> int:
        d = 0
        cur = n
        while cur.parent_id is not None and cur.parent_id in by_id:
            cur = by_id[cur.parent_id]
            d += 1
        return d

    for ns in sorted(snapshot.nodes, key=depth):
        db.add(
            Node(
                id=ns.id,
                project_id=project_id,
                name=ns.name,
                description=ns.description,
                role=ns.role,
                technology=ns.technology,
                parent_id=ns.parent_id,
                openapi_spec=ns.openapi_spec,
                is_external=ns.is_external,
                shape=ns.shape,
                status=ns.status,
            )
        )
    db.flush()  # узлы существуют до рёбер/раскладки/доков

    # Доки логики — с исходными id (redo-удаление и внешние ссылки работают по id)
    for ds in snapshot.node_docs:
        db.add(
            NodeDoc(
                id=ds.id,
                node_id=ds.node_id,
                name=ds.name,
                kind=ds.kind,
                operation=ds.operation,
                content=ds.content,
            )
        )

    for es in snapshot.edges:
        db.add(
            Edge(
                id=es.id,
                project_id=project_id,
                label=es.label,
                technology=es.technology,
                channel=es.channel,
                source_id=es.source_id,
                target_id=es.target_id,
                is_synchronous=es.is_synchronous,
            )
        )
    db.flush()

    # Строки раскладки: удаление их вычистило (каскад/явная чистка), коллизий нет.
    for it in snapshot.layout_items:
        db.add(
            ViewLayoutItem(
                project_id=project_id,
                view_id=it.view_id,
                item_id=it.item_id,
                payload=it.payload,
            )
        )

    db.commit()
