"""Декларация копирования проекта: что переносится, что у копии своё, что пересчитывается.

Копия проекта трижды отставала от модели (2026-07-09 — `status` узла; затем
`channel` связи и `source_ref` узла; структура БД и каналы брокеров не копировались
вовсе) ровно по одной причине: перечень копируемых полей был РУЧНЫМ СПИСКОМ
ВКЛЮЧЕНИЙ. Новое поле молча не попадало в копию, и узнавал об этом пользователь.

Здесь список перевёрнут:
  • по умолчанию копируется ВСЁ, что есть в модели, — новое поле едет в копию само;
  • не копируется только объявленное: `own` (у копии обязано быть своим) и `mapped`
    (значение пересчитывает копировщик — ссылки через карты новых id, ключ раскладки);
  • полноту декларации сторожит tests/test_copy_plan.py: новая колонка модели или
    новая модель, не попавшая ни в один список, роняет гейт.

Итог: о новом поле разработчик узнаёт от гейта, а пользователь не узнаёт вовсе —
даже если декларацию забыли обновить, поле уже в копии (дефолт — копировать).
"""

from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any, TypeVar

from sqlalchemy import inspect as sa_inspect

from app.database import Base
from app.models.broker_channel import BrokerChannel
from app.models.business_process import BusinessProcess
from app.models.channel_field import ChannelField
from app.models.db_column import DbColumn
from app.models.db_table import DbTable
from app.models.edge import Edge
from app.models.node import Node
from app.models.node_doc import NodeDoc
from app.models.process_fragment import ProcessFragment, ProcessFragmentBranch
from app.models.process_message import ProcessMessage
from app.models.process_participant import ProcessParticipant
from app.models.project import Project
from app.models.user import User
from app.models.view_layout import ViewLayoutItem
from app.models.view_state import ViewState


@dataclass(frozen=True)
class TablePlan:
    """План копирования одной модели.

    own    — колонка, значение которой у копии СВОЁ: из источника не берётся никогда
             (приходит override-ом от копировщика или дефолтом модели). Причина —
             словами: исключение обязано быть осознанным, а не «исторически сложилось».
    mapped — колонка, значение которой копировщик ПЕРЕСЧИТЫВАЕТ (ссылка через карту
             новых id, ключ раскладки, отфильтрованный payload). Тоже приходит
             override-ом; текст говорит, чем именно.
    data   — колонки-данные: едут в копию как есть. Список нужен НЕ копировщику
             (тот копирует всё, что не own/mapped), а сторожу — это снимок, с
             которым тест сверяет набор колонок модели.
    """

    own: Mapping[str, str]
    mapped: Mapping[str, str]
    data: tuple[str, ...]


# Причины «своего у копии», повторяющиеся почти у каждой модели.
_ID = "новый id: копия — другая строка, а не та же самая"
_PROJECT = "копия принадлежит НОВОМУ проекту"
_VERSION = "счётчик CAS: у копии своя история правок, начинается с нуля"
_CREATED = "время создания копии — своё"
_UPDATED = "время правки копии — своё"
# Атрибут, которого в таблице нет: column_property считает его ВЫРАЖЕНИЕМ поверх
# копируемых колонок. Копировать нечего — у копии он посчитается сам; передать его
# в конструктор значило бы посадить на строку копии значение источника.
_DERIVED = "признак производный (column_property поверх тела схемы): в БД не хранится"

# Перемэппинг ссылок: все карты «старый id → новый» аллоцируются в copy_project_schema
# заранее, до вставки, — порядок обхода не важен.
_BY_NMAP = "ссылка на узел — через карту узлов nmap"

COPY_PLAN: dict[type[Base], TablePlan] = {
    Node: TablePlan(
        own={
            "id": _ID,
            "project_id": _PROJECT,
            "version": _VERSION,
            "created_at": _CREATED,
            "updated_at": _UPDATED,
        },
        mapped={"parent_id": _BY_NMAP},
        data=(
            "name",
            "description",
            "role",
            "technology",
            "openapi_spec",
            "is_external",
            "shape",
            "status",
            "source_ref",
        ),
    ),
    NodeDoc: TablePlan(
        own={
            "id": _ID,
            "version": _VERSION,
            "created_at": _CREATED,
            "updated_at": _UPDATED,
            "described": _DERIVED,
        },
        mapped={"node_id": _BY_NMAP},
        data=("name", "kind", "operation", "content"),
    ),
    DbTable: TablePlan(
        own={"id": _ID, "version": _VERSION, "created_at": _CREATED, "updated_at": _UPDATED},
        mapped={"node_id": _BY_NMAP},
        data=("name", "schema_name", "description"),
    ),
    DbColumn: TablePlan(
        own={"id": _ID},
        mapped={
            "table_id": "ссылка на таблицу — через карту таблиц",
            "references_column_id": (
                "внешний ключ КАРТЫ — через карту колонок вторым проходом: цель может "
                "лежать в другой таблице и даже у другого узла, без перемэппинга копия "
                "смотрела бы в исходный проект"
            ),
        },
        data=("name", "type", "nullable", "is_primary_key", "description", "order"),
    ),
    BrokerChannel: TablePlan(
        own={"id": _ID, "version": _VERSION, "created_at": _CREATED, "updated_at": _UPDATED},
        mapped={"node_id": _BY_NMAP},
        # ИМЯ канала копируется как есть и переименованию не подлежит: связь ссылается
        # на канал ПО ИМЕНИ (Edge.channel — мягкая ссылка, не FK), и любая правка имени
        # порвала бы шов «стрелка → канал» в копии.
        data=(
            "name",
            "group_name",
            "kind",
            "partition_key",
            "delivery",
            "retention",
            "description",
        ),
    ),
    ChannelField: TablePlan(
        own={"id": _ID},
        mapped={"channel_id": "ссылка на канал — через карту каналов"},
        data=("name", "type", "required", "description", "order"),
    ),
    Edge: TablePlan(
        own={"id": _ID, "project_id": _PROJECT, "version": _VERSION, "created_at": _CREATED},
        mapped={"source_id": _BY_NMAP, "target_id": _BY_NMAP},
        # channel — ИМЯ канала брокера (мягкая ссылка): едет как есть, каналы копии
        # носят те же имена, поэтому резолв на чтении (AL29–AL31) продолжает сходиться.
        data=("label", "technology", "channel", "is_synchronous"),
    ),
    BusinessProcess: TablePlan(
        own={"id": _ID, "project_id": _PROJECT, "created_at": _CREATED, "updated_at": _UPDATED},
        mapped={"scope_node_id": _BY_NMAP},
        data=("name",),
    ),
    ProcessParticipant: TablePlan(
        own={"id": _ID},
        mapped={
            "process_id": "ссылка на процесс — через карту процессов",
            # У непривязанного участника узла нет — ремапить нечего, едет NULL: такой
            # участник законен (импорт процесса, удалённый узел) и обязан пережить копию.
            "node_id": _BY_NMAP,
        },
        data=("name", "order"),
    ),
    ProcessMessage: TablePlan(
        own={"id": _ID},
        mapped={
            "process_id": "ссылка на процесс — через карту процессов",
            # Повисший шаг (edge_id = NULL) переносится повисшим: расхождение со схемой
            # должно быть видно в копии так же, как в источнике.
            "edge_id": "ссылка на связь — через карту связей",
            "from_participant_id": "ссылка на участника — через карту участников",
            "to_participant_id": "ссылка на участника — через карту участников",
        },
        data=("order", "leg", "caption"),
    ),
    ProcessFragment: TablePlan(
        own={"id": _ID},
        mapped={"process_id": "ссылка на процесс — через карту процессов"},
        data=("kind", "from_order", "to_order", "guard"),
    ),
    ProcessFragmentBranch: TablePlan(
        own={"id": _ID},
        mapped={"fragment_id": "ссылка на фрагмент — через карту фрагментов"},
        data=("start_order", "guard"),
    ),
    ViewLayoutItem: TablePlan(
        own={"id": _ID, "project_id": _PROJECT},
        mapped={
            "view_id": _BY_NMAP,
            "item_id": "строковый ключ несёт uuid узлов — перемэппивается по nmap",
            "payload": "фильтруется до живых ключей (x/y/expanded): легаси-геометрия "
            "пучков в копию не едет",
        },
        data=(),
    ),
}

# Модели, которые копия проекта НЕ переносит намеренно. Реестр нужен сторожу: новая
# доменная модель, забытая в копировании (так случилось со структурой БД и каналами
# брокеров), обязана споткнуться о гейт, а не о пользователя.
NOT_COPIED: dict[type[Base], str] = {
    Project: "сам проект копия не копирует: строку создаёт роутер (имя, описание и "
    "автор у копии свои)",
    User: "пользователи глобальны и проекту не принадлежат",
    ViewState: "fence конкурентных записей раскладки: счётчик версий вида у копии "
    "свой и начинается с нуля",
}


TRow = TypeVar("TRow", bound=Base)


def copy_row(row: TRow, **overrides: Any) -> TRow:
    """Строка-копия: ВСЕ колонки-данные модели как есть, поверх — overrides.

    Дефолт — копировать: колонка, о которой в плане ничего не сказано, попадает в
    копию. Пропускаются только own/mapped — их значения обязан передать вызывающий
    (или оставить дефолту модели). Override на колонку, не объявленную ни в own, ни в
    mapped, — ошибка программиста: значит план разошёлся с копировщиком, и молчать об
    этом нельзя (ровно так исключения и переставали быть осознанными).
    """
    model = type(row)
    plan = COPY_PLAN.get(model)
    if plan is None:
        raise ValueError(
            f"{model.__name__} не объявлена в COPY_PLAN: решите, копируется она или нет"
        )
    values: dict[str, Any] = {}
    for attr in sa_inspect(model).column_attrs:
        if attr.key in plan.own or attr.key in plan.mapped:
            continue  # значение у копии своё либо пересчитанное — придёт override-ом
        values[attr.key] = getattr(row, attr.key)
    for key in overrides:
        if key not in plan.own and key not in plan.mapped:
            raise ValueError(
                f"{model.__name__}.{key} подменяется при копировании, но в COPY_PLAN "
                f"не объявлена ни как own, ни как mapped"
            )
    values.update(overrides)
    return model(**values)
