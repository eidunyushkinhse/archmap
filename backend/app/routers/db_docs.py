"""CRUD структуры БД (таблицы/колонки) и обращений к данным.

Мутации — только архитектору, чтение — обеим ролям: как у node_docs. Каждая мутация
бампает meta_rev — структура это МЕТА узла (видна на его странице, не на схеме), и
поллинг страницы обязан отличать её от изменений схемы (graph_rev).

Структуру заводим ЛЮБОМУ атомарному узлу, но не контейнеру: у контейнера собственной
логики и контрактов не бывает — они живут на атомарных детях (правила контейнеров,
container.md §9, алерт AL24). Форму узла НЕ проверяем: интерфейс ведёт к структуре от
базы данных, а агент BYOA может прислать таблицы узлу, которому пользователь дал
другую форму — отвергать такой импорт хуже, чем показать расхождение.
"""

import uuid

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session, aliased

from app.auth import get_current_user, require_architect
from app.database import get_db
from app.deps import get_current_project, scoped_node, touch_project
from app.models.db_column import DbColumn
from app.models.db_table import DbTable
from app.models.doc_data_access import DocDataAccess
from app.models.node import Node
from app.models.node_doc import NodeDoc
from app.models.project import Project
from app.models.user import User
from app.schemas.db_doc import (
    DataAccessCreate,
    DataAccessResponse,
    DbColumnCreate,
    DbColumnResponse,
    DbColumnUpdate,
    DbTableCreate,
    DbTableResponse,
    DbTableUpdate,
    ProjectTableRef,
    TableUsage,
)
from app.view_state import bump_meta_rev

# Каталог таблиц ВСЕГО проекта живёт под своим префиксом, а не под /nodes/…: путь
# «/nodes/tables» перехватил бы «/nodes/{node_id}» (объявлен раньше) и упал бы на
# разборе uuid.
catalog_router = APIRouter(prefix="/tables", tags=["db-docs"])
tables_router = APIRouter(prefix="/nodes/{node_id}/tables", tags=["db-docs"])
access_router = APIRouter(prefix="/nodes/{node_id}/docs/{doc_id}/access", tags=["db-docs"])


def _get_node(db: Session, node_id: uuid.UUID, project: Project) -> Node:
    node = scoped_node(db, node_id, project)
    if not node:
        raise HTTPException(status_code=404, detail="Узел не найден")
    return node


def _writable_node(db: Session, node_id: uuid.UUID, project: Project) -> Node:
    node = _get_node(db, node_id, project)
    has_children = (
        db.query(Node.id).filter(Node.parent_id == node.id).first() is not None
    )
    if has_children:
        raise HTTPException(
            status_code=400,
            detail="У контейнера не бывает собственной структуры — она живёт на его детях",
        )
    return node


def _scoped_table(db: Session, node: Node, table_id: uuid.UUID) -> DbTable:
    table = db.get(DbTable, table_id)
    if table is None or table.node_id != node.id:
        raise HTTPException(status_code=404, detail="Таблица не найдена")
    return table


def _table_taken(
    db: Session, node_id: uuid.UUID, schema_name: str, name: str, except_id: uuid.UUID | None
) -> bool:
    """Пре-чек уникальности имени в контуре — 409 вместо IntegrityError-500."""
    q = db.query(DbTable.id).filter(
        DbTable.node_id == node_id, DbTable.schema_name == schema_name, DbTable.name == name
    )
    if except_id is not None:
        q = q.filter(DbTable.id != except_id)
    return db.query(q.exists()).scalar() or False


def _column_taken(
    db: Session, table_id: uuid.UUID, name: str, except_id: uuid.UUID | None
) -> bool:
    q = db.query(DbColumn.id).filter(DbColumn.table_id == table_id, DbColumn.name == name)
    if except_id is not None:
        q = q.filter(DbColumn.id != except_id)
    return db.query(q.exists()).scalar() or False


# ── Таблицы ───────────────────────────────────────────────────────────────────


@tables_router.get("", response_model=list[DbTableResponse])
def list_tables(
    node_id: uuid.UUID,
    db: Session = Depends(get_db),
    project: Project = Depends(get_current_project),
    _: User = Depends(get_current_user),
) -> list[DbTable]:
    node = _get_node(db, node_id, project)
    return list(node.db_tables)


@tables_router.get("/usage", response_model=list[TableUsage])
def list_usage(
    node_id: uuid.UUID,
    db: Session = Depends(get_db),
    project: Project = Depends(get_current_project),
    _: User = Depends(get_current_user),
) -> list[TableUsage]:
    """Кто обращается к таблицам этой базы — разворот doc_data_access.

    Ради этого ответа всё и строилось: перечень таблиц говорит, ГДЕ значение может
    лежать, а обратный индекс — КТО его туда кладёт.
    """
    node = _get_node(db, node_id, project)
    caller = aliased(Node)
    rows = (
        db.query(
            DbTable.id, DbTable.name, DbColumn.id, DbColumn.name,
            DocDataAccess.mode, NodeDoc.id, NodeDoc.name, caller.id, caller.name,
        )
        .select_from(DocDataAccess)
        .join(DbTable, DbTable.id == DocDataAccess.table_id)
        .outerjoin(DbColumn, DbColumn.id == DocDataAccess.column_id)
        .join(NodeDoc, NodeDoc.id == DocDataAccess.node_doc_id)
        .join(caller, caller.id == NodeDoc.node_id)
        .filter(DbTable.node_id == node.id)
        .order_by(DbTable.name, caller.name, NodeDoc.name)
        .all()
    )
    return [
        TableUsage(
            table_id=t_id, table_name=t_name, column_id=c_id, column_name=c_name,
            mode=mode, doc_id=d_id, doc_name=d_name, node_id=n_id, node_name=n_name,
        )
        for t_id, t_name, c_id, c_name, mode, d_id, d_name, n_id, n_name in rows
    ]


@catalog_router.get("", response_model=list[ProjectTableRef])
def list_project_tables(
    db: Session = Depends(get_db),
    project: Project = Depends(get_current_project),
    _: User = Depends(get_current_user),
) -> list[ProjectTableRef]:
    """Все таблицы проекта с именами узлов-владельцев — материал пикера обращений."""
    rows = (
        db.query(DbTable, Node.name)
        .join(Node, Node.id == DbTable.node_id)
        .filter(Node.project_id == project.id)
        .order_by(Node.name, DbTable.schema_name, DbTable.name)
        .all()
    )
    return [
        ProjectTableRef(
            id=t.id, node_id=t.node_id, node_name=node_name,
            name=t.name, schema_name=t.schema_name,
            columns=list(t.columns),
        )
        for t, node_name in rows
    ]


@tables_router.post("", response_model=DbTableResponse, status_code=status.HTTP_201_CREATED)
def create_table(
    node_id: uuid.UUID,
    payload: DbTableCreate,
    db: Session = Depends(get_db),
    project: Project = Depends(get_current_project),
    user: User = Depends(require_architect),
) -> DbTable:
    node = _writable_node(db, node_id, project)
    if _table_taken(db, node.id, payload.schema_name, payload.name, None):
        raise HTTPException(status_code=409, detail="Таблица с таким именем уже есть")
    table = DbTable(
        node_id=node.id,
        name=payload.name,
        schema_name=payload.schema_name,
        description=payload.description,
    )
    db.add(table)
    bump_meta_rev(db, project)
    touch_project(db, project, user.id)
    db.commit()
    db.refresh(table)
    return table


@tables_router.patch("/{table_id}", response_model=DbTableResponse)
def update_table(
    node_id: uuid.UUID,
    table_id: uuid.UUID,
    payload: DbTableUpdate,
    db: Session = Depends(get_db),
    project: Project = Depends(get_current_project),
    user: User = Depends(require_architect),
) -> DbTable:
    node = _get_node(db, node_id, project)
    table = _scoped_table(db, node, table_id)
    data = payload.model_dump(exclude_unset=True)
    base_version = data.pop("base_version", None)
    if base_version is not None and base_version != table.version:
        raise HTTPException(status_code=409, detail="Таблица изменена в другой сессии")
    if data:
        new_name = data.get("name", table.name)
        new_schema = data.get("schema_name", table.schema_name)
        if _table_taken(db, node.id, new_schema, new_name, table.id):
            raise HTTPException(status_code=409, detail="Таблица с таким именем уже есть")
        for field, value in data.items():
            setattr(table, field, value)
        table.version += 1
        bump_meta_rev(db, project)
    touch_project(db, project, user.id)
    db.commit()
    db.refresh(table)
    return table


@tables_router.delete("/{table_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_table(
    node_id: uuid.UUID,
    table_id: uuid.UUID,
    db: Session = Depends(get_db),
    project: Project = Depends(get_current_project),
    user: User = Depends(require_architect),
) -> None:
    node = _get_node(db, node_id, project)
    table = _scoped_table(db, node, table_id)
    db.delete(table)
    bump_meta_rev(db, project)
    touch_project(db, project, user.id)
    db.commit()


# ── Колонки ───────────────────────────────────────────────────────────────────


@tables_router.post(
    "/{table_id}/columns", response_model=DbColumnResponse, status_code=status.HTTP_201_CREATED
)
def create_column(
    node_id: uuid.UUID,
    table_id: uuid.UUID,
    payload: DbColumnCreate,
    db: Session = Depends(get_db),
    project: Project = Depends(get_current_project),
    user: User = Depends(require_architect),
) -> DbColumn:
    node = _get_node(db, node_id, project)
    table = _scoped_table(db, node, table_id)
    if _column_taken(db, table.id, payload.name, None):
        raise HTTPException(status_code=409, detail="Колонка с таким именем уже есть в таблице")
    column = DbColumn(table_id=table.id, **payload.model_dump())
    db.add(column)
    bump_meta_rev(db, project)
    touch_project(db, project, user.id)
    db.commit()
    db.refresh(column)
    return column


@tables_router.patch("/{table_id}/columns/{column_id}", response_model=DbColumnResponse)
def update_column(
    node_id: uuid.UUID,
    table_id: uuid.UUID,
    column_id: uuid.UUID,
    payload: DbColumnUpdate,
    db: Session = Depends(get_db),
    project: Project = Depends(get_current_project),
    user: User = Depends(require_architect),
) -> DbColumn:
    node = _get_node(db, node_id, project)
    table = _scoped_table(db, node, table_id)
    column = db.get(DbColumn, column_id)
    if column is None or column.table_id != table.id:
        raise HTTPException(status_code=404, detail="Колонка не найдена")
    data = payload.model_dump(exclude_unset=True)
    if data:
        new_name = data.get("name")
        if new_name is not None and _column_taken(db, table.id, new_name, column.id):
            raise HTTPException(
                status_code=409, detail="Колонка с таким именем уже есть в таблице"
            )
        for field, value in data.items():
            setattr(column, field, value)
        bump_meta_rev(db, project)
    touch_project(db, project, user.id)
    db.commit()
    db.refresh(column)
    return column


@tables_router.delete(
    "/{table_id}/columns/{column_id}", status_code=status.HTTP_204_NO_CONTENT
)
def delete_column(
    node_id: uuid.UUID,
    table_id: uuid.UUID,
    column_id: uuid.UUID,
    db: Session = Depends(get_db),
    project: Project = Depends(get_current_project),
    user: User = Depends(require_architect),
) -> None:
    node = _get_node(db, node_id, project)
    table = _scoped_table(db, node, table_id)
    column = db.get(DbColumn, column_id)
    if column is None or column.table_id != table.id:
        raise HTTPException(status_code=404, detail="Колонка не найдена")
    db.delete(column)
    bump_meta_rev(db, project)
    touch_project(db, project, user.id)
    db.commit()


# ── Обращения к данным (у ВЫЗЫВАЮЩЕГО, в доке его операции) ───────────────────


def _scoped_doc(db: Session, node: Node, doc_id: uuid.UUID) -> NodeDoc:
    doc = db.get(NodeDoc, doc_id)
    if doc is None or doc.node_id != node.id:
        raise HTTPException(status_code=404, detail="Схема не найдена")
    return doc


@access_router.get("", response_model=list[DataAccessResponse])
def list_access(
    node_id: uuid.UUID,
    doc_id: uuid.UUID,
    db: Session = Depends(get_db),
    project: Project = Depends(get_current_project),
    _: User = Depends(get_current_user),
) -> list[DocDataAccess]:
    node = _get_node(db, node_id, project)
    return list(_scoped_doc(db, node, doc_id).data_access)


@access_router.post("", response_model=DataAccessResponse, status_code=status.HTTP_201_CREATED)
def create_access(
    node_id: uuid.UUID,
    doc_id: uuid.UUID,
    payload: DataAccessCreate,
    db: Session = Depends(get_db),
    project: Project = Depends(get_current_project),
    user: User = Depends(require_architect),
) -> DocDataAccess:
    node = _get_node(db, node_id, project)
    doc = _scoped_doc(db, node, doc_id)
    # Таблица — из ЛЮБОГО узла проекта: обращение по определению уходит на чужой узел
    # (сервис → его БД). Скоуп проверяем через владельца таблицы.
    table = db.get(DbTable, payload.table_id)
    owner = db.get(Node, table.node_id) if table else None
    if table is None or owner is None or owner.project_id != project.id:
        raise HTTPException(status_code=404, detail="Таблица не найдена")
    if payload.column_id is not None:
        column = db.get(DbColumn, payload.column_id)
        if column is None or column.table_id != table.id:
            raise HTTPException(status_code=400, detail="Колонка не из этой таблицы")
    # Дубли (одно и то же обращение дважды) — 409, а не молчаливая вторая строка:
    # уникальный индекс здесь не поможет, NULL в column_id сам себе не конфликтует.
    exists = (
        db.query(DocDataAccess.id)
        .filter(
            DocDataAccess.node_doc_id == doc.id,
            DocDataAccess.table_id == payload.table_id,
            DocDataAccess.column_id == payload.column_id,
            DocDataAccess.mode == payload.mode,
        )
        .first()
    )
    if exists is not None:
        raise HTTPException(status_code=409, detail="Такое обращение уже описано")
    access = DocDataAccess(node_doc_id=doc.id, **payload.model_dump())
    db.add(access)
    bump_meta_rev(db, project)
    touch_project(db, project, user.id)
    db.commit()
    db.refresh(access)
    return access


@access_router.delete("/{access_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_access(
    node_id: uuid.UUID,
    doc_id: uuid.UUID,
    access_id: uuid.UUID,
    db: Session = Depends(get_db),
    project: Project = Depends(get_current_project),
    user: User = Depends(require_architect),
) -> None:
    node = _get_node(db, node_id, project)
    doc = _scoped_doc(db, node, doc_id)
    access = db.get(DocDataAccess, access_id)
    if access is None or access.node_doc_id != doc.id:
        raise HTTPException(status_code=404, detail="Обращение не найдено")
    db.delete(access)
    bump_meta_rev(db, project)
    touch_project(db, project, user.id)
    db.commit()
