import uuid
from typing import TYPE_CHECKING

from sqlalchemy import (
    Boolean,
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
    from app.models.broker_channel import BrokerChannel


class ChannelField(Base):
    """Поле сообщения канала — «колонка» события.

    Глубина «канал.поле» здесь не для полноты картины: вопрос сопровождения звучит
    «откуда в событии X значение Y», и без полей структура отвечает лишь на половину.
    Смысл поля (`description`) особенно важен у enum-подобных значений («status:
    new|paid») — правило, унаследованное от колонок БД.
    """

    __tablename__ = "channel_fields"
    __table_args__ = (UniqueConstraint("channel_id", "name", name="uq_channel_field_name"),)

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    channel_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("broker_channels.id", ondelete="CASCADE"), nullable=False, index=True
    )
    name: Mapped[str] = mapped_column(String(256), nullable=False)
    # Тип как В СЕРИАЛИЗАЦИИ («string», «uuid», «int64», «object»): по языкам и
    # схемам не нормализуем — карта должна совпадать с контрактом события.
    type: Mapped[str] = mapped_column(String(128), nullable=False, default="", server_default="")
    required: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=False, server_default="false"
    )
    description: Mapped[str | None] = mapped_column(Text, nullable=True)
    # Порядок в сообщении (как в схеме события) — читаемость важнее алфавита.
    order: Mapped[int] = mapped_column(Integer, nullable=False, default=0, server_default="0")

    channel: Mapped["BrokerChannel"] = relationship("BrokerChannel", back_populates="fields")
