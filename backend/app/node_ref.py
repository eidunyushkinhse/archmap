"""Ссылка на узел во ввозных форматах: путь и уточнитель-якорь для законных тёзок.

Во всех ввозных форматах узел адресуется ПУТЁМ «Корень / … / Имя»: концы связей
C4 (edges[].from/to) и адреса семей фактов («%% archmap-node:» в схемах логики,
«# archmap-node:» в структуре БД, каналах, конфигурации и спеках архива). Путь не
различает ЗАКОННЫХ ТЁЗОК — два узла с одним именем в одном родителе, которых мердж
держит раздельно, потому что их якоря противоречат друг другу (два «Каталог-БД» с
разными репозиториями). Без различения проект с такой парой не переносился ничем,
даже собственным архивом: разбор экспорта падал на «неоднозначно».

ГРАММАТИКА. Экспорт дописывает к НЕ уникальному пути канонический ключ якоря узла
(nodes.source_ref как есть — «git:repo», «git:repo#path» или «host:name»)::

    Ярмарка / Каталог-БД @ git:github.com/org/shop-db

Уточнитель пишется только тёзкам с якорем; у остальных узлов адрес прежний
байт-в-байт. Агентам он не объявляется (промпты о нём молчат) — это деталь
экспорта, а резолверы его просто понимают:

  1. сначала точный путь, как всегда: имя, в котором законно стоит « @ », работает;
  2. точного пути нет — хвост по ПОСЛЕДНЕМУ « @ »; если это распознаваемый ключ
     якоря, кандидаты по голове-пути фильтруются по якорю, и единственный
     оставшийся — ответ.

Уточнитель ставится ДО любой нормализации пути: в ключе законны слэши
(git:github.com/org/x) и решётка (git:repo#path), и слэш-фолбэк резолверов,
режущий путь по «/», разрезал бы и его.
"""

import uuid
from collections import Counter
from collections.abc import Sequence

from app.identity import SourceRef, canonical_key, source_ref_dict
from app.models.node import Node
from app.processes import node_path

# Разделитель пути и уточнителя. С пробелами по краям, как « / » у пути: «@» внутри
# имени (почта, декоратор) уточнителем не считается.
QUALIFIER_SEP = " @ "


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


def qualify(path: str, key: str | None) -> str:
    """Путь с уточнителем (или путь как есть, когда якоря нет)."""
    return f"{path}{QUALIFIER_SEP}{key}" if key else path


def qualified_paths(paths: Sequence[str], keys: Sequence[str | None]) -> list[str]:
    """Адреса узлов набора: уточнитель — ТОЛЬКО там, где путь в наборе не уникален
    и у узла есть якорь. Уникальность считается в пределах переданного набора
    (поддерево экспорта — свой набор)."""
    counts = Counter(paths)
    return [
        qualify(p, k) if counts[p] > 1 else p for p, k in zip(paths, keys, strict=True)
    ]


def split_ref(ref: str) -> tuple[str, str] | None:
    """Ссылка → (голова-путь, ключ якоря), если хвост по ПОСЛЕДНЕМУ « @ » —
    распознаваемый ключ; иначе None (ссылка без уточнителя).

    Ключ приводится к канонической форме тем же кругом, что у якоря узла
    (anchor_key): человек, правящий архив руками, может написать repo со схемой
    или в другом регистре, и это всё ещё тот же ключ."""
    head, sep, tail = ref.rpartition(QUALIFIER_SEP)
    head = head.strip()
    if not sep or not head:
        return None
    key = anchor_key(tail.strip())
    return (head, key) if key else None


def node_addresses(nodes: Sequence[Node]) -> dict[uuid.UUID, str]:
    """Адрес каждого узла ПРОЕКТА для файлов семей («# archmap-node: …»): полный
    путь от корня, у законных тёзок — с уточнителем. nodes — все узлы проекта."""
    by_id = {n.id: n for n in nodes}
    ids = list(by_id)
    return dict(zip(
        ids,
        qualified_paths(
            [node_path(by_id, i) for i in ids], [anchor_key(by_id[i].source_ref) for i in ids]
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
    """Кандидаты ссылки с уточнителем в карте узлов проекта (docs_import._node_paths)
    — для родных приёмников семей: голова ищется их же порядком (точный путь, голое
    имя, однозначный хвост пути), потом фильтр по якорю узла. Ссылка без
    уточнителя — пусто: её уже искали обычным порядком."""
    split = split_ref(ref)
    if split is None:
        return []
    head, key = split
    hits = by_path.get(head) or by_bare.get(head) or [
        i for i, full in enumerate(fulls) if full.endswith(f" / {head}")
    ]
    return [i for i in hits if anchor_key(flat[i].source_ref) == key]
