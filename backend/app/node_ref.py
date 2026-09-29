"""Ссылка на узел во ввозных форматах: путь и уточнитель для тёзок.

Во всех ввозных форматах узел адресуется ПУТЁМ «Корень / … / Имя»: концы связей
C4 (edges[].from/to) и адреса семей фактов («%% archmap-node:» в схемах логики,
«# archmap-node:» в структуре БД, каналах, конфигурации и спеках архива). Путь не
различает ТЁЗОК — узлы с одним именем в одном родителе. Законные тёзки (якоря
противоречат друг другу, мердж держит их раздельно) и тёзки без различающего якоря
(два «api», созданные руками) одинаково легальны в живом проекте, и без различения
проект с такой парой не переносился ничем, даже собственным архивом: разбор
экспорта падал на «неоднозначно».

ГРАММАТИКА. Экспорт дописывает к НЕ уникальному пути УТОЧНИТЕЛЬ::

    Ярмарка / Каталог-БД @ git:github.com/org/shop-db     (якорный)
    Ярмарка / api @ #2                                     (порядковый)

Правило — по ГРУППЕ узлов одного пути: если якоря есть у всех узлов группы и
попарно различны, каждому пишется канонический ключ его якоря (nodes.source_ref
как есть — «git:repo», «git:repo#path» или «host:name»); иначе ВСЕЙ группе —
порядковый «#N», где N (с единицы) — позиция узла среди узлов этого пути в
ПОРЯДКЕ ДОКУМЕНТА. Порядок документа детерминирован и не зависит от выдачи БД:
сиблинги идут по имени, а тёзки между собой — по содержательному ключу
(сериализация узла с поддеревом, document_order). Полные двойники неразличимы, и
их взаимный порядок байтам безразличен.

Уточнитель пишется только тёзкам; у остальных узлов адрес прежний байт-в-байт.
Агентам он не объявляется (промпты о нём молчат) — это деталь экспорта, а
резолверы его просто понимают:

  1. сначала точный путь, как всегда: имя, в котором законно стоит « @ », работает;
  2. точного пути нет — хвост по ПОСЛЕДНЕМУ « @ »; если это ключ якоря, кандидаты
     по голове-пути фильтруются по якорю, если «#N» — берётся N-й из кандидатов
     одного пути в порядке документа; единственный оставшийся — ответ.

Уточнитель ставится ДО любой нормализации пути: в ключе законны слэши
(git:github.com/org/x) и решётка (git:repo#path), и слэш-фолбэк резолверов,
режущий путь по «/», разрезал бы и его.
"""

import json
import re
import uuid
from collections import Counter
from collections.abc import Callable, Iterable, Sequence

from app.identity import SourceRef, canonical_key, source_ref_dict
from app.models.node import Node
from app.processes import node_path

# Разделитель пути и уточнителя. С пробелами по краям, как « / » у пути: «@» внутри
# имени (почта, декоратор) уточнителем не считается.
QUALIFIER_SEP = " @ "
# Разделитель сегментов пути (тот же, что у processes.node_path).
PATH_SEP = " / "
# Порядковый уточнитель: «#1», «#2»… — без ведущих нулей, чтобы у одного узла
# была ровно одна запись.
_ORDINAL = re.compile(r"#([1-9]\d*)")

# Уточнитель ссылки: ключ якоря (str) либо порядковый номер среди тёзок (int).
Qualifier = str | int


def anchor_key(source_ref: str | None) -> str | None:
    """Ключ якоря узла в ТОЙ форме, в какой его соберёт разбор, — или None.

    Экспорт пишет якорь словарём source (source_ref_dict), разбор собирает из него
    канонический ключ заново. Уточнитель обязан совпасть с собранным, поэтому
    проходит тот же круг: ключ снятого вида («img:»/«k8s:») или петлевой адрес
    якорем не станет и уточнителем тоже."""
    if not source_ref:
        return None
    parts = source_ref_dict(source_ref)
    return canonical_key(SourceRef(**parts)) if parts else None


def _usable(key: str | None) -> bool:
    """Годится ли ключ в уточнитель: разделители пути и уточнителя внутри ключа
    (ручной якорь с пробелами вокруг «/» или «@») разрезали бы адрес при разборе.
    Такая группа тёзок получает порядковые уточнители."""
    return key is not None and key != "" and PATH_SEP not in key and QUALIFIER_SEP not in key


def qualify(path: str, key: str | None) -> str:
    """Путь с якорным уточнителем (или путь как есть, когда якоря нет)."""
    return f"{path}{QUALIFIER_SEP}{key}" if key else path


def ordinal(path: str, n: int) -> str:
    """Путь с порядковым уточнителем «#N» (N — с единицы)."""
    return f"{path}{QUALIFIER_SEP}#{n}"


def qualified_paths(paths: Sequence[str], keys: Sequence[str | None]) -> list[str]:
    """Адреса узлов набора В ПОРЯДКЕ ДОКУМЕНТА: уточнитель — ТОЛЬКО там, где путь в
    наборе не уникален. Правило по группе одного пути: у всех якоря есть и попарно
    различны — якорные уточнители, иначе всей группе порядковые (позиция в группе
    по порядку документа). Уникальность считается в пределах переданного набора
    (поддерево экспорта — свой набор)."""
    groups: dict[str, list[int]] = {}
    for i, p in enumerate(paths):
        groups.setdefault(p, []).append(i)
    out = list(paths)
    for p, members in groups.items():
        if len(members) == 1:
            continue
        member_keys = [keys[i] for i in members]
        if all(_usable(k) for k in member_keys) and len(set(member_keys)) == len(members):
            for i in members:
                out[i] = qualify(p, keys[i])
        else:
            for n, i in enumerate(members, 1):
                out[i] = ordinal(p, n)
    return out


def split_ref(ref: str) -> tuple[str, Qualifier] | None:
    """Ссылка → (голова-путь, уточнитель), если хвост по ПОСЛЕДНЕМУ « @ » —
    распознаваемый уточнитель: ключ якоря (str) или «#N» (int); иначе None
    (ссылка без уточнителя).

    Ключ приводится к канонической форме тем же кругом, что у якоря узла
    (anchor_key): человек, правящий архив руками, может написать repo со схемой
    или в другом регистре, и это всё ещё тот же ключ."""
    head, sep, tail = ref.rpartition(QUALIFIER_SEP)
    head, tail = head.strip(), tail.strip()
    if not sep or not head:
        return None
    m = _ORDINAL.fullmatch(tail)
    if m is not None:
        return head, int(m.group(1))
    key = anchor_key(tail)
    return (head, key) if key else None


def pick(
    hits: Iterable[int],
    qualifier: Qualifier,
    keys_of: Callable[[int], Sequence[str]],
    group_of: Callable[[int], object],
) -> list[int]:
    """Кандидаты головы ссылки → те, кого называет уточнитель.

    Ключ якоря — фильтр по якорям кандидата. «#N» — N-й кандидат своей группы
    (group_of — путь узла: «N-й из узлов одного пути»); кандидаты приходят в
    порядке документа. Порядковый номер за пределами группы — пусто: угадывать
    соседа нельзя."""
    if isinstance(qualifier, str):
        return [i for i in hits if qualifier in keys_of(i)]
    groups: dict[object, list[int]] = {}
    for i in hits:
        groups.setdefault(group_of(i), []).append(i)
    return [g[qualifier - 1] for g in groups.values() if len(g) >= qualifier]


# ── Порядок документа ────────────────────────────────────────────────────────


def _roots_and_kids(nodes: Sequence[Node]) -> tuple[list[Node], dict[uuid.UUID, list[Node]]]:
    """Корни набора (родитель вне набора) и дети по родителю — в порядке входа."""
    ids = {n.id for n in nodes}
    roots: list[Node] = []
    kids: dict[uuid.UUID, list[Node]] = {}
    for n in nodes:
        if n.parent_id is not None and n.parent_id in ids:
            kids.setdefault(n.parent_id, []).append(n)
        else:
            roots.append(n)
    return roots, kids


class _Order:
    """Сортировка сиблингов порядка документа: по имени, тёзки — по содержательному
    ключу (сериализация узла с поддеревом). Ключ считается лениво и только для
    тёзок: без них сортировка та же, что всегда (по имени), и стоит столько же."""

    def __init__(self, kids: dict[uuid.UUID, list[Node]]) -> None:
        self.kids = kids
        self.memo: dict[uuid.UUID, str] = {}

    def content_key(self, n: Node) -> str:
        """Всё, что экспорт пишет об узле и его поддереве, — кроме координат и
        знания (схем, фактов), которых в C4 нет. Значения в той форме, в какой их
        восстановит разбор: пустое описание и отсутствие описания — одно и то же."""
        key = self.memo.get(n.id)
        if key is None:
            key = json.dumps(
                [
                    n.name, n.shape or "", n.status or "", n.role or "", n.technology or "",
                    bool(n.is_external), n.description or "", anchor_key(n.source_ref) or "",
                    [self.content_key(k) for k in self.sort(self.kids.get(n.id, []))],
                ],
                ensure_ascii=False,
            )
            self.memo[n.id] = key
        return key

    def sort(self, group: Sequence[Node]) -> list[Node]:
        by_name = sorted(group, key=lambda n: n.name)
        names = Counter(n.name for n in by_name)
        if all(c == 1 for c in names.values()):
            return by_name
        # Сортировка устойчива: полные двойники остаются в порядке входа.
        return sorted(
            by_name, key=lambda n: (n.name, self.content_key(n) if names[n.name] > 1 else "")
        )


def sibling_sorter(nodes: Sequence[Node]) -> Callable[[Sequence[Node]], list[Node]]:
    """Сортировщик групп сиблингов набора в порядке документа (для обходов, которые
    строят свои карты сами, — docs_import._node_paths)."""
    return _Order(_roots_and_kids(nodes)[1]).sort


def document_order(nodes: Sequence[Node]) -> list[Node]:
    """Узлы набора в ПОРЯДКЕ ДОКУМЕНТА экспорта: обход в глубину, родитель раньше
    детей, сиблинги по имени, тёзки — по содержательному ключу. Корни набора —
    узлы, чей родитель вне набора (у поддерева это его корень)."""
    roots, kids = _roots_and_kids(nodes)
    order = _Order(kids)
    out: list[Node] = []

    def walk(n: Node) -> None:
        out.append(n)
        for k in order.sort(kids.get(n.id, [])):
            walk(k)

    for r in order.sort(roots):
        walk(r)
    return out


def node_addresses(nodes: Sequence[Node]) -> dict[uuid.UUID, str]:
    """Адрес каждого узла ПРОЕКТА для файлов семей («# archmap-node: …»): полный
    путь от корня, у тёзок — с уточнителем (порядковый — в порядке документа
    экспорта, тот же, что у c4.yaml архива). nodes — все узлы проекта."""
    ordered = document_order(nodes)
    by_id = {n.id: n for n in nodes}
    return dict(zip(
        (n.id for n in ordered),
        qualified_paths(
            [node_path(by_id, n.id) for n in ordered],
            [anchor_key(n.source_ref) for n in ordered],
        ),
        strict=True,
    ))


def anchored_node_hits(
    ref: str,
    flat: Sequence[Node],
    fulls: Sequence[str],
    by_bare: dict[str, list[int]],
    by_path: dict[str, list[int]],
) -> list[int]:
    """Кандидаты ссылки с уточнителем в карте узлов проекта (docs_import._node_paths:
    flat — в порядке документа) — для родных приёмников семей: голова ищется их же
    порядком (точный путь, голое имя, однозначный хвост пути), потом уточнитель.
    Ссылка без уточнителя — пусто: её уже искали обычным порядком."""
    split = split_ref(ref)
    if split is None:
        return []
    head, qualifier = split
    hits = by_path.get(head) or by_bare.get(head) or [
        i for i, full in enumerate(fulls) if full.endswith(f" / {head}")
    ]
    return pick(
        hits,
        qualifier,
        lambda i: [k] if (k := anchor_key(flat[i].source_ref)) else [],
        lambda i: fulls[i],
    )
