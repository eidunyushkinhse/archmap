"""CRUD структуры брокера — каналы и поля сообщений.

Зеркало db_docs.py по устройству (структура записями, CAS, meta_rev), но с ДРУГИМ
правилом владения: каналы бывают только у shape="broker". У базы форму не проверяли
осознанно (интерфейс ведёт к структуре от БД, а агент мог прислать таблицы узлу с
чужой формой), здесь же наоборот — «канал» без брокера бессмысленен, и правило формы
энфорсится на ВХОДЕ, а не разбирается потом расхождением (урок находки Х1 №4).

Мутации — редактору проекта, чтение — всем с доступом: как у node_docs. Каждая мутация
бампает meta_rev — структура это МЕТА узла (видна на его странице, не на схеме), и
поллинг страницы обязан отличать её от изменений схемы (graph_rev).

Обращений к каналам («кто публикует / кто потребляет») СВОИХ ЗАПИСЕЙ здесь нет и не
будет: их истина — пометки «публикует:/потребляет:» в тексте схем логики вызывающих,
разбор и резолв на чтении (пивот §1 docs/plan-broker-docs.md). Обратный индекс
(GET /usage) их только РАЗВОРАЧИВАЕТ, ничего не храня.
"""

import uuid

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session

from app.auth import get_current_user
from app.data_refs import catalog_for_project, doc_ref_hits
from app.database import get_db
from app.deps import (
    check_cas,
    commit_change,
    get_current_project,
    name_taken,
    node_or_404,
    owned_or_404,
    require_project_editor,
)
from app.models.broker_channel import BrokerChannel
from app.models.channel_field import ChannelField
from app.models.node import Node
from app.models.project import Project
from app.models.user import User
from app.schemas.broker_channel import (
    BrokerChannelCreate,
    BrokerChannelResponse,
    BrokerChannelUpdate,
    ChannelFieldCreate,
    ChannelFieldResponse,
    ChannelFieldUpdate,
    ChannelUsage,
)
from app.view_state import bump_meta_rev

router = APIRouter(prefix="/nodes/{node_id}/channels", tags=["broker-docs"])


def _broker_node(db: Session, node_id: uuid.UUID, project: Project) -> Node:
    """Узел-владелец каналов. Форма проверяется на КАЖДОЙ мутации, включая создание:
    иначе «каналы у сервиса» пришлось бы ловить постфактум, а страница их не покажет.
    Контейнер отсекается этой же проверкой — детей имеет только сервис (node.md N4)."""
    node = node_or_404(db, node_id, project)
    if node.shape != "broker":
        raise HTTPException(
            status_code=400, detail="Каналы может иметь только узел-брокер"
        )
    return node


def _scoped_channel(db: Session, node: Node, channel_id: uuid.UUID) -> BrokerChannel:
    return owned_or_404(db, BrokerChannel, channel_id, "node_id", node.id, "Канал не найден")


def _scoped_field(db: Session, channel: BrokerChannel, field_id: uuid.UUID) -> ChannelField:
    return owned_or_404(db, ChannelField, field_id, "channel_id", channel.id, "Поле не найдено")


def _channel_taken(
    db: Session, node_id: uuid.UUID, group_name: str, name: str, except_id: uuid.UUID | None
) -> bool:
    """Пре-чек уникальности имени в группе — 409 вместо IntegrityError-500."""
    return name_taken(
        db,
        BrokerChannel.id,
        except_id,
        BrokerChannel.node_id == node_id,
        BrokerChannel.group_name == group_name,
        BrokerChannel.name == name,
    )


def _field_taken(
    db: Session, channel_id: uuid.UUID, name: str, except_id: uuid.UUID | None
) -> bool:
    return name_taken(
        db,
        ChannelField.id,
        except_id,
        ChannelField.channel_id == channel_id,
        ChannelField.name == name,
    )


# ── Каналы ────────────────────────────────────────────────────────────────────


@router.get("", response_model=list[BrokerChannelResponse])
def list_channels(
    node_id: uuid.UUID,
    db: Session = Depends(get_db),
    project: Project = Depends(get_current_project),
    _: User = Depends(get_current_user),
) -> list[BrokerChannel]:
    # Чтение форму НЕ проверяет: если каналы у узла уже есть (например, форму сменили
    # в обход), спрятать их хуже, чем показать — «применённое-но-невидимое» и так
    # запрещено при смене типа (node.md N4а).
    node = node_or_404(db, node_id, project)
    return list(node.broker_channels)


@router.get("/usage", response_model=list[ChannelUsage])
def list_usage(
    node_id: uuid.UUID,
    db: Session = Depends(get_db),
    project: Project = Depends(get_current_project),
    _: User = Depends(get_current_user),
) -> list[ChannelUsage]:
    """Кто публикует и кто потребляет каналы этого брокера — разворот пометок из
    схем логики проекта.

    Ради этого ответа структура каналов и заводилась: перечень каналов говорит, ЧТО
    брокер переносит, а обратный индекс — кто кладёт событие и кто его ждёт (вопрос
    сопровождения «кого сломает изменение формата»). Источник — сам текст доков
    (пивот §1 плана): разбор и резолв на чтении, хранения обращений нет.

    ОБЪЯВЛЕН ДО путей с {channel_id}: иначе «usage» поехало бы в разбор uuid.
    """
    node = node_or_404(db, node_id, project)
    catalog = catalog_for_project(db, project.id)
    # Резолв идёт по каталогу ВСЕГО проекта (doc_ref_hits), а в ответ отбираем свои.
    mine = {c.id: c for c in catalog.channels if c.node_id == node.id}
    if not mine:
        return []

    rows: list[ChannelUsage] = []
    # Дедуп в пределах дока: «orders.created» и «Кафка / orders.created» — одно и то
    # же обращение, написанное по-разному, и второй строкой в индексе быть не должно.
    seen: set[tuple[uuid.UUID, uuid.UUID, uuid.UUID | None, str]] = set()
    for hit in doc_ref_hits(db, project.id, catalog):
        ref = hit.ref
        # Табличные пометки («читает:/пишет:») этому индексу не принадлежат —
        # их разворот живёт у базы: каталоги и семьи режимов разведены.
        if ref.mode != "publish" and ref.mode != "consume":
            continue
        # unknown_channel/ambiguous сюда НЕ попадают: индекс брокера отвечает за
        # факты, а нерезолвнутой пометке место в алертах и в плашке редактора.
        if ref.status not in ("ok", "unknown_field") or ref.channel_id is None:
            continue
        channel = mine.get(ref.channel_id)
        if channel is None:
            continue
        # unknown_field = канал нашёлся, поля нет → обращение к каналу ЦЕЛИКОМ;
        # несуществующее поле в индекс не тащим (его подсветит алерт).
        field_id = ref.field_id if ref.status == "ok" else None
        field_name = ref.field_name if ref.status == "ok" else None
        key = (hit.doc_id, channel.id, field_id, ref.mode)
        if key in seen:
            continue
        seen.add(key)
        rows.append(
            ChannelUsage(
                channel_id=channel.id, channel_name=channel.name,
                field_id=field_id, field_name=field_name,
                mode=ref.mode, doc_id=hit.doc_id, doc_name=hit.doc_name,
                node_id=hit.node_id, node_name=hit.node_name,
            )
        )
    rows.sort(key=lambda u: (u.channel_name, u.node_name, u.doc_name))
    return rows


@router.post("", response_model=BrokerChannelResponse, status_code=status.HTTP_201_CREATED)
def create_channel(
    node_id: uuid.UUID,
    payload: BrokerChannelCreate,
    db: Session = Depends(get_db),
    project: Project = Depends(get_current_project),
    user: User = Depends(require_project_editor),
) -> BrokerChannel:
    node = _broker_node(db, node_id, project)
    if _channel_taken(db, node.id, payload.group_name, payload.name, None):
        raise HTTPException(status_code=409, detail="Канал с таким именем уже есть")
    channel = BrokerChannel(node_id=node.id, **payload.model_dump())
    db.add(channel)
    commit_change(db, project, user.id, meta=True)
    db.refresh(channel)
    return channel


@router.patch("/{channel_id}", response_model=BrokerChannelResponse)
def update_channel(
    node_id: uuid.UUID,
    channel_id: uuid.UUID,
    payload: BrokerChannelUpdate,
    db: Session = Depends(get_db),
    project: Project = Depends(get_current_project),
    user: User = Depends(require_project_editor),
) -> BrokerChannel:
    node = _broker_node(db, node_id, project)
    channel = _scoped_channel(db, node, channel_id)
    data = payload.model_dump(exclude_unset=True)
    base_version = data.pop("base_version", None)
    check_cas(channel.version, base_version, "Канал изменён в другой сессии")
    if data:
        new_name = data.get("name", channel.name)
        new_group = data.get("group_name", channel.group_name)
        if _channel_taken(db, node.id, new_group, new_name, channel.id):
            raise HTTPException(status_code=409, detail="Канал с таким именем уже есть")
        for field, value in data.items():
            setattr(channel, field, value)
        channel.version += 1
        bump_meta_rev(db, project)
    commit_change(db, project, user.id)
    db.refresh(channel)
    return channel


@router.delete("/{channel_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_channel(
    node_id: uuid.UUID,
    channel_id: uuid.UUID,
    db: Session = Depends(get_db),
    project: Project = Depends(get_current_project),
    user: User = Depends(require_project_editor),
) -> None:
    node = _broker_node(db, node_id, project)
    channel = _scoped_channel(db, node, channel_id)
    db.delete(channel)
    commit_change(db, project, user.id, meta=True)


# ── Поля сообщений ────────────────────────────────────────────────────────────


@router.post(
    "/{channel_id}/fields",
    response_model=ChannelFieldResponse,
    status_code=status.HTTP_201_CREATED,
)
def create_field(
    node_id: uuid.UUID,
    channel_id: uuid.UUID,
    payload: ChannelFieldCreate,
    db: Session = Depends(get_db),
    project: Project = Depends(get_current_project),
    user: User = Depends(require_project_editor),
) -> ChannelField:
    node = _broker_node(db, node_id, project)
    channel = _scoped_channel(db, node, channel_id)
    if _field_taken(db, channel.id, payload.name, None):
        raise HTTPException(status_code=409, detail="Поле с таким именем уже есть в канале")
    field = ChannelField(channel_id=channel.id, **payload.model_dump())
    db.add(field)
    commit_change(db, project, user.id, meta=True)
    db.refresh(field)
    return field


@router.patch("/{channel_id}/fields/{field_id}", response_model=ChannelFieldResponse)
def update_field(
    node_id: uuid.UUID,
    channel_id: uuid.UUID,
    field_id: uuid.UUID,
    payload: ChannelFieldUpdate,
    db: Session = Depends(get_db),
    project: Project = Depends(get_current_project),
    user: User = Depends(require_project_editor),
) -> ChannelField:
    node = _broker_node(db, node_id, project)
    channel = _scoped_channel(db, node, channel_id)
    field = _scoped_field(db, channel, field_id)
    data = payload.model_dump(exclude_unset=True)
    if data:
        new_name = data.get("name")
        if new_name is not None and _field_taken(db, channel.id, new_name, field.id):
            raise HTTPException(
                status_code=409, detail="Поле с таким именем уже есть в канале"
            )
        for attr, value in data.items():
            setattr(field, attr, value)
        bump_meta_rev(db, project)
    commit_change(db, project, user.id)
    db.refresh(field)
    return field


@router.delete(
    "/{channel_id}/fields/{field_id}", status_code=status.HTTP_204_NO_CONTENT
)
def delete_field(
    node_id: uuid.UUID,
    channel_id: uuid.UUID,
    field_id: uuid.UUID,
    db: Session = Depends(get_db),
    project: Project = Depends(get_current_project),
    user: User = Depends(require_project_editor),
) -> None:
    node = _broker_node(db, node_id, project)
    channel = _scoped_channel(db, node, channel_id)
    field = _scoped_field(db, channel, field_id)
    db.delete(field)
    commit_change(db, project, user.id, meta=True)
