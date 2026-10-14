"""«Принять переход» (app/transition.py): план и итог. Вынесены из schemas/node.py
(аудит Q-42)."""

import uuid

from pydantic import BaseModel


class TransitionNodeOut(BaseModel):
    """Объект в плане перехода: показываем именем и путём — id нужен только коду."""

    id: uuid.UUID
    name: str
    path: str


class TransitionPreviewOut(BaseModel):
    """Что произойдёт, если принять переход. Ничего не записано."""

    graph_rev: int
    is_noop: bool
    # Верхние выводимые узлы (их поддеревья уедут каскадом).
    delete: list[TransitionNodeOut] = []
    # Сколько узлов исчезнет ВСЕГО, вместе с потомками.
    delete_total: int = 0
    # Уезжающие ЗАОДНО: устаревшими их никто не помечал, они просто лежат внутри.
    # Главное, что должно быть видно до подтверждения.
    collateral: list[TransitionNodeOut] = []
    delete_edges: int = 0
    delete_docs: int = 0
    delete_specs: int = 0
    promote: list[TransitionNodeOut] = []


class TransitionApplyIn(BaseModel):
    """Курсор схемы, увиденный в превью: если схему успели изменить, применение
    отклоняется, а не выполняет вслепую не то, что человек видел."""

    base_graph_rev: int | None = None


class TransitionApplyOut(BaseModel):
    deleted_nodes: int
    promoted_nodes: int
