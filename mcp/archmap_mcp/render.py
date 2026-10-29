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

import json
from datetime import UTC, datetime
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


# ── Якорь объекта (docs/plan-anchor-ux.md) ───────────────────────────────────
#
# Якорь — чем ArchMap опознаёт объект при обновлениях из кода (мердж нескольких
# файлов, догрузка архивов, синк). Видов ровно два: КОД (репозиторий и путь в
# нём) и ИМЯ ЗАВИСИМОСТИ (как продукт сам называет базу, брокер или соседний
# продукт). Слова здесь — ДОСЛОВНАЯ копия словаря интерфейса
# (frontend/src/components/anchor/anchorText.ts): агент и человек обязаны
# называть одно и то же одинаково, иначе разговор о схеме расходится с тем, что
# пользователь видит на экране (инвариант N36 docs/specs/node.md).

KIND_LABEL = {"code": "код", "dependency": "имя зависимости"}
BASIS_LABEL = {"code": "по коду", "dependency": "по имени зависимости", "name": "по имени"}
NO_ANCHOR = "нет — опознаётся по имени"


def anchor_kind(source: dict[str, Any] | None) -> str | None:
    """Вид источника словом-ключом: code | dependency | None (источника нет)."""
    if not source:
        return None
    if source.get("repo"):
        return "code"
    return "dependency" if source.get("host") else None


def anchor_readable(source: dict[str, Any]) -> str:
    """Источник в человеческий вид: «github.com/org/repo, путь src/api» / «payments»."""
    if source.get("repo"):
        path = source.get("path")
        return f"{source['repo']}, путь {path}" if path else str(source["repo"])
    return str(source.get("host") or "")


def anchor_value(source: dict[str, Any] | None) -> str:
    """Значение поля «Источник»: вид и сам источник либо объяснение последствия."""
    kind = anchor_kind(source)
    if not source or not kind:
        return NO_ANCHOR
    return f"{KIND_LABEL[kind]} {anchor_readable(source)}"


def anchor_line(node: dict[str, Any]) -> str:
    """Строка карточки объекта. Читаем разобранный source, а не source_ref:
    ключ хранения — внутренность, агенту незачем разбирать его самому."""
    return f"Источник: {anchor_value(node.get('source'))}"


# ── Статус страницы объекта (docs/tasks/page-status.md) ───────────────────────
#
# Статус ДОКУМЕНТАЦИИ, а не жизненный цикл (тот — STATUS_WORD выше). Слова — те же,
# что на пилюле страницы (frontend/src/components/nodeTerms.ts, APPROVAL_LABEL),
# строчными: агент и человек называют статус одинаково.
APPROVAL_WORD = {"in_progress": "в работе", "approved": "согласовано"}


def approval_line(node: dict[str, Any], children: list[dict[str, Any]]) -> str | None:
    """Строка карточки «Статус страницы: …». У листа — его статус; у контейнера —
    статус, вычисленный сервером по детям (approval_effective), и счётчик согласованных
    прямых детей. Сервер, который статуса страниц не знает, поля не отдаёт — тогда
    строки нет: выдуманное «в работе» было бы неправдой."""
    value = node.get("approval_effective")
    if value is None:
        return None
    word = APPROVAL_WORD.get(str(value), str(value))
    if not node.get("has_children"):
        return f"Статус страницы: {word}"
    done = sum(1 for c in children if c.get("approval_effective") == "approved")
    return (
        f"Статус страницы: {word} — складывается из детей, "
        f"согласовано {done} из {len(children)}"
    )


# ── Размещение на площадках (docs/tasks/deployment-view.md) ───────────────────
#
# Площадка — где крутится объект: облако, кластер, ВМ, сервер. В карточке объекта —
# только имена (строка «Размещение» страницы объекта); вид площадки словом — в
# archmap_deployment, где площадки показываются деревом. Один словарь на модуль.
SITE_KIND_WORD = {
    "cloud": "облако",
    "kubernetes": "kubernetes",
    "vm": "вм",
    "physical": "сервер",
    "other": "другое",
}
NO_SITES = (
    "Площадок нет: размещение задаётся на холсте «Развёртывание» или разделом "
    "deployment в YAML импорта"
)
PLACEMENT_CAP = 20  # объектов на площадку и в «Без размещения»: дальше — счётчиком


def _site_name(s: dict[str, Any]) -> str:
    """Площадка строкой карточки: «Кластер prod (в Облако)»; у контейнера площадка, где
    стоит часть его объектов, — «(в Облако, часть объектов)» / «(часть объектов)»."""
    notes = [f"в {s['parent_name']}"] if s.get("parent_name") else []
    if s.get("partial"):
        notes.append("часть объектов")
    name = str(s.get("name", "?"))
    return f"{name} ({', '.join(notes)})" if notes else name


def placement_line(node: dict[str, Any]) -> str | None:
    """Строка карточки «Размещение: Кластер prod (в Облако), ВМ-2» — площадки объекта
    (NodeResponse.sites); у контейнера — площадки его объектов, частичные помечены.
    Пусто — строки нет."""
    sites = list(node.get("sites") or [])
    if not sites:
        return None
    return "Размещение: " + ", ".join(_site_name(s) for s in sites)


def site_label(site: dict[str, Any]) -> str:
    """Площадка строкой дерева: «Облако [облако, Yandex Cloud]»."""
    bits = [SITE_KIND_WORD.get(str(site.get("kind")), str(site.get("kind") or ""))]
    if site.get("technology"):
        bits.append(str(site["technology"]))
    return f"{site.get('name', '?')} [{', '.join(b for b in bits if b)}]"


def site_paths(sites: list[dict[str, Any]]) -> dict[str, str]:
    """id площадки → путь от корневой («Облако / Кластер prod»); подъём с seen."""
    by_id = {str(s["id"]): s for s in sites}
    out: dict[str, str] = {}
    for sid, site in by_id.items():
        parts: list[str] = []
        seen: set[str] = set()
        cur: dict[str, Any] | None = site
        while cur is not None and str(cur["id"]) not in seen:
            seen.add(str(cur["id"]))
            parts.append(str(cur.get("name", "?")))
            parent = cur.get("parent_id")
            cur = by_id.get(str(parent)) if parent else None
        out[sid] = " / ".join(reversed(parts))
    return out


def _objects(n: int) -> str:
    return f"{n} {_plural(n, ('объект', 'объекта', 'объектов'))}"


def _site_members(nodes: list[dict[str, Any]]) -> dict[str, list[tuple[dict[str, Any], int]]]:
    """Состав площадок: площадка → [(узел, объектов в нём)]. Контейнер, все объекты
    которого стоят на одном наборе площадок (sites без partial), — одной строкой со
    счётчиком объектов, внутрь не спускаемся; иначе — его объекты по отдельности."""
    kids_of: dict[str | None, list[dict[str, Any]]] = {}
    for n in nodes:
        parent = str(n["parent_id"]) if n.get("parent_id") else None
        kids_of.setdefault(parent, []).append(n)
    members: dict[str, list[tuple[dict[str, Any], int]]] = {}

    def leaves(n: dict[str, Any], seen: set[str]) -> int:
        """Объектов в поддереве n; его узлы ложатся в seen — контейнер, взятый целиком,
        второй раз (по списку всех узлов) не обходится."""
        children = kids_of.get(str(n["id"]), [])
        if not children:
            return 0 if n.get("shape") == "person" else 1
        total = 0
        for k in children:
            kid = str(k["id"])
            if kid in seen:
                continue
            seen.add(kid)
            total += leaves(k, seen)
        return total

    def walk(n: dict[str, Any], seen: set[str]) -> None:
        nid = str(n["id"])
        if nid in seen or n.get("shape") == "person":
            return
        seen.add(nid)
        placed = list(n.get("sites") or [])
        children = kids_of.get(nid, [])
        if not children:
            for s in placed:
                members.setdefault(str(s["id"]), []).append((n, 1))
            return
        if placed and not any(s.get("partial") for s in placed):
            count = leaves(n, seen)
            for s in placed:
                members.setdefault(str(s["id"]), []).append((n, count))
            return
        for k in children:
            walk(k, seen)

    seen: set[str] = set()
    for root in kids_of.get(None, []):
        walk(root, seen)
    for n in nodes:  # узлы в цикле родителей (страховка) — как корневые
        walk(n, seen)
    return members


def deployment_tree(sites: list[dict[str, Any]], nodes: list[dict[str, Any]]) -> list[str]:
    """Площадки деревом с составом (archmap_deployment без объекта).

    Под площадкой — что на ней стоит: контейнер целиком одной строкой («целиком, N
    объектов») или объекты по отдельности (_site_members). Затем «Без размещения» —
    объекты без площадок, кроме «Пользователей» (они живут вне системы). nodes —
    /nodes/all: sites объекта — его площадки, контейнера — площадки его объектов."""
    by_id = {str(n["id"]): n for n in nodes}
    own = _site_members(nodes)
    ids = {str(s["id"]) for s in sites}
    kids: dict[str | None, list[dict[str, Any]]] = {}
    for s in sites:
        parent = str(s["parent_id"]) if s.get("parent_id") and str(s["parent_id"]) in ids else None
        kids.setdefault(parent, []).append(s)

    out: list[str] = []
    seen: set[str] = set()

    def walk(site: dict[str, Any], depth: int) -> None:
        sid = str(site["id"])
        if sid in seen:
            return
        seen.add(sid)
        pad = "  " * depth
        members = sorted(own.get(sid, []), key=lambda m: path_of(str(m[0]["id"]), by_id))
        total = sum(c for _n, c in members)
        out.append(f"{pad}{site_label(site)} — {_objects(total) if members else 'пусто'}")
        for n, c in members[:PLACEMENT_CAP]:
            tail = f" (целиком, {_objects(c)})" if n.get("has_children") else ""
            out.append(f"{pad}  • {path_of(str(n['id']), by_id)}{tail}  id={n['id']}")
        if len(members) > PLACEMENT_CAP:
            out.append(f"{pad}  …и ещё {len(members) - PLACEMENT_CAP}")
        for k in sorted(kids.get(sid, []), key=lambda s: str(s.get("name"))):
            walk(k, depth + 1)

    for root in sorted(kids.get(None, []), key=lambda s: str(s.get("name"))):
        walk(root, 0)
    for s in sites:  # площадки в цикле вложенности (страховка) — корневыми
        walk(s, 0)

    unplaced = sorted(
        path_of(str(n["id"]), by_id) + f"  id={n['id']}"
        for n in nodes
        if not n.get("has_children") and n.get("shape") != "person" and not n.get("sites")
    )
    if not unplaced:
        out.append("Без размещения: нет — все объекты стоят на площадках")
        return out
    out.append(f"Без размещения: {_objects(len(unplaced))}")
    out.extend(f"  • {u}" for u in unplaced[:PLACEMENT_CAP])
    if len(unplaced) > PLACEMENT_CAP:
        out.append(f"  …и ещё {len(unplaced) - PLACEMENT_CAP}")
    return out


def node_placement(
    node: dict[str, Any], by_id: dict[str, dict[str, Any]], sites: list[dict[str, Any]]
) -> list[str]:
    """Размещение одного объекта (archmap_deployment с node_id): путь объекта, затем
    площадки путями с видом; у контейнера это площадки его объектов, и где стоит часть
    — пометка «часть объектов»."""
    out = [f"Путь: {path_of(str(node['id']), by_id)}  id={node['id']}"]
    if node.get("shape") == "person":
        out.append("Размещения нет: пользователь живёт вне системы")
        return out
    placed = list(node.get("sites") or [])
    if not placed:
        out.append("Размещение: не указано")
        return out
    paths = site_paths(sites)
    by_site = {str(s["id"]): s for s in sites}
    out.append(f"Размещение ({len(placed)} {_plural(len(placed), ('площадка', 'площадки', 'площадок'))}):")
    for e in placed:
        sid = str(e.get("id"))
        site = by_site.get(sid, e)
        label = site_label({**site, "name": paths.get(sid, e.get("name", "?"))})
        if e.get("partial"):
            label += " — часть объектов"
        out.append(f"  • {label}")
    return out


def anchor_note(source: dict[str, Any] | None) -> str:
    """Источник НОВОГО объекта строкой: с ним — какой именно, без него — последствие."""
    kind = anchor_kind(source)
    if source and kind:
        return f"источник: {KIND_LABEL[kind]} {anchor_readable(source)}"
    return "источника нет — будет опознаваться по имени"


def basis_label(basis: str, path: str | None = None) -> str:
    """Чем два объекта признаны одним. Для «по имени» дописываем ГДЕ: имя решает
    только внутри своего контейнера, и без этого фраза обещает больше, чем сделал
    матчер."""
    if basis != "name":
        return BASIS_LABEL.get(basis, basis)
    parent = " / ".join((path or "").split(" / ")[:-1])
    return f"по имени внутри «{parent}»" if parent else "по имени на верхнем уровне"


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
    "ambiguous": "имя неоднозначно, укажите „БД / таблица“",
    "unknown_column": "колонки нет в таблице",
}
CHANNEL_REASON = {
    "unknown_channel": "канал не найден у брокеров проекта",
    "ambiguous": "имя неоднозначно, укажите „Брокер / канал“",
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


UNKNOWN_ALERTS_SHOWN = 5  # записей незнакомого класса в блоке: дальше — счётчиком


def _unknown_alert_blocks(data: dict[str, Any], known: set[str]) -> list[tuple[str, int]]:
    """Классы замечаний, которых этот MCP-сервер не знает: (блок, число записей).

    Слов панели для них у клиента нет, поэтому заголовок — ключ ответа, а записи —
    как пришли (JSON строкой): сырое честнее, чем ничего."""
    out: list[tuple[str, int]] = []
    for key, value in data.items():
        if key in known or not isinstance(value, list) or not value:
            continue
        lines = [
            json.dumps(item, ensure_ascii=False) if isinstance(item, dict | list) else str(item)
            for item in value[:UNKNOWN_ALERTS_SHOWN]
        ]
        if len(value) > UNKNOWN_ALERTS_SHOWN:
            lines.append(f"… и ещё {len(value) - UNKNOWN_ALERTS_SHOWN}")
        head = (
            f"«{key}» ({len(value)}). Этот класс замечаний MCP-серверу незнаком — сервер "
            "ArchMap новее, обновите MCP-сервер. Записи как есть:"
        )
        out.append((head + "\n" + "\n".join("  • " + line for line in lines), len(value)))
    return out


def alerts(data: dict[str, Any]) -> str:
    """Незавершённость схемы — 15 классов в порядке, заголовках и словах панели
    SchemaAlerts.tsx (решение 7 плана эпика «Доработка MCP-сервера»).

    Читается это агентом, а показывается человеку панелью — значит и называться
    должно одинаково: расхождение слов дороже любой экономии контекста.

    Все списки берутся через .get(..., []): сервер старше клиента новых классов не
    отдаёт вовсе, и рендер обязан это пережить, а не упасть на KeyError. Обратный
    случай — сервер НОВЕЕ клиента: незнакомый непустой список печатается общим
    блоком (ключ, число записей, первые записи как есть), а не глотается — иначе
    агент прочёл бы «Замечаний нет», пока панель горит (камень 24
    docs/plan-c4-elements.md).
    """
    known: set[str] = set()

    def lst(key: str) -> list[dict[str, Any]]:
        known.add(key)
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
    unknown = _unknown_alert_blocks(data, known)
    blocks.extend(block for block, _ in unknown)

    if not blocks:
        return "Замечаний нет — схема завершена."

    # Общий счётчик — как бабл панели: изолированные группы дают не число групп, а
    # число НЕДОСТАЮЩИХ связей (групп − 1), остальные классы — по записи.
    total = (
        len(disconnected) + len(intermediate) + len(descendant) + max(0, len(isolated) - 1)
        + len(container_own) + len(data_refs) + len(channel_refs) + len(config_refs)
        + len(broker_edges) + len(dangling) + len(orphan_legs) + len(unbound)
        + len(unlinked) + len(undescribed) + len(persons_inside)
        + sum(count for _, count in unknown)
    )
    head = f"Замечаний: {total}"
    return head + "\n\n" + "\n\n".join(blocks)


# Вид схемы логики словарём — те же слова, что в списке схем на странице объекта
# (KIND_LABEL из frontend/src/components/docsList.ts). Неизвестный вид печатается
# как есть: молча подменять незнакомое слово хуже, чем показать сырое.
KIND_WORD = {"operation": "операция", "worker": "воркер"}

# Капы против раздувания контекста: карточку читает модель, и перечень на две
# сотни строк она оплачивает целиком. Верхняя граница — по записям семьи и по
# членам одной записи (колонки таблицы, поля канала); остаток называется числом.
FACT_ROWS_CAP = 40
FACT_MEMBERS_CAP = 20


def _capped(lines: list[str], cap: int, forms: tuple[str, str, str]) -> list[str]:
    """Список с хвостом «… и ещё N»: обрезать молча — значит соврать о полноте."""
    if len(lines) <= cap:
        return lines
    rest = len(lines) - cap
    return [*lines[:cap], f"… и ещё {rest} {_plural(rest, forms)}"]


def docs(
    items: list[dict[str, Any]],
    *,
    described: dict[str, bool],
    usage: list[dict[str, Any]],
) -> tuple[str, list[str]]:
    """Схемы логики узла: вид словарём, метка заглушки, участие в процессах.

    described приходит из МЕТЫ узла (NodeDocMeta.described — производное поле,
    считается в БД по непустому телу): по content судить нельзя, «пусто» там —
    результат SQL-trim, а не текста.

    Возвращает (заголовок, строки): «описано N из M» дописывается в заголовок
    только когда заглушки есть — иначе это шум в каждой карточке.
    """
    if not items:
        return "СХЕМЫ ЛОГИКИ:", ["  (нет)"]

    by_doc: dict[str, list[dict[str, Any]]] = {}
    for row in usage:
        by_doc.setdefault(str(row.get("doc_id")), []).append(row)

    lines: list[str] = []
    stubs = 0
    for d in items:
        doc_id = str(d["id"])
        kind = str(d.get("kind", "?"))
        head = KIND_WORD.get(kind, kind)
        if d.get("operation"):
            head += f" · {d['operation']}"
        marks: list[str] = []
        if described.get(doc_id) is False:
            stubs += 1
            marks.append("не описана")
        rows = by_doc.get(doc_id, [])
        if rows:
            where = ", ".join(str(r.get("process_name", "?")) for r in rows)
            n = len(rows)
            marks.append(f"в {n} {_plural(n, ('процессе', 'процессах', 'процессах'))}: {where}")
        tail = f" — {'; '.join(marks)}" if marks else ""
        lines.append(f"  • {d['name']} ({head}){tail}  id={doc_id}")

    title = "СХЕМЫ ЛОГИКИ:"
    if stubs:
        title = f"СХЕМЫ ЛОГИКИ (описано {len(items) - stubs} из {len(items)}):"
    return title, lines


# ── Бизнес-процессы ──────────────────────────────────────────────────────────
# Тип шага словами. kind — ПРОИЗВОДНЫЙ (schemas/process.py): forward — обычный
# вызов, о нём говорить нечего, поэтому в словаре его нет.
STEP_KIND_WORD = {
    "return": "ответ",
    "async": "асинхронно",
    "self": "самосообщение",
}
# Чем сломан шаг — теми же словами, что чип на диаграмме (SequenceDiagram.tsx):
# «связь удалили из схемы» и «канал стал асинхронным, ответа у него не бывает».
STEP_BROKEN_WORD = {
    "edge_deleted": "связь удалена",
    "leg_gone": "канал без ответа",
}


def process_list(items: list[dict[str, Any]]) -> str:
    """Список процессов. Поля — ровно те, что отдаёт ProcessListItem: имени
    участников в нём НЕТ, и печатать «участников ?» вместо честного «шагов N»
    значит выдавать пробел контракта за свойство процесса."""
    lines: list[str] = []
    for p in items:
        scope = p.get("scope_name") or "весь проект"
        n = int(p.get("message_count", 0) or 0)
        lines.append(
            f"• {p.get('name', '?')} — область: {scope}, "
            f"шагов {n}  id={p.get('id', '?')}"
        )
    return "\n".join(lines)


def node_processes(items: list[dict[str, Any]]) -> tuple[str, list[str]]:
    """Где объект участвует. Вопрос про ОБЪЕКТ, а не про его схемы: участником
    процесса узел бывает и без единой схемы логики, поэтому раздел не выводится
    из обратного индекса доков в карточке."""
    lines = [
        f"  • {p.get('name', '?')} — шагов {int(p.get('message_count', 0) or 0)}"
        f"  id={p.get('id', '?')}"
        for p in items
    ]
    return f"УЧАСТВУЕТ В ПРОЦЕССАХ ({len(items)}):", lines


def _step_binding(m: dict[str, Any]) -> str:
    """Хвост привязки шага к схеме логики — адрес его документации.

    Путь узла обязателен рядом с именем: одноимённые схемы живут у разных
    объектов, и «схема „POST /orders“» без адреса неразличима."""
    if not m.get("doc_id"):
        return " — схема не привязана"
    where = f" ({m['doc_node_path']})" if m.get("doc_node_path") else ""
    return f" → схема «{m.get('doc_name', '?')}»{where}"


def process_detail(detail: dict[str, Any]) -> str:
    """Процесс: участники, шаги с привязками, фрагменты одной строкой.

    ⚠️ Концы шага — УЧАСТНИКИ (from_participant_id / to_participant_id), а не
    узлы: у непривязанного участника узла нет вовсе. Ключевать участников по
    node_id — тот самый класс «сводка читает поля, которых нет»: у половины
    процессов концы печатались бы как «?».
    """
    parts = sorted(detail.get("participants", []), key=lambda p: p.get("order", 0))
    by_part = {str(p["id"]): p for p in parts}

    scope = detail.get("scope_name") or "весь проект"
    out = [f"Область: {scope}", "", "УЧАСТНИКИ:"]
    if not parts:
        out.append("  (нет)")
    for p in parts:
        marks = [str(p[k]) for k in ("role",) if p.get(k)]
        if p.get("is_external"):
            marks.append("внешний")
        if not p.get("node_id"):
            marks.append("не привязан к объекту")
        tail = f" — {', '.join(marks)}" if marks else ""
        out.append(f"  {p.get('order', '?')}. {p.get('name', '?')}{tail}")

    out.append("")
    out.append("ШАГИ:")
    messages = sorted(detail.get("messages", []), key=lambda m: m.get("order", 0))
    if not messages:
        out.append("  (нет)")
    for m in messages:
        src = by_part.get(str(m.get("from_participant_id")), {}).get("name", "?")
        dst = by_part.get(str(m.get("to_participant_id")), {}).get("name", "?")
        marks = []
        word = STEP_KIND_WORD.get(str(m.get("kind")))
        if word:
            marks.append(word)
        if m.get("technology"):
            marks.append(str(m["technology"]))
        if not m.get("valid", True):
            marks.append(
                "⚠ " + STEP_BROKEN_WORD.get(str(m.get("invalid_reason")), "шаг сломан")
            )
        tail = " · " + " · ".join(marks) if marks else ""
        # id и version печатаются ВСЕГДА: это вход archmap_bind_step (CAS), и
        # без версии агенту пришлось бы перечитывать процесс ради одного числа.
        out.append(
            f"  {m.get('order', '?')}. {src} → {dst}: {m.get('caption') or '—'}"
            f"{tail}{_step_binding(m)}  id={m.get('id', '?')} version={m.get('version', '?')}"
        )

    fragments = sorted(detail.get("fragments", []), key=lambda f: f.get("from_order", 0))
    if fragments:
        out.append("")
        out.append("ФРАГМЕНТЫ:")
        for f in fragments:
            guard = f" «{f['guard']}»" if f.get("guard") else ""
            branches = f.get("branches") or []
            extra = (
                f", ветвей ещё {len(branches)}" if branches else ""
            )
            out.append(
                f"  {f.get('kind', '?')} шаги {f.get('from_order', '?')}–"
                f"{f.get('to_order', '?')}{guard}{extra}"
            )
    return "\n".join(out)


# Каталог схем шага бывает широким (поддеревья ОБОИХ участников): кап тот же
# приём, что у семей фактов — обрезать молча значит соврать о полноте.
DOC_CATALOG_CAP = 80


def step_docs(data: dict[str, Any]) -> str:
    """Каталог «чем можно задокументировать шаг» (MessageDocCatalog).

    Порядок бэкенда НЕ пересортировываем: он и есть подсказка — схемы владельца
    шага (конец ребра, несущий логику) идут первыми, и пометка «исполнитель»
    называет ровно их.
    """
    docs_ = data.get("docs") or []
    if not docs_:
        return (
            "Подходящих схем логики нет: ни у участников шага, ни у их потомков не "
            "заведено ни одной. Сначала опишите логику — archmap_docs_prompt / "
            "archmap_docs_apply."
        )
    owner = str(data.get("default_node_id") or "")
    lines: list[str] = []
    for d in docs_:
        kind = str(d.get("kind", "?"))
        head = KIND_WORD.get(kind, kind)
        if d.get("operation"):
            head += f" · {d['operation']}"
        marks: list[str] = []
        if owner and str(d.get("node_id")) == owner:
            marks.append("исполнитель")
        if d.get("described") is False:
            marks.append("не описана")
        tail = f" [{', '.join(marks)}]" if marks else ""
        lines.append(
            f"  • {d.get('name', '?')} ({head}) — {d.get('node_path', '?')}{tail}"
            f"  id={d.get('id', '?')}"
        )
    head_line = f"ПОДХОДЯЩИЕ СХЕМЫ ЛОГИКИ ({len(docs_)}):"
    body = _capped(lines, DOC_CATALOG_CAP, ("схема", "схемы", "схем"))
    return head_line + "\n" + "\n".join(body)


def step_bound(m: dict[str, Any]) -> str:
    """Итог привязки: новое состояние шага и НОВАЯ версия — следующая правка идёт
    от неё, иначе CAS вернёт 409 на ровном месте."""
    return (
        f"Шаг {m.get('order', '?')} «{m.get('caption') or '—'}»{_step_binding(m)}"
        f"  id={m.get('id', '?')} version={m.get('version', '?')}"
    )


def db_tables(items: list[dict[str, Any]]) -> tuple[str, list[str]]:
    """Структура БД: таблица одной строкой, колонки — «имя тип» с флагами PK/NOT
    NULL (те же пометки, что в разделе «Структура» на странице объекта)."""
    if not items:
        return "СТРУКТУРА БД:", ["  (не описана)"]
    lines: list[str] = []
    for t in items:
        name = f"{t['schema_name']}.{t['name']}" if t.get("schema_name") else str(t["name"])
        cols: list[str] = []
        for c in sorted(t.get("columns", []), key=lambda c: c.get("order", 0)):
            bits = [str(c["name"])]
            if c.get("type"):
                bits.append(str(c["type"]))
            if c.get("is_primary_key"):
                bits.append("PK")
            if c.get("nullable") is False:
                bits.append("NOT NULL")
            cols.append(" ".join(bits))
        shown = _capped(cols, FACT_MEMBERS_CAP, ("колонка", "колонки", "колонок"))
        lines.append(f"  • {name}: " + (", ".join(shown) if shown else "(колонок нет)"))
    n = len(items)
    title = f"СТРУКТУРА БД ({n} {_plural(n, ('таблица', 'таблицы', 'таблиц'))}):"
    return title, _capped(lines, FACT_ROWS_CAP, ("таблица", "таблицы", "таблиц"))


def broker_channels(items: list[dict[str, Any]]) -> tuple[str, list[str]]:
    """Каналы брокера: имя, свойства доставки в скобках, поля сообщения."""
    if not items:
        return "КАНАЛЫ:", ["  (не описаны)"]
    lines: list[str] = []
    for ch in items:
        name = f"{ch['group_name']}/{ch['name']}" if ch.get("group_name") else str(ch["name"])
        meta = [str(ch["kind"])] if ch.get("kind") else []
        if ch.get("partition_key"):
            meta.append(f"ключ: {ch['partition_key']}")
        if ch.get("delivery"):
            meta.append(str(ch["delivery"]))
        if ch.get("retention"):
            meta.append(f"retention: {ch['retention']}")
        head = f"{name} [{', '.join(meta)}]" if meta else name
        fields: list[str] = []
        for f in sorted(ch.get("fields", []), key=lambda f: f.get("order", 0)):
            bits = [str(f["name"])]
            if f.get("type"):
                bits.append(str(f["type"]))
            if f.get("required"):
                bits.append("обяз.")
            fields.append(" ".join(bits))
        shown = _capped(fields, FACT_MEMBERS_CAP, ("поле", "поля", "полей"))
        lines.append(f"  • {head}: " + (", ".join(shown) if shown else "(полей нет)"))
    n = len(items)
    title = f"КАНАЛЫ ({n} {_plural(n, ('канал', 'канала', 'каналов'))}):"
    return title, _capped(lines, FACT_ROWS_CAP, ("канал", "канала", "каналов"))


def config_params(items: list[dict[str, Any]]) -> tuple[str, list[str]]:
    """Конфигурация сервиса: имя, тип, обязательность, дефолт ИЗ КОДА и «что
    переключает». Значений сред здесь нет и быть не может (§2.5 плана семьи)."""
    if not items:
        return "КОНФИГУРАЦИЯ:", ["  (не описана)"]
    lines: list[str] = []
    for p in items:
        bits: list[str] = []
        if p.get("value_type"):
            bits.append(str(p["value_type"]))
        bits.append("обяз." if p.get("required") else "необяз.")
        if p.get("default_value"):
            bits.append(f"по умолчанию «{p['default_value']}»")
        desc = f" — {p['description']}" if p.get("description") else ""
        lines.append(f"  • {p['name']} ({', '.join(bits)}){desc}")
    n = len(items)
    title = f"КОНФИГУРАЦИЯ ({n} {_plural(n, ('параметр', 'параметра', 'параметров'))}):"
    return title, _capped(lines, FACT_ROWS_CAP, ("параметр", "параметра", "параметров"))


# Группы превью разведки: порядок и ЗАГОЛОВКИ — дословно из окна ReconAgentModal
# (GROUPS), потому что агент и человек смотрят на один и тот же отчёт. Пояснение
# у двух групп — там, где действие не читается из заголовка: «уже описаны» и
# «не найдено в коде» обе выглядят как повод что-то сделать, а делать нечего.
# Четвёртый элемент — короткая подпись для строки счётчиков: заголовок группы
# («Есть в документации, но не найдено в коде») в перечислении не читается.
RECON_GROUPS: tuple[tuple[str, str, str, str], ...] = (
    ("create", "Создадим заглушки", "", "создадим заглушек"),
    ("unchanged", "Заглушки уже есть", "", "заглушки уже есть"),
    (
        "described",
        "Уже описаны — не тронем",
        "повторный сбор перечня не затирает работу",
        "уже описано",
    ),
    (
        "vanished",
        "Есть в документации, но не найдено в коде",
        "ничего не удаляем — это показ расхождения",
        "не найдено в коде",
    ),
)

# Кап строк одной группы разведки. Перечень монолита — сотни точек входа (Zulip:
# 201), и вываливать их целиком в контекст незачем: агенту нужны числа и образцы,
# а полный список он и так держит в файле, который сам же и составил.
RECON_GROUP_CAP = 80


def recon_report(data: dict[str, Any], *, applied: bool) -> str:
    """Отчёт разведки: счётчики по действиям, затем группы строк, затем проблемы.

    Форма общая у превью и применения (её различает applied) — как у отчёта
    дозаливки: разница только в хвосте «ничего не записано» и в том, что после
    применения печатается число созданных заглушек.
    """
    items = [i for i in (data.get("items") or []) if isinstance(i, dict)]
    by_action: dict[str, list[dict[str, Any]]] = {}
    for it in items:
        by_action.setdefault(str(it.get("action")), []).append(it)

    out: list[str] = []
    node_path = str(data.get("node_path") or "")
    if node_path:
        out.append(f"Объект: {node_path}")
    # После записи «создадим» — ложь: то же поле отчёта описывает уже сделанное.
    # Переименовывается ровно одна группа, три остальных читаются в обоих временах.
    def words(action: str, title: str, short: str) -> tuple[str, str]:
        if applied and action == "create":
            return "Заглушки созданы", "создано заглушек"
        return title, short

    counts = [
        f"{words(action, title, short)[1]} {len(by_action.get(action, []))}"
        for action, title, _note, short in RECON_GROUPS
        # После записи созданное называет отдельная строка ЧИСЛОМ СЕРВЕРА — в
        # счётчике оно было бы вторым, слегка другим ответом на тот же вопрос.
        if by_action.get(action) and not (applied and action == "create")
    ]
    if applied:
        out.append(f"Создано заглушек: {data.get('created', 0)}")
    if counts:
        out.append("Остальное: " if applied else "Итог: ")
        out[-1] += ", ".join(counts)
    elif not applied:
        out.append("Итог: перечень пуст")

    for action, title, note, _short in RECON_GROUPS:
        rows = by_action.get(action) or []
        if not rows:
            continue
        out.append("")
        out.append(f"{words(action, title, _short)[0]} ({len(rows)}):")
        if note:  # пояснение отдельной строкой: в заголовке два тире не читаются
            out.append(f"  ({note})")
        lines = []
        for it in rows:
            kind = str(it.get("kind", "?"))
            # doc_name приходит, только когда имя существующей схемы отличается от
            # строки перечня: «POST /messages» бывает описан схемой «Отправка
            # сообщения», и агент обязан видеть, ЧТО именно закрыло операцию.
            tail = f" → {it['doc_name']}" if it.get("doc_name") else ""
            lines.append(f"  • {it.get('name', '?')} ({KIND_WORD.get(kind, kind)}){tail}")
        out.extend(_capped(lines, RECON_GROUP_CAP, ("строка", "строки", "строк")))

    out.extend(problems(data))
    if not applied:
        out.append("\nНичего не записано — для записи вызовите archmap_recon_apply.")
    return "\n".join(out)


def problems(data: dict[str, Any]) -> list[str]:
    """Ошибки и предупреждения отчёта — общий хвост всех сводок записи.

    Ошибки и предупреждения РАЗДЕЛЕНЫ: при errors бэкенд не пишет ничего вовсе, а
    warnings записи не мешают — свалить их в одну кучу значит заставить агента
    гадать, сорвалась заливка или нет.
    """
    out: list[str] = []
    for key, title in (("errors", "Проблемы"), ("warnings", "Предупреждения")):
        rows = data.get(key) or []
        if rows:
            out.append("")
            out.append(f"{title} ({len(rows)}):")
            out.extend("  • " + str(r) for r in rows)
    return out


# Слова действий — дословно из ACTION_LABEL окон дозаливки
# (frontend/src/components/docsImport/agentModalShared.ts). «fill» здесь отдельным
# словом не случайно: заполнение ЗАГЛУШКИ разведки безопасно, а настоящая
# перезапись — нет, и путать их нельзя ни человеку, ни агенту.
ACTION_WORD = {
    "create": "новая",
    "fill": "заполнит заглушку",
    "overwrite": "перезапись",
    "skip": "пропуск (занято)",
    "unchanged": "без изменений",
}


# Пустая запись — самый частый брак пакета: агент назвал таблицу, но колонки
# растерял. Окна помечают такую строку красным, и агенту знать это важнее, чем
# человеку: чинить пакет ему.
EMPTY_MARK = " ⚠ проверьте файл"


def _fact_table(item: dict[str, Any]) -> str:
    name = f"{item['schema_name']}.{item['name']}" if item.get("schema_name") else str(item["name"])
    n = int(item.get("columns", 0) or 0)
    return f"{name} · колонок {n}" + (EMPTY_MARK if n == 0 else "")


def _fact_channel(item: dict[str, Any]) -> str:
    name = f"{item['group_name']}/{item['name']}" if item.get("group_name") else str(item["name"])
    n = int(item.get("fields", 0) or 0)
    return f"{name} · полей {n}" + (EMPTY_MARK if n == 0 else "")


def _fact_param(item: dict[str, Any]) -> str:
    bits = [str(item["value_type"])] if item.get("value_type") else []
    bits.append("обяз." if item.get("required") else "необяз.")
    return f"{item['name']} ({', '.join(bits)})"


# Три семьи табличных фактов одной таблицей: ключ списка в отчёте, как рисуется
# строка, как называются записи и какие счётчики записи печатать. Инструменты у
# семей общие (решение 1 плана эпика) — значит и сводка обязана быть одной формы,
# иначе агент читает три разных отчёта об одном и том же действии.
FACT_FAMILIES: dict[str, dict[str, Any]] = {
    "tables": {
        "items_key": "tables",
        "row": _fact_table,
        "title": "ТАБЛИЦЫ",
        "forms": ("таблица", "таблицы", "таблиц"),
        "written": (("tables_written", "таблиц"), ("columns_written", "колонок")),
    },
    "channels": {
        "items_key": "channels",
        "row": _fact_channel,
        "title": "КАНАЛЫ",
        "forms": ("канал", "канала", "каналов"),
        "written": (("channels_written", "каналов"), ("fields_written", "полей")),
    },
    "config": {
        "items_key": "params",
        "row": _fact_param,
        "title": "ПАРАМЕТРЫ",
        "forms": ("параметр", "параметра", "параметров"),
        "written": (("params_written", "параметров"),),
    },
}

# Кап строк сводки семьи: у крупной БД сотни таблиц, и агенту нужны числа и
# образцы, а не полный дамп его же собственного пакета.
FACT_REPORT_CAP = 80


def facts_report(data: dict[str, Any], family: str, *, applied: bool) -> str:
    """Сводка дозаливки одной семьи фактов — общая форма для всех трёх.

    Счётчики: сколько записей приехало и сколько из них новых (то же, что окно
    показывает строкой «Таблиц: N (новых K)»), а после записи — числа СЕРВЕРА о
    том, что он действительно записал.
    """
    spec = FACT_FAMILIES[family]
    items = [i for i in (data.get(spec["items_key"]) or []) if isinstance(i, dict)]

    n = len(items)
    head = f"{spec['title']}: {n} {_plural(n, spec['forms'])}"
    new = sum(1 for i in items if i.get("action") == "create")
    if new:
        head += f" (новых {new})"
    out = [head]
    if applied:
        out.append(
            "Записано: "
            + ", ".join(f"{word} {data.get(key, 0)}" for key, word in spec["written"])
        )

    lines = []
    for it in items:
        action = str(it.get("action", "?"))
        # Путь объекта в каждой строке, а не общей шапкой: один пакет описывает
        # РАЗНЫЕ объекты (у монолита несколько БД), и без адреса строка безымянна.
        lines.append(
            f"  {ACTION_WORD.get(action, action)}: «{it.get('node_path', '?')}» · {spec['row'](it)}"
        )
    if lines:
        out.append("")
        out.extend(_capped(lines, FACT_REPORT_CAP, spec["forms"]))

    out.extend(problems(data))
    if not applied:
        out.append("\nНичего не записано — для записи вызовите archmap_facts_apply.")
    return "\n".join(out)


def docs_report(data: dict[str, Any], *, applied: bool) -> str:
    """Сводка дозаливки схем логики и OpenAPI-спек.

    ⚠ Читает `logic` и `specs` — ровно те поля, что отдаёт DocsImportReport. Прежняя
    версия спрашивала `items`/`status`, которых в отчёте нет вовсе, и печатала
    ПУСТОЙ ПЛАН на валидный пакет: агент видел «ничего не приедет» и всё равно шёл
    применять вслепую (найдено живой проверкой Ф2). Форма отчёта — единственный
    судья таких полей, поэтому фикстуры тестов валидируются ею.
    """
    logic = [i for i in (data.get("logic") or []) if isinstance(i, dict)]
    specs = [i for i in (data.get("specs") or []) if isinstance(i, dict)]

    out: list[str] = []
    if applied:
        out.append(
            f"Применено: схем создано {data.get('created_docs', 0)}, "
            f"заполнено заглушек {data.get('filled_docs', 0)}, "
            f"перезаписано {data.get('updated_docs', 0)}, "
            f"спецификаций {data.get('specs_written', 0)}"
        )

    if logic:
        n = len(logic)
        counts = ", ".join(
            f"{ACTION_WORD.get(a, a)} {sum(1 for i in logic if i.get('action') == a)}"
            for a in ACTION_WORD
            if any(i.get("action") == a for i in logic)
        )
        out.append("")
        out.append(f"СХЕМЫ ЛОГИКИ: {n} ({counts})")
        lines = []
        for it in logic:
            kind = str(it.get("kind", "?"))
            head = f"{it.get('name', '?')} ({KIND_WORD.get(kind, kind)}"
            head += f" · {it['operation']})" if it.get("operation") else ")"
            action = str(it.get("action", "?"))
            lines.append(
                f"  {ACTION_WORD.get(action, action)}: «{it.get('node_path', '?')}» · {head}"
            )
        out.extend(_capped(lines, FACT_REPORT_CAP, ("схема", "схемы", "схем")))

    if specs:
        out.append("")
        out.append(f"OPENAPI-СПЕКИ: {len(specs)}")
        lines = []
        for it in specs:
            bits = [str(it.get("source", "?"))]
            if it.get("oas_version"):
                bits.append(f"OAS {it['oas_version']}")
            # «Синтезирована из кода» — не мелочь: такую спеку человек обязан
            # посмотреть глазами, и окно помечает её тем же словом.
            if it.get("origin"):
                bits.append(str(it["origin"]))
            if not it.get("valid_yaml", True):
                bits.append("невалидный YAML")
            elif not it.get("looks_openapi", True):
                bits.append("не похожа на OpenAPI")
            action = str(it.get("action", "?"))
            lines.append(
                f"  {ACTION_WORD.get(action, action)}: «{it.get('node_path', '?')}» · "
                + " · ".join(bits)
            )
        out.extend(_capped(lines, FACT_REPORT_CAP, ("спецификация", "спецификации", "спецификаций")))

    conflicts = data.get("conflicts") or []
    if conflicts:
        out.append("")
        out.append(f"Конфликты файлов ({len(conflicts)}, оставлен первый файл):")
        out.extend("  • " + str(c) for c in conflicts)

    out.extend(problems(data))
    if not logic and not specs and not data.get("errors"):
        out.append("")
        out.append("Пакет ничего не принёс: ни схем логики, ни спецификаций не распознано.")
    if not applied:
        out.append("\nНичего не записано — для записи вызовите archmap_docs_apply.")
    return "\n".join(out).lstrip("\n")


# ── Архив проекта ────────────────────────────────────────────────────────────

# Категории манифеста архива (backend/app/archive_export.py, ключ contents) —
# порядок и слова те же, что в самом архиве, чтобы агент и человек, открывший zip,
# называли его состав одинаково.
ARCHIVE_CATEGORIES: list[tuple[str, str]] = [
    ("c4", "схема C4"),
    ("docs", "схемы логики"),
    ("specs", "спецификации OpenAPI"),
    ("db", "структура БД"),
    ("channels", "каналы брокеров"),
    ("config", "конфигурация"),
    ("processes", "бизнес-процессы"),
]


def _dict(value: Any) -> dict[str, Any]:
    """Ветка манифеста словарём — или пустой словарь. Манифест приезжает из файла
    на диске: чужой архив может оказаться каким угодно, а падать стектрейсом на
    кривом zip-е инструменту нельзя."""
    return dict(value) if isinstance(value, dict) else {}


def archive_summary(manifest: dict[str, Any], *, files: int, size: int, path: str) -> str:
    """Сводка выгруженного архива: что внутри и куда лёг файл.

    СОДЕРЖИМОГО файлов тут нет намеренно: архив — бэкап на диске, а не материал
    для чтения моделью (полный дамп знания проекта в контекст — тот самый шум,
    ради борьбы с которым сделан весь render). Истинное имя проекта берём из
    манифеста: в заголовке HTTP оно ASCII-огрызок.
    """
    project = _dict(manifest.get("project"))
    name = str(project.get("name") or "без имени")
    out = [f"Архив проекта «{name}» сохранён: {path}"]
    if project.get("description"):
        out.append(f"Описание: {project['description']}")
    fmt = manifest.get("archmap-archive")
    out.append(
        f"Формат archmap-archive: {fmt if fmt is not None else '?'}; "
        f"файлов {files}; размер {size / 1024:.1f} КБ."
    )

    contents = _dict(manifest.get("contents"))
    rows: list[str] = []
    for key, title in ARCHIVE_CATEGORIES:
        value = contents.get(key)
        if value is None:
            continue
        count = len(value) if isinstance(value, list) else 1
        rows.append(f"  • {title}: {count}")
    # Категория, которой ещё не знает этот рендер, — лучше показать сырым ключом,
    # чем молча потерять: архив обгоняет MCP-сервер (ровно это и лечит эпик).
    for key in contents:
        if key not in {k for k, _ in ARCHIVE_CATEGORIES}:
            value = contents[key]
            rows.append(f"  • {key}: {len(value) if isinstance(value, list) else 1}")
    if rows:
        out.append("Состав:")
        out.extend(rows)
    else:
        out.append("Состав: пусто — в проекте нечего архивировать.")
    return "\n".join(out)


# ── Единый импорт: N входов, споры содержимого, догрузка к живому ────────────

C4_LIST_CAP = 20  # списки замечаний C4-части
CONFLICT_CAP = 30  # споры содержимого: больше тридцати выбирают не в разговоре

FAMILY_WORD = {
    "doc": "схема логики",
    "spec": "спецификация OpenAPI",
    "table": "таблица",
    "channel": "канал",
    "config": "параметр",
}

# Счётчики единого превью (UnifiedFamilyCountsOut) — «что приедет при дефолтных
# решениях»: те же слова, что в панели ввоза, чтобы агент и человек называли
# приезжающее одинаково.
FAMILY_COUNTS: list[tuple[str, str]] = [
    ("docs", "схем логики"),
    ("specs", "спецификаций"),
    ("tables", "таблиц"),
    ("channels", "каналов"),
    ("params", "параметров"),
    ("processes", "процессов"),
    ("sites", "площадок"),
]


def c4_preview(c4: dict[str, Any]) -> list[str]:
    """C4-часть превью — общая для старого одно-YAML пути и единого ввоза.

    Модель у них одна (ImportPreviewOut), и второй формат отчёта тут завести
    значило бы, что один и тот же разбор читается по-разному в зависимости от
    того, каким инструментом его позвали.
    """
    out = [
        f"Разбор прошёл: объектов {c4.get('node_count', 0)}, "
        f"связей {c4.get('edge_count', 0)}, файлов {c4.get('files', 0)}."
    ]
    if c4.get("roots"):
        out.append("Корни: " + ", ".join(str(r) for r in c4["roots"]))
    if c4.get("merged_count"):
        merged = ", ".join(str(m) for m in (c4.get("merged") or []))
        out.append(f"Склеено из нескольких входов: {c4['merged_count']}" + (f" ({merged})" if merged else ""))
        # ОСНОВАНИЕ каждой склейки: «склеено 7» без «почему» — невидимая магия, а
        # ложная склейка хуже дубля именно тем, что выглядит правильной схемой.
        for m in c4.get("merged_nodes") or []:
            path = str(m.get("path", ""))
            out.append(f"  • {path} — {basis_label(str(m.get('basis')), path)}")
    # Узлы без якоря следующий прогон опознает только по имени внутри контейнера:
    # переименуют — получится дубль. Счётчиком, а не списком: при создании проекта
    # новые ВСЕ узлы, и перечень был бы шумом, а не предупреждением.
    without = int(c4.get("nodes_without_anchor") or 0)
    if without:
        out.append(
            f"Без источника: {without} {_plural(without, ('объект', 'объекта', 'объектов'))} — "
            "будут опознаваться по имени"
        )
    for key, title in (
        ("warnings", "Предупреждения"),
        ("conflicts", "Конфликты слияния"),
    ):
        items = [str(i) for i in (c4.get(key) or [])]
        if items:
            out.append(f"{title} ({len(items)}):")
            out.extend(_capped(["  • " + i for i in items], C4_LIST_CAP, ("штука", "штуки", "штук")))
    if c4.get("dropped_edges"):
        out.append(f"Отброшено дублей связей: {c4['dropped_edges']}")

    # Пофайловые замечания адресованы ВХОДУ по номеру: пакет собирают несколько
    # агентов, и «чините вход 2» — единственная работающая адресация.
    for remark in c4.get("file_remarks") or []:
        rows = [f"ошибка: {e}" for e in remark.get("errors") or []]
        rows += [f"замечание: {w}" for w in remark.get("warnings") or []]
        if rows:
            out.append(f"Вход {remark.get('file', '?')}:")
            out.extend("  • " + r for r in rows)
    return out


def family_counts(counts: dict[str, Any]) -> str:
    """Строка «что приедет» по семьям — только непустое: нули в перечне отвлекают."""
    bits = [f"{title} {counts.get(key, 0)}" for key, title in FAMILY_COUNTS if counts.get(key)]
    return "Содержимое: " + (", ".join(bits) if bits else "ничего кроме C4") + "."


def conflicts(rows: list[dict[str, Any]], *, apply_tool: str) -> list[str]:
    """Споры о ТЕЛЕ факта: один ключ описан по-разному в разных входах.

    Их рассудить может только человек (или его агент), поэтому печатаем id, чем
    спорят и что случится САМО СОБОЙ — дефолт применится, если решения не
    передать. Тела не показываем целиком: спор различают по сводке, а полный
    текст сделал бы вывод инструмента дампом всех версий всех схем.
    """
    if not rows:
        return []
    out = ["", f"Споры содержимого ({len(rows)}) — один факт описан по-разному:"]
    lines: list[str] = []
    for c in rows:
        family = FAMILY_WORD.get(str(c.get("family")), str(c.get("family")))
        lines.append(f"  «{c.get('id')}» — {family} «{c.get('key')}» у «{c.get('node_path')}»")
        for i, cand in enumerate(c.get("candidates") or []):
            mark = " [текущий в проекте]" if cand.get("current") else ""
            lines.append(
                f"      cand:{i} — {cand.get('origin_label', '?')} · "
                f"{cand.get('summary', '')}{mark}"
            )
        allow = ', «all» — взять все' if c.get("allow_all") else ""
        lines.append(f"      по умолчанию: {c.get('default')}{allow}")
    out.extend(_capped(lines, CONFLICT_CAP * 3, ("строка", "строки", "строк")))
    out.append(
        f'Чтобы решить иначе, передайте в {apply_tool} resolutions: '
        '{"<id спора>": "cand:<номер кандидата>"}. Без этого применится дефолт.'
    )
    return out


def unified_preview(data: dict[str, Any]) -> str:
    """Сводка dry-run единого ввоза (UnifiedPreviewOut): N входов любого типа."""
    if not data.get("ok"):
        rows = [str(e) for e in (data.get("errors") or [])] or ["причина не названа"]
        return "Импорт НЕ пройдёт. Ошибки:\n" + "\n".join("  • " + e for e in rows)

    out: list[str] = []
    c4 = data.get("c4")
    if isinstance(c4, dict):
        out.extend(c4_preview(c4))
    else:
        out.append("C4-схемы во входах нет — приедет только содержимое архивов.")
    out.append(family_counts(_dict(data.get("families"))))
    out.extend(conflicts(list(data.get("family_conflicts") or []), apply_tool="archmap_import_apply"))

    warnings = [str(w) for w in (data.get("warnings") or [])]
    if warnings:
        out.append("")
        out.append(f"Предупреждения ({len(warnings)}):")
        out.extend("  • " + w for w in warnings)

    # Имя проекта: у одного архива оно приедет из манифеста, во всех остальных
    # случаях его обязан задать вызывающий — иначе применение откажет.
    if data.get("name_source") == "manifest":
        out.append(
            f"\nИмя проекта возьмётся из манифеста: «{data.get('manifest_name') or '—'}»"
            " (передайте name, чтобы назвать иначе)."
        )
    else:
        out.append("\nИмя проекта придётся задать самому: аргумент name у archmap_import_apply.")
    out.append("Ничего не создано — для создания вызовите archmap_import_apply.")
    return "\n".join(out)


def _channel_stubs_line(data: dict[str, Any]) -> list[str]:
    """Заглушки каналов по связям схемы — строка только когда они заведены."""
    n = int(data.get("channel_stubs") or 0)
    if not n:
        return []
    return [
        f"Каналов брокеров заведено по связям схемы: {n} "
        f"{_plural(n, ('заглушка', 'заглушки', 'заглушек'))} без описания — дозалейте "
        "пакет каналов (archmap_facts_prompt family=channels)."
    ]


def unified_result(data: dict[str, Any]) -> str:
    """Отчёт создания проекта (ArchiveImportResult): что именно легло в новый проект."""
    out = [
        f"Проект «{data.get('project_name')}» создан: объектов {data.get('nodes', 0)}, "
        f"связей {data.get('edges', 0)}. id={data.get('project_id')}"
    ]
    out.append(
        f"Схем логики: {data.get('docs_created', 0)}; спецификаций OpenAPI: {data.get('specs_applied', 0)}."
    )
    out.extend(_channel_stubs_line(data))
    out.extend(_family_reports(data))
    out.extend(_processes_report(list(data.get("processes") or [])))
    if data.get("resolved_conflicts"):
        out.append(f"Разрешено споров содержимого: {data['resolved_conflicts']}.")
    out.extend(problems(data))
    return "\n".join(out)


def into_preview(data: dict[str, Any]) -> str:
    """Сводка dry-run ДОГРУЗКИ архивов к живому проекту (IntoPreviewOut).

    Числа тут про ДИФФ: что появится, а не что лежит в архивах. Дефолт спора с
    живым — «оставить моё», поэтому перезапись случается только явным выбором.
    """
    if not data.get("ok"):
        rows = [str(e) for e in (data.get("errors") or [])] or ["причина не названа"]
        return "Догрузка НЕ пройдёт. Ошибки:\n" + "\n".join("  • " + e for e in rows)

    out = [
        f"Приедет нового: объектов {data.get('nodes_new', 0)}, связей {data.get('edges_new', 0)}."
    ]
    # Самое спорное решение догрузки — «это тот же объект»: до Ф2 она о нём
    # молчала, показывая только новое. Называем и находки, и основание каждой.
    matched = int(data.get("nodes_matched") or 0)
    if matched:
        out.append(
            f"Найдено в проекте: {matched} "
            f"{_plural(matched, ('объект', 'объекта', 'объектов'))}"
        )
        shown = list(data.get("matched_nodes") or [])
        for m in shown:
            path = str(m.get("path", ""))
            out.append(f"  • {path} — {basis_label(str(m.get('basis')), path)}")
        if matched > len(shown):
            out.append(f"  … и ещё {matched - len(shown)}")
    # Новые объекты — с их якорями: «(без якоря)» значит, что следующая догрузка
    # найдёт объект только по имени внутри контейнера.
    new_nodes = list(data.get("new_nodes") or [])
    if new_nodes:
        out.append("Новые объекты:")
        for n in new_nodes:
            source = n.get("source")
            tail = f" — источник: {anchor_value(source)}" if anchor_kind(source) else " (без источника)"
            out.append(f"  • {n.get('path', '?')}{tail}")
    else:
        # Старое поле — запасной путь: контракты превью только дополняются, и
        # отчёт не должен онеметь, если новых узлов перечень пришёл прежним видом.
        paths = [str(p) for p in (data.get("nodes_new_paths") or [])]
        if paths:
            out.append("Новые объекты: " + ", ".join(paths))
    out.append(family_counts(_dict(data.get("families"))))
    out.extend(
        conflicts(list(data.get("family_conflicts") or []), apply_tool="archmap_import_into_apply")
    )

    warnings = [str(w) for w in (data.get("warnings") or [])]
    if warnings:
        out.append("")
        out.append(f"Предупреждения ({len(warnings)}):")
        out.extend("  • " + w for w in warnings)

    out.append("")
    out.append(
        f"Для применения передайте base_graph_rev={data.get('base_graph_rev', 0)} и "
        f"base_meta_rev={data.get('base_meta_rev', 0)} — они защищают от параллельной "
        "правки проекта (при расхождении будет 409, тогда перечитайте превью)."
    )
    out.append("Ничего не записано — для записи вызовите archmap_import_into_apply.")
    return "\n".join(out)


def into_result(data: dict[str, Any]) -> str:
    """Отчёт применения догрузки (IntoApplyOut): что тронуто в живом проекте."""
    out = [
        f"Догружено: объектов создано {data.get('nodes_created', 0)}, "
        f"дополнено {data.get('nodes_filled', 0)}, связей создано {data.get('edges_created', 0)}."
    ]
    out.append(
        f"Схем логики создано {data.get('docs_created', 0)}, "
        f"заменено {data.get('docs_replaced', 0)}; спецификаций применено "
        f"{data.get('specs_applied', 0)}; параметров заменено {data.get('params_replaced', 0)}."
    )
    out.extend(_channel_stubs_line(data))
    out.extend(_family_reports(data))
    out.extend(_processes_report(list(data.get("processes") or [])))
    if data.get("resolved_conflicts"):
        out.append(f"Разрешено споров содержимого: {data['resolved_conflicts']}.")
    out.extend(problems(data))
    out.append(
        f"\nНовые ревизии проекта: graph_rev={data.get('graph_rev', 0)}, "
        f"meta_rev={data.get('meta_rev', 0)}."
    )
    return "\n".join(out)


def _family_reports(data: dict[str, Any]) -> list[str]:
    """Отчёты трёх семей фактов — РОДНЫЕ, те же, что у BYOA-дозаливки: вторых
    форматов отчёта не заводим (норма эпика архива)."""
    out: list[str] = []
    for key in ("db", "channels", "config"):
        report = data.get(key)
        if not isinstance(report, dict):
            continue
        family = {"db": "tables", "channels": "channels", "config": "config"}[key]
        out.append("")
        out.append(facts_report(report, family, applied=True))
    return out


def _processes_report(items: list[dict[str, Any]]) -> list[str]:
    """Процессы: сколько шагов встало на каналы схемы и сколько осталось висеть.

    Повисшие и непривязанные к схемам шаги — не косметика: именно они попадают в
    алерты полноты, и агенту чинить их.
    """
    if not items:
        return []
    out = ["", f"Процессы: {len(items)}"]
    for p in items:
        bits = [
            f"шагов {p.get('messages', 0)}",
            f"на каналах {p.get('attached', 0)}",
        ]
        if p.get("dangling"):
            bits.append(f"повисло {p['dangling']} ⚠")
        if p.get("unbound"):
            bits.append(f"участников без объекта {p['unbound']}")
        if p.get("doc_linked"):
            bits.append(f"шагов со схемой {p['doc_linked']}")
        if p.get("doc_unresolved"):
            bits.append(f"схема не найдена у {p['doc_unresolved']} ⚠")
        if p.get("unsupported"):
            bits.append(f"не поддержано: {len(p['unsupported'])}")
        out.append(f"  • {p.get('process_id')}: " + ", ".join(bits))
    return out


# ── Поиск и одна схема ───────────────────────────────────────────────────────
# Вид находки словами — в единственном числе, как подпись строки.
SEARCH_KIND_WORD = {
    "node": "объект",
    "doc": "схема",
    "spec": "спецификация",
    "table": "таблица",
    "column": "колонка",
    "channel": "канал",
    "field": "поле",
    "param": "параметр",
    "process": "процесс",
    "step": "шаг",
}
SEARCH_NEXT = (
    "Открыть найденное: схему целиком — archmap_doc(doc_id), объект — "
    "archmap_node(node_id), процесс с шагами — archmap_processes(process_id)."
)


def _hit_tail(h: dict[str, Any]) -> str:
    """Хвост находки: что совпало. Счёт — для сравнения находок между собой."""
    matched = ", ".join(str(t) for t in h.get("matched") or [])
    return f"  [{h.get('score', 0):g}; совпало: {matched}]"


def _hit_line(h: dict[str, Any]) -> str:
    """Строка находки внутри группы схемы/спеки: номер строки и сниппет."""
    where = f"стр. {h['line_no']}" if h.get("line_no") else "заголовок"
    return f"      {where}: {h.get('snippet', '')}{_hit_tail(h)}"


def search_results(data: dict[str, Any]) -> str:
    """Выдача поиска (SearchResponse), сгруппированная по объектам.

    Порядок групп — по лучшей находке (бэкенд отдаёт по убыванию счёта). Внутри
    объекта строки одной схемы (или спеки) собраны под её заголовком с doc_id —
    именно его агент понесёт в archmap_doc. Процессы и шаги объекту не
    принадлежат: у каждого процесса своя группа с process_id.
    """
    tokens = ", ".join(str(t) for t in data.get("tokens") or [])
    hits: list[dict[str, Any]] = data.get("hits") or []
    total = int(data.get("total", 0) or 0)
    if not hits:
        return (
            f"Ничего не нашлось (искали по: {tokens}). Находкой считается строка, где "
            "совпали хотя бы два слова запроса, а схемы часто пересказывают ошибку "
            "по-русски. Попробуйте одно характерное слово из строки — имя параметра, "
            "протокола, таблицы, устройства: запрос из одного слова находит все его "
            "вхождения."
        )
    head = f"Найдено {total}"
    if total > len(hits):
        head += f", показаны лучшие {len(hits)}"
    out = [f"{head} (искали по: {tokens})"]

    # Группа → подгруппы в порядке первой находки. Ключ подгруппы: схема (doc_id),
    # спека объекта или одиночная находка.
    groups: dict[str, dict[str, list[dict[str, Any]]]] = {}
    group_head: dict[str, str] = {}
    for h in hits:
        if h.get("node_id"):
            g = f"node:{h['node_id']}"
            group_head[g] = f"▸ {h.get('node_path') or '?'}  node_id={h['node_id']}"
        else:
            g = f"process:{h.get('process_id')}"
            group_head[g] = f"▸ процесс «{h.get('title', '?')}»  process_id={h.get('process_id')}"
        kind = h.get("kind")
        if kind == "doc":
            sub = f"doc:{h.get('doc_id')}"
        elif kind == "spec":
            sub = "spec"
        else:
            sub = f"one:{len(groups.get(g, {}))}"
        groups.setdefault(g, {}).setdefault(sub, []).append(h)

    for g, subs in groups.items():
        out.append("")
        out.append(group_head[g])
        for sub, items in subs.items():
            first = items[0]
            if sub.startswith("doc:"):
                out.append(f"  • схема «{first.get('title', '?')}»  doc_id={first.get('doc_id')}")
                out.extend(_hit_line(h) for h in items)
            elif sub == "spec":
                out.append("  • OpenAPI-спецификация объекта (archmap_node с include_spec)")
                out.extend(_hit_line(h) for h in items)
            else:
                out.append(_single_hit(first))
                continue
            more = int(first.get("more_in_group", 0) or 0)
            if more:
                where = "в спецификации" if sub == "spec" else "в этой схеме"
                lines = _plural(more, ("строка", "строки", "строк"))
                out.append(f"      … ещё {more} {lines} {where}")
    out.append("")
    out.append(SEARCH_NEXT)
    return "\n".join(out)


def _single_hit(h: dict[str, Any]) -> str:
    """Непострочная находка: объект, таблица, колонка, канал, поле, параметр,
    процесс, шаг."""
    kind = str(h.get("kind", "?"))
    word = SEARCH_KIND_WORD.get(kind, kind)
    if kind in ("node", "process"):
        line = f"  • {word}: {h.get('snippet', '')}"
    elif kind == "step":
        line = f"  • {word}: {h.get('snippet', '')}  message_id={h.get('message_id')}"
        if h.get("doc_id"):
            line += f" (задокументирован схемой doc_id={h['doc_id']})"
    else:
        line = f"  • {word} {h.get('title', '?')}: {h.get('snippet', '')}"
    return line + _hit_tail(h)


def doc_card(detail: dict[str, Any]) -> str:
    """Одна схема логики (NodeDocDetail): адрес, вид, эндпоинт, заглушка,
    участие в процессах и полный текст."""
    kind = str(detail.get("kind", "?"))
    head = KIND_WORD.get(kind, kind)
    if detail.get("operation"):
        head += f" · {detail['operation']}"
    out = [
        f"Объект: {detail.get('node_path', '?')}  node_id={detail.get('node_id')}",
        f"Схема: «{detail.get('name', '?')}» ({head})  doc_id={detail.get('id')}",
    ]
    if detail.get("described") is False:
        out.append("Не описана: это заглушка разведки, тела у схемы нет.")
    procs: list[dict[str, Any]] = detail.get("processes") or []
    if procs:
        n = len(procs)
        out.append(f"В {n} {_plural(n, ('процессе', 'процессах', 'процессах'))}:")
        for p in procs:
            steps = int(p.get("steps", 0) or 0)
            out.append(
                f"  • {p.get('process_name', '?')} — {steps} "
                f"{_plural(steps, ('шаг', 'шага', 'шагов'))}  process_id={p.get('process_id')}"
            )
    else:
        out.append("В процессах шаги этой схемой не задокументированы.")
    if detail.get("described") is not False:
        out.append("")
        # Хвостовые переводы строк тела — не содержание: без обрезки перед
        # закрывающей оградой висела пустая строка (живой прогон 2026-09-29).
        out.append("```mermaid\n" + str(detail.get("content", "")).rstrip() + "\n```")
    return "\n".join(out)


# ── Версии документации объекта (docs/tasks/doc-versions.md §8) ──────────────
#
# Категории элемента дельты словами — один словарь на весь вывод: строка дельты,
# «изменено: …» у версии и перечень незафиксированного говорят одними словами.
# Строчными, потому что слово стоит и внутри фразы («изменено: схема логики «A»»);
# в начале строки дельты оно поднимается с заглавной. Статусы — в среднем роде:
# элемент бывает схемой, связью, таблицей, а согласовывать род по категории в
# тексте для агента незачем (интерфейс это делает, там слова на экране).
VERSION_CATEGORY_WORD = {
    "props": "свойства",
    "edges": "связь",
    "doc": "схема логики",
    "spec": "OpenAPI",
    "db": "таблица",
    "channels": "канал",
    "config": "конфигурация",
    "placement": "размещение",
    "approval": "статус страницы",
    "process": "процесс",
}
VERSION_STATUS_WORD = {"added": "новое", "removed": "удалено", "changed": "изменено"}

# Строка «изменено: …» у версии — подсказка, а не отчёт: пять элементов и счётчик
# остального. Полный перечень — archmap_version_diff той же версии.
CHANGED_BRIEF_CAP = 5
# Список элементов дельты режется ПО КАТЕГОРИЯМ, а не общим хвостом: сервер сортирует
# по категории, и у первой версии корня (всё «новое») общий кап съел бы свойствами
# и связями сотен объектов схемы логики и процессы — то, о чём агент и спрашивает.
VERSION_ITEMS_CAP = 40

# Метка строки таблицы в представлении элемента (VersionRow.mark): добавлена,
# удалена, изменена (ячейка «было → стало»), только переставлена; пусто — контекст.
ROW_MARK = {"add": "+", "del": "−", "mod": "~", "move": "↕", "": " "}
# Метка построчной дельты текста (DiffLine.mark) — как в unified diff; «mod» —
# заголовок куска «@@» или смена свойства схемы, печатается как есть.
LINE_MARK = {"add": "+", "del": "-", "": " "}

DIFF_NEXT = (
    "Дельта одного элемента — archmap_version_diff с item (те же version и base); "
    "текст схемы, спецификации или процесса на версии — archmap_version_doc."
)


def _version_item_label(item: dict[str, Any]) -> str:
    """«схема логики «Создать заказ»». Имя, совпадающее со словом категории (у спеки
    оно всегда «OpenAPI»), не повторяется."""
    cat = str(item.get("category", "?"))
    word = VERSION_CATEGORY_WORD.get(cat, cat)
    name = str(item.get("name") or "")
    return f"{word} «{name}»" if name and name != word else word


def changed_brief(items: list[dict[str, Any]]) -> str:
    """Короткий перечень элементов (VersionChanged или VersionItem): категория и имя,
    у нового и удалённого — пометка в скобках; дальше пятого — «и ещё M»."""
    parts: list[str] = []
    for item in items[:CHANGED_BRIEF_CAP]:
        label = _version_item_label(item)
        status = str(item.get("status", ""))
        if status in ("added", "removed"):
            label += f" ({VERSION_STATUS_WORD[status]})"
        parts.append(label)
    rest = len(items) - CHANGED_BRIEF_CAP
    tail = f" и ещё {rest}" if rest > 0 else ""
    return ", ".join(parts) + tail


def _version_when(raw: Any) -> str:
    """Время версии: «2026-10-22 10:15 UTC». Зону называем явно — агент и человек могут
    жить в разных; неразборчивое время печатается как пришло."""
    try:
        moment = datetime.fromisoformat(str(raw))
    except ValueError:
        return str(raw)
    if moment.tzinfo is None:
        moment = moment.replace(tzinfo=UTC)
    return moment.astimezone(UTC).strftime("%Y-%m-%d %H:%M UTC")


def _version_kind(version: dict[str, Any]) -> str | None:
    """Вид автоматической версии словами; у ручной — ничего."""
    kind = version.get("kind")
    if kind == "pre_restore":
        return "перед откатом"
    if kind == "restore":
        source = version.get("restored_from")
        return f"откат к v{source}" if source is not None else "откат"
    return None


def version_list(title: str, data: dict[str, Any]) -> str:
    """Список версий (VersionList): заголовок, незафиксированное с последней версии,
    версии новыми сверху с короткой строкой «изменено»."""
    rows: list[dict[str, Any]] = data.get("versions") or []
    pending: dict[str, Any] = data.get("pending") or {}
    out = [title]
    if not rows:
        out.append("Версий ещё нет.")
        return "\n".join(out)

    last = max(int(v.get("number", 0)) for v in rows)
    items: list[dict[str, Any]] = pending.get("items") or []
    if items:
        out.append(f"Есть изменения с v{last}: {changed_brief(items)}")
    elif pending.get("changed"):
        out.append(f"Есть изменения с v{last}.")
    else:
        out.append(f"Изменений с v{last} нет.")

    out.append("")
    for v in rows:
        bits = [
            f"v{v.get('number', '?')}",
            str(v.get("comment") or ""),
            _version_when(v.get("created_at")),
            # null — пользователь удалён: история остаётся, автора у неё больше нет.
            str(v.get("author") or "автор удалён"),
        ]
        # Вид автоверсии не печатаем: её комментарий («Перед откатом к vN», «Откат к vN»)
        # уже называет его, а повтор в конце строки — шум.
        out.append("• " + " · ".join(bits))
        changed: list[dict[str, Any]] = (v.get("stats") or {}).get("changed") or []
        if changed:
            out.append(f"    изменено: {changed_brief(changed)}")
    out.append("")
    out.append(
        "Что изменилось в версии — archmap_version_diff с version; "
        "с версии до текущего состояния — base=live."
    )
    return "\n".join(out)


def _version_ref(ref: dict[str, Any] | None) -> str:
    """Сторона сравнения (VersionRef): версия с комментарием, текущее состояние
    (number — null) или пустое начало (стороны нет: первая версия против «предыдущей»)."""
    if ref is None:
        return "с начала"
    number = ref.get("number")
    if number is None:
        return "текущее состояние"
    comment = ref.get("comment")
    return f"v{number} ({comment})" if comment else f"v{number}"


def _version_item_line(item: dict[str, Any]) -> str:
    """«Схема логики «Создать заказ» (Заказы / Сервис заказов): изменено, +3 −2»."""
    label = _version_item_label(item)
    label = label[:1].upper() + label[1:]
    path = item.get("node_path")
    where = f" ({path})" if path else ""
    status = str(item.get("status", "?"))
    summary = item.get("summary")
    tail = f", {summary}" if summary else ""
    return f"{label}{where}: {VERSION_STATUS_WORD.get(status, status)}{tail}"


def version_diff(owner: str, data: dict[str, Any]) -> str:
    """Элементы дельты (VersionDiff) — строка на элемент, item в конце строки: им
    агент спрашивает подробности одного элемента."""
    head = f"{owner} — {_version_ref(data.get('base'))} → {_version_ref(data.get('target'))}"
    items: list[dict[str, Any]] = data.get("items") or []
    if not items:
        return f"{head}\nИзменений нет."

    groups: dict[str, list[str]] = {}
    for item in items:
        line = f"• {_version_item_line(item)}  item={item.get('item_id')}"
        groups.setdefault(str(item.get("category")), []).append(line)
    out = [head, ""]
    for lines in groups.values():
        out.extend(_capped(lines, VERSION_ITEMS_CAP, ("элемент", "элемента", "элементов")))
    out.append("")
    out.append(DIFF_NEXT)
    return "\n".join(out)


def _version_base_phrase(number: int, base: str) -> str:
    """С чем сравнивали одну дельту: ответ ручки элемента сторон не называет, а base
    у вызова на руках."""
    if base == "prev":
        return f"v{number} против предыдущей версии"
    if base == "live":
        return f"v{number} → текущее состояние"
    return f"v{base} → v{number}"


def _version_view(view: dict[str, Any]) -> list[str]:
    """Одно представление элемента (VersionView) строками. Форма ровно одна: text —
    как есть, lines — построчная дельта со знаками, columns + rows — таблица ячейками
    через « | ». Все поля пусты — элемента на этой стороне нет."""
    text = view.get("text")
    if text is not None:
        return [str(text)] if str(text) else ["(пусто)"]
    lines: list[dict[str, Any]] | None = view.get("lines")
    if lines:
        out: list[str] = []
        for ln in lines:
            mark = str(ln.get("mark", ""))
            body = str(ln.get("text", ""))
            # Заголовок куска «@@» и смена свойства схемы — строки без знака.
            out.append(body if mark == "mod" else LINE_MARK.get(mark, " ") + body)
        return out
    columns: list[str] | None = view.get("columns")
    rows: list[dict[str, Any]] | None = view.get("rows")
    if columns is not None and rows:
        table = ["  " + " | ".join(str(c) for c in columns)]
        for row in rows:
            mark = ROW_MARK.get(str(row.get("mark", "")), " ")
            table.append(f"{mark} " + " | ".join(str(c) for c in row.get("cells") or []))
        return table
    return ["(нет)"]


def version_item(
    owner: str, number: int, base: str, detail: dict[str, Any], *, with_sides: bool
) -> str:
    """Один элемент дельты (VersionItemDetail): строка элемента и «изменения»; с
    with_sides — ещё «было» и «стало» теми же правилами."""
    item: dict[str, Any] = detail.get("item") or {}
    out = [
        f"{owner} — {_version_base_phrase(number, base)}",
        f"{_version_item_line(item)}  item={item.get('item_id')}",
        "",
        "ИЗМЕНЕНИЯ:",
        *_version_view(detail.get("changes") or {}),
    ]
    if with_sides:
        out += ["", "БЫЛО:", *_version_view(detail.get("before") or {})]
        out += ["", "СТАЛО:", *_version_view(detail.get("after") or {})]
    return "\n".join(out)


def version_text(label: str, number: int, data: dict[str, Any], *, fence: str) -> str:
    """Текст на версии (VersionText): «Схема логики «Имя» (vN)» и тело в ограде."""
    body = str(data.get("text", "")).rstrip()
    return f"{label} «{data.get('name', '?')}» (v{number})\n```{fence}\n{body}\n```"


def version_created(data: dict[str, Any]) -> str:
    """Итог фиксации (VersionOut): номер, комментарий и что изменено относительно
    предыдущей версии объекта (у первой — относительно пустого)."""
    changed: list[dict[str, Any]] = (data.get("stats") or {}).get("changed") or []
    tail = (
        f"; изменено: {changed_brief(changed)}"
        if changed
        else "; относительно предыдущей версии ничего не изменилось"
    )
    return f"v{data.get('number', '?')} зафиксирована: {data.get('comment', '')}{tail}"
