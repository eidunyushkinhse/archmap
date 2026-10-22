import uuid
from datetime import UTC, datetime
from typing import Any

from sqlalchemy import (
    JSON,
    DateTime,
    ForeignKey,
    Integer,
    LargeBinary,
    String,
    UniqueConstraint,
    Uuid,
)
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base
from app.domain_types import VersionKind


class NodeVersion(Base):
    """Версия документации объекта — зафиксированный редактором срез (docs/tasks/doc-versions.md).

    Не путать с CAS-полем version у узла, схемы или шага: то — счётчик конкурентных
    правок одной строки, а это — история документации, которую человек фиксирует сам,
    с комментарием (номер релиза или задачи). Срез берёт объект целиком вместе с
    поддеревом: свойства, связи, схемы логики, факты и процессы с его участием
    (сборка — app/versions_snapshot.py). Раскладки холста в нём нет.

    node_id допускает NULL: это срез всего проекта (страница проекта — корень дерева).
    Иначе появление новой системы на верхнем уровне не попало бы ни в одну историю.
    Нумерация своя у каждого объекта и у корня; уникальность (project_id, node_id,
    number) с NULL как значением держит postgresql_nulls_not_distinct, как у view_layout.

    snapshot — zlib канонического JSON: тексты схем и спек сжимаются в разы, а читается
    снимок только при открытии версии или дельты. snapshot_format — версия формата
    снимка отдельной колонкой: сменив формат, новый код читает старые строки по их
    номеру формата, и переписывать накопленную историю миграцией данных не нужно.
    content_hash — sha256 семантической проекции снимка: «есть ли изменения с vN»
    отвечается сравнением хэшей, без распаковки и дельты.
    """

    __tablename__ = "node_versions"
    __table_args__ = (
        UniqueConstraint(
            "project_id",
            "node_id",
            "number",
            name="uq_node_versions_number",
            # PG15: NULL node_id (срез всего проекта) участвует в уникальности как значение
            postgresql_nulls_not_distinct=True,
        ),
    )

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    project_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("projects.id", ondelete="CASCADE"), nullable=False, index=True
    )
    # Каскад: история удалённого объекта уходит вместе с ним (Undo удаления возвращает
    # объект без истории — app/restore.NOT_IN_SNAPSHOT); документацию объекта хранят
    # срезы его контейнера и корня проекта.
    node_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("nodes.id", ondelete="CASCADE"), nullable=True, index=True
    )
    # Порядковый номер у объекта: max + 1 под блокировкой строки проекта.
    number: Mapped[int] = mapped_column(Integer, nullable=False)
    # Комментарий редактора; предел длины сторожит app/column_limits (422, а не 500).
    comment: Mapped[str] = mapped_column(String(512), nullable=False)
    kind: Mapped[VersionKind] = mapped_column(
        String(16), nullable=False, default="manual", server_default="manual"
    )
    # Номер версии-источника у kind="restore" («Откат к vN»); у остальных — NULL.
    restored_from: Mapped[int | None] = mapped_column(Integer, nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(UTC)
    )
    # SET NULL: удаление пользователя не стирает историю, версия остаётся без автора.
    created_by_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("users.id", ondelete="SET NULL"), nullable=True, index=True
    )
    snapshot: Mapped[bytes] = mapped_column(LargeBinary, nullable=False)
    snapshot_format: Mapped[int] = mapped_column(
        Integer, nullable=False, default=1, server_default="1"
    )
    content_hash: Mapped[str] = mapped_column(String(64), nullable=False)
    # Счётчики по категориям для строки списка (Ф1 добавит перечень изменённых
    # элементов относительно предыдущей версии).
    stats: Mapped[dict[str, Any]] = mapped_column(JSON, nullable=False)
