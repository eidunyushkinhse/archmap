"""Ответы инструментов — текстом, а не сырым JSON.

Почему так: инструменты читает языковая модель. Сырой ответ /nodes/graph несёт
uuid, версии, координаты и цепочки предков — для агента это шум, который он
оплачивает контекстом и в котором теряет суть. Здесь то же содержание
сворачивается в компактный текст: дерево с отступами, связи стрелками, планы —
счётчиками и списком.

Uuid остаются там, где агент обязан ими оперировать дальше (правки узла/связи),
и убираются оттуда, где нужен только смысл.
"""

from __future__ import annotations

from typing import Any

SHAPE_WORD = {
    "service": "сервис",
    "database": "БД",
    "broker": "брокер",
    "person": "пользователь",
}
STATUS_WORD = {"existing": "", "planned": "запланирован", "deprecated": "выводится"}


def node_line(node: dict[str, Any], *, with_id: bool = True) -> str:
    """Строка объекта: имя, форма, технология, статус, внешность, id."""
    bits: list[str] = []
    shape = SHAPE_WORD.get(str(node.get("shape")), str(node.get("shape") or ""))
    if shape:
        bits.append(shape)
    if node.get("role"):
        bits.append(str(node["role"]))
    if node.get("technology"):
        bits.append(str(node["technology"]))
    status = STATUS_WORD.get(str(node.get("status")), "")
    if status:
        bits.append(status)
    if node.get("is_external"):
        bits.append("внешний")
    tail = f" [{', '.join(bits)}]" if bits else ""
    ident = f"  id={node['id']}" if with_id and node.get("id") else ""
    return f"{node.get('name', '?')}{tail}{ident}"


def tree(nodes: list[dict[str, Any]], *, with_ids: bool = True) -> str:
    """Дерево объектов отступами. Порядок — по имени внутри уровня: агенту важна
    предсказуемость вывода, а не порядок вставки."""
    kids: dict[str | None, list[dict[str, Any]]] = {}
    for n in nodes:
        kids.setdefault(n.get("parent_id"), []).append(n)
    for group in kids.values():
        group.sort(key=lambda n: str(n.get("name", "")))

    lines: list[str] = []

    def walk(parent: str | None, depth: int) -> None:
        for n in kids.get(parent, []):
            lines.append("  " * depth + "• " + node_line(n, with_id=with_ids))
            walk(str(n["id"]), depth + 1)

    walk(None, 0)
    return "\n".join(lines) if lines else "(объектов нет)"


def edges(edge_list: list[dict[str, Any]], names: dict[str, str], *, with_ids: bool = True) -> str:
    """Связи стрелками: «A → B [подпись, технология, канал]»."""
    if not edge_list:
        return "(связей нет)"
    out: list[str] = []
    for e in sorted(
        edge_list,
        key=lambda e: (names.get(str(e.get("source_id")), ""), names.get(str(e.get("target_id")), "")),
    ):
        bits = [str(e[k]) for k in ("label", "technology") if e.get(k)]
        # is_synchronous: null = синхронная по умолчанию, явное false — событие.
        if e.get("is_synchronous") is False:
            bits.append("асинхронная")
        tail = f" [{', '.join(bits)}]" if bits else ""
        ident = f"  id={e['id']}" if with_ids and e.get("id") else ""
        src = names.get(str(e.get("source_id")), "?")
        tgt = names.get(str(e.get("target_id")), "?")
        out.append(f"{src} → {tgt}{tail}{ident}")
    return "\n".join(out)


def path_of(node_id: str, by_id: dict[str, dict[str, Any]]) -> str:
    """Путь объекта от корня — тот же вид, что в интерфейсе («A / B / C»)."""
    parts: list[str] = []
    cur: dict[str, Any] | None = by_id.get(node_id)
    seen: set[str] = set()
    while cur is not None and str(cur["id"]) not in seen:
        seen.add(str(cur["id"]))
        parts.append(str(cur.get("name", "?")))
        parent = cur.get("parent_id")
        cur = by_id.get(str(parent)) if parent else None
    return " / ".join(reversed(parts))


def alerts(data: dict[str, Any]) -> str:
    """Незавершённость схемы — по классам, с именами, а не идентификаторами."""
    blocks: list[str] = []

    def add(title: str, items: list[str]) -> None:
        if items:
            blocks.append(f"{title} ({len(items)}):\n" + "\n".join("  • " + i for i in items))

    add("Объекты без связей", [str(d["node_name"]) for d in data.get("disconnected_nodes", [])])
    add(
        "Связи в контейнер",
        [f"{e['source_name']} → {e['target_name']}" for e in data.get("intermediate_edges", [])],
    )
    add(
        "Изолированные группы",
        [", ".join(str(x) for x in g.get("node_names", [])) for g in data.get("isolated_groups", [])],
    )
    add(
        "Контейнер со своей документацией",
        [str(c["node_name"]) for c in data.get("container_own_docs", [])],
    )
    add(
        "Пользователи внутри контейнера",
        [f"{p['node_name']} внутри {p['parent_name']}" for p in data.get("persons_inside", [])],
    )
    add(
        "Незадокументированные сообщения",
        [
            f"{m['process_name']}: {m.get('caption') or 'без подписи'} ({m['from_name']} → {m['to_name']})"
            for m in data.get("dangling_messages", [])
        ],
    )
    if not blocks:
        return "Замечаний нет — схема завершена."
    return "\n\n".join(blocks)
