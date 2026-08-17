"""CRUD структуры БД (таблицы/колонки) и обратный индекс «кто к ним обращается».

Обращения СВОЕГО ввода здесь не имеют: они живут пометками «читает:/пишет:» в тексте
схем логики вызывающих (пивот §9 plan-db-docs.md), а индекс собирается их разбором на
чтении. Записями хранится только структура — «контракт» узла-базы.

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
from sqlalchemy.orm import Session

from app.auth import get_current_user, require_architect
from app.data_refs import catalog_for_project, parse_data_refs, resolve_data_refs
from app.database import get_db
from app.deps import get_current_project, scoped_node, touch_project
from app.models.db_column import DbColumn
from app.models.db_table import DbTable
from app.models.node import Node
from app.models.node_doc import NodeDoc
from app.models.project import Project
from app.models.user import User
from app.schemas.db_doc import (
    DbColumnCreate,
    DbColumnResponse,
    DbColumnUpdate,
    DbTableCreate,
    DbTableResponse,
    DbTableUpdate,
    TableUsage,
)
from app.view_state import bump_meta_rev

tables_router = APIRouter(prefix="/nodes/{node_id}/tables", tags=["db-docs"])


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
    """Кто обращается к таблицам этой базы — разворот пометок из схем логики проекта.

    Ради этого ответа всё и строилось: перечень таблиц говорит, ГДЕ значение может
    лежать, а обратный индекс — КТО его туда кладёт. Источник — сам текст доков
    (пивот §9 плана): разбор и резолв на чтении, хранения обращений нет.
    """
    node = _get_node(db, node_id, project)
    tables, channels, params_by_node, node_paths = catalog_for_project(db, project.id)
    # Резолв идёт по каталогу ВСЕГО проекта (иначе одноимённые таблицы в чужих базах
    # перестали бы делать ссылку неоднозначной), а в ответ отбираем свои.
    mine = {t.id: t for t in tables if t.node_id == node.id}
    if not mine:
        return []

    docs = (
        db.query(NodeDoc.id, NodeDoc.name, NodeDoc.content, Node.id, Node.name)
        .select_from(NodeDoc)
        .join(Node, Node.id == NodeDoc.node_id)
        .filter(Node.project_id == project.id)
        .all()
    )

    rows: list[TableUsage] = []
    # Дедуп в пределах дока: «orders.status» и «Хранилище / orders.status» — одно и то
    # же обращение, написанное по-разному, и второй строкой в индексе быть не должно.
    seen: set[tuple[uuid.UUID, uuid.UUID, uuid.UUID | None, str]] = set()
    for doc_id, doc_name, content, caller_id, caller_name in docs:
        if not content:
            continue
        for ref in resolve_data_refs(
            parse_data_refs(content),
            tables,
            channels,
            node_paths,
            # Конфигурация ВЛАДЕЛЬЦА дока: этому индексу она не нужна, но каталог
            # передаём настоящий — подсунуть пустой значило бы сказать резолверу
            # неправду и получить ложные статусы, если фильтр ниже когда-нибудь
            # ослабнет.
            owner_params=params_by_node.get(caller_id, {}),
        ):
            # unknown_table/ambiguous сюда НЕ попадают: индекс базы отвечает за факты,
            # а нерезолвнутой пометке место в алертах и в плашке редактора дока.
            # Канальные пометки («публикует:/потребляет:») отсеиваются сами: у них
            # table_id пуст — их разворот живёт у брокера (channels/usage).
            if ref.status not in ("ok", "unknown_column") or ref.table_id is None:
                continue
            table = mine.get(ref.table_id)
            if table is None:
                continue
            # unknown_column = таблица нашлась, колонки нет → обращение к таблице
            # ЦЕЛИКОМ; несуществующую колонку в индекс не тащим (её подсветит алерт).
            column_id = ref.column_id if ref.status == "ok" else None
            column_name = ref.column_name if ref.status == "ok" else None
            key = (doc_id, table.id, column_id, ref.mode)
            if key in seen:
                continue
            seen.add(key)
            rows.append(
                TableUsage(
                    table_id=table.id, table_name=table.name,
                    column_id=column_id, column_name=column_name,
                    mode=ref.mode, doc_id=doc_id, doc_name=doc_name,
                    node_id=caller_id, node_name=caller_name,
                )
            )
    rows.sort(key=lambda u: (u.table_name, u.node_name, u.doc_name))
    return rows


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
