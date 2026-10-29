"""Контракт схемы развёртывания (docs/tasks/deployment-view.md): площадки, размещение
объектов и граф вида «Развёртывание».

Площадка — где крутятся объекты (облако, кластер Kubernetes, ВМ, физический сервер),
вложенная в другую площадку через parent_id. Размещение задаётся НАБОРОМ площадок
единицы целиком. Единица размещения — контейнер (в том числе лист): он стоит на
площадках сам, его компоненты отдельно не развёртываются и размещения не имеют.
Система размещается целиком — набор получает каждый её контейнер, а размещение самой
системы выводится из них (app/deployment.placement_map, Р16 эпика
docs/plan-c4-elements.md).
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
    # Число объектов на площадке: им окно подтверждения удаления говорит, сколько
    # размещений снимется вместе с ней.
    instance_count: int = 0

    model_config = {"from_attributes": True}


class PlacementsIn(BaseModel):
    """Размещение нескольких объектов разом: КАЖДОЙ единице — ровно этот набор
    площадок (лишние экземпляры снимаются, недостающие добавляются); пустой
    site_ids — снять размещение у всех перечисленных. Контейнер (в том числе лист)
    пишется сам; система среди node_ids размещается целиком — набор получает каждый
    контейнер внутри неё; компонент — отказ 422: площадки задаются его контейнеру."""

    node_ids: list[uuid.UUID]
    site_ids: list[uuid.UUID]


class DeploymentNodeOut(NodeResponse):
    """Узел поддерева уровня на холсте развёртывания: все поля узла плюс instances —
    id площадок, где стоит единица (контейнер, в том числе лист); у системы — где
    стоят ВСЕ её единицы (а где часть — видно в sites с пометкой partial); у компонента
    — пусто. Кого рисовать карточкой — единицу или цельную систему — решает фронт по
    размещению единиц и element_effective."""

    # Без дефолта: роутер графа заполняет поле всегда, а обязательное поле контракта
    # и в генерате фронта обязательное (не «?:»).
    instances: list[uuid.UUID]


class DeploymentGraph(BaseModel):
    """Граф вида «Развёртывание» уровня: всё его поддерево любой глубины (без
    «Пользователей» и без самого узла уровня; компоненты — в ответе, концы их связей
    фронт поднимает к контейнеру), все площадки проекта, сырые связи с обоими концами
    в этом поддереве и раскладка вида.

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
