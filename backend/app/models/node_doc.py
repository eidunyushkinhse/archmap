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
    func,
)
from sqlalchemy.orm import Mapped, column_property, mapped_column, relationship

from app.database import Base

if TYPE_CHECKING:
    # Только для типов: связь резолвится реестром SQLAlchemy по строке в рантайме.
    from app.models.node import Node


class NodeDoc(Base):
    """Именованная схема логики узла (mermaid flowchart).

    Коллекция вместо прежнего единственного поля Node.flowchart (этап 1
    plan-agent-docs.md): у сервиса много сценариев — обработчик на каждую
    API-операцию плюс фоновые воркеры, каждый — отдельной схемой.
    Имя уникально в пределах узла: по нему доки адресуются при BYOA-дозаливке
    (этап 2) и в будущей адресации шагов бизнес-процесса.
    """

    __tablename__ = "node_docs"
    __table_args__ = (UniqueConstraint("node_id", "name", name="uq_node_doc_name"),)

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    node_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("nodes.id", ondelete="CASCADE"), nullable=False, index=True
    )
    name: Mapped[str] = mapped_column(String(256), nullable=False)
    # Вид схемы: operation (сценарий, запускаемый извне: обработчик API-операции
    # или действие пользователя в интерфейсе) | worker (фоновая работа).
    # Кодируется Literal-ом в Pydantic-схеме. Вид «overview» удалён миграцией
    # 4c1e0a9f6b2d вместе со всеми схемами, которые его несли.
    kind: Mapped[str] = mapped_column(String(16), default="operation", server_default="operation")
    # Привязка к операции OpenAPI-спеки узла («METHOD /path», свободная строка) —
    # задел под провал «шаг процесса → схема сценария / спека операции».
    operation: Mapped[str | None] = mapped_column(String(256), nullable=True)
    # Тело схемы (mermaid) — ОТЛОЖЕННАЯ колонка (Р37). Связь Node.docs грузится
    # selectin-ом в каждой графовой выдаче, но отдаётся там лёгкой метой без тела
    # (NodeDocMeta) — а тянулись при этом полные тексты, чтобы тут же их выбросить.
    # До разведки это стоило немного (полевой максимум — 13 схем на проект), после
    # неё у монолита схем две сотни, и каждая выборка узлов волокла двести mermaid.
    # ВНИМАНИЕ потребителям: где тело действительно нужно, его надо ЗАПРОСИТЬ —
    # undefer(NodeDoc.content) в опциях запроса. Забытый undefer не ошибка, а тихий
    # N+1: код работает, тесты зелёные, а запросов становится по одному на схему.
    # Сторож — tests/test_doc_content_deferred.py (считает запросы, а не рассуждает).
    content: Mapped[str] = mapped_column(
        Text, nullable=False, default="", server_default="", deferred=True
    )
    # «Схема описана» — производный признак, а не колонка: разведка точек входа
    # (docs/plan-recon.md) создаёт ЗАГЛУШКИ — схемы с пустым телом, — и витрина
    # обязана отличать их от готовой документации. Считается ВЫРАЖЕНИЕМ В БД, а не
    # в Python по self.content: мета доков отдаётся без тела, у монолита схем две
    # сотни, и признак не должен зависеть от того, загружено тело или нет (иначе
    # будущая разгрузка тел молча его сломает). length(trim(...)) есть и у
    # PostgreSQL, и у SQLite — тестам на SQLite экзотика не нужна.
    described: Mapped[bool] = column_property(func.length(func.trim(content)) > 0)
    # Версия для optimistic CAS — тот же паттерн, что у Node.version: PATCH с
    # base_version ≠ текущей → 409, правка от устаревшего текста не затирает чужую.
    version: Mapped[int] = mapped_column(Integer, nullable=False, default=1, server_default="1")
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(UTC)
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        default=lambda: datetime.now(UTC),
        onupdate=lambda: datetime.now(UTC),
    )

    node: Mapped["Node"] = relationship("Node", back_populates="docs")
