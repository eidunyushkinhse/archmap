import uuid
from datetime import UTC, datetime
from typing import TYPE_CHECKING

from sqlalchemy import (
    Boolean,
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
    from app.models.node import Node


class ConfigParam(Base):
    """Параметр конфигурации сервиса — переменная окружения, флаг, настройка.

    Третья семья фактов после структуры БД и каналов брокера
    (docs/plan-config-docs.md). Смысл тот же: развилка в схеме логики обязана уметь
    сослаться на то, от чего зависит. От данных («если статус paid») ссылаться уже
    можно, от конфигурации («если FEATURE_X включён») — было нечем.

    Владелец — ВСЕГДА САМ СЕРВИС (решение пользователя §2.1 плана): узлы-хранилища
    конфигурации (ConfigMap, Consul, Vault) владельцами не заводим. Отсюда главное
    упрощение против двух предыдущих семей — у пометки «зависит от: X» ровно одно
    место, где X может найтись, и неоднозначность НЕВОЗМОЖНА ПО ПОСТРОЕНИЮ, а не
    обработана. Одинаковый параметр у разных сервисов — две записи, а не одна
    общая (§2.2): назначение и дефолт у них разные, а единая запись врала бы про
    общность.

    Обращений к параметру своих записей здесь нет и не будет: их истина — пометка
    «зависит от:» в тексте схемы логики, разбор и резолв на чтении (app/data_refs.py),
    как у обеих предыдущих семей.

    ЗНАЧЕНИЙ НЕ ХРАНИМ НИКОГДА (§2.5): они разные по средам и часто секретны, а
    ArchMap не хранилище секретов. default_value — это ТЕКСТ ДЕФОЛТА из кода
    («30s», «false»), а не значение, подставленное средой.
    """

    __tablename__ = "config_params"
    # Уникальность плоская — групп/секций у параметра нет (решение §2.3), поэтому и
    # пустых строк вместо NULL городить не пришлось, в отличие от schema_name таблиц
    # и group_name каналов.
    __table_args__ = (UniqueConstraint("node_id", "name", name="uq_config_param_name"),)

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    node_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("nodes.id", ondelete="CASCADE"), nullable=False, index=True
    )
    # Имя как В КОДЕ: «DATABASE_URL», «feature.new_checkout», «--retry-count».
    name: Mapped[str] = mapped_column(String(256), nullable=False)
    # НАЗНАЧЕНИЕ — «что переключает», а не «что означает по названию»: ради ответа на
    # него сопровождение и ходит в конфигурацию.
    description: Mapped[str | None] = mapped_column(Text, nullable=True)
    # ТИП ЗНАЧЕНИЯ («string», «int», «bool», «duration», «json») — свободная строка,
    # как technology у узла: перечисление здесь врало бы про разнообразие конфигов.
    value_type: Mapped[str] = mapped_column(
        String(64), nullable=False, default="", server_default=""
    )
    # Обязателен ли: сервис без него не стартует.
    required: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=False, server_default="false"
    )
    # Текст дефолта ИЗ КОДА, не значение среды. Пусто = дефолт не назван; отличать
    # «дефолта нет» от «дефолт — пустая строка» осознанно не стали: агент присылает
    # пустую строку там, где дефолта нет, и NULL-семантика превратилась бы в
    # выдуманный факт «по умолчанию пусто» (молчание лучше лжи).
    default_value: Mapped[str] = mapped_column(
        String(512), nullable=False, default="", server_default=""
    )
    # CAS — как у db_tables и broker_channels: правка от устаревшей версии не затирает
    # чужую.
    version: Mapped[int] = mapped_column(Integer, nullable=False, default=1, server_default="1")
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(UTC)
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        default=lambda: datetime.now(UTC),
        onupdate=lambda: datetime.now(UTC),
    )

    node: Mapped["Node"] = relationship("Node", back_populates="config_params")
