import uuid
from datetime import UTC, datetime
from typing import TYPE_CHECKING

from sqlalchemy import (
    DateTime,
    ForeignKey,
    Integer,
    String,
    Text,
    UniqueConstraint,
    Uuid,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.database import Base

if TYPE_CHECKING:
    # Только для типов: связь резолвится реестром SQLAlchemy по строке в рантайме.
    from app.models.db_column import DbColumn
    from app.models.node import Node


class DbTable(Base):
    """Таблица базы данных — часть СТРУКТУРЫ узла-БД.

    Структура — «контракт» базы, ровно как openapi_spec — контракт сервиса: описывает
    то, что узел ПРЕДОСТАВЛЯЕТ. Кто этой таблицей пользуется, здесь не хранится —
    обращения живут у вызывающего, ПОМЕТКОЙ в тексте схемы его операции («читает:
    orders.status»): тот же принцип, по которому спека принадлежит поставщику, а не
    вызывающему. Разбор и резолв пометок — на чтении (app/data_refs.py), записей нет.

    Хранится ЗАПИСЯМИ, а не текстом mermaid (решение пользователя 2026-08-12):
    ER-диаграмма — производное представление, а из текста диаграммы нельзя построить
    обратный индекс «кто трогает orders.status», ради которого всё и затевалось.
    """

    __tablename__ = "db_tables"
    # schema_name NOT NULL с пустой строкой вместо NULL: в Postgres NULL-ы друг другу
    # не конфликтуют, и уникальность «одно имя на контур» просто не сработала бы.
    __table_args__ = (
        UniqueConstraint("node_id", "schema_name", "name", name="uq_db_table_name"),
    )

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    node_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("nodes.id", ondelete="CASCADE"), nullable=False, index=True
    )
    name: Mapped[str] = mapped_column(String(256), nullable=False)
    # СХЕМА БД (namespace: «public», «billing», …). Пусто = база без разделения на
    # схемы, обычный случай. Отдельной сущностью не заводим: группировка — это
    # представление, а не структура. В интерфейсе слово всегда с уточнением «БД»:
    # «схема» в ArchMap уже занята диаграммой.
    schema_name: Mapped[str] = mapped_column(
        String(128), nullable=False, default="", server_default=""
    )
    description: Mapped[str | None] = mapped_column(Text, nullable=True)
    # CAS — как у node_docs: правка от устаревшей версии не затирает чужую.
    version: Mapped[int] = mapped_column(Integer, nullable=False, default=1, server_default="1")
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(UTC)
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        default=lambda: datetime.now(UTC),
        onupdate=lambda: datetime.now(UTC),
    )

    node: Mapped["Node"] = relationship("Node", back_populates="db_tables")
    columns: Mapped[list["DbColumn"]] = relationship(
        "DbColumn",
        back_populates="table",
        cascade="all, delete-orphan",
        passive_deletes=True,
        order_by="DbColumn.order, DbColumn.name",
        lazy="selectin",
    )
