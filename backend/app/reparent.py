"""Перенос узла на другой уровень вложенности (смена parent_id).

До 2026-08-12 переносить узел было нечем: `parent_id` проставлялся только при
СОЗДАНИИ, и алерт «Пользователи внутри контейнера» указывал на проблему, которую
интерфейс не давал починить. Здесь — доменная часть жеста: что переносить можно, и
что делать с раскладкой переехавшего поддерева.

Два правила, ради которых модуль и появился:

1. ЗАПРЕТЫ. Контракт `NodeUpdate` принимал ЛЮБОЙ parent_id — включая собственного
   потомка, то есть поддерево можно было оторвать от корня и потерять из дерева
   насовсем. Проверки чистые (без HTTP), возвращают текст причины; статус ставит
   роутер.

2. РАСКЛАДКА. Позиция узла живёт не «в виде его родителя», а В КАЖДОМ ВИДЕ, ГДЕ ЕГО
   ВИДНО: ребёнок раскрытой рамки показан на уровне-предке и позицию получает именно
   там (см. posView в MapEditorPage). После переезда все такие позиции бессмысленны —
   снимаем их и отдаём вызывающему СНИМКОМ, чтобы Undo вернул не только родителя, но и
   геометрию. А вот виды ВНУТРИ переезжающего поддерева трогать нельзя: внутренняя
   раскладка от того, где висит корень поддерева, не зависит.
"""

import uuid
from typing import Literal

from sqlalchemy import or_
from sqlalchemy.orm import Session

from app import tree
from app.domain_types import NodeShape
from app.element_marks import project_element_rows
from app.element_rules import store_refusal
from app.models.broker_channel import BrokerChannel
from app.models.db_table import DbTable
from app.models.deployment_instance import DeploymentInstance
from app.models.node import Node
from app.models.project import Project
from app.models.view_layout import ViewLayoutItem
from app.schemas.restore import DeletionSnapshot, ViewLayoutItemSnapshot
from app.view_state import bump_view_version

# Формы, внутрь которых можно вкладывать объекты. Зеркало фронтового
# canHaveChildren: у БД, брокера и человека детей не бывает.
CONTAINER_SHAPES = {"service"}
# Отказ «внутрь формы без детей» — общий у переноса и создания (routers/nodes.create_node).
NO_CHILDREN = "Внутрь этого объекта нельзя вкладывать другие — детей не бывает"
# «Пользователь» живёт только на верхнем уровне (решение владельца 2026-10-31): по C4
# человек пользуется системой, а не входит в неё, и Structurizr DSL не допускает person
# нигде, кроме модели. Одна семья текстов на три жеста — перенос внутрь объекта, создание
# внутри него и смену формы у вложенного объекта. Вынести в корень можно всегда.
PERSON_MOVE = "Пользователь живёт вне границ системы — его нельзя вложить в объект"
PERSON_CREATE = "Пользователь живёт вне границ системы, создайте его на верхнем уровне"
PERSON_SHAPE = (
    "Пользователь живёт вне границ системы, сначала перенесите «{name}» на верхний уровень"
)


def person_refusal(
    *,
    shape: str,
    parent_id: uuid.UUID | None,
    name: str,
    action: Literal["create", "move", "shape"],
) -> str | None:
    """Почему объект формы shape не может оказаться под parent_id; None — может. shape,
    parent_id и name — ПОСЛЕ правки (тот же запрос может и переносить, и менять форму);
    action выбирает текст. Чистая проверка, без HTTP: статус ставит роутер.

    Вложенные «Пользователи» из старых данных (до 2026-10-31 создание внутри объекта
    проходило) правило не трогает: их отмечает AL25 (app/alerts), а копия проекта, Undo
    удаления и откат версии переносят их как есть."""
    if shape != "person" or parent_id is None:
        return None
    if action == "move":
        return PERSON_MOVE
    if action == "create":
        return PERSON_CREATE
    return PERSON_SHAPE.format(name=name)


def validate_reparent(
    db: Session,
    project: Project,
    node: Node,
    new_parent_id: uuid.UUID | None,
    *,
    shape: str | None = None,
) -> str | None:
    """Причина, по которой переносить нельзя, либо None. Чистая проверка, без HTTP.

    shape — форма узла после правки, если тот же запрос её меняет (иначе текущая): база
    или брокер внутри контейнера (Р6 эпика элементов) и «Пользователь» проверяются по
    дереву после правки."""
    # Человек по C4 живёт на контекстном уровне, ЗА границей системы — именно это
    # нарушение и ловит алерт AL25. Запрет односторонний: вынести человека НАРУЖУ
    # (parent_id = None) можно всегда, иначе алерт снова стал бы тупиком.
    person = person_refusal(
        shape=shape or node.shape, parent_id=new_parent_id, name=node.name, action="move"
    )
    if person:
        return person
    if new_parent_id is None:
        return None
    if new_parent_id == node.id:
        return "Объект нельзя вложить в самого себя"
    parent = (
        db.query(Node)
        .filter(Node.id == new_parent_id, Node.project_id == project.id)
        .first()
    )
    if parent is None:
        return "Новый родитель не найден в проекте"
    if parent.shape not in CONTAINER_SHAPES:
        return NO_CHILDREN
    if new_parent_id in tree.collect_subtree_ids_db(db, node.id):
        return "Объект нельзя перенести внутрь собственного потомка"
    # Р6: база или брокер — сам переносимый или в его поддереве — не входят в контейнер.
    # Контейнер внутрь контейнера переносить можно: по Р5 он становится составным
    # компонентом, хранимое значение спит (действующий элемент решают предки).
    return store_refusal(
        project_element_rows(db, project.id),
        node_id=node.id,
        name=node.name,
        parent_id=new_parent_id,
        shape=shape or node.shape,
        action="move",
    )


def _outside_rows(db: Session, project_id: uuid.UUID, node: Node) -> list[ViewLayoutItem]:
    """Строки раскладки поддерева в видах ЗА ПРЕДЕЛАМИ этого поддерева.

    Ключ item_id — строка без FK (в нём живут и uuid узлов, и легаси-ключи пучков
    «b:<src>><tgt>»), поэтому ищем вхождением, как это делает чистка при удалении.
    Виды самого поддерева исключаются: они переезжают вместе с ним и остаются верны.
    """
    subtree = tree.collect_subtree_ids_db(db, node.id)
    like = or_(*[ViewLayoutItem.item_id.like(f"%{sid}%") for sid in subtree])
    rows = (
        db.query(ViewLayoutItem)
        .filter(ViewLayoutItem.project_id == project_id, like)
        .all()
    )
    return [r for r in rows if r.view_id is None or r.view_id not in subtree]


def build_move_snapshot(db: Session, project: Project, node: Node) -> DeletionSnapshot:
    """Снимок раскладки, которую снимет перенос. Клиент берёт его ПЕРЕД переносом и
    возвращает через POST /nodes/restore при Undo — тем же путём, что и удаление
    (узлы/связи в снимке пусты: перенос ничего не сносит, кроме позиций)."""
    return DeletionSnapshot(
        nodes=[],
        edges=[],
        layout_items=[
            ViewLayoutItemSnapshot.model_validate(r)
            for r in _outside_rows(db, project.id, node)
        ],
    )


def strip_layout(db: Session, project: Project, node: Node, old_parent: uuid.UUID | None) -> None:
    """Снять позиции переехавшего поддерева во внешних видах и сдвинуть версии
    затронутых видов (fence конкурентных сессий: членство видов изменилось)."""
    rows = _outside_rows(db, project.id, node)
    touched: set[uuid.UUID | None] = {r.view_id for r in rows}
    for r in rows:
        db.delete(r)
    # Виды обоих родителей — даже если позиций в них не было (узел мог ни разу не
    # показываться): их СОСТАВ изменился, и соседняя сессия обязана перечитать уровень.
    touched.add(old_parent)
    touched.add(node.parent_id)
    for vid in touched:
        bump_view_version(db, project.id, vid)


def validate_shape_change(
    db: Session,
    node: Node,
    new_shape: NodeShape,
    *,
    parent_id: uuid.UUID | None,
) -> str | None:
    """Причина, по которой форму узла менять нельзя, либо None. Чистая проверка, без HTTP.

    Оба запрета — про то, чем узел УЖЕ владеет и чего новая форма держать не умеет:

      • ДЕТИ. Вкладывать объекты можно только в сервис (спека node.md N4, зеркало
        фронтового canHaveChildren): сменив форму контейнеру, мы оставили бы
        поддерево у формы, которая ни детей не показывает, ни внутрь не пускает.
      • СТРУКТУРА БД. Таблицы — «контракт» узла-базы (routers/db_docs.py), и страница
        рендерит их ТОЛЬКО у shape=database. Правка прошла бы, а структура исчезла из
        интерфейса, оставшись в БД: применённое-но-невидимое хуже честного отказа.
      • КАНАЛЫ БРОКЕРА. Ровно тот же довод у shape=broker (routers/broker_channels.py):
        каналы рендерятся только у брокера, и CRUD их брокером же и ограничивает —
        запрет здесь замыкает правило с другой стороны.
      • РАЗМЕЩЕНИЕ. «Пользователь» живёт вне системы, и поставить его на площадку
        нельзя (app/deployment.set_placements). Объект со своими экземплярами,
        ставший пользователем, держал бы размещение, которого не видно нигде.

    Доки логики и OpenAPI смену на person/broker не держат осознанно: страница
    показывает «неположенное» содержимое legacy-механикой (legacyLogic/legacySpec) —
    с предупреждением и без кнопок добавления, то есть унести его есть чем.

    И запреты по месту, а не по владению: база или брокер не входят в контейнер (Р6 эпика
    элементов) — объект внутри контейнера его компонент, и стать базой или брокером он
    не может; «Пользователь» живёт только на верхнем уровне (решение владельца
    2026-10-31) — вложенный объект им не становится, пока его не вынесли в корень.
    parent_id — родитель после правки (тот же запрос может и переносить): «вынести в
    корень и стать пользователем» одним запросом проходит.
    """
    if new_shape not in CONTAINER_SHAPES:
        has_children = db.query(Node.id).filter(Node.parent_id == node.id).first() is not None
        if has_children:
            return (
                "У объекта есть вложенные объекты — базой данных, брокером или "
                "«Пользователем» ему не стать"
            )
    if node.shape == "database" and new_shape != "database":
        has_tables = db.query(DbTable.id).filter(DbTable.node_id == node.id).first() is not None
        if has_tables:
            return "У узла описана структура БД — сначала перенесите или удалите её"
    if node.shape == "broker" and new_shape != "broker":
        has_channels = (
            db.query(BrokerChannel.id).filter(BrokerChannel.node_id == node.id).first()
            is not None
        )
        if has_channels:
            return "У узла описаны каналы брокера — сначала перенесите или удалите их"
    if new_shape == "person" and node.shape != "person":
        placed = (
            db.query(DeploymentInstance.id).filter(DeploymentInstance.node_id == node.id).first()
            is not None
        )
        if placed:
            return "У объекта указано размещение — у пользователя его нет, сначала снимите его"
    person = person_refusal(shape=new_shape, parent_id=parent_id, name=node.name, action="shape")
    if person:
        return person
    return store_refusal(
        project_element_rows(db, node.project_id),
        node_id=node.id,
        name=node.name,
        parent_id=parent_id,
        shape=new_shape,
        action="shape",
    )
