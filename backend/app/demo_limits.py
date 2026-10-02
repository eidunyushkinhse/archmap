"""Пределы проекта на демо-стенде: одна центральная проверка (docs/tasks/demo-mode.md).

Пишущих ручек десятки (узлы, связи, доки, факты, процессы, все импорты и apply,
синк, разведка, копия проекта), и проверка, размазанная по ним, забылась бы в
первой же новой. Поэтому проверка висит на сессии SQLAlchemy и видит любую запись:

1. before_flush: собирает проекты, которых касается запись (у строки есть
   project_id, или он находится через node_id / table_id / channel_id / process_id
   / fragment_id), и для каждого нового в транзакции проекта меряет «до» — состояние
   БД, ещё не тронутое этой транзакцией;
2. before_commit: доливает отложенное, меряет «после» и сравнивает с пределами.
   Превышение — исключение DemoLimitExceeded, глобальный обработчик в app/main.py
   отдаёт 409 с текстом по прототипу, а транзакция не коммитится (сессию запроса
   откатывает её закрытие).

Считается ИТОГ после записи: объекты, связи, схемы логики, процессы и объём
текста проекта (сумма байтов текстовых полей). Отказ — только если итог вышел за
предел И вырос за транзакцию: удаление и уменьшение проходят всегда, даже в
проекте, который уже сверх предела.

Вне демо-режима слушатели возвращаются сразу, поведение продукта не меняется.
Превью импорта зовут measure / find_excess напрямую (dry_run_excess): так
превышение видно до кнопки «Создать».
"""

import uuid
from collections.abc import Callable, Iterable
from dataclasses import dataclass
from typing import Any, Literal

from fastapi import HTTPException, status
from sqlalchemy import Integer, event, func, inspect, select
from sqlalchemy.engine import Connection
from sqlalchemy.ext.compiler import compiles
from sqlalchemy.orm import Session, SessionTransaction
from sqlalchemy.orm.base import NO_VALUE
from sqlalchemy.sql.compiler import SQLCompiler
from sqlalchemy.sql.elements import ColumnElement
from sqlalchemy.sql.functions import FunctionElement

from app import demo
from app.config import settings
from app.models.broker_channel import BrokerChannel
from app.models.business_process import BusinessProcess
from app.models.channel_field import ChannelField
from app.models.config_param import ConfigParam
from app.models.db_column import DbColumn
from app.models.db_table import DbTable
from app.models.edge import Edge
from app.models.node import Node
from app.models.node_doc import NodeDoc
from app.models.process_fragment import ProcessFragment, ProcessFragmentBranch
from app.models.process_message import ProcessMessage
from app.models.process_participant import ProcessParticipant
from app.models.project import Project
from app.schemas.demo import DemoExcess

LimitKind = Literal["nodes", "edges", "docs", "processes", "text"]

# Признак отказа по пределу в теле 409: фронт отличает его от конфликта версий.
DEMO_LIMIT_CODE = "demo_limit"


# ── Размер проекта ──────────────────────────────────────────────────────────


class _TextBytes(FunctionElement[int]):
    """Длина текста в байтах UTF-8. Postgres — octet_length; SQLite тестов —
    длина BLOB-приведения (octet_length там есть не во всех сборках)."""

    type = Integer()
    inherit_cache = True


@compiles(_TextBytes)
def _text_bytes_default(element: _TextBytes, compiler: SQLCompiler, **kw: Any) -> str:
    return f"octet_length({compiler.process(element.clauses, **kw)})"


@compiles(_TextBytes, "sqlite")
def _text_bytes_sqlite(element: _TextBytes, compiler: SQLCompiler, **kw: Any) -> str:
    return f"length(CAST({compiler.process(element.clauses, **kw)} AS BLOB))"


def _bytes_of(*columns: Any) -> ColumnElement[int]:
    """Сумма байтов нескольких текстовых полей строки (NULL — ноль)."""
    total: ColumnElement[int] = func.coalesce(_TextBytes(columns[0]), 0)
    for col in columns[1:]:
        total = total + func.coalesce(_TextBytes(col), 0)
    return total


def _sum(expr: ColumnElement[int]) -> ColumnElement[int]:
    return func.coalesce(func.sum(expr), 0)


@dataclass(frozen=True)
class ProjectSize:
    """Что проверяют пределы: число объектов, связей, схем логики, процессов и
    объём текста проекта в байтах."""

    nodes: int = 0
    edges: int = 0
    docs: int = 0
    processes: int = 0
    text_bytes: int = 0


def measure(conn: Connection | Session, project_id: uuid.UUID) -> ProjectSize:
    """Размер проекта одним SQL-запросом (скалярные подзапросы по таблицам)."""
    pid = project_id
    in_project = Node.project_id == pid

    def count(stmt: Any) -> Any:
        return stmt.scalar_subquery()

    nodes = count(select(func.count()).select_from(Node).where(in_project))
    edges = count(select(func.count()).select_from(Edge).where(Edge.project_id == pid))
    docs = count(
        select(func.count()).select_from(NodeDoc).join(Node, Node.id == NodeDoc.node_id)
        .where(in_project)
    )
    processes = count(
        select(func.count()).select_from(BusinessProcess)
        .where(BusinessProcess.project_id == pid)
    )
    # Объём текста: описания, спеки, схемы логики, конфигурация, таблицы, каналы и
    # процессы. Каждая таблица — свой подзапрос, итог — их сумма.
    text_parts = [
        select(_sum(_bytes_of(Project.description))).where(Project.id == pid),
        select(
            _sum(_bytes_of(Node.name, Node.description, Node.role, Node.technology,
                           Node.openapi_spec))
        ).where(in_project),
        select(_sum(_bytes_of(Edge.label, Edge.technology, Edge.channel)))
        .where(Edge.project_id == pid),
        select(_sum(_bytes_of(NodeDoc.name, NodeDoc.operation, NodeDoc.content)))
        .join(Node, Node.id == NodeDoc.node_id).where(in_project),
        select(
            _sum(_bytes_of(ConfigParam.name, ConfigParam.description, ConfigParam.value_type,
                           ConfigParam.default_value))
        ).join(Node, Node.id == ConfigParam.node_id).where(in_project),
        select(_sum(_bytes_of(DbTable.name, DbTable.schema_name, DbTable.description)))
        .join(Node, Node.id == DbTable.node_id).where(in_project),
        select(_sum(_bytes_of(DbColumn.name, DbColumn.type, DbColumn.description)))
        .join(DbTable, DbTable.id == DbColumn.table_id)
        .join(Node, Node.id == DbTable.node_id).where(in_project),
        select(
            _sum(_bytes_of(BrokerChannel.name, BrokerChannel.group_name, BrokerChannel.kind,
                           BrokerChannel.partition_key, BrokerChannel.delivery,
                           BrokerChannel.retention, BrokerChannel.description))
        ).join(Node, Node.id == BrokerChannel.node_id).where(in_project),
        select(_sum(_bytes_of(ChannelField.name, ChannelField.type, ChannelField.description)))
        .join(BrokerChannel, BrokerChannel.id == ChannelField.channel_id)
        .join(Node, Node.id == BrokerChannel.node_id).where(in_project),
        select(_sum(_bytes_of(BusinessProcess.name))).where(BusinessProcess.project_id == pid),
        select(_sum(_bytes_of(ProcessParticipant.name)))
        .join(BusinessProcess, BusinessProcess.id == ProcessParticipant.process_id)
        .where(BusinessProcess.project_id == pid),
        select(_sum(_bytes_of(ProcessMessage.caption)))
        .join(BusinessProcess, BusinessProcess.id == ProcessMessage.process_id)
        .where(BusinessProcess.project_id == pid),
        select(_sum(_bytes_of(ProcessFragment.guard)))
        .join(BusinessProcess, BusinessProcess.id == ProcessFragment.process_id)
        .where(BusinessProcess.project_id == pid),
        select(_sum(_bytes_of(ProcessFragmentBranch.guard)))
        .join(ProcessFragment, ProcessFragment.id == ProcessFragmentBranch.fragment_id)
        .join(BusinessProcess, BusinessProcess.id == ProcessFragment.process_id)
        .where(BusinessProcess.project_id == pid),
    ]
    text = sum((count(part) for part in text_parts[1:]), count(text_parts[0]))
    row = conn.execute(select(nodes, edges, docs, processes, text)).one()
    return ProjectSize(
        nodes=int(row[0] or 0),
        edges=int(row[1] or 0),
        docs=int(row[2] or 0),
        processes=int(row[3] or 0),
        text_bytes=int(row[4] or 0),
    )


# ── Превышение ──────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class Excess:
    """Какой предел превышен: что, сколько вышло и сколько можно."""

    kind: LimitKind
    actual: int
    limit: int

    @property
    def detail(self) -> str:
        """Текст отказа по прототипу (жирное начало добавляет фронт)."""
        if self.kind == "text":
            kb = self.limit // 1024
            return (
                f"Текста в проекте стало больше {kb} КБ, это предел демо. "
                "Сократите схему или удалите ненужные."
            )
        what = {
            "nodes": "объектов",
            "edges": "связей",
            "docs": "схем логики",
            "processes": "процессов",
        }[self.kind]
        return (
            f"Демо-проект поддерживает до {self.limit} {what}. "
            "Удалите ненужные, чтобы добавить новые."
        )


def limits() -> dict[LimitKind, int]:
    """Пределы проекта. Читаются при каждом вызове: тесты подменяют константы."""
    return {
        "nodes": demo.MAX_NODES,
        "edges": demo.MAX_EDGES,
        "docs": demo.MAX_DOCS,
        "processes": demo.MAX_PROCESSES,
        "text": demo.MAX_TEXT_BYTES,
    }


def _value(size: ProjectSize, kind: LimitKind) -> int:
    return size.text_bytes if kind == "text" else int(getattr(size, kind))


def find_excess(after: ProjectSize, before: ProjectSize | None = None) -> Excess | None:
    """Первое превышение: итог вышел за предел И вырос относительно «до». Без «до»
    (новый проект) рост — любое ненулевое значение."""
    base = before or ProjectSize()
    for kind, limit in limits().items():
        value = _value(after, kind)
        if value > limit and value > _value(base, kind):
            return Excess(kind=kind, actual=value, limit=limit)
    return None


class DemoLimitExceeded(Exception):
    """Запись вывела проект за предел демо-стенда. Глобальный обработчик → 409."""

    def __init__(self, excess: Excess) -> None:
        super().__init__(excess.detail)
        self.excess = excess

    @property
    def detail(self) -> str:
        return self.excess.detail


# ── Слушатели сессии ────────────────────────────────────────────────────────

_BASE = "demo_limits_base"  # project_id → размер «до» транзакции
_LATE = "demo_limits_late"  # строки, чей проект найдётся только после flush

# Родитель строки: класс родителя, его FK-колонка вверх и имя связи у ребёнка.
_UP: dict[type, tuple[type, str, str]] = {
    NodeDoc: (Node, "node_id", "node"),
    ConfigParam: (Node, "node_id", "node"),
    DbTable: (Node, "node_id", "node"),
    BrokerChannel: (Node, "node_id", "node"),
    DbColumn: (DbTable, "table_id", "table"),
    ChannelField: (BrokerChannel, "channel_id", "channel"),
    ProcessParticipant: (BusinessProcess, "process_id", "process"),
    ProcessMessage: (BusinessProcess, "process_id", "process"),
    ProcessFragment: (BusinessProcess, "process_id", "process"),
    ProcessFragmentBranch: (ProcessFragment, "fragment_id", "fragment"),
}
_HAS_PROJECT: tuple[type, ...] = (Node, Edge, BusinessProcess)


def _loaded(obj: object, name: str) -> object | None:
    """Значение связи, если оно уже в памяти (ленивую загрузку не провоцируем)."""
    state = inspect(obj, raiseerr=False)
    if state is None:
        return None
    value = state.attrs[name].loaded_value
    return None if value is NO_VALUE else value


class _Resolver:
    """Находит проект строки: по project_id, по связи в памяти, по ожидающим
    вставки строкам сессии или запросом к БД (с кэшем на транзакцию)."""

    def __init__(self, session: Session) -> None:
        self.session = session
        self.pending = {
            (type(o), o.id): o for o in session.new if getattr(o, "id", None) is not None
        }
        self.cache: dict[tuple[type, uuid.UUID], uuid.UUID | None] = session.info.setdefault(
            "demo_limits_parents", {}
        )

    def project_of(self, obj: object) -> uuid.UUID | None:
        if isinstance(obj, Project):
            return obj.id
        if isinstance(obj, (Node, Edge, BusinessProcess)):
            pid: uuid.UUID | None = obj.project_id
            if pid is not None:
                return pid
            project = _loaded(obj, "project")
            return project.id if isinstance(project, Project) else None
        up = _UP.get(type(obj))
        if up is None:
            return None
        parent_cls, fk, rel = up
        parent = _loaded(obj, rel)
        if parent is not None:
            return self.project_of(parent)
        parent_id = getattr(obj, fk)
        return None if parent_id is None else self._by_id(parent_cls, parent_id)

    def _by_id(self, cls: type, ident: uuid.UUID) -> uuid.UUID | None:
        key = (cls, ident)
        if key in self.cache:
            return self.cache[key]
        obj = self.pending.get(key)
        if obj is not None:
            pid = self.project_of(obj)
        elif cls is Node or cls is BusinessProcess:
            pid = self._scalar(select(cls.project_id).where(cls.id == ident))  # type: ignore[attr-defined]
        else:
            parent_cls, fk, _rel = _UP[cls]
            parent_id = self._scalar(
                select(getattr(cls, fk)).where(cls.id == ident)  # type: ignore[attr-defined]
            )
            pid = None if parent_id is None else self._by_id(parent_cls, parent_id)
        # Ненайденное не кэшируем: после flush цепочка ожидающих строк обретёт id.
        if pid is not None:
            self.cache[key] = pid
        return pid

    def _scalar(self, stmt: Any) -> uuid.UUID | None:
        value = self.session.connection().execute(stmt).scalar()
        return value if isinstance(value, uuid.UUID) or value is None else uuid.UUID(str(value))


def _tracked(objs: Iterable[object]) -> Iterable[object]:
    """Строки, влияющие на размер проекта. Удаление проекта целиком не меряем:
    после него проекта нет, а его схему уносит БД-каскад."""
    for obj in objs:
        if isinstance(obj, Project) or isinstance(obj, _HAS_PROJECT) or type(obj) in _UP:
            yield obj


def _before_flush(session: Session, _ctx: object, _instances: object) -> None:
    if not settings.demo_mode:
        return
    base: dict[uuid.UUID, ProjectSize] = session.info.setdefault(_BASE, {})
    late: list[object] = session.info.setdefault(_LATE, [])
    resolver = _Resolver(session)
    deleted_projects = {o.id for o in session.deleted if isinstance(o, Project)}
    for obj in _tracked([*session.new, *session.dirty, *session.deleted]):
        if isinstance(obj, Project) and obj.id in deleted_projects:
            continue
        pid = resolver.project_of(obj)
        if pid is None:
            # Цепочка упирается в новый проект без id: найдём после flush.
            late.append(obj)
        elif pid not in base:
            # БД ещё не видела записей транзакции в этот проект: это и есть «до».
            base[pid] = measure(session.connection(), pid)


def _after_flush(session: Session, _ctx: object) -> None:
    late: list[object] = session.info.pop(_LATE, [])
    if not late or not settings.demo_mode:
        return
    base: dict[uuid.UUID, ProjectSize] = session.info.setdefault(_BASE, {})
    resolver = _Resolver(session)
    for obj in late:
        pid = resolver.project_of(obj)
        if pid is not None:
            # Не нашёлся до flush — значит проект родился в этой же транзакции: «до» пусто.
            base.setdefault(pid, ProjectSize())


def check_session(session: Session) -> None:
    """Проверить итог транзакции по всем затронутым проектам (зовётся перед коммитом)."""
    base: dict[uuid.UUID, ProjectSize] = session.info.get(_BASE) or {}
    for pid, before in list(base.items()):
        excess = find_excess(measure(session.connection(), pid), before)
        if excess is not None:
            raise DemoLimitExceeded(excess)


def _before_commit(session: Session) -> None:
    # Коммит SAVEPOINT — не итог: проверяем только внешнюю транзакцию.
    if not settings.demo_mode or session.in_nested_transaction():
        return
    session.flush()
    check_session(session)


def _after_transaction_end(session: Session, transaction: SessionTransaction) -> None:
    if transaction.parent is None:
        for key in (_BASE, _LATE, "demo_limits_parents"):
            session.info.pop(key, None)


_LISTENERS: tuple[tuple[str, Callable[..., None]], ...] = (
    ("before_flush", _before_flush),
    ("after_flush", _after_flush),
    ("before_commit", _before_commit),
    ("after_transaction_end", _after_transaction_end),
)


def install() -> None:
    """Повесить слушатели на все сессии (идемпотентно). Вне демо-режима они
    возвращаются сразу."""
    for name, fn in _LISTENERS:
        if not event.contains(Session, name, fn):
            event.listen(Session, name, fn)


install()


# ── Превью импорта и размер файла ───────────────────────────────────────────


def dry_run_excess(
    db: Session, project_id: uuid.UUID | None, apply: Callable[[], uuid.UUID | None]
) -> Excess | None:
    """Превышение, которое дало бы применение импорта, — без записи в БД.

    apply() честно применяет план в текущей транзакции и возвращает id проекта
    (для нового проекта — его же). Затем размер меряется и транзакция откатывается
    целиком: превью ничего не пишет. Ошибка применения — не превышение (её покажет
    само превью или применение). Вне демо-режима — None без применения."""
    if not settings.demo_mode:
        return None
    before = measure(db, project_id) if project_id is not None else ProjectSize()
    try:
        pid = apply()
        db.flush()
        after = measure(db, pid) if pid is not None else None
    except Exception:
        # Сбой пробного применения не ломает превью: причину покажет само превью
        # или честное применение.
        after = None
    finally:
        db.rollback()
    return find_excess(after, before) if after is not None else None


def excess_out(excess: Excess | None) -> DemoExcess | None:
    """Превышение в контракт превью."""
    if excess is None:
        return None
    return DemoExcess(kind=excess.kind, actual=excess.actual, limit=excess.limit)


def _human_size(size: int) -> str:
    """Размер по-русски: «251 КБ», «1,4 МБ» (КБ округляются вверх, чтобы предел
    250 КБ не превращался в «весит 250 КБ»)."""
    if size >= 1024 * 1024:
        return f"{size / (1024 * 1024):.1f}".replace(".", ",") + " МБ"
    return f"{-(-size // 1024)} КБ"


def file_too_large_detail(name: str, size: int) -> str:
    """Текст отказа по размеру файла (экран 3 прототипа)."""
    return (
        f"Файл слишком большой для демо. «{name}» весит {_human_size(size)}, "
        f"а в демо можно загрузить до {demo.MAX_FILE_BYTES // 1024} КБ."
    )


def check_files(files: Iterable[tuple[str, int]]) -> None:
    """413, если хоть один загружаемый файл больше предела демо-стенда. Фронт
    проверяет то же до отправки; это страховка бэка. Вне демо-режима — ничего."""
    if not settings.demo_mode:
        return
    for name, size in files:
        if size > demo.MAX_FILE_BYTES:
            raise HTTPException(
                status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
                detail=file_too_large_detail(name, size),
            )


def check_texts(texts: Iterable[tuple[str, str]]) -> None:
    """То же для файлов, приехавших текстом в JSON: размер — байты UTF-8."""
    check_files((name, len(text.encode("utf-8"))) for name, text in texts)
