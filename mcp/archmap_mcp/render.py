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
