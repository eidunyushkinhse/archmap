import uuid
from typing import TYPE_CHECKING

from sqlalchemy import ForeignKey, String, Text, Uuid
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.database import Base

if TYPE_CHECKING:
    # Только для типов: связи резолвятся реестром SQLAlchemy по строкам в рантайме.
    from app.models.db_column import DbColumn
    from app.models.db_table import DbTable
    from app.models.node_doc import NodeDoc


class DocDataAccess(Base):
    """Обращение к данным: «эта операция читает/пишет вот эту таблицу (колонку)».

    РАДИ ЭТОЙ ТАБЛИЦЫ ВСЁ И ЗАТЕВАЛОСЬ. Инженеру сопровождения нужен не перечень
    таблиц, а происхождение значения: «откуда взялось поле в этом процессе». Структура
    отвечает «где значение может лежать», обращения — «кто его туда кладёт».
    Разворот этих же записей даёт обратный индекс на странице БД: «к orders.status
    обращаются: Биллинг POST /pay — пишет; Витрина GET /orders — читает».

    Цепляется к node_doc, а не к паре «узел + операция»: док И ЕСТЬ описание операции
    (или воркера) — это его единица. Обращения сервиса вне задокументированной
    операции не показываются, и это правильно: показывать нечего.

    Глубина: колонка НЕОБЯЗАТЕЛЬНА (column_id = NULL — обращение к таблице целиком).
    Решение пользователя 2026-08-12: требовать колоночную точность везде — заведомо
    получать выдумку, `SELECT *` в коде обычен.
    """

    __tablename__ = "doc_data_access"

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    node_doc_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("node_docs.id", ondelete="CASCADE"), nullable=False, index=True
    )
    table_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("db_tables.id", ondelete="CASCADE"), nullable=False, index=True
    )
    # NULL = обращение к таблице целиком (колонка неизвестна или несущественна).
    column_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("db_columns.id", ondelete="CASCADE"), nullable=True
    )
    # read | write. Отдельного «delete» нет: для карты данных важно, меняет операция
    # состояние или только читает, а чем именно меняет — деталь реализации.
    mode: Mapped[str] = mapped_column(String(8), nullable=False)
    note: Mapped[str | None] = mapped_column(Text, nullable=True)

    doc: Mapped["NodeDoc"] = relationship("NodeDoc", back_populates="data_access")
    table: Mapped["DbTable"] = relationship("DbTable")
    column: Mapped["DbColumn"] = relationship("DbColumn")
