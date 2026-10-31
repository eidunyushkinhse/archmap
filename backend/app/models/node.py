import uuid
from collections.abc import Sequence
from datetime import UTC, datetime
from typing import TYPE_CHECKING

from sqlalchemy import Boolean, DateTime, ForeignKey, Index, Integer, String, Text, Uuid
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.database import Base
from app.domain_types import (
    NodeApproval,
    NodeElement,
    NodeElementEffective,
    NodeShape,
    NodeStatus,
)
from app.identity import source_ref_dict

if TYPE_CHECKING:
    # Только для типов/линтера: связь Node ↔ Edge SQLAlchemy резолвит по строке
    # через свой реестр в рантайме, поэтому здесь импорт не нужен (и создал бы цикл).
    from app.models.broker_channel import BrokerChannel
    from app.models.config_param import ConfigParam
    from app.models.db_table import DbTable
    from app.models.edge import Edge
    from app.models.node_doc import NodeDoc
    from app.models.project import Project
    from app.schemas.node import NodeSiteOut


class Node(Base):
    __tablename__ = "nodes"
    # Матчинг синка всегда скоупится проектом («узлы ЭТОГО проекта с такими
    # якорями»), поэтому индекс составной, а не по одному source_ref.
    __table_args__ = (Index("ix_nodes_project_source", "project_id", "source_ref"),)

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    # Проект-владелец: вся доменная модель скоупится им (NOT NULL, каскад при удалении).
    project_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("projects.id", ondelete="CASCADE"), nullable=False, index=True
    )
    name: Mapped[str] = mapped_column(String(256), nullable=False)
    description: Mapped[str | None] = mapped_column(Text, nullable=True)
    role: Mapped[str | None] = mapped_column(String(128), nullable=True)
    technology: Mapped[str | None] = mapped_column(String(128), nullable=True)
    parent_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("nodes.id", ondelete="CASCADE"), nullable=True, index=True
    )
    # Логика узла живёт в коллекции именованных схем node_docs (relationship docs
    # ниже); прежнее единственное поле flowchart перенесено туда миграцией.
    openapi_spec: Mapped[str | None] = mapped_column(Text, nullable=True)
    # ПОЗИЦИЙ здесь больше нет (R3): координаты пер-вид, хранятся в view_layout
    # (item_id = id узла, вид = родитель).
    is_external: Mapped[bool] = mapped_column(Boolean, default=False, server_default="false")
    # вариант отображения: service | database | broker | person (C4-формы)
    shape: Mapped[NodeShape] = mapped_column(String(32), default="service", server_default="service")
    # статус жизненного цикла: existing (as-is, дефолт) | planned (to-be) | deprecated.
    # Версионируемая семантика, не раскладка. Кодируется на схеме цветом тела узла.
    status: Mapped[NodeStatus] = mapped_column(String(16), default="existing", server_default="existing")
    # Статус СТРАНИЦЫ объекта (docs/tasks/page-status.md) — не жизненный цикл выше:
    # in_progress («в работе», дефолт у всех новых) | approved («согласовано»). Ставит
    # человек — редактор проекта из пилюли страницы (агент по MCP — только по его
    # просьбе); правка документации его НЕ сбрасывает. У системы хранимое значение не
    # показывается: статус складывается из вложенных объектов (approval_effective ниже),
    # а PATCH отказывает 422; контейнер (и с компонентами) и компонент показывают своё
    # (Р14 эпика элементов). Система, оставшаяся без детей, снова контейнер — и снова
    # показывает это хранимое значение.
    approval: Mapped[NodeApproval] = mapped_column(
        String(16), default="in_progress", server_default="in_progress"
    )
    # Элемент архитектуры (docs/plan-c4-elements.md, Р1–Р7): system | container | NULL.
    # NULL — «не сказано», читается как сегодня (узел с детьми — система), поэтому без
    # server_default: мердж, синк и догрузка отличают молчание от явной «системы».
    # Задаётся только у формы service, у листа хранится как намерение (Р3) и срабатывает
    # с первым ребёнком; внутри контейнера не задаётся — там всё компоненты (Р5).
    # Действующий элемент хранимым не является — его считает app/element.py
    # (element_effective ниже).
    element: Mapped[NodeElement | None] = mapped_column(String(16), nullable=True)
    # Канонический ключ источника — ЯКОРЬ узла (app/identity): чем узел опознаётся
    # между прогонами ИИ-агента. Видов два: код («git:github.com/org/payments#src/api»)
    # и имя зависимости («host:postgres»). Пишется импортом и синком И РУКАМИ —
    # PATCH /nodes/{id} с блоком source задаёт и чистит якорь (Ф0 эпика
    # docs/plan-anchor-ux.md: якорь — первоклассная сущность, видимая и управляемая).
    # УНИКАЛЬНОСТИ НЕТ намеренно — монорепо легально даёт один repo многим узлам.
    source_ref: Mapped[str | None] = mapped_column(String(512), nullable=True)
    # Версия для optimistic CAS (этап 0 конкурентности, docs/archive/plan-concurrency.md):
    # PATCH с base_version ≠ текущей → 409 — правка от устаревшего состояния не
    # затирает чужую (критично для текстов flowchart/openapi_spec). Инкремент —
    # в update_node при каждой успешной правке.
    version: Mapped[int] = mapped_column(
        Integer, nullable=False, default=1, server_default="1"
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(UTC)
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        default=lambda: datetime.now(UTC),
        onupdate=lambda: datetime.now(UTC),
    )

    project: Mapped["Project"] = relationship("Project", back_populates="nodes")
    parent: Mapped["Node | None"] = relationship(
        "Node", remote_side="Node.id", back_populates="children"
    )
    # passive_deletes=True: при удалении узла НЕ грузим/не правим связанные строки в
    # Python — доверяем БД-каскаду (ondelete="CASCADE" на FK ниже). Это и снимает повод
    # для прежнего bulk-костыля в delete_node: раньше ORM пытался занулить target_id
    # входящих рёбер потомков (incoming_edges без каскада, NOT NULL) → IntegrityError.
    children: Mapped[list["Node"]] = relationship(
        "Node", back_populates="parent", cascade="all, delete-orphan", passive_deletes=True
    )
    outgoing_edges: Mapped[list["Edge"]] = relationship(
        "Edge",
        foreign_keys="[Edge.source_id]",
        back_populates="source",
        cascade="all, delete-orphan",
        passive_deletes=True,
    )
    incoming_edges: Mapped[list["Edge"]] = relationship(
        "Edge",
        foreign_keys="[Edge.target_id]",
        back_populates="target",
        # без cascade на уровне ORM: рёбра «принадлежат» источнику (outgoing_edges).
        # Удаление узла-цели сносит входящие рёбра БД-каскадом (target_id ondelete CASCADE).
        passive_deletes=True,
    )
    # Именованные схемы логики (mermaid). lazy="selectin": мета доков едет в каждой
    # graph-выдаче (NodeResponse.docs) — selectin грузит их одним запросом на выборку
    # узлов, без N+1. Удаление узла сносит доки БД-каскадом (passive_deletes).
    docs: Mapped[list["NodeDoc"]] = relationship(
        "NodeDoc",
        back_populates="node",
        cascade="all, delete-orphan",
        passive_deletes=True,
        lazy="selectin",
        order_by="NodeDoc.name",
    )
    # Структура БД (таблицы) — «контракт» узла-базы, как openapi_spec у сервиса.
    # Ленивая загрузка обычная: страница объекта берёт таблицы отдельным запросом,
    # а графу уровня они не нужны — selectin здесь только раздувал бы каждый ответ.
    db_tables: Mapped[list["DbTable"]] = relationship(
        "DbTable",
        back_populates="node",
        cascade="all, delete-orphan",
        passive_deletes=True,
        order_by="DbTable.schema_name, DbTable.name",
    )
    # Структура брокера (каналы) — тот же «контракт» узла, что таблицы у базы.
    # Ленивость обычная по той же причине: каналы читает страница объекта, графу
    # уровня они не нужны.
    broker_channels: Mapped[list["BrokerChannel"]] = relationship(
        "BrokerChannel",
        back_populates="node",
        cascade="all, delete-orphan",
        passive_deletes=True,
        order_by="BrokerChannel.group_name, BrokerChannel.name",
    )
    # Конфигурация сервиса (переменные окружения, флаги). Владелец — сам сервис, а не
    # отдельный узел-хранилище (docs/plan-config-docs.md §2.1). Ленивость обычная, как
    # у двух семей выше: параметры читает страница объекта, графу уровня они не нужны.
    config_params: Mapped[list["ConfigParam"]] = relationship(
        "ConfigParam",
        back_populates="node",
        cascade="all, delete-orphan",
        passive_deletes=True,
        order_by="ConfigParam.name",
    )

    # Вычисляемые атрибуты отдачи (в БД НЕ хранятся — не колонки). Проставляются
    # на экземплярах в домене/роутерах (graph_queries, context_graph, routers.nodes)
    # перед сериализацией NodeResponse: схема с from_attributes читает их как
    # обычные атрибуты. Аннотация без Mapped — маппер SQLAlchemy их игнорирует
    # (проверено: в __table__/__mapper__ не попадают), дефолт совпадает со схемой.
    child_count: int = 0
    has_children: bool = False
    # Показываемый статус страницы (app/approval.effective_approvals): у системы —
    # approved, только если согласованы все вложенные объекты, кроме вложенных систем;
    # у остальных — своё approval.
    approval_effective: NodeApproval = "in_progress"
    # Действующий элемент архитектуры (app/element_marks): system | container | component,
    # у «Пользователя» None. Дефолт None, а не правдоподобное значение: выдача, забывшая
    # его проставить, отдаст пустоту, и сторож tests/test_element_api.py это поймает
    # (камень 2 плана) — молча неверный «контейнер» не поймал бы никто. Аннотация — только
    # для типизации: аннотированный атрибут со значением None декларатив SQLAlchemy принимает
    # за колонку без Mapped[] и роняет импорт модели, а без аннотации он его не трогает.
    if TYPE_CHECKING:
        element_effective: NodeElementEffective | None
    else:
        element_effective = None
    # Имя контейнера, частью которого узел является (только у компонента; app/element_marks
    # — тем же проходом, что element_effective): строка «Компонент контейнера «orders»» в
    # свойствах объекта. Аннотация — по той же причине, что выше.
    if TYPE_CHECKING:
        container_name: str | None
    else:
        container_name = None
    # Действующее размещение на площадках (app/deployment.mark_sites): у контейнера —
    # свои экземпляры, у системы — площадки её контейнеров, у остальных пусто. Дефолт — пустой
    # КОРТЕЖ, а не список: атрибут класса общий для всех экземпляров, и изменяемый
    # дефолт был бы одним списком на все узлы. mark_sites всегда присваивает свой
    # список; где он не зовётся (граф уровня, контекст-схема), NodeResponse получает [].
    sites: "Sequence[NodeSiteOut]" = ()

    @property
    def source(self) -> dict[str, str] | None:
        """Якорь узла В РАЗОБРАННОМ ВИДЕ — то, что отдаётся в NodeResponse.source.

        Хранится ОДИН канонический ключ, поэтому в словаре заполнена ровно одна
        сторона: repo (+path) — вид «код», host — вид «имя зависимости». Якоря
        нет — None: карточка объекта показывает «опознаётся по имени».
        Свойство, а не колонка: единственный источник правды — source_ref,
        а разбор ключа обязан жить в одном месте (app/identity)."""
        if not self.source_ref:
            return None
        return source_ref_dict(self.source_ref) or None
