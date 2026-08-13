"""Дозаливка СТРУКТУРЫ БД от агента (BYOA, Ф5 plan-db-docs.md).

Почему без этого эпик наполовину бесполезен: базу с сорока таблицами руками не
опишут. Зато агент читает миграции и ORM-модели — структуру он отдаёт надёжнее, чем
нарисованную диаграмму.

Только структура: обращения к данным приезжают не сюда, а пометками «читает:/пишет:»
в тексте схем логики (пивот §9). Старый раздел `access` в пакете не ошибка, но и не
данные — на него отвечаем предупреждением, чтобы пакет по прежнему промпту не уехал
в тишину.

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
from app.models.node import Node
from app.schemas.data_import import DataImportReport, DataTableItem

NODE_HEADER = re.compile(r"^#\s*archmap-node:\s*(.+?)\s*$", re.MULTILINE)
# «Файл ПОХОЖ на наш» — по разделам верхнего уровня. Нужен, чтобы отличить чужой файл
# пакета (схему логики, спеку) от НАШЕГО, но с битым YAML: молча пропустив второй, мы
# сказали бы «в пакете нет файлов со структурой данных», хотя данные там есть.
# `access` тут остался намеренно: пакет по старому промпту — всё ещё НАШ файл, и битый
# YAML в нём должен получить внятный ответ, а не считаться чужим.
LOOKS_LIKE_DATA = re.compile(r"^(tables|access):", re.MULTILINE)


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
class ParsedData:
    node_ref: str | None = None
    tables: list[TableIn] = field(default_factory=list)
    # В файле был раздел `access` (пакет по старому промпту). Содержимое не разбираем —
    # обращений-записей больше нет; факт нужен, чтобы предупредить человека.
    has_access: bool = False


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
    # `access` по-прежнему делает файл НАШИМ (иначе пакет по старому промпту, где кроме
    # обращений ничего нет, получил бы «в пакете нет файлов со структурой данных» —
    # ответ формально верный, но необъясняющий).
    if not isinstance(doc, dict) or not ({"tables", "access"} & doc.keys()):
        return None
    m = NODE_HEADER.search(content)
    out = ParsedData(node_ref=m.group(1) if m else None, has_access="access" in doc)

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

    return out


@dataclass
class DataPlan:
    """План дозаливки: что создастся, что обновится, что уже такое."""

    report: DataImportReport = field(default_factory=DataImportReport)
    # (узел-владелец, разобранная таблица, источник)
    tables: list[tuple[Node, TableIn, str]] = field(default_factory=list)
    # Пути узлов проекта: нужны и плану, и применению (резолв адреса владельца).
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
        # ЧАСТИЧНЫЙ путь («Сервис заказов / Order API» при корне «Маркетплейс …»):
        # агент видит только свой репозиторий и корневого контейнера не знает, а
        # промпт как раз просит писать путь. Совпадение по хвосту — по границе « / »,
        # чтобы «…/ Заказы» не цеплялось к «…/ Мои Заказы».
        hits = [i for i, full in enumerate(fulls) if full.endswith(f" / {ref}")]
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
        elif LOOKS_LIKE_DATA.search(content):
            plan.report.errors.append(
                f"{fname}: похоже на файл данных, но YAML не разобрался. Частая причина — "
                "двоеточие с пробелом внутри значения (например «actor: кто перевёл: user»): "
                "возьмите такое значение в кавычки"
            )
    if not parsed:
        plan.report.errors.append("В пакете нет файлов со структурой данных (tables)")
        return plan

    # Пакет по СТАРОМУ промпту (с разделом `access`) — не ошибка, но и не данные:
    # обращения теперь живут пометками в схемах логики. Одно предупреждение на файл.
    for fname, pd in parsed:
        if pd.has_access:
            plan.report.warnings.append(
                f"{fname}: раздел access больше не поддерживается — обращения описываются "
                "пометками «читает:/пишет:» в схемах логики"
            )

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

    return plan


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

    r.applied = True
