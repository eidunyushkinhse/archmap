import uuid

from sqlalchemy import ForeignKey, UniqueConstraint, Uuid
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base


class DeploymentInstance(Base):
    """Экземпляр развёртывания: «объект стоит на площадке» (docs/tasks/deployment-view.md).

    У объекта экземпляров ноль или больше — один сервис может крутиться в двух
    кластерах сразу. Экземпляры есть только у ОБЪЕКТОВ (листьев дерева): контейнер
    размещается целиком — набор площадок получает каждый объект внутри, а размещение
    самого контейнера app/deployment выводит из объектов (с 2026-10-27; раньше объекты
    наследовали размещение предка, и экземпляры хранились у контейнера).

    Оба FK — каскадом: удалили объект или площадку — экземпляр теряет смысл. Пара
    (node_id, site_id) уникальна: дважды на одной площадке объект не стоит.
    project_id дублирует проект узла и площадки ради выборки «все экземпляры
    проекта» одним запросом без соединений (действующее размещение считается по
    всему дереву) и ради каскада при удалении проекта.
    """

    __tablename__ = "deployment_instances"
    __table_args__ = (
        UniqueConstraint("node_id", "site_id", name="uq_deployment_instances_node_site"),
    )

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    project_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("projects.id", ondelete="CASCADE"), nullable=False, index=True
    )
    node_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("nodes.id", ondelete="CASCADE"), nullable=False, index=True
    )
    site_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("deployment_sites.id", ondelete="CASCADE"), nullable=False, index=True
    )
