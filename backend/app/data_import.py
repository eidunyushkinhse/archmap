"""Дозаливка структуры БД и обращений от агента (BYOA, Ф5 plan-db-docs.md).

Почему без этого эпик наполовину бесполезен: базу с сорока таблицами руками не
опишут. Зато агент читает миграции и ORM-модели — структуру он отдаёт надёжнее, чем
нарисованную диаграмму, и обращения тоже (запросы видны в коде операции).

Формат пакета — YAML-файлы рядом с .mmd схемами логики; адрес узла-владельца задаётся
ведущим комментарием «# archmap-node: …», как «%% archmap-node» у схем. Разбор
намеренно ТОЛЕРАНТНЫЙ (урок импорта репозитория): неизвестные ключи игнорируются,
кривая запись даёт ошибку в отчёте, а не роняет пакет целиком.

УДАЛЕНИЙ НЕТ: чего агент не увидел, то остаётся. Расхождение должно быть видно
человеку, а не молча исчезать (та же политика, что у дозаливки доков).
"""

import re
import uuid
from dataclasses import dataclass, field

import yaml
from sqlalchemy.orm import Session

from app.docs_import import _node_paths
from app.models.db_column import DbColumn
from app.models.db_table import DbTable
from app.models.doc_data_access import DocDataAccess
from app.models.node import Node
from app.models.node_doc import NodeDoc
from app.schemas.data_import import DataAccessItem, DataImportReport, DataTableItem

NODE_HEADER = re.compile(r"^#\s*archmap-node:\s*(.+?)\s*$", re.MULTILINE)


@dataclass
class ColumnIn:
    name: str
    type: str = ""
    pk: bool = False
    required: bool = False
    references: str | None = None
    description: str | None = None


@dataclass
class TableIn:
    name: str
    schema_name: str = ""
    description: str | None = None
    columns: list[ColumnIn] = field(default_factory=list)


@dataclass
class AccessIn:
    node_ref: str | None
    doc: str
    table: str
    column: str | None
    mode: str


@dataclass
class ParsedData:
    node_ref: str | None = None
    tables: list[TableIn] = field(default_factory=list)
    access: list[AccessIn] = field(default_factory=list)


def _as_bool(v: object) -> bool:
    return v is True or (isinstance(v, str) and v.strip().lower() in {"true", "да", "yes", "1"})


def _as_str(v: object) -> str:
    return "" if v is None else str(v).strip()


def parse_data_file(content: str) -> ParsedData | None:
    """Разобрать файл пакета. None — файл не про данные (пусть его смотрит другой
    разборщик: в пакете рядом лежат и спеки, и схемы логики)."""
    try:
        doc = yaml.safe_load(content)
    except yaml.YAMLError:
        return None
    if not isinstance(doc, dict) or not ({"tables", "access"} & doc.keys()):
        return None
    m = NODE_HEADER.search(content)
    out = ParsedData(node_ref=m.group(1) if m else None)

    for raw in doc.get("tables") or []:
        if not isinstance(raw, dict) or not _as_str(raw.get("name")):
            continue
        t = TableIn(
            name=_as_str(raw.get("name")),
            schema_name=_as_str(raw.get("schema")),
            description=_as_str(raw.get("description")) or None,
        )
        for rc in raw.get("columns") or []:
            if not isinstance(rc, dict) or not _as_str(rc.get("name")):
                continue
            t.columns.append(
                ColumnIn(
                    name=_as_str(rc.get("name")),
                    type=_as_str(rc.get("type")),
                    pk=_as_bool(rc.get("pk")),
                    required=_as_bool(rc.get("required")),
                    references=_as_str(rc.get("references")) or None,
                    description=_as_str(rc.get("description")) or None,
                )
            )
        out.tables.append(t)

    for raw in doc.get("access") or []:
        if not isinstance(raw, dict):
            continue
        mode = _as_str(raw.get("mode")).lower()
        table = _as_str(raw.get("table"))
        doc_name = _as_str(raw.get("doc"))
        if mode not in {"read", "write"} or not table or not doc_name:
            continue
        out.access.append(
            AccessIn(
                node_ref=_as_str(raw.get("node")) or None,
                doc=doc_name,
                table=table,
                column=_as_str(raw.get("column")) or None,
                mode=mode,
            )
        )
    return out


@dataclass
class DataPlan:
    """План дозаливки: что создастся, что обновится, что уже такое."""

    report: DataImportReport = field(default_factory=DataImportReport)
    # (узел-владелец, разобранная таблица, источник)
    tables: list[tuple[Node, TableIn, str]] = field(default_factory=list)
    # (док вызывающего, ССЫЛКА на таблицу, имя колонки|None, режим, источник).
    # Именно ссылка, а не объект: таблица может создаваться ЭТИМ ЖЕ пакетом и на момент
    # плана ещё не существовать — цель резолвится повторно при применении.
    access: list[tuple[NodeDoc, str, str | None, str, str]] = field(default_factory=list)
    # Пути узлов проекта: нужны и плану, и применению (резолв «узел / таблица»).
    path_of: dict[uuid.UUID, str] = field(default_factory=dict)


def _resolve_node(
    ref: str | None,
    fname: str,
    flat: list[Node],
    fulls: list[str],
    by_bare: dict[str, list[int]],
    by_path: dict[str, list[int]],
    window: uuid.UUID | None,
    plan: DataPlan,
) -> Node | None:
    """Узел по адресу: полный путь либо голое имя (как в дозаливке доков). Без
    адреса — объект окна."""
    if ref is None:
        if window is None:
            plan.report.errors.append(f"{fname}: не указан объект, а окно не сказало, к какому применять")
            return None
        for i, n in enumerate(flat):
            if n.id == window:
                return flat[i]
        plan.report.errors.append(f"{fname}: объект окна не найден")
        return None
    hits = by_path.get(ref) or by_bare.get(ref) or []
    if not hits:
        plan.report.errors.append(f"{fname}: объект «{ref}» не найден")
        return None
    if len(hits) > 1:
        plan.report.errors.append(
            f'{fname}: имя «{ref}» неоднозначно ({", ".join(fulls[i] for i in hits)}) — укажите полный путь'
        )
        return None
    return flat[hits[0]]


def build_data_plan(
    db: Session,
    nodes: list[Node],
    files: list[tuple[str, str]],
    window: uuid.UUID | None,
    overwrite: bool,
) -> DataPlan:
    plan = DataPlan()
    flat, fulls, by_bare, by_path = _node_paths(nodes)
    path_of = {n.id: fulls[i] for i, n in enumerate(flat)}
    plan.path_of = path_of

    parsed: list[tuple[str, ParsedData]] = []
    for fname, content in files:
        pd = parse_data_file(content)
        if pd is not None:
            parsed.append((fname, pd))
    if not parsed:
        plan.report.errors.append("В пакете нет файлов со структурой данных (tables/access)")
        return plan

    # --- Таблицы ---------------------------------------------------------------
    for fname, pd in parsed:
        if not pd.tables:
            continue
        owner = _resolve_node(pd.node_ref, fname, flat, fulls, by_bare, by_path, window, plan)
        if owner is None:
            continue
        existing = {
            (t.schema_name, t.name): t
            for t in db.query(DbTable).filter(DbTable.node_id == owner.id).all()
        }
        for t in pd.tables:
            live = existing.get((t.schema_name, t.name))
            action = "create" if live is None else ("overwrite" if overwrite else "unchanged")
            plan.report.tables.append(
                DataTableItem(
                    node_path=path_of.get(owner.id, owner.name), source=fname,
                    schema_name=t.schema_name, name=t.name, columns=len(t.columns),
                    action=action,  # type: ignore[arg-type]
                )
            )
            plan.tables.append((owner, t, fname))

    # --- Обращения -------------------------------------------------------------
    # Таблицы ищем по всему проекту: обращение по определению уходит на ЧУЖОЙ узел.
    live_tables = (
        db.query(DbTable).filter(DbTable.node_id.in_([n.id for n in nodes])).all() if nodes else []
    )
    for fname, pd in parsed:
        for a in pd.access:
            caller = _resolve_node(a.node_ref, fname, flat, fulls, by_bare, by_path, window, plan)
            if caller is None:
                continue
            doc = (
                db.query(NodeDoc)
                .filter(NodeDoc.node_id == caller.id, NodeDoc.name == a.doc)
                .first()
            )
            if doc is None:
                plan.report.errors.append(
                    f'{fname}: у объекта «{path_of.get(caller.id, caller.name)}» нет схемы «{a.doc}»'
                )
                continue
            table = _pick_table(a.table, live_tables, path_of)
            # Таблица могла приехать ЭТИМ ЖЕ пакетом — тогда живой её ещё нет.
            planned = None if table else _pick_planned(a.table, plan.tables, path_of)
            if table is None and planned is None:
                plan.report.errors.append(f'{fname}: таблица «{a.table}» не найдена или неоднозначна')
                continue
            t_name = table.name if table else planned[1].name  # type: ignore[index]
            column = None
            if a.column:
                known = (
                    [c.name for c in table.columns] if table
                    else [c.name for c in planned[1].columns]  # type: ignore[index]
                )
                if a.column in known:
                    column = a.column
                else:
                    plan.report.warnings.append(
                        f'{fname}: колонки «{a.column}» нет в «{t_name}» — обращение к таблице целиком'
                    )
            dup = None
            if table is not None:
                col_id = next((c.id for c in table.columns if c.name == column), None)
                dup = (
                    db.query(DocDataAccess.id)
                    .filter(
                        DocDataAccess.node_doc_id == doc.id,
                        DocDataAccess.table_id == table.id,
                        DocDataAccess.column_id == col_id,
                        DocDataAccess.mode == a.mode,
                    )
                    .first()
                )
            plan.report.access.append(
                DataAccessItem(
                    node_path=path_of.get(caller.id, caller.name), source=fname, doc=a.doc,
                    target=f"{t_name}{f'.{column}' if column else ''}",
                    mode=a.mode,  # type: ignore[arg-type]
                    action="unchanged" if dup else "create",
                )
            )
            if not dup:
                plan.access.append((doc, a.table, column, a.mode, fname))
    return plan


def _pick_planned(
    ref: str, planned: list[tuple[Node, TableIn, str]], path_of: dict[uuid.UUID, str]
) -> tuple[Node, TableIn] | None:
    """Та же выборка, но по таблицам, которые ПРИЕДУТ этим пакетом."""
    node_ref, _, bare = ref.rpartition(" / ")
    schema, _, name = bare.rpartition(".")
    hits = [
        (owner, t)
        for owner, t, _src in planned
        if t.name == name
        and (not schema or t.schema_name == schema)
        and (not node_ref or path_of.get(owner.id, "").endswith(node_ref))
    ]
    return hits[0] if len(hits) == 1 else None


def _pick_table(
    ref: str, tables: list[DbTable], path_of: dict[uuid.UUID, str]
) -> DbTable | None:
    """Таблица по ссылке: «узел / таблица», «контур.таблица» либо голое имя (если
    единственная в проекте)."""
    node_ref, _, bare = ref.rpartition(" / ")
    schema, _, name = bare.rpartition(".")
    hits = [
        t
        for t in tables
        if t.name == name
        and (not schema or t.schema_name == schema)
        and (not node_ref or path_of.get(t.node_id, "").endswith(node_ref))
    ]
    return hits[0] if len(hits) == 1 else None


def apply_data_plan(db: Session, plan: DataPlan, overwrite: bool) -> None:
    """Применить план. Ничего не удаляем; заполненное перетираем только по overwrite."""
    r = plan.report
    for owner, t, _src in plan.tables:
        table = (
            db.query(DbTable)
            .filter(
                DbTable.node_id == owner.id,
                DbTable.schema_name == t.schema_name,
                DbTable.name == t.name,
            )
            .first()
        )
        if table is None:
            table = DbTable(
                node_id=owner.id, name=t.name, schema_name=t.schema_name,
                description=t.description,
            )
            db.add(table)
            db.flush()
            r.tables_written += 1
        elif overwrite and t.description:
            table.description = t.description
            table.version += 1
            r.tables_written += 1

        live_cols = {c.name: c for c in table.columns}
        for order, c in enumerate(t.columns):
            col = live_cols.get(c.name)
            if col is None:
                db.add(
                    DbColumn(
                        table_id=table.id, name=c.name, type=c.type, nullable=not c.required,
                        is_primary_key=c.pk, description=c.description, order=order,
                    )
                )
                r.columns_written += 1
            elif overwrite:
                col.type = c.type or col.type
                col.nullable = not c.required
                col.is_primary_key = c.pk
                if c.description:
                    col.description = c.description
                r.columns_written += 1
        db.flush()

    # Внешние ключи — ВТОРЫМ проходом: цель может лежать в таблице, созданной этим же
    # пакетом ниже по файлу.
    for owner, t, _src in plan.tables:
        table = (
            db.query(DbTable)
            .filter(
                DbTable.node_id == owner.id,
                DbTable.schema_name == t.schema_name,
                DbTable.name == t.name,
            )
            .first()
        )
        if table is None:
            continue
        owner_tables = db.query(DbTable).filter(DbTable.node_id == owner.id).all()
        for c in t.columns:
            if not c.references:
                continue
            col = next((x for x in table.columns if x.name == c.name), None)
            if col is None or col.references_column_id is not None:
                continue
            t_name, _, c_name = c.references.rpartition(".")
            target_t = next((x for x in owner_tables if x.name == t_name), None)
            target_c = (
                next((x for x in target_t.columns if x.name == c_name), None) if target_t else None
            )
            if target_c is None:
                r.warnings.append(f"{t.name}.{c.name}: цель ссылки «{c.references}» не найдена")
                continue
            col.references_column_id = target_c.id

    # Обращения — ПОСЛЕ таблиц: цель могла приехать этим же пакетом, и живой её на
    # момент плана не было.
    live = db.query(DbTable).filter(DbTable.node_id.in_(list(plan.path_of))).all() if plan.path_of else []
    for doc, table_ref, column_name, mode, src in plan.access:
        table = _pick_table(table_ref, live, plan.path_of)
        if table is None:
            r.warnings.append(f"{src}: таблица «{table_ref}» не найдена при применении")
            continue
        col = next((c for c in table.columns if c.name == column_name), None) if column_name else None
        db.add(
            DocDataAccess(
                node_doc_id=doc.id, table_id=table.id,
                column_id=col.id if col else None, mode=mode,
            )
        )
        r.access_written += 1
    r.applied = True
