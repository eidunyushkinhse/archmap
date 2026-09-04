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


def _plural(n: int, forms: tuple[str, str, str]) -> str:
    """Русское согласование числительного (зеркало ui/plural.ts фронта)."""
    tens = n % 100
    if 11 <= tens <= 14:
        return forms[2]
    ones = n % 10
    if ones == 1:
        return forms[0]
    if 2 <= ones <= 4:
        return forms[1]
    return forms[2]


# Почему пометка не срослась. Слова — дословно из панели SchemaAlerts.tsx
# (REF_REASON / CHANNEL_REASON): агент и человек обязаны называть проблему
# одинаково, иначе разговор о схеме идёт на двух языках.
DATA_REASON = {
    "unknown_table": "таблица не найдена",
    "ambiguous": "имя неоднозначно — укажите „БД / таблица“",
    "unknown_column": "колонки нет в таблице",
}
CHANNEL_REASON = {
    "unknown_channel": "канал не найден у брокеров проекта",
    "ambiguous": "имя неоднозначно — укажите „Брокер / канал“",
    "unknown_field": "поля нет в канале",
}
# Пометка «зависит от:» причины не несёт — она единственная (AL33), поэтому текст
# постоянный и, как в панели, называет ОБА выхода: описать ручку или переписать фразу.
CONFIG_REASON = (
    "параметра нет в конфигурации объекта: опишите его или, "
    "если это обычная фраза, уберите двоеточие"
)


def _caption(item: dict[str, Any]) -> str:
    return f"«{item['caption']}»" if item.get("caption") else "без подписи"


def alerts(data: dict[str, Any]) -> str:
    """Незавершённость схемы — 15 классов в порядке, заголовках и словах панели
    SchemaAlerts.tsx (решение 7 плана эпика «Доработка MCP-сервера»).

    Читается это агентом, а показывается человеку панелью — значит и называться
    должно одинаково: расхождение слов дороже любой экономии контекста.

    Все списки берутся через .get(..., []): сервер старше клиента новых классов не
    отдаёт вовсе, и рендер обязан это пережить, а не упасть на KeyError.
    """
    def lst(key: str) -> list[dict[str, Any]]:
        value = data.get(key) or []
        return list(value) if isinstance(value, list) else []

    disconnected = lst("disconnected_nodes")
    intermediate = lst("intermediate_edges")
    descendant = lst("descendant_edges")
    isolated = lst("isolated_groups")
    container_own = lst("container_own_docs")
    data_refs = lst("unresolved_data_refs")
    channel_refs = lst("unresolved_channel_refs")
    config_refs = lst("unresolved_config_refs")
    broker_edges = lst("broker_edge_channels")
    dangling = lst("dangling_messages")
    orphan_legs = lst("orphan_legs")
    unbound = lst("unbound_participants")
    unlinked = lst("unlinked_messages")
    undescribed = lst("undescribed_docs")
    persons_inside = lst("persons_inside")

    blocks: list[str] = []

    def add(title: str, items: list[str]) -> None:
        if items:
            blocks.append(f"{title} ({len(items)}):\n" + "\n".join("  • " + i for i in items))

    def end(name: str, marked: bool) -> str:
        """Конец связи: проблемный выделяется кавычками — в панели он подсвечен."""
        return f"«{name}»" if marked else name

    add("Объекты без связей", [str(d["node_name"]) for d in disconnected])
    add(
        "Связи в контейнер",
        [
            f"{end(str(e['source_name']), bool(e.get('source_is_intermediate')))} → "
            f"{end(str(e['target_name']), bool(e.get('target_is_intermediate')))}"
            for e in intermediate
        ],
    )
    add(
        "Связи в собственный компонент",
        [
            f"{e['source_name']} → {e['target_name']}: "
            f"«{e['source_name'] if e.get('source_is_part') else e['target_name']}» — часть "
            f"«{e['target_name'] if e.get('source_is_part') else e['source_name']}»; "
            "иерархия уже выражает вложенность — удалите связь или перевесьте её"
            for e in descendant
        ],
    )
    add(
        "Изолированные группы",
        [
            f"Группа {i + 1}: " + ", ".join(str(x) for x in g.get("node_names", []))
            for i, g in enumerate(isolated)
        ],
    )
    add("Контейнеры со своей документацией", [str(c["node_name"]) for c in container_own])
    add(
        "Обращения к неописанным данным",
        [
            f"{r['node_name']} · {r['doc_name']}: „{r['ref']}“ — "
            f"{DATA_REASON.get(str(r.get('reason')), str(r.get('reason')))}"
            for r in data_refs
        ],
    )
    add(
        "Обращения к неописанным каналам",
        [
            f"{r['node_name']} · {r['doc_name']}: „{r['ref']}“ — "
            f"{CHANNEL_REASON.get(str(r.get('reason')), str(r.get('reason')))}"
            for r in channel_refs
        ],
    )
    add(
        "Обращения к неописанным параметрам",
        [f"{r['node_name']} · {r['doc_name']}: „{r['ref']}“ — {CONFIG_REASON}" for r in config_refs],
    )
    add(
        "Связи с брокером без канала",
        [
            f"{b['source_name']} → {b['target_name']}: "
            + (
                "канал не указан"
                if b.get("reason") == "missing"
                else f"канал «{b.get('channel')}» не найден у брокера «{b['broker_name']}»"
            )
            for b in broker_edges
        ],
    )
    add(
        "Незадокументированные сообщения",
        [f"{m['process_name']}: {_caption(m)} ({m['from_name']} → {m['to_name']})" for m in dangling],
    )
    add(
        "Ответ на асинхронном канале",
        [
            f"{m['process_name']}: {_caption(m)} ({m['from_name']} → {m['to_name']}"
            + (f" · канал «{m['edge_label']}»" if m.get("edge_label") else "")
            + ")"
            for m in orphan_legs
        ],
    )
    add(
        "Незадокументированные участники",
        [f"{p['process_name']}: {p['name']}" for p in unbound],
    )
    add(
        "Шаги без схемы логики",
        [f"{m['process_name']}: {_caption(m)} ({m['from_name']} → {m['to_name']})" for m in unlinked],
    )
    add(
        "Объекты с неописанными схемами логики",
        [
            f"{u['node_name']} — {u['count']} {_plural(int(u['count']), ('схема', 'схемы', 'схем'))}"
            for u in undescribed
        ],
    )
    add(
        "Пользователи внутри контейнера",
        [f"{p['node_name']} внутри {p['parent_name']}" for p in persons_inside],
    )

    if not blocks:
        return "Замечаний нет — схема завершена."

    # Общий счётчик — как бабл панели: изолированные группы дают не число групп, а
    # число НЕДОСТАЮЩИХ связей (групп − 1), остальные классы — по записи.
    total = (
        len(disconnected) + len(intermediate) + len(descendant) + max(0, len(isolated) - 1)
        + len(container_own) + len(data_refs) + len(channel_refs) + len(config_refs)
        + len(broker_edges) + len(dangling) + len(orphan_legs) + len(unbound)
        + len(unlinked) + len(undescribed) + len(persons_inside)
    )
    head = f"Замечаний: {total}"
    return head + "\n\n" + "\n\n".join(blocks)
