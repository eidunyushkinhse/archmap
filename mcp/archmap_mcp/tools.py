"""Каталог инструментов ArchMap для агента пользователя.

Инструменты сделаны ПО ЗАДАЧАМ, а не по эндпоинтам: у API их около шестидесяти,
и зеркалить их один в один — значит вывалить на модель роуты вместо смысла.
Здесь три слоя:

  • чтение — понять систему (проекты, дерево, карточка, алерты, процессы, YAML);
  • правила формата — те же промпты, что отдаёт интерфейс (BYOA): агент сперва
    узнаёт требуемый формат, потом строит YAML/.mmd;
  • запись — пачкой через превью→применение (импорт, синк, доки) и точечно
    (создать/поправить объект или связь).

УДАЛЕНИЙ НЕТ НИ ОДНОГО — осознанно (решение пользователя 2026-08-10). Снос узла
уводит поддерево, связи, доки и спеки; такое делают глазами, а не «на всякий
случай» из разговора. Правки статуса достаточно, чтобы пометить лишнее
выводимым, а физически убрать его человек может кнопкой «Принять переход».

Каждый инструмент, работающий с проектом, требует его ЯВНО (`project` — имя или
uuid). «Текущего проекта» в сервере нет намеренно: скрытое состояние на стороне
сервера делает результат зависимым от порядка вызовов, а агент этот порядок не
контролирует.
"""

from __future__ import annotations

import json
import uuid as uuidlib
from typing import Any

from archmap_mcp import render
from archmap_mcp.client import ArchMapClient, ArchMapError

PROJECT_ARG = {
    "type": "string",
    "description": "Проект: имя (можно частью) или uuid.",
}


def _is_uuid(value: str) -> bool:
    try:
        uuidlib.UUID(value)
    except ValueError:
        return False
    return True


async def resolve_project(client: ArchMapClient, ref: str) -> tuple[str, str]:
    """Ссылку на проект → (uuid, имя). Имя резолвится точным совпадением, затем
    подстрокой; неоднозначность — ошибка со списком вариантов, а не молчаливый
    выбор первого попавшегося."""
    projects = await client.request("GET", "/projects")
    by_id = {str(p["id"]): p for p in projects}
    if _is_uuid(ref):
        found = by_id.get(ref)
        if not found:
            raise ArchMapError(f"Проект {ref} не найден.")
        return ref, str(found["name"])

    low = ref.strip().lower()
    exact = [p for p in projects if str(p["name"]).lower() == low]
    partial = exact or [p for p in projects if low in str(p["name"]).lower()]
    if not partial:
        names = ", ".join(f"«{p['name']}»" for p in projects[:20]) or "(проектов нет)"
        raise ArchMapError(f"Проект «{ref}» не найден. Есть: {names}.")
    if len(partial) > 1:
        names = ", ".join(f"«{p['name']}»" for p in partial[:20])
        raise ArchMapError(f"Под «{ref}» подходит несколько проектов: {names}. Уточните.")
    return str(partial[0]["id"]), str(partial[0]["name"])


# ── Чтение ───────────────────────────────────────────────────────────────────

async def t_projects(client: ArchMapClient, args: dict[str, Any]) -> str:
    projects = await client.request("GET", "/projects")
    if not projects:
        return "Проектов нет."
    lines = []
    for p in projects:
        tail = f" — {p['description']}" if p.get("description") else ""
        archived = " (в архиве)" if p.get("archived_at") else ""
        lines.append(
            f"• {p['name']}{archived}: {p.get('object_count', '?')} объектов{tail}  id={p['id']}"
        )
    return "\n".join(lines)


async def t_schema(client: ArchMapClient, args: dict[str, Any]) -> str:
    pid, pname = await resolve_project(client, args["project"])
    nodes = await client.request("GET", "/nodes/all", project_id=pid)
    edge_list = await client.request("GET", "/edges/", project_id=pid)
    by_id = {str(n["id"]): n for n in nodes}

    root = args.get("node_id")
    if root:
        if root not in by_id:
            raise ArchMapError(f"Объект {root} не найден в проекте «{pname}».")
        keep: set[str] = set()
        stack = [root]
        while stack:
            cur = stack.pop()
            keep.add(cur)
            stack.extend(str(n["id"]) for n in nodes if str(n.get("parent_id")) == cur)
        subtree = [dict(n) for n in nodes if str(n["id"]) in keep]
        for n in subtree:  # корень поддерева показываем как вершину
            if str(n["id"]) == root:
                n["parent_id"] = None
        nodes_view = subtree
        edge_list = [
            e for e in edge_list
            if str(e.get("source_id")) in keep or str(e.get("target_id")) in keep
        ]
        head = f"Проект «{pname}», поддерево «{by_id[root]['name']}»"
    else:
        nodes_view = nodes
        head = f"Проект «{pname}»"

    names = {str(n["id"]): str(n["name"]) for n in nodes}
    return (
        f"{head}\n\nОБЪЕКТЫ:\n{render.tree(nodes_view)}\n\n"
        f"СВЯЗИ:\n{render.edges(edge_list, names)}"
    )


# Какая семья табличных фактов уместна форме объекта. Зеркало shapeDocs()
# фронта (frontend/src/types/index.ts) и гейтов shape в роутерах бэкенда:
# структура — у базы, каналы — у брокера, конфигурация — у сервиса. Запрашивать
# семью там, где её не бывает, — лишний круг к серверу и ложный раздел в карточке.
FACT_FAMILY = {
    "database": ("tables", render.db_tables),
    "broker": ("channels", render.broker_channels),
    "service": ("config", render.config_params),
}


async def t_node(client: ArchMapClient, args: dict[str, Any]) -> str:
    pid, pname = await resolve_project(client, args["project"])
    node_id = args["node_id"]
    node = await client.request("GET", f"/nodes/{node_id}", project_id=pid)
    all_nodes = await client.request("GET", "/nodes/all", project_id=pid)
    by_id = {str(n["id"]): n for n in all_nodes}
    incident = await client.request("GET", f"/nodes/{node_id}/edges", project_id=pid)
    doc_list = await client.request("GET", f"/nodes/{node_id}/docs", project_id=pid)
    # Заглушка/описанность — из МЕТЫ узла: в ответе /docs поля described нет, а
    # считать его по content нельзя (признак производный, живёт в БД).
    described = {str(d["id"]): bool(d.get("described", True)) for d in node.get("docs", [])}
    # Обратный индекс «в каких процессах» — только когда схемы есть: пустой узел
    # не должен платить лишним запросом.
    usage = (
        await client.request("GET", f"/nodes/{node_id}/docs/usage", project_id=pid)
        if doc_list
        else []
    )

    out = [
        f"Проект «{pname}»",
        f"Путь: {render.path_of(str(node['id']), by_id)}",
        f"Объект: {render.node_line(node)}",
    ]
    if node.get("description"):
        out.append(f"Описание: {node['description']}")
    out.append("")
    out.append("СВЯЗИ:")
    if incident:
        for e in incident:
            arrow = "→" if e.get("direction") == "outgoing" else "←"
            bits = [str(e[k]) for k in ("label", "technology") if e.get(k)]
            tail = f" [{', '.join(bits)}]" if bits else ""
            out.append(f"  {arrow} {e['other_node_name']}{tail}  id={e['id']}")
    else:
        out.append("  (нет)")

    out.append("")
    title, lines = render.docs(doc_list, described=described, usage=usage)
    out.append(title)
    out.extend(lines)

    # Семья табличных фактов — ровно одна и только по форме объекта.
    family = FACT_FAMILY.get(str(node.get("shape")))
    if family:
        path, draw = family
        rows = await client.request("GET", f"/nodes/{node_id}/{path}", project_id=pid)
        title, lines = draw(rows)
        out.append("")
        out.append(title)
        out.extend(lines)

    spec = node.get("openapi_spec")
    out.append("")
    out.append(f"OpenAPI-спека: {'есть' if spec else 'нет'}")
    if spec and args.get("include_spec"):
        out.append("```yaml\n" + str(spec) + "\n```")
    if doc_list and args.get("include_docs"):
        for d in doc_list:
            out.append(f"\n--- {d['name']} ---\n```mermaid\n{d.get('content', '')}\n```")
    return "\n".join(out)


async def t_alerts(client: ArchMapClient, args: dict[str, Any]) -> str:
    pid, pname = await resolve_project(client, args["project"])
    data = await client.request("GET", "/nodes/alerts", project_id=pid)
    return f"Проект «{pname}» — незавершённость схемы\n\n{render.alerts(data)}"


async def t_processes(client: ArchMapClient, args: dict[str, Any]) -> str:
    pid, pname = await resolve_project(client, args["project"])
    if not args.get("process_id"):
        items = await client.request("GET", "/processes", project_id=pid)
        if not items:
            return f"В проекте «{pname}» бизнес-процессов нет."
        lines = [
            f"• {p['name']} — участников {p.get('participant_count', '?')}, "
            f"сообщений {p.get('message_count', '?')}  id={p['id']}"
            for p in items
        ]
        return f"Проект «{pname}» — бизнес-процессы:\n" + "\n".join(lines)

    detail = await client.request("GET", f"/processes/{args['process_id']}", project_id=pid)
    by_node = {str(p["node_id"]): str(p["name"]) for p in detail.get("participants", [])}
    out = [f"Процесс «{detail['name']}» (проект «{pname}»)", "", "УЧАСТНИКИ:"]
    for p in sorted(detail.get("participants", []), key=lambda p: p.get("order", 0)):
        out.append(f"  {p.get('order', '?')}. {p['name']}")
    out.append("")
    out.append("ШАГИ:")
    for m in sorted(detail.get("messages", []), key=lambda m: m.get("order", 0)):
        broken = "" if m.get("valid", True) else "  ⚠ связь удалена из схемы"
        src = by_node.get(str(m.get("from_id")), "?")
        dst = by_node.get(str(m.get("to_id")), "?")
        out.append(f"  {m.get('order', '?')}. {src} → {dst}: {m.get('caption') or '—'}{broken}")
    return "\n".join(out)


async def t_export(client: ArchMapClient, args: dict[str, Any]) -> str:
    pid, pname = await resolve_project(client, args["project"])
    path = f"/export/{args['node_id']}" if args.get("node_id") else "/export"
    data = await client.request("GET", path, project_id=pid)
    return f"# Проект «{pname}» — семантический экспорт\n{data.get('yaml', '')}"


# ── Правила формата (BYOA-промпты) ───────────────────────────────────────────

def _variant(args: dict[str, Any], params: dict[str, Any]) -> None:
    """Вариант промпта в query — ТОЛЬКО когда его попросили явно.

    Дефолт ручки и дефолт инструмента — «builder», поэтому пустой вызов обязан
    уходить на сервер прежним байт-в-байт: на строительном промпте сидят уже
    работающие агенты, и лишний параметр в запросе — это уже другой запрос."""
    variant = args.get("variant")
    if variant:
        params["variant"] = variant


async def t_import_prompt(client: ArchMapClient, args: dict[str, Any]) -> str:
    params: dict[str, Any] = {"system_name": args["system_name"]}
    for key in ("depth", "hints"):
        if args.get(key) is not None:
            params[key] = args[key]
    _variant(args, params)
    # Ложь = серверный дефолт: не шлём её, чтобы одно-продуктовый вызов не менялся.
    if args.get("multi_product"):
        params["multi_product"] = True
    data = await client.request("GET", "/projects/import/prompt", params=params)
    return str(data["prompt"])


async def t_docs_prompt(client: ArchMapClient, args: dict[str, Any]) -> str:
    pid, _ = await resolve_project(client, args["project"])
    params: dict[str, Any] = {"include": args.get("include", "both")}
    if args.get("node_id"):
        params["node_id"] = args["node_id"]
    _variant(args, params)
    data = await client.request("GET", "/docs-import/prompt", project_id=pid, params=params)
    return str(data["prompt"])


# ── Запись пачкой: превью → применение ───────────────────────────────────────

def _docs(args: dict[str, Any]) -> list[dict[str, str]]:
    return [{"name": f["name"], "content": f["content"]} for f in args["files"]]


async def t_import_preview(client: ArchMapClient, args: dict[str, Any]) -> str:
    # ⚠️ Контракт ручки (ImportPreviewIn.contents) — СПИСОК ТЕКСТОВ, не записей
    # {name, content}: имён файлов он не принимает вовсе, а нумерация замечаний
    # («файл 2») идёт по порядку списка. Записи давали латентную 422 на живом
    # сервере — тесты на подменённом транспорте формы не проверяли.
    body = {"contents": [f["content"] for f in args["files"]]}
    data = await client.request("POST", "/projects/import/preview", json=body)
    if not data.get("ok"):
        return "Импорт НЕ пройдёт. Ошибки:\n" + "\n".join("  • " + e for e in data.get("errors", []))
    out = [
        f"Разбор прошёл: объектов {data['node_count']}, связей {data['edge_count']}, "
        f"файлов {data['files']}."
    ]
    if data.get("roots"):
        out.append("Корни: " + ", ".join(data["roots"]))
    for key, title in (
        ("warnings", "Предупреждения"),
        ("conflicts", "Конфликты слияния"),
        ("dropped_edges", "Отброшенные связи"),
    ):
        items = data.get(key) or []
        if items:
            out.append(f"{title} ({len(items)}):\n" + "\n".join("  • " + str(i) for i in items))
    out.append("\nПроект ещё НЕ создан — для записи вызовите archmap_import_apply.")
    return "\n".join(out)


async def t_import_apply(client: ArchMapClient, args: dict[str, Any]) -> str:
    body = {
        "name": args["name"],
        "description": args.get("description"),
        "start": "import",
        # ⚠️ То же, что у превью: ProjectCreate.import_yamls — список ТЕКСТОВ.
        "import_yamls": [f["content"] for f in args["files"]],
    }
    data = await client.request("POST", "/projects", json=body)
    return (
        f"Проект «{data['name']}» создан: {data.get('object_count', '?')} объектов. "
        f"id={data['id']}"
    )


async def t_sync_preview(client: ArchMapClient, args: dict[str, Any]) -> str:
    pid, pname = await resolve_project(client, args["project"])
    body = _sync_body(args)
    data = await client.request("POST", f"/projects/{pid}/sync/preview", project_id=pid, json=body)
    return f"Проект «{pname}» — план обновления из кода\n\n" + _sync_report(data, applied=False)


async def t_sync_apply(client: ArchMapClient, args: dict[str, Any]) -> str:
    pid, pname = await resolve_project(client, args["project"])
    body = _sync_body(args)
    if args.get("base_graph_rev") is not None:
        body["base_graph_rev"] = args["base_graph_rev"]
    data = await client.request("POST", f"/projects/{pid}/sync/apply", project_id=pid, json=body)
    return f"Проект «{pname}» обновлён из кода\n\n" + _sync_report(data, applied=True)


def _sync_body(args: dict[str, Any]) -> dict[str, Any]:
    # ⚠️ SyncPreviewIn.contents — тоже список ТЕКСТОВ (вход синка совпадает с
    # входом импорта, отличаются только политики). Имена файлов контракт не берёт.
    body: dict[str, Any] = {"contents": [f["content"] for f in args["files"]]}
    for flag in (
        "update_descriptions",
        "update_names",
        "sync_components",
        "mark_missing_deprecated",
        "restore_returned",
    ):
        if args.get(flag) is not None:
            body[flag] = bool(args[flag])
    return body


def _sync_report(data: dict[str, Any], *, applied: bool) -> str:
    verb = "Сделано" if applied else "Будет сделано"
    counts = [
        f"создать объектов: {data.get('nodes_created', 0)}",
        f"обновить: {data.get('nodes_updated', 0)}",
        f"без изменений: {data.get('nodes_unchanged', 0)}",
        f"пропало из кода: {data.get('nodes_missing', 0)}",
        f"вернулось: {data.get('nodes_returned', 0)}",
        f"связей создать: {data.get('edges_created', 0)}",
    ]
    out = [f"{verb}: " + ", ".join(counts)]
    changed = [
        a for a in data.get("nodes", []) if a.get("action") in ("create", "update", "missing")
    ]
    if changed:
        out.append("")
        out.append("ОБЪЕКТЫ:")
        for a in changed[:60]:
            fields = f" ({', '.join(a['fields'])})" if a.get("fields") else ""
            out.append(f"  {a['action']}: {a['path']}{fields}")
        if len(changed) > 60:
            out.append(f"  … и ещё {len(changed) - 60}")
    if not applied:
        out.append("\nНичего не записано — для записи вызовите archmap_sync_apply.")
    return "\n".join(out)


async def t_docs_preview(client: ArchMapClient, args: dict[str, Any]) -> str:
    pid, pname = await resolve_project(client, args["project"])
    data = await client.request(
        "POST", "/docs-import/preview", project_id=pid, json=_docs_body(args)
    )
    return f"Проект «{pname}» — план дозаливки\n\n" + _docs_report(data, applied=False)


async def t_docs_apply(client: ArchMapClient, args: dict[str, Any]) -> str:
    pid, pname = await resolve_project(client, args["project"])
    data = await client.request(
        "POST", "/docs-import/apply", project_id=pid, json=_docs_body(args)
    )
    return f"Проект «{pname}» — дозаливка применена\n\n" + _docs_report(data, applied=True)


def _docs_body(args: dict[str, Any]) -> dict[str, Any]:
    body: dict[str, Any] = {"files": _docs(args), "overwrite": bool(args.get("overwrite", False))}
    if args.get("only"):
        body["only"] = args["only"]
    if args.get("node_id"):
        body["node_id"] = args["node_id"]
    return body


def _docs_report(data: dict[str, Any], *, applied: bool) -> str:
    out: list[str] = []
    items = data.get("items", [])
    for it in items[:80]:
        status = it.get("status", "?")
        target = it.get("target") or it.get("node_path") or ""
        out.append(f"  {status}: {it.get('name', '?')} → {target}")
    if len(items) > 80:
        out.append(f"  … и ещё {len(items) - 80}")
    problems = data.get("errors") or []
    if problems:
        out.append("\nПроблемы:\n" + "\n".join("  • " + str(p) for p in problems))
    if not applied:
        out.append("\nНичего не записано — для записи вызовите archmap_docs_apply.")
    return "\n".join(out) if out else json.dumps(data, ensure_ascii=False)[:2000]


# ── Точечные правки ──────────────────────────────────────────────────────────

async def t_create_node(client: ArchMapClient, args: dict[str, Any]) -> str:
    pid, pname = await resolve_project(client, args["project"])
    body = {
        "name": args["name"],
        "description": args.get("description"),
        "role": args.get("role"),
        "technology": args.get("technology"),
        "parent_id": args.get("parent_id"),
        "shape": args.get("shape", "service"),
        "is_external": bool(args.get("is_external", False)),
        "status": args.get("status", "existing"),
    }
    data = await client.request("POST", "/nodes/", project_id=pid, json=body)
    return f"В проекте «{pname}» создан объект «{data['name']}». id={data['id']}"


async def t_update_node(client: ArchMapClient, args: dict[str, Any]) -> str:
    pid, pname = await resolve_project(client, args["project"])
    body = {
        k: args[k]
        for k in ("name", "description", "role", "technology", "shape", "status", "is_external")
        if args.get(k) is not None
    }
    if not body:
        raise ArchMapError("Нечего менять: не передано ни одного поля.")
    data = await client.request("PATCH", f"/nodes/{args['node_id']}", project_id=pid, json=body)
    return f"В проекте «{pname}» обновлён «{data['name']}»: {', '.join(body)}."


async def t_create_edge(client: ArchMapClient, args: dict[str, Any]) -> str:
    pid, pname = await resolve_project(client, args["project"])
    body = {
        "source_id": args["source_id"],
        "target_id": args["target_id"],
        "label": args.get("label"),
        "technology": args.get("technology"),
        "is_synchronous": args.get("is_synchronous"),
    }
    data = await client.request("POST", "/edges/", project_id=pid, json=body)
    return f"В проекте «{pname}» создана связь. id={data['id']}"


async def t_update_edge(client: ArchMapClient, args: dict[str, Any]) -> str:
    pid, pname = await resolve_project(client, args["project"])
    body = {
        k: args[k] for k in ("label", "technology", "is_synchronous") if args.get(k) is not None
    }
    if not body:
        raise ArchMapError("Нечего менять: не передано ни одного поля.")
    await client.request("PATCH", f"/edges/{args['edge_id']}", project_id=pid, json=body)
    return f"В проекте «{pname}» связь обновлена: {', '.join(body)}."


# ── Реестр ───────────────────────────────────────────────────────────────────

VARIANT_ARG = {
    "type": "string",
    "enum": ["builder", "orchestrated", "skeptic"],
    "description": (
        "Вариант промпта: builder — строительный (по умолчанию); "
        "orchestrated — обёртка «построил → аудит скептика → починил», требует субагентов; "
        "skeptic — только промпт аудита готового пакета."
    ),
}

FILES_ARG = {
    "type": "array",
    "description": "Файлы прогона агента: [{name, content}].",
    "items": {
        "type": "object",
        "properties": {"name": {"type": "string"}, "content": {"type": "string"}},
        "required": ["name", "content"],
    },
}

TOOLS: list[dict[str, Any]] = [
    {
        "name": "archmap_projects",
        "description": "Список проектов ArchMap: имя, число объектов, id. С него начинают — дальше проект указывают именем.",
        "schema": {"type": "object", "properties": {}},
        "handler": t_projects,
    },
    {
        "name": "archmap_schema",
        "description": "Архитектура проекта: дерево объектов и все связи. node_id — показать только поддерево этого объекта.",
        "schema": {
            "type": "object",
            "properties": {"project": PROJECT_ARG, "node_id": {"type": "string"}},
            "required": ["project"],
        },
        "handler": t_schema,
    },
    {
        "name": "archmap_node",
        "description": "Карточка объекта: путь, мета, входящие и исходящие связи, схемы логики (вид, привязка к операции, метка «не описана» у заглушек разведки, участие в бизнес-процессах), наличие OpenAPI-спеки и семья табличных фактов по форме объекта — структура БД с колонками у базы, каналы с полями сообщений у брокера, параметры конфигурации у сервиса. include_docs/include_spec — вернуть тексты схем и спеки целиком.",
        "schema": {
            "type": "object",
            "properties": {
                "project": PROJECT_ARG,
                "node_id": {"type": "string"},
                "include_docs": {"type": "boolean"},
                "include_spec": {"type": "boolean"},
            },
            "required": ["project", "node_id"],
        },
        "handler": t_node,
    },
    {
        "name": "archmap_alerts",
        "description": "Незавершённость схемы — те же 15 классов замечаний и те же слова, что видит человек в панели интерфейса: объекты без связей; связи в контейнер; связи в собственный компонент; изолированные группы; контейнеры со своей документацией; обращения к неописанным данным, каналам и параметрам; связи с брокером без канала; незадокументированные сообщения; ответ на асинхронном канале; незадокументированные участники; шаги без схемы логики; объекты с неописанными схемами логики; пользователи внутри контейнера. Первая строка — общий счётчик проблем.",
        "schema": {
            "type": "object",
            "properties": {"project": PROJECT_ARG},
            "required": ["project"],
        },
        "handler": t_alerts,
    },
    {
        "name": "archmap_processes",
        "description": "Бизнес-процессы проекта: без process_id — список, с ним — участники и шаги сценария.",
        "schema": {
            "type": "object",
            "properties": {"project": PROJECT_ARG, "process_id": {"type": "string"}},
            "required": ["project"],
        },
        "handler": t_processes,
    },
    {
        "name": "archmap_export",
        "description": "Схема проекта в YAML формата ArchMap (семантика без раскладки) — то, что подают обратно на импорт и синк. node_id — только поддерево.",
        "schema": {
            "type": "object",
            "properties": {"project": PROJECT_ARG, "node_id": {"type": "string"}},
            "required": ["project"],
        },
        "handler": t_export,
    },
    {
        "name": "archmap_import_prompt",
        "description": "ПРАВИЛА ФОРМАТА: как построить YAML архитектуры по исходникам репозитория. Вызывать ДО построения YAML — промпт задаёт слои C4, правила связей и запреты. variant — какой промпт вернуть: строительный (по умолчанию), оркестраторный с аудитом скептика (для него нужны субагенты) или один аудит. multi_product — проект объединяет несколько самостоятельных продуктов (федерация репозиториев).",
        "schema": {
            "type": "object",
            "properties": {
                "system_name": {"type": "string", "description": "Имя системы в схеме."},
                "depth": {"type": "integer", "description": "Глубина C4: 2 или 3 (по умолчанию 3)."},
                "hints": {"type": "string", "description": "Подсказки про систему свободным текстом."},
                "variant": VARIANT_ARG,
                "multi_product": {
                    "type": "boolean",
                    "description": "Проект из нескольких продуктов: свой — контейнером, соседние — заглушками без детей. По умолчанию false.",
                },
            },
            "required": ["system_name"],
        },
        "handler": t_import_prompt,
    },
    {
        "name": "archmap_docs_prompt",
        "description": "ПРАВИЛА ФОРМАТА: как оформить схемы логики (.mmd с шапкой «%% archmap-name») и OpenAPI-спеки для дозаливки. include: logic | api | both. variant — строительный промпт (по умолчанию), оркестраторный с аудитом скептика (нужны субагенты) или один аудит.",
        "schema": {
            "type": "object",
            "properties": {
                "project": PROJECT_ARG,
                "node_id": {"type": "string", "description": "Объект, для которого готовим доки."},
                "include": {"type": "string", "enum": ["logic", "api", "both"]},
                "variant": VARIANT_ARG,
            },
            "required": ["project"],
        },
        "handler": t_docs_prompt,
    },
    {
        "name": "archmap_import_preview",
        "description": "Проверить YAML архитектуры БЕЗ записи: разбор, слияние нескольких репозиториев, конфликты и предупреждения. Проект не создаётся.",
        "schema": {
            "type": "object",
            "properties": {"files": FILES_ARG},
            "required": ["files"],
        },
        "handler": t_import_preview,
    },
    {
        "name": "archmap_import_apply",
        "description": "СОЗДАЁТ НОВЫЙ ПРОЕКТ из YAML архитектуры. Вызывать после archmap_import_preview.",
        "schema": {
            "type": "object",
            "properties": {
                "name": {"type": "string", "description": "Имя нового проекта."},
                "description": {"type": "string"},
                "files": FILES_ARG,
            },
            "required": ["name", "files"],
        },
        "handler": t_import_apply,
    },
    {
        "name": "archmap_sync_preview",
        "description": "План обновления СУЩЕСТВУЮЩЕГО проекта по свежему прогону кода, без записи: что создастся, что обновится, что пропало из кода.",
        "schema": {
            "type": "object",
            "properties": {
                "project": PROJECT_ARG,
                "files": FILES_ARG,
                "update_descriptions": {"type": "boolean"},
                "update_names": {"type": "boolean"},
                "sync_components": {"type": "boolean"},
                "mark_missing_deprecated": {"type": "boolean"},
                "restore_returned": {"type": "boolean"},
            },
            "required": ["project", "files"],
        },
        "handler": t_sync_preview,
    },
    {
        "name": "archmap_sync_apply",
        "description": "ПРИМЕНЯЕТ обновление проекта из кода. Синк не удаляет объекты и не трогает раскладку. Вызывать после archmap_sync_preview.",
        "schema": {
            "type": "object",
            "properties": {
                "project": PROJECT_ARG,
                "files": FILES_ARG,
                "update_descriptions": {"type": "boolean"},
                "update_names": {"type": "boolean"},
                "sync_components": {"type": "boolean"},
                "mark_missing_deprecated": {"type": "boolean"},
                "restore_returned": {"type": "boolean"},
                "base_graph_rev": {
                    "type": "integer",
                    "description": "Курсор схемы из превью: если схему успели изменить, применение отклонится.",
                },
            },
            "required": ["project", "files"],
        },
        "handler": t_sync_apply,
    },
    {
        "name": "archmap_docs_preview",
        "description": "План дозаливки схем логики (.mmd) и OpenAPI-спек БЕЗ записи: куда что уедет и что займёт занятый слот.",
        "schema": {
            "type": "object",
            "properties": {
                "project": PROJECT_ARG,
                "files": FILES_ARG,
                "overwrite": {"type": "boolean", "description": "Перезаписывать занятые слоты."},
                "only": {"type": "string", "enum": ["logic", "api"]},
                "node_id": {"type": "string", "description": "Ограничить область этим объектом."},
            },
            "required": ["project", "files"],
        },
        "handler": t_docs_preview,
    },
    {
        "name": "archmap_docs_apply",
        "description": "ПРИМЕНЯЕТ дозаливку схем логики и спек. Вызывать после archmap_docs_preview.",
        "schema": {
            "type": "object",
            "properties": {
                "project": PROJECT_ARG,
                "files": FILES_ARG,
                "overwrite": {"type": "boolean"},
                "only": {"type": "string", "enum": ["logic", "api"]},
                "node_id": {"type": "string"},
            },
            "required": ["project", "files"],
        },
        "handler": t_docs_apply,
    },
    {
        "name": "archmap_create_node",
        "description": "Создать один объект. parent_id — внутри какого объекта (без него — корневой уровень). shape: service | database | broker | person; person ВСЕГДА корневой (человек живёт за границей системы). status: existing | planned | deprecated.",
        "schema": {
            "type": "object",
            "properties": {
                "project": PROJECT_ARG,
                "name": {"type": "string"},
                "description": {"type": "string"},
                "role": {"type": "string", "description": "Роль: «сервис», «БД», «брокер»."},
                "technology": {"type": "string", "description": "Технология: Python, Kafka, Redis."},
                "parent_id": {"type": "string"},
                "shape": {"type": "string", "enum": ["service", "database", "broker", "person"]},
                "is_external": {"type": "boolean"},
                "status": {"type": "string", "enum": ["existing", "planned", "deprecated"]},
            },
            "required": ["project", "name"],
        },
        "handler": t_create_node,
    },
    {
        "name": "archmap_update_node",
        "description": "Правка объекта: имя, описание, роль, технология, форма, статус, внешность. Удаления объектов через MCP нет — чтобы убрать лишнее, поставьте status=deprecated, физически удалит человек кнопкой «Принять переход».",
        "schema": {
            "type": "object",
            "properties": {
                "project": PROJECT_ARG,
                "node_id": {"type": "string"},
                "name": {"type": "string"},
                "description": {"type": "string"},
                "role": {"type": "string"},
                "technology": {"type": "string"},
                "shape": {"type": "string", "enum": ["service", "database", "broker", "person"]},
                "status": {"type": "string", "enum": ["existing", "planned", "deprecated"]},
                "is_external": {"type": "boolean"},
            },
            "required": ["project", "node_id"],
        },
        "handler": t_update_node,
    },
    {
        "name": "archmap_create_edge",
        "description": "Создать связь между двумя объектами. Направление — от инициатора вызова. is_synchronous: false — событие (у асинхронного канала нет ответного плеча).",
        "schema": {
            "type": "object",
            "properties": {
                "project": PROJECT_ARG,
                "source_id": {"type": "string"},
                "target_id": {"type": "string"},
                "label": {"type": "string", "description": "Что передаётся: «создать заказ»."},
                "technology": {"type": "string", "description": "REST, gRPC, Kafka."},
                "is_synchronous": {"type": "boolean"},
            },
            "required": ["project", "source_id", "target_id"],
        },
        "handler": t_create_edge,
    },
    {
        "name": "archmap_update_edge",
        "description": "Правка связи: подпись, технология, тип канала.",
        "schema": {
            "type": "object",
            "properties": {
                "project": PROJECT_ARG,
                "edge_id": {"type": "string"},
                "label": {"type": "string"},
                "technology": {"type": "string"},
                "is_synchronous": {"type": "boolean"},
            },
            "required": ["project", "edge_id"],
        },
        "handler": t_update_edge,
    },
]

BY_NAME = {t["name"]: t for t in TOOLS}


async def call(name: str, args: dict[str, Any], client: ArchMapClient) -> str:
    tool = BY_NAME.get(name)
    if tool is None:
        raise ArchMapError(f"Неизвестный инструмент: {name}")
    handler = tool["handler"]
    return str(await handler(client, args))
