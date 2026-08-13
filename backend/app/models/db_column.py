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
    from app.models.db_table import DbTable


class DbColumn(Base):
    """Колонка таблицы. Смысл колонки (`description`) — не украшение: вопросы
    сопровождения чаще всего именно про enum-подобные значения («status: new|paid»),
    и без расшифровки структура отвечает лишь на половину вопроса.
    """

    __tablename__ = "db_columns"
    __table_args__ = (UniqueConstraint("table_id", "name", name="uq_db_column_name"),)

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    table_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("db_tables.id", ondelete="CASCADE"), nullable=False, index=True
    )
    name: Mapped[str] = mapped_column(String(256), nullable=False)
    # Тип как В КОДЕ («uuid», «varchar(256)», «timestamptz»): нормализовать по диалектам
    # не пытаемся — карта должна совпадать с миграцией, а не с чьим-то представлением.
    type: Mapped[str] = mapped_column(String(128), nullable=False, default="", server_default="")
    nullable: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True, server_default="true")
    is_primary_key: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=False, server_default="false"
    )
    # Внешний ключ КАРТЫ (не БД): ссылка на колонку другой таблицы — из этих ссылок и
    # рисуется ER. SET NULL: снос колонки-цели не должен уносить ссылающуюся колонку.
    references_column_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("db_columns.id", ondelete="SET NULL"), nullable=True
    )
    description: Mapped[str | None] = mapped_column(Text, nullable=True)
    # Порядок в таблице (как в DDL) — читаемость важнее алфавита.
    order: Mapped[int] = mapped_column(Integer, nullable=False, default=0, server_default="0")

    table: Mapped["DbTable"] = relationship("DbTable", back_populates="columns")
