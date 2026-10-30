"""Вопрос «похоже на контейнер» в превью ввоза (Р7 эпика docs/plan-c4-elements.md).

Подсказка — не запись: ввоз сам элемент не выводит (без поля узел с детьми — система, Р4),
а спрашивает, когда источники кода говорят, что вложенные объекты — части одной
программы. Признак строгий, чтобы на демо и на обычных системах вопрос не возникал ложно:
- у узла P нет поля element во входе, P — сервис с детьми не внутри контейнера (его
  действующий элемент — система), и у P есть источник кода с путём (`git:repo#path`);
- каждый прямой ребёнок P — сервис с ключом кода того же репозитория и путём строго внутри
  пути P, без имени зависимости (`host:`). База, брокер, «Пользователь» и объект без
  источника кода среди детей признак гасят: контейнер базу не содержит, а объект без кода
  не похож на часть этой программы. Внуки на признак не влияют.
Ответ «Контейнер» ставит элемент слитому узлу до санитизации (дальше — обычные правила
ввоза, app/import_element), «Система» и молчание оставляют узел как есть.

Модуль чистый: дерево разбора (_ImpNode) на входе, индексы узлов на выходе; вопрос из
них собирает app/unified_remarks.
"""

from collections.abc import Callable, Sequence
from dataclasses import dataclass

from app.identity import key_type, source_ref_dict
from app.import_element import effective_elements
from app.import_yaml import _ImpNode


@dataclass(frozen=True)
class ContainerHint:
    """Узел, похожий на контейнер: его индекс, репозиторий и каталог (путь узла в
    репозитории) и прямые дети в порядке дерева."""

    node_idx: int
    repo: str
    folder: str
    children: tuple[int, ...]


def _code(keys: Sequence[str]) -> list[tuple[str, str]]:
    """(репозиторий, путь) каждого ключа кода; у ключа без пути путь пустой."""
    out: list[tuple[str, str]] = []
    for key in keys:
        if key_type(key) == "git":
            src = source_ref_dict(key)
            out.append((src.get("repo", ""), src.get("path", "")))
    return out


def _part_of(node: _ImpNode, repo: str, folder: str) -> bool:
    """Ребёнок — часть программы из каталога folder репозитория repo."""
    if node.shape != "service" or any(key_type(k) == "host" for k in node.source_keys):
        return False
    return any(r == repo and p.startswith(folder + "/") for r, p in _code(node.source_keys))


def container_hints(
    nodes: Sequence[_ImpNode], skip: Callable[[int], bool] | None = None
) -> list[ContainerHint]:
    """Узлы, о которых спросить «похоже на контейнер», в порядке дерева. skip — узлы,
    о которых не спрашивать (живые при догрузке: живое ввоз не судит, Р3)."""
    elements = effective_elements(nodes)
    children: dict[int, list[int]] = {}
    for i, n in enumerate(nodes):
        if n.parent_idx is not None:
            children.setdefault(n.parent_idx, []).append(i)
    out: list[ContainerHint] = []
    for p in sorted(children):
        parent = nodes[p]
        if parent.element is not None or parent.shape != "service" or elements[p] != "system":
            continue
        if skip is not None and skip(p):
            continue
        kids = children[p]
        for repo, folder in _code(parent.source_keys):
            if folder and all(_part_of(nodes[c], repo, folder) for c in kids):
                out.append(ContainerHint(p, repo, folder, tuple(kids)))
                break
    return out
