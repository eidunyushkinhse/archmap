"""Доменное ядро бизнес-процессов: канал → плечи и проекция концов.

Связь C4 (Edge) — не одна стрелка, а «канал с плечами»: синхронный канал отдаёт
два плеча (вызов forward + ответ return), асинхронный — одно (forward, рисуется как
событие). Синхронность задаётся явно тумблером в UI связи (Edge.is_synchronous;
дефолт — синхронный). Это «запертый
слой» из ТЗ §0: сообщение процесса может ссылаться только на легальное плечо
существующего канала, концы которого проецируются на участников процесса.
"""

import uuid
from dataclasses import dataclass

from app.models.edge import Edge
from app.models.node import Node
from app.tree import ancestors


def edge_is_synchronous(edge: Edge) -> bool:
    """Синхронен ли канал. Задаётся явно тумблером в UI связи (Edge.is_synchronous).
    Авто-определения по технологии больше нет: оно зависело от текста, что неочевидно.
    Дефолт для связей без явного значения (null, в т.ч. легаси) — синхронный."""
    return edge.is_synchronous if edge.is_synchronous is not None else True


@dataclass(frozen=True)
class Leg:
    """Плечо канала. kind — производное для рендера (forward/return/async)."""

    leg: str  # "forward" | "return" — что хранится на сообщении
    kind: str  # "forward" | "return" | "async" — стиль стрелки
    from_id: uuid.UUID  # сырой конец-источник (узел C4)
    to_id: uuid.UUID  # сырой конец-цель (узел C4)
    default_caption: str | None  # подпись по умолчанию


def legs_for_edge(edge: Edge) -> list[Leg]:
    """Набор плеч канала: forward всегда; return — только для синхронного."""
    sync = edge_is_synchronous(edge)
    legs = [
        Leg(
            leg="forward",
            kind="forward" if sync else "async",
            from_id=edge.source_id,
            to_id=edge.target_id,
            default_caption=edge.label,
        )
    ]
    if sync:
        legs.append(
            Leg(
                leg="return",
                kind="return",
                from_id=edge.target_id,
                to_id=edge.source_id,
                default_caption="ответ",
            )
        )
    return legs


def resolve_to_participant(
    node_id: uuid.UUID,
    participant_ids: set[uuid.UUID],
    all_nodes: dict[uuid.UUID, Node],
) -> uuid.UUID | None:
    """Ближайший участник, покрывающий конец ребра: сам узел или ближайший
    предок-участник (самый глубокий). None — конец не покрыт ни одним участником.

    Покрывает и прямые, и сквозные связи (конец вглубь чужого поддерева проецируется
    на предка-участника).
    """
    if node_id in participant_ids:
        return node_id
    # ancestors() даёт корень→родитель; реверс → идём от ближайшего предка вверх,
    # берём первого участника (самый глубокий побеждает).
    for a in reversed(ancestors(all_nodes, node_id)):
        if a.id in participant_ids:
            return a.id
    return None
