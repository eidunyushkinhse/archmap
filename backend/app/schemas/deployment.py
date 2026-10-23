"""Контракт схемы развёртывания (docs/tasks/deployment-view.md): площадки, размещение
объектов и граф вида «Развёртывание».

Площадка — где крутятся объекты (облако, кластер Kubernetes, ВМ, физический сервер),
вложенная в другую площадку через parent_id. Размещение задаётся НАБОРОМ площадок
объекта целиком; действующее размещение объекта без своих экземпляров наследуется от
ближайшего предка (app/deployment.effective_instances).
"""

import uuid

from pydantic import BaseModel

from app.domain_types import SiteKind
from app.schemas.node import GraphEdgeResponse, NodeResponse
from app.schemas.view import ViewLayoutPayload


class SiteCreate(BaseModel):
    name: str
    kind: SiteKind = "other"
    technology: str | None = None
    description: str | None = None
    # Площадка, в которую вложена новая; пусто — корневая.
    parent_id: uuid.UUID | None = None


class SiteUpdate(BaseModel):
    """Правка площадки: не прислано — не трогаем. parent_id: null — вынести в корень."""

    name: str | None = None
    kind: SiteKind | None = None
    technology: str | None = None
    description: str | None = None
    parent_id: uuid.UUID | None = None
    # CAS, как у узла: версия, от которой клиент правил; не совпала — 409.
    base_version: int | None = None


class SiteOut(BaseModel):
    """Площадка плоским списком: дерево фронт строит сам по parent_id."""

    id: uuid.UUID
    name: str
    kind: SiteKind
    technology: str | None = None
    description: str | None = None
    parent_id: uuid.UUID | None = None
    version: int = 1
    # Число СВОИХ экземпляров на площадке (унаследованные не в счёт): им окно
    # подтверждения удаления говорит, сколько размещений снимется вместе с ней.
    instance_count: int = 0

    model_config = {"from_attributes": True}


class PlacementsIn(BaseModel):
    """Размещение нескольких объектов разом: КАЖДОМУ объекту — ровно этот набор
    площадок (лишние экземпляры снимаются, недостающие добавляются); пустой
    site_ids — снять своё размещение у всех перечисленных."""

    node_ids: list[uuid.UUID]
    site_ids: list[uuid.UUID]


class EffectiveInstanceOut(BaseModel):
    """Действующий экземпляр объекта: площадка и, если он унаследован, — предок,
    от которого (пусто у своего)."""

    site_id: uuid.UUID
    inherited_from_id: uuid.UUID | None = None


class DeploymentNodeOut(NodeResponse):
    """Узел поддерева уровня на холсте развёртывания: все поля узла плюс свои
    экземпляры (instances — id площадок, где объект поставлен сам) и действующие
    (effective — с наследованием от предка). Карточка представителя — объекта или
    цельного контейнера — рисуется в рамке каждой площадки из effective."""

    # Без дефолтов: роутер графа заполняет оба поля всегда, а обязательные поля
    # контракта и в генерате фронта обязательные (не «?:»).
    instances: list[uuid.UUID]
    effective: list[EffectiveInstanceOut]


class DeploymentGraph(BaseModel):
    """Граф вида «Развёртывание» уровня: всё его поддерево — контейнеры и листья (без
    «Пользователей» и без самого контейнера уровня), все площадки проекта, сырые связи
    с обоими концами в этом поддереве и раскладка вида.

    layout — строки view_layout вида этого уровня с ключами «deploy:<узел>@<площадка>»
    (карточка экземпляра) и «deploy:site:<площадка>» (рамка площадки): вид делит
    хранилище раскладки с холстом объектов, а префикс разводит их ключи. Пишутся тем
    же PUT /views/{view_id}/layout. version — версия вида (fence записей раскладки),
    graph_rev/meta_rev — курсоры проекта для поллинга, как у графа уровня."""

    sites: list[SiteOut]
    nodes: list[DeploymentNodeOut]
    edges: list[GraphEdgeResponse]
    layout: dict[str, ViewLayoutPayload] = {}
    version: int = 0
    graph_rev: int = 0
    meta_rev: int = 0
