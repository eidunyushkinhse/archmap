"""Снимок версии документации объекта: сборка, канонический JSON, хэш, кодек.

ТЗ — docs/tasks/doc-versions.md §3. Снимок версии = снимок удаления без раскладки
плюс процессы с участием объекта: строки — схемами app/schemas/restore.py, выборка
документации поддерева — общая с ним (restore.collect_subtree_docs), поэтому новая
колонка модели или семья фактов попадает в версию вместе со снимком удаления. Оттуда
же — свои экземпляры размещения узлов среза; к ним снимок добавляет путь площадки
для показа (docs/tasks/deployment-view.md, Ф0б).

Детерминизм — условие всего механизма: «есть ли изменения с vN» отвечается
сравнением content_hash, и два снимка одного состояния обязаны совпасть байт-в-байт.
Поэтому списки отсортированы по str(id), JSON — с сортировкой ключей и без пробелов.

Полноту сторожит tests/test_versions_snapshot.py по реестрам VERSION_PLAN и
NOT_IN_VERSION ниже: новая модель проекта обязана попасть в один из них.
"""

import hashlib
import json
import uuid
import zlib
from collections.abc import Iterable, Mapping
from typing import Any, Protocol

from sqlalchemy import or_, select
from sqlalchemy.orm import Session, selectinload

from app import processes, tree
from app.database import Base
from app.models.broker_channel import BrokerChannel
from app.models.business_process import BusinessProcess
from app.models.channel_field import ChannelField
from app.models.config_param import ConfigParam
from app.models.db_column import DbColumn
from app.models.db_table import DbTable
from app.models.deployment_instance import DeploymentInstance
from app.models.deployment_site import DeploymentSite
from app.models.edge import Edge
from app.models.node import Node
from app.models.node_doc import NodeDoc
from app.models.node_version import NodeVersion
from app.models.personal_token import PersonalToken
from app.models.process_fragment import ProcessFragment, ProcessFragmentBranch
from app.models.process_message import ProcessMessage
from app.models.process_participant import ProcessParticipant
from app.models.project import Project
from app.models.project_member import ProjectMember
from app.models.user import User
from app.models.view_layout import ViewLayoutItem
from app.models.view_state import ViewState
from app.process_export import detail_to_mermaid
from app.restore import collect_subtree_docs
from app.schemas.process import ProcessDetail
from app.schemas.restore import (
    BrokerChannelSnapshot,
    ChannelFieldSnapshot,
    ConfigParamSnapshot,
    DbColumnSnapshot,
    DbTableSnapshot,
    DeploymentInstanceSnapshot,
    EdgeSnapshot,
    NodeDocSnapshot,
    NodeSnapshot,
)
from app.schemas.versions import (
    ProcessVersion,
    VersionEdge,
    VersionInstance,
    VersionSnapshot,
)
from app.versions_diff import semantic

# Формат снимка в колонке node_versions.snapshot_format. Меняется вместе с формой
# VersionSnapshot, если старый JSON ею больше не читается: decode различает строки по
# номеру, и накопленную историю не приходится переписывать миграцией данных.
SNAPSHOT_FORMAT = 1

# Уровень zlib: 6 — умолчание библиотеки, почти весь выигрыш по размеру за малую цену.
_ZLIB_LEVEL = 6

# Модель → схема строки в снимке версии. Те же пары, что у снимка удаления
# (restore.SNAPSHOT_PLAN), кроме раскладки: схемы одни на оба снимка. Связи и экземпляры
# размещения едут в снимке подклассами этих схем (VersionEdge, VersionInstance) — с
# путями для показа сверх полей строки.
VERSION_PLAN: dict[type[Base], type] = {
    Node: NodeSnapshot,
    Edge: EdgeSnapshot,
    NodeDoc: NodeDocSnapshot,
    DbTable: DbTableSnapshot,
    DbColumn: DbColumnSnapshot,
    BrokerChannel: BrokerChannelSnapshot,
    ChannelField: ChannelFieldSnapshot,
    ConfigParam: ConfigParamSnapshot,
    DeploymentInstance: DeploymentInstanceSnapshot,
}

_LAYOUT = "раскладка холста — не документация: версия несёт только семантику (ТЗ §2 п.7)"
_PROCESS = (
    "процесс едет в версию целиком через ProcessDetail (ProcessVersion.detail): его "
    "поля сторожит контракт процессов, а строки этой таблицы отдельно не снимаются"
)

# Модели проекта, которых снимок версии НЕ несёт строками, — с причиной словами.
NOT_IN_VERSION: dict[type[Base], str] = {
    ViewLayoutItem: _LAYOUT,
    ViewState: "fence конкурентных записей раскладки — счётчик, а не данные; " + _LAYOUT,
    Project: "строка проекта — контейнер истории, а не документация объекта",
    User: "пользователи глобальны; автор версии — created_by_id строки версии",
    ProjectMember: "участники проекта — доступ, а не документация объекта",
    PersonalToken: "личные токены принадлежат пользователю, а не документации",
    NodeVersion: "сама история версий: снимок версий внутри версии был бы рекурсией",
    BusinessProcess: _PROCESS,
    ProcessParticipant: _PROCESS,
    ProcessMessage: _PROCESS,
    ProcessFragment: _PROCESS,
    ProcessFragmentBranch: _PROCESS,
    DeploymentSite: (
        "площадка — общая сущность проекта, как процесс: в версию входит размещение "
        "объекта на ней (экземпляр с путём площадки для показа), а сама она — нет; её "
        "правка и удаление версией не откатываются"
    ),
}

# Что входит в content_hash, решает одна функция — versions_diff.semantic: по ней же
# сравнивает дельта, и «есть изменения с vN» не расходится с перечнем изменённого. Вне
# проекции — производное для показа: пути концов связей и площадок размещения, mermaid
# процесса, живые имена и свойства чужих узлов в detail процесса, CAS-счётчик шага.


class _HasId(Protocol):
    """Строка снимка или модель: у всех есть исходный id."""

    @property
    def id(self) -> uuid.UUID: ...


def _by_id[T: _HasId](rows: Iterable[T]) -> list[T]:
    """Строки снимка в порядке str(id): порядок выдачи БД не определён, а снимок
    обязан быть детерминированным."""
    return sorted(rows, key=lambda r: str(r.id))


def _path(all_nodes: dict[uuid.UUID, Node], node_id: uuid.UUID) -> str:
    """Путь узла именами от корня («Система / Сервис») для показа конца связи. Узел
    вне карты проекта (гонка с удалением) — пустой путь, а не 500."""
    return processes.node_path(all_nodes, node_id) if node_id in all_nodes else ""


def _site_path(sites: Mapping[uuid.UUID, tuple[str, uuid.UUID | None]], site_id: uuid.UUID) -> str:
    """Путь площадки именами от корневой («Облако / Кластер prod») по карте площадок
    проекта «id → (имя, родитель)». Подъём с seen: данные снимков и импорта бывают
    циклическими, и цикл даёт обрезанный путь, а не зависание. Площадки нет в карте
    (гонка с удалением) — пустой путь."""
    names: list[str] = []
    seen: set[uuid.UUID] = set()
    cur: uuid.UUID | None = site_id
    while cur is not None and cur in sites and cur not in seen:
        seen.add(cur)
        name, cur = sites[cur]
        names.append(name)
    return " / ".join(reversed(names))


def _version_instances(
    db: Session, project_id: uuid.UUID, rows: list[DeploymentInstanceSnapshot]
) -> list[VersionInstance]:
    """Свои экземпляры размещения узлов среза с путями площадок. Площадки проекта
    читаются одним запросом и только если размещать есть что."""
    if not rows:
        return []
    sites = {
        sid: (name, parent_id)
        for sid, name, parent_id in db.query(
            DeploymentSite.id, DeploymentSite.name, DeploymentSite.parent_id
        ).filter(DeploymentSite.project_id == project_id)
    }
    return _by_id(
        VersionInstance(**i.model_dump(), site_path=_site_path(sites, i.site_id)) for i in rows
    )


def _stable_detail(detail: ProcessDetail) -> ProcessDetail:
    """Порядок detail — как у build_process_detail (участники и шаги по order,
    фрагменты по from_order), но с id вторым ключом. Сортировка там устойчива и
    наследует порядок выдачи БД при равных order (например, вложенные фрагменты с
    общим началом), а снимку нужен порядок, не зависящий от выдачи."""
    detail.participants.sort(key=lambda p: (p.order, str(p.id)))
    detail.messages.sort(key=lambda m: (m.order, str(m.id)))
    detail.fragments.sort(key=lambda f: (f.from_order, str(f.id)))
    return detail


def _process_versions(
    db: Session,
    project_id: uuid.UUID,
    subtree: set[uuid.UUID] | None,
    all_nodes: dict[uuid.UUID, Node],
    loaded_edges: set[uuid.UUID],
) -> list[ProcessVersion]:
    """Процессы, где участник привязан к узлу поддерева (subtree — None: все процессы
    проекта). Участники, шаги и фрагменты — пачками на все процессы сразу, связи
    шагов — одним запросом: build_process_detail иначе ходил бы за каждой."""
    query = db.query(BusinessProcess).filter(BusinessProcess.project_id == project_id)
    if subtree is not None:
        query = query.filter(
            BusinessProcess.id.in_(
                select(ProcessParticipant.process_id).where(ProcessParticipant.node_id.in_(subtree))
            )
        )
    procs = query.options(
        selectinload(BusinessProcess.participants),
        selectinload(BusinessProcess.messages),
        selectinload(BusinessProcess.fragments),
    ).all()
    # Связи шагов, которых ещё нет в сессии: после этой выборки db.get в
    # build_process_detail берёт их из identity map, без запроса на связь. Список
    # держим до конца сборки: identity map хранит слабые ссылки, и выброшенный
    # результат сборщик мусора унёс бы раньше, чем до него дойдёт db.get.
    step_edges = {m.edge_id for p in procs for m in p.messages if m.edge_id is not None}
    missing = step_edges - loaded_edges
    held_edges = db.query(Edge).filter(Edge.id.in_(missing)).all() if missing else []

    out: list[ProcessVersion] = []
    for proc in _by_id(procs):
        detail = _stable_detail(processes.build_process_detail(db, proc, all_nodes))
        out.append(
            ProcessVersion(
                id=proc.id,
                name=proc.name,
                scope_node_id=proc.scope_node_id,
                detail=detail,
                mermaid=detail_to_mermaid(detail),
            )
        )
    del held_edges
    return out


def build_snapshot(
    db: Session, project_id: uuid.UUID, root_id: uuid.UUID | None
) -> VersionSnapshot:
    """Снимок документации объекта root_id с поддеревом; root_id — None: весь проект.

    Карта узлов проекта грузится одним запросом в любом случае — она нужна путям
    концов связей и сборке процессов, — поэтому поддерево считается по ней в памяти
    (tree.subtree_ids), без запроса на уровень дерева.
    """
    all_nodes = processes.load_nodes(db, project_id)
    if root_id is None:
        subtree = set(all_nodes)
    elif root_id not in all_nodes:
        # Чужой или несуществующий узел: без проверки выборка документации по его id
        # унесла бы в снимок данные другого проекта.
        raise ValueError("Объект не найден в проекте")
    else:
        subtree = tree.subtree_ids(all_nodes, root_id)

    edge_query = db.query(Edge)
    if root_id is None:
        edge_query = edge_query.filter(Edge.project_id == project_id)
    else:
        # Связи с хотя бы одним концом в поддереве — и внутренние, и наружу.
        edge_query = edge_query.filter(
            or_(Edge.source_id.in_(subtree), Edge.target_id.in_(subtree))
        )
    edges = edge_query.all()

    docs = collect_subtree_docs(db, subtree)
    return VersionSnapshot(
        root_id=root_id,
        nodes=_by_id(NodeSnapshot.model_validate(all_nodes[nid]) for nid in subtree),
        edges=_by_id(
            VersionEdge(
                **EdgeSnapshot.model_validate(e).model_dump(),
                source_path=_path(all_nodes, e.source_id),
                target_path=_path(all_nodes, e.target_id),
            )
            for e in edges
        ),
        node_docs=_by_id(docs.node_docs),
        db_tables=_by_id(docs.db_tables),
        db_columns=_by_id(docs.db_columns),
        broker_channels=_by_id(docs.broker_channels),
        channel_fields=_by_id(docs.channel_fields),
        config_params=_by_id(docs.config_params),
        instances=_version_instances(db, project_id, docs.instances),
        processes=_process_versions(
            db,
            project_id,
            None if root_id is None else subtree,
            all_nodes,
            {e.id for e in edges},
        ),
    )


def _dumps(data: Any) -> str:
    return json.dumps(data, sort_keys=True, ensure_ascii=False, separators=(",", ":"))


def canonical_json(snapshot: VersionSnapshot) -> str:
    """Канонический JSON снимка: ключи отсортированы, без пробелов, UTF-8 как есть —
    одно состояние даёт одну строку."""
    return _dumps(snapshot.model_dump(mode="json"))


def content_hash(snapshot: VersionSnapshot) -> str:
    """sha256 канонического JSON СЕМАНТИЧЕСКОЙ проекции снимка (versions_diff.semantic)."""
    return hashlib.sha256(_dumps(semantic(snapshot)).encode("utf-8")).hexdigest()


def encode(snapshot: VersionSnapshot) -> bytes:
    """Байты для node_versions.snapshot: zlib канонического JSON (формат SNAPSHOT_FORMAT)."""
    return zlib.compress(canonical_json(snapshot).encode("utf-8"), _ZLIB_LEVEL)


def decode(data: bytes, fmt: int) -> VersionSnapshot:
    """Снимок из node_versions.snapshot по номеру его формата."""
    if fmt != SNAPSHOT_FORMAT:
        raise ValueError(f"Неизвестный формат снимка версии: {fmt}")
    return VersionSnapshot.model_validate_json(zlib.decompress(data))


def stats(snapshot: VersionSnapshot) -> dict[str, int]:
    """Счётчики по категориям — для строки списка версий. Колонки и поля каналов не
    считаются отдельно: в строке списка они читаются через таблицы и каналы."""
    return {
        "nodes": len(snapshot.nodes),
        "edges": len(snapshot.edges),
        "docs": len(snapshot.node_docs),
        "tables": len(snapshot.db_tables),
        "channels": len(snapshot.broker_channels),
        "params": len(snapshot.config_params),
        "processes": len(snapshot.processes),
    }
