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
    from app.models.channel_field import ChannelField
    from app.models.node import Node


class BrokerChannel(Base):
    """Канал брокера (топик/очередь/exchange/stream/subject) — часть СТРУКТУРЫ
    узла-брокера.

    Прямой аналог db_tables у базы (docs/plan-broker-docs.md §2), но отдельной
    таблицей, а не обобщением: у канала своя мета (доставка, ключ партиционирования,
    retention), у таблицы своя, и общая сущность вышла бы «строкой с дюжиной
    nullable-полей», размывающей обе. Структура — «контракт» брокера: то, что узел
    ПРЕДОСТАВЛЯЕТ. Кто публикует и кто потребляет, здесь не хранится — обращения
    живут у вызывающего, ПОМЕТКОЙ в тексте схемы его операции («публикует:
    orders.created»), а индекс собирается их разбором на чтении.
    """

    __tablename__ = "broker_channels"
    # group_name NOT NULL с пустой строкой вместо NULL: в Postgres NULL-ы друг другу
    # не конфликтуют, и уникальность «одно имя на группу» просто не сработала бы
    # (тот же урок, что у schema_name таблиц).
    __table_args__ = (
        UniqueConstraint("node_id", "group_name", "name", name="uq_broker_channel_name"),
    )

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    node_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("nodes.id", ondelete="CASCADE"), nullable=False, index=True
    )
    name: Mapped[str] = mapped_column(String(256), nullable=False)
    # ГРУППА канала — уровень изоляции движка: vhost (RabbitMQ), namespace/tenant
    # (Pulsar), account (NATS). У Kafka её нет — поле пустое, как schema_name у Redis.
    group_name: Mapped[str] = mapped_column(
        String(128), nullable=False, default="", server_default=""
    )
    # РАЗНОВИДНОСТЬ: topic | queue | exchange | stream | subject. Свободная строка, а
    # не Literal, — осознанно (универсальность движков, как role/technology у узла):
    # перечень терминов подсказывает интерфейс, а карта обязана совпадать с реальной
    # инсталляцией, а не с нашим представлением о ней.
    kind: Mapped[str] = mapped_column(
        String(64), nullable=False, default="", server_default=""
    )
    # Ключ партиционирования/маршрутизации («order_id», routing key) — от него зависит
    # ПОРЯДОК применения событий, первый из трёх частых инцидентов сопровождения.
    partition_key: Mapped[str] = mapped_column(
        String(256), nullable=False, default="", server_default=""
    )
    # Гарантия доставки: at-least-once | at-most-once | exactly-once. Отвечает на
    # «что будет при повторной обработке» — тоже свободная строка.
    delivery: Mapped[str] = mapped_column(
        String(64), nullable=False, default="", server_default=""
    )
    # Хранение: «7d», «до ack», «compacted». Отвечает на «при переигрывании ничего
    # не нашлось».
    retention: Mapped[str] = mapped_column(
        String(128), nullable=False, default="", server_default=""
    )
    description: Mapped[str | None] = mapped_column(Text, nullable=True)
    # CAS — как у db_tables: правка от устаревшей версии не затирает чужую.
    version: Mapped[int] = mapped_column(Integer, nullable=False, default=1, server_default="1")
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(UTC)
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        default=lambda: datetime.now(UTC),
        onupdate=lambda: datetime.now(UTC),
    )

    node: Mapped["Node"] = relationship("Node", back_populates="broker_channels")
    fields: Mapped[list["ChannelField"]] = relationship(
        "ChannelField",
        back_populates="channel",
        cascade="all, delete-orphan",
        passive_deletes=True,
        order_by="ChannelField.order, ChannelField.name",
        lazy="selectin",
    )
