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

Одна таблица может приехать НЕСКОЛЬКИМИ файлами пакета: файлы собраны разными прогонами
агента, и обзорный файл по миграциям пересекается с подробным по конкретной таблице.
Правило — слить в одну таблицу, первый описавший побеждает (_merge_duplicate). Иначе
смысл карты зависел бы от порядка файлов в пакете, а он случаен: агент кладёт файлы как
получилось. Та же политика, что у доливки пакетов из разных репозиториев.

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

# Кап у таблиц, описанных НЕСКОЛЬКИМИ файлами пакета. Считает ТАБЛИЦЫ, а не строки:
# к заметке о дубле может добавиться расхождение описания между файлами.
MAX_DUPLICATE_WARNINGS = 8


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
    # В YAML верхнего уровня есть КЛЮЧ «archmap-node»: агент потерял решётку, и адрес
    # стал невидимым (полевой QA Zabbix 7 — записи молча уехали к объекту окна).
    # Адресом ключ не считаем (поведение прежнее), но молчать о нём нельзя.
    has_node_key: bool = False


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
    out = ParsedData(
        node_ref=m.group(1) if m else None,
        has_access="access" in doc,
        has_node_key="archmap-node" in doc,
    )

    for raw in doc.get("tables") or []:
        if not isinstance(raw, dict) or not _as_str(raw.get("name")):
            continue
        t = TableIn(
            name=_as_str(raw.get("name")),
            schema_name=_as_str(raw.get("schema")),
            description=_as_str(raw.get("description")) or None,
        )
        seen_columns: set[str] = set()
        for rc in raw.get("columns") or []:
            if not isinstance(rc, dict) or not _as_str(rc.get("name")):
                continue
            col_name = _as_str(rc.get("name"))
            # Одно имя колонки дважды в одной таблице — та же неряшливость агента, что и
            # колонка без имени выше, и молча пропустить её тут дешевле, чем ловить
            # уникальностью (table_id, name) уже на записи: превью показало бы завышенное
            # число колонок, а применение упало бы 500-й.
            if col_name in seen_columns:
                continue
            seen_columns.add(col_name)
            t.columns.append(
                ColumnIn(
                    name=col_name,
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


@dataclass
class _Merged:
    """Таблица плана: первое вхождение плюс всё, что долили следующие файлы пакета."""

    owner: Node
    table: TableIn
    # Файл ПЕРВОГО вхождения — он и стоит источником в строке превью.
    source: str
    # Все файлы пакета, описавшие эту таблицу, в порядке пакета и без повторов.
    files: list[str] = field(default_factory=list)
    # Расхождения описания МЕЖДУ файлами пакета — поимённо, значение первого.
    meta_notes: list[str] = field(default_factory=list)


def _db_nodes_hint(flat: list[Node], fulls: list[str]) -> str:
    """Перечень узлов-БД проекта для текстов ошибок.

    Слабая модель адрес ВЫДУМЫВАЕТ («Zabbix Storage»), а «объект не найден» без списка
    допустимых заставляет её гадать вслепую — раунд переписки за раунд (полевой QA).
    """
    paths = [fulls[i] for i, n in enumerate(flat) if n.shape == "database"]
    return ", ".join(paths) if paths else "в проекте их нет"


def _resolve_node(
    ref: str | None,
    fname: str,
    flat: list[Node],
    fulls: list[str],
    by_bare: dict[str, list[int]],
    by_path: dict[str, list[int]],
    window: uuid.UUID | None,
    plan: DataPlan,
    db_hint: str,
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
        plan.report.errors.append(
            f"{fname}: объект «{ref}» не найден; узлы-БД проекта: {db_hint}"
        )
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
    db_hint = _db_nodes_hint(flat, fulls)

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
        # Адрес без решётки: YAML-ключ вместо ведущего комментария. Разбор прежний
        # (ключ игнорируется), но тишина тут стоила бы пользователю потерянной схемы —
        # он бы решил, что адресовал пакет, а тот уехал к объекту окна.
        if pd.has_node_key:
            plan.report.warnings.append(
                f"{fname}: ключ archmap-node адресом не является — адрес пишется "
                "комментарием «# archmap-node: …»; записи уедут к объекту окна"
            )

    # --- Таблицы ---------------------------------------------------------------
    # Таблица плана — одна на «узел + схема БД + имя», сколькими бы файлами пакета она
    # ни была описана. Порядок вставки = порядок пакета, он же порядок строк превью.
    merged: dict[tuple[uuid.UUID, str, str], _Merged] = {}
    for fname, pd in parsed:
        if not pd.tables:
            continue
        owner = _resolve_node(
            pd.node_ref, fname, flat, fulls, by_bare, by_path, window, plan, db_hint
        )
        if owner is None:
            continue
        # Зеркало CRUD-правила «структура — контракт узла-БД» (routers/db_docs.py):
        # применённое на сервисе или контейнере стало бы НЕВИДИМЫМ (секцию «Структура»
        # страница рендерит только у shape=database), поэтому не предупреждение, а
        # ошибка. Проверяется и объект окна: адрес мог быть не написан вовсе.
        if owner.shape != "database":
            plan.report.errors.append(
                f"{fname}: объект «{path_of.get(owner.id, owner.name)}» — не база данных; "
                "структура может принадлежать только узлу-БД (форма database). "
                f"Узлы-БД проекта: {db_hint}"
            )
            continue
        for t in pd.tables:
            # Ключ таблицы — тот же, что у уникальности в БД: узел + схема БД + имя.
            # Одно имя в РАЗНЫХ базах (и в разных схемах одной базы) — законно разные
            # таблицы, и сливать их нельзя.
            key = (owner.id, t.schema_name, t.name)
            m = merged.get(key)
            if m is None:
                merged[key] = _Merged(owner=owner, table=t, source=fname, files=[fname])
            else:
                _merge_duplicate(m, fname, t)

    _warn_duplicate_tables(plan, list(merged.values()))

    # Живое состояние берём ОДНИМ запросом после слияния: до него не известно, к
    # скольким владельцам приехал пакет, а строка превью нужна одна на таблицу.
    live_by_key: dict[tuple[uuid.UUID, str, str], DbTable] = {}
    owner_ids = {m.owner.id for m in merged.values()}
    if owner_ids:
        for tb in db.query(DbTable).filter(DbTable.node_id.in_(owner_ids)).all():
            live_by_key[(tb.node_id, tb.schema_name, tb.name)] = tb

    for key, m in merged.items():
        t, owner = m.table, m.owner
        live = live_by_key.get(key)
        action = "create" if live is None else ("overwrite" if overwrite else "unchanged")
        plan.report.tables.append(
            DataTableItem(
                node_path=path_of.get(owner.id, owner.name), source=m.source,
                schema_name=t.schema_name, name=t.name, columns=len(t.columns),
                action=action,  # type: ignore[arg-type]
            )
        )
        plan.tables.append((owner, t, m.source))

    return plan


def _merge_duplicate(m: _Merged, fname: str, t: TableIn) -> None:
    """Долить в таблицу плана её же описание из другого файла ЭТОГО пакета.

    Политика — та же, что у доливки пакетов РАЗНЫХ репозиториев: колонки объединяются
    по имени, а при расхождении побеждает описанное раньше. Иначе смысл карты зависел
    бы от порядка файлов в пакете — а он случаен: обзорный файл по миграциям и
    подробный файл по одной таблице приезжают как получилось.

    Пустое значение спором не считается: файл про один срез кода не видит того, что
    видел другой, и «не знаю» не должно вытеснять «знаю».
    """
    if fname not in m.files:
        m.files.append(fname)
    first = m.table
    if not first.description:
        first.description = t.description
    elif t.description and t.description != first.description:
        # Описание — вся мета таблицы (схема и имя ушли в ключ), и молчать о том, что
        # файлы говорят о таблице разное, тут не на что: расхождение видно только здесь.
        m.meta_notes.append(
            f"{fname}: таблица «{first.name}» — description «{t.description}», а в "
            f"{m.source} «{first.description}»; оставлено значение из {m.source} "
            "(описана раньше)"
        )

    by_name = {c.name: c for c in first.columns}
    for c in t.columns:
        earlier = by_name.get(c.name)
        if earlier is None:
            # Новая колонка встаёт в конец: порядок колонок — это порядок В ТАБЛИЦЕ (как
            # в DDL), и доливка чужого файла не вправе его перемешивать.
            first.columns.append(c)
            by_name[c.name] = c
            continue
        # Имя совпало — побеждает колонка первого файла, доливаем только пустое.
        # Поимённого замечания на каждую такую колонку нет: об этом уже сказано заметкой
        # о таблице, а построчно вышел бы шум на весь пакет.
        earlier.type = earlier.type or c.type
        earlier.description = earlier.description or c.description
        earlier.references = earlier.references or c.references
        earlier.pk = earlier.pk or c.pk
        earlier.required = earlier.required or c.required


def _warn_duplicate_tables(plan: DataPlan, merged: list[_Merged]) -> None:
    """Таблица описана НЕСКОЛЬКИМИ файлами пакета — план сливает её в одну строку.

    Механизм тот же, что у каналов (7bbf9cd): живое состояние читалось по файлу и не
    знало о таблицах, уже поставленных в план предыдущими файлами. Превью показывало
    ДВЕ строки «create» с разным числом колонок, а применение падало 500-й — второй
    файл лил одноимённую колонку в таблицу, только что созданную первым (уникальность
    uq_db_column_name; у свежесозданной таблицы коллекция columns после flush пуста).
    Дубль внутри пакета — норма (файлы собраны разными прогонами агента), поэтому
    сливаем и предупреждаем, а не падаем и не молчим.

    Порядок — как в пакете: он осмыслен, в отличие от произвольного порядка строк из БД.
    """
    dups = [m for m in merged if len(m.files) > 1 or m.meta_notes]
    for m in dups[:MAX_DUPLICATE_WARNINGS]:
        if len(m.files) > 1:
            plan.report.warnings.append(
                f"таблица «{m.table.name}» описана в нескольких файлах пакета "
                f'({", ".join(m.files)}): колонки сольются в одну таблицу, при совпадении '
                "имени колонки и расхождении меты побеждает первый файл"
            )
        plan.report.warnings.extend(m.meta_notes)
    if len(dups) > MAX_DUPLICATE_WARNINGS:
        plan.report.warnings.append(
            f"…ещё {len(dups) - MAX_DUPLICATE_WARNINGS} таблиц описаны в нескольких "
            "файлах пакета"
        )


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
