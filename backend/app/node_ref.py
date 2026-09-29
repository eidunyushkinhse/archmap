"""Ссылка на узел во ввозных форматах: путь и уточнители тёзок на его сегментах.

Во всех ввозных форматах узел адресуется ПУТЁМ «Корень / … / Имя»: концы связей
C4 (edges[].from/to) и адреса семей фактов («%% archmap-node:» в схемах логики,
«# archmap-node:» в структуре БД, каналах, конфигурации и спеках архива). Путь не
различает ТЁЗОК — узлы с одним именем в одном родителе — и их потомков. Законные
тёзки (якоря противоречат друг другу, мердж держит их раздельно) и тёзки без
различающего якоря (два «api», созданные руками) одинаково легальны в живом
проекте, и без различения проект с такой парой не переносился ничем, даже
собственным архивом: разбор экспорта падал на «неоднозначно».

ГРАММАТИКА. Путь режется по « / » (с пробелами) на сегменты; сегмент тёзки несёт
УТОЧНИТЕЛЬ::

    Ярмарка / Каталог-БД @ git:github.com/org/shop-db            (якорный)
    Ярмарка / api @ #2                                           (порядковый)
    Ярмарка / Каталог-БД @ git:github.com/org/shop-db / reader   (ребёнок тёзки)

Уточнитель ставится на ТОТ сегмент, где стоит тёзка, — у потомков тёзки он едет в
их путях на сегменте предка. Правило — по ГРУППЕ сиблингов одного имени: если
якоря есть у всех узлов группы и различают их, каждому пишется канонический ключ
его якоря (nodes.source_ref как есть — «git:repo», «git:repo#path» или
«host:name»); иначе ВСЕЙ группе — порядковый «#N», где N (с единицы) — позиция
узла среди тёзок в ПОРЯДКЕ ДОКУМЕНТА. Порядок документа детерминирован и не
зависит от выдачи БД: сиблинги идут по имени, а тёзки между собой — по
содержательному ключу (сериализация узла с поддеревом, document_order). Полные
двойники неразличимы, и их взаимный порядок байтам безразличен.

В ключе якоря слэши и решётка идут без пробелов (git:repo#a/b), поэтому разрез
по « / » их не задевает; ключ с « / » или « @ » внутри (ручной якорь) в уточнитель
не годится — его группа получает порядковые.

Уточнители пишутся только тёзкам и их потомкам; у остальных узлов адрес прежний
байт-в-байт. Агентам они не объявляются (промпты о них молчат) — это деталь
экспорта, а резолверы их просто понимают (RefIndex):

  1. сначала точный путь, как всегда: имя, в котором законно стоит « @ », работает;
  2. точного пути нет, но у сегмента хвост по ПОСЛЕДНЕМУ « @ » — ключ якоря или
     «#N» — путь проходится посегментно: от корней (полный путь), иначе от любого
     узла (голое имя, однозначный хвост пути); на каждом сегменте сначала
     дословное имя, иначе имя с уточнителем: якорь фильтрует тёзок, «#N» берёт
     N-го из них по порядку документа.

Уточнитель отрезается ДО любой нормализации пути: слэш-фолбэк резолверов, режущий
путь по «/», разрезал бы и ключ.
"""

import json
import re
import uuid
from collections import Counter
from collections.abc import Callable, Sequence

from app.identity import SourceRef, canonical_key, source_ref_dict
from app.models.node import Node

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


def _segment_qualifier(tail: str) -> Qualifier | None:
    """Хвост сегмента → уточнитель: «#N» (int) или ключ якоря (str); иначе None.

    Ключ приводится к канонической форме тем же кругом, что у якоря узла
    (anchor_key): человек, правящий архив руками, может написать repo со схемой
    или в другом регистре, и это всё ещё тот же ключ."""
    m = _ORDINAL.fullmatch(tail)
    if m is not None:
        return int(m.group(1))
    return anchor_key(tail)


def split_segment(segment: str) -> tuple[str, Qualifier | None]:
    """Сегмент пути → (имя, уточнитель). Уточнитель — хвост по ПОСЛЕДНЕМУ « @ »,
    если он распознаётся; иначе весь сегмент — имя (почта, декоратор в имени)."""
    head, sep, tail = segment.rpartition(QUALIFIER_SEP)
    head = head.strip()
    if sep and head:
        qualifier = _segment_qualifier(tail.strip())
        if qualifier is not None:
            return head, qualifier
    return segment.strip(), None


def tree_addresses(
    names: Sequence[str],
    parents: Sequence[int | None],
    keys: Sequence[Sequence[str]],
    anchors_only: bool = False,
) -> list[str | None]:
    """Адреса узлов дерева, данных В ПОРЯДКЕ ДОКУМЕНТА (родитель раньше детей):
    путь от корня набора, сегмент тёзки — с уточнителем.

    keys[i] — ключи якоря узла, первый — его уточнитель. Якорный режим у группы
    сиблингов одного имени — только если первый ключ каждого есть, годится в
    уточнитель и указывает ровно на него одного (у разобранного узла ключей бывает
    несколько: git и host). Иначе группа — порядковая.

    anchors_only — для перечней «укажите один из них»: порядковый номер агентам не
    объявляется, и узел, чей адрес без него не написать, получает None."""
    groups: dict[tuple[int | None, str], list[int]] = {}
    for i, (name, parent) in enumerate(zip(names, parents, strict=True)):
        groups.setdefault((parent, name), []).append(i)
    segment: list[str] = list(names)
    ordinal: set[int] = set()
    for (_parent, name), members in groups.items():
        if len(members) == 1:
            continue
        firsts = [keys[i][0] if keys[i] else None for i in members]
        if all(
            _usable(k) and sum(1 for j in members if k in keys[j]) == 1 for k in firsts
        ):
            for i, k in zip(members, firsts, strict=True):
                segment[i] = f"{name}{QUALIFIER_SEP}{k}"
        else:
            for n, i in enumerate(members, 1):
                segment[i] = f"{name}{QUALIFIER_SEP}#{n}"
                ordinal.add(i)
    out: list[str | None] = []
    for i, parent in enumerate(parents):
        head = out[parent] if parent is not None else ""
        if (parent is not None and head is None) or (anchors_only and i in ordinal):
            out.append(None)
            continue
        out.append(f"{head}{PATH_SEP}{segment[i]}" if parent is not None else segment[i])
    return out


# Шаг посегментного обхода: (сегмент дословно, имя, уточнитель).
_Step = tuple[str, str, Qualifier | None]


class RefIndex:
    """Карта узлов для ссылок с уточнителями: имена, родители и якоря В ПОРЯДКЕ
    ДОКУМЕНТА (родитель раньше детей). Строится и по разобранному документу, и по
    живым узлам (docs_import._node_paths отдаёт их в том же порядке)."""

    def __init__(
        self,
        names: Sequence[str],
        parents: Sequence[int | None],
        keys: Sequence[Sequence[str]],
    ) -> None:
        self.names = names
        self.parents = parents
        self.keys = keys
        self.roots = [i for i, p in enumerate(parents) if p is None]
        self.children: dict[int, list[int]] = {}
        for i, p in enumerate(parents):
            if p is not None:
                self.children.setdefault(p, []).append(i)

    @classmethod
    def of_flat(cls, flat: Sequence[Node]) -> "RefIndex":
        """Живые узлы в порядке документа (родитель раньше детей)."""
        pos = {n.id: i for i, n in enumerate(flat)}
        return cls(
            [n.name for n in flat],
            [pos.get(n.parent_id) if n.parent_id is not None else None for n in flat],
            [[k] if (k := anchor_key(n.source_ref)) else [] for n in flat],
        )

    def addresses(self, anchors_only: bool = False) -> list[str | None]:
        return tree_addresses(self.names, self.parents, self.keys, anchors_only)

    def resolve(self, ref: str) -> list[int] | None:
        """Кандидаты ссылки с уточнителем; None — в ссылке нет ни одного
        уточнителя (её ищут обычным порядком резолвера, здесь делать нечего).

        От корней (полный путь), иначе от любого узла (голое имя, хвост пути); не
        нашлось — то же со слэшем без пробелов внутри имён («Ярмарка/Каталог-БД @
        git:…»: слабые модели пишут путь так, а ключ со слэшами при этом цел)."""
        steps = self._steps(ref)
        if steps is None:
            return None
        hits = self._walk(steps, True) or self._walk(steps, False)
        if not hits:
            slashed = self._slashed(steps)
            if slashed != steps:
                hits = self._walk(slashed, True) or self._walk(slashed, False)
        return hits

    def resolve_full(self, ref: str) -> list[int] | None:
        """То же для адреса, который обязан быть ПОЛНЫМ путём от корня (адреса семей
        архива): хвост, голое имя и слэш-фолбэк там не угадываются."""
        steps = self._steps(ref)
        return None if steps is None else self._walk(steps, True)

    @staticmethod
    def _steps(ref: str) -> list[_Step] | None:
        steps: list[_Step] = [(seg, *split_segment(seg)) for seg in ref.split(PATH_SEP)]
        return None if all(q is None for _raw, _name, q in steps) else steps

    @staticmethod
    def _slashed(steps: list[_Step]) -> list[_Step]:
        out: list[_Step] = []
        for raw, name, q in steps:
            parts = [p.strip() for p in name.split("/") if p.strip()] or [name]
            out.extend((p, p, None) for p in parts[:-1])
            # Дословное сравнение последней части — только у сегмента без
            # уточнителя: иначе голое имя совпало бы с обоими тёзками.
            out.append((raw if q is not None or len(parts) == 1 else parts[-1], parts[-1], q))
        return out

    def _walk(self, steps: list[_Step], from_roots: bool) -> list[int]:
        cands: list[int] = []
        for depth, (raw, name, q) in enumerate(steps):
            if depth == 0:
                pool = self.roots if from_roots else list(range(len(self.names)))
            else:
                pool = [k for c in cands for k in self.children.get(c, [])]
            literal = [i for i in pool if self.names[i] == raw]
            if literal:
                cands = literal
            elif q is None:
                return []
            else:
                cands = self._pick([i for i in pool if self.names[i] == name], q)
            if not cands:
                return []
        return cands

    def _pick(self, named: list[int], q: Qualifier) -> list[int]:
        """Тёзки сегмента → те, кого называет уточнитель: ключ якоря — фильтр, «#N»
        — N-й тёзка у своего родителя по порядку документа (номер за пределами
        группы — пусто: угадывать соседа нельзя)."""
        if isinstance(q, str):
            return [i for i in named if q in self.keys[i]]
        groups: dict[int | None, list[int]] = {}
        for i in named:
            groups.setdefault(self.parents[i], []).append(i)
        return [g[q - 1] for g in groups.values() if len(g) >= q]


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
    путь от корня, у тёзок и их потомков — с уточнителями (порядковые — в порядке
    документа экспорта, том же, что у c4.yaml архива). nodes — все узлы проекта."""
    ordered = document_order(nodes)
    index = RefIndex.of_flat(ordered)
    return {n.id: a for n, a in zip(ordered, index.addresses(), strict=True) if a is not None}


def qualified_node_hits(ref: str, flat: Sequence[Node]) -> list[int]:
    """Кандидаты ссылки с уточнителем в карте узлов проекта (docs_import._node_paths:
    flat — в порядке документа) — для родных приёмников. Ссылка без уточнителя —
    пусто: её уже искали обычным порядком. Карта строится, только если в ссылке
    вообще есть « @ »: приёмники зовут помощника на каждом промахе адреса, и
    опечатке без уточнителя обход всего проекта ни к чему."""
    if QUALIFIER_SEP not in ref:
        return []
    return RefIndex.of_flat(flat).resolve(ref) or []
