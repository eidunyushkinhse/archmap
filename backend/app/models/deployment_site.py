import uuid
from datetime import UTC, datetime

from sqlalchemy import (
    DateTime,
    ForeignKey,
    Integer,
    String,
    Text,
    UniqueConstraint,
    Uuid,
)
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base
from app.domain_types import SiteKind


class DeploymentSite(Base):
    """Площадка развёртывания — где физически крутятся объекты схемы: облако или
    управляемый сервис, кластер Kubernetes, виртуальная машина, физический сервер
    (docs/tasks/deployment-view.md). Объект ставится на площадку экземпляром
    (DeploymentInstance); схема одна, без разделения сред — это целевая топология,
    значений сред ArchMap не хранит.

    Площадки вкладываются друг в друга (облако → кластер → узел кластера): parent_id —
    ссылка на площадку того же проекта. Площадку с вложенными удалить нельзя —
    вложенные повисли бы без родителя (или ушли бы каскадом вместе со своими
    экземплярами, молча). Роутер отказывает раньше БД понятным текстом «сначала
    перенесите вложенные площадки»; FK без каскада — страховка последней линии.

    Действие FK — NO ACTION (умолчание), а не RESTRICT, и разница тут не косметическая.
    Обе запрещают удалить площадку с вложенными, но RESTRICT в SQLite (на ней гоняются
    тесты) проверяется сразу на каждой строке: удаление ПРОЕКТА каскадом сносит его
    площадки одним оператором, и родитель, удалённый раньше вложенной, ронял бы всё
    удаление. NO ACTION проверяется в конце оператора — когда вложенных уже нет.
    Postgres пропускает каскад проекта при обеих (проверено на dev-базе).

    Имя уникально в ПРОЕКТЕ, а не у родителя: импорт YAML и агент (MCP) ссылаются на
    площадку именем, без пути, — два «prod-cluster» в разных облаках сделали бы ссылку
    неоднозначной.
    """

    __tablename__ = "deployment_sites"
    __table_args__ = (UniqueConstraint("project_id", "name", name="uq_deployment_sites_name"),)

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    project_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("projects.id", ondelete="CASCADE"), nullable=False, index=True
    )
    parent_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("deployment_sites.id"), nullable=True, index=True
    )
    name: Mapped[str] = mapped_column(String(256), nullable=False)
    # Вид площадки (app/domain_types.SiteKind): по нему фронт выбирает иконку рамки.
    kind: Mapped[SiteKind] = mapped_column(
        String(16), nullable=False, default="other", server_default="other"
    )
    # Технология свободным текстом («Yandex Cloud», «k3s», «VMware») — как у узла.
    technology: Mapped[str | None] = mapped_column(String(128), nullable=True)
    description: Mapped[str | None] = mapped_column(Text, nullable=True)
    # CAS, как у узла: правка от устаревшей версии не затирает чужую (409).
    version: Mapped[int] = mapped_column(Integer, nullable=False, default=1, server_default="1")
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(UTC)
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        default=lambda: datetime.now(UTC),
        onupdate=lambda: datetime.now(UTC),
    )
