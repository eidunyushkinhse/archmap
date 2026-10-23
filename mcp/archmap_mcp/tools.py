"""Каталог инструментов ArchMap для агента пользователя.

Инструменты сделаны ПО ЗАДАЧАМ, а не по эндпоинтам: у API их около шестидесяти,
и зеркалить их один в один — значит вывалить на модель роуты вместо смысла.
Здесь три слоя:

  • чтение — понять систему (проекты, дерево, поиск по всему знанию, карточка,
    одна схема логики, версии документации и их дельты, алерты, процессы,
    размещение на площадках развёртывания, YAML)
    и вынести её знание наружу целиком (архив проекта — в файл на диске);
  • правила формата — те же промпты, что отдаёт интерфейс (BYOA): агент сперва
    узнаёт требуемый формат, потом строит YAML/.mmd/перечень/таблицы. Сюда же
    входит разведка — единственный промпт, который производит не документацию, а
    ОГЛАВЛЕНИЕ: перечень точек входа, по которому документирование идёт адресно;
  • запись — пачкой через превью→применение (единый импорт N входов, догрузка
    архивов к живому проекту, синк, доки, заглушки разведки, три семьи табличных
    фактов одной тройкой инструментов с аргументом family) и точечно
    (создать/поправить объект или связь, привязать шаг процесса к схеме логики,
    зафиксировать версию документации — только по просьбе человека).
    Процессы, стало быть, не только читаются: сам сценарий рисуют глазами, а вот
    АДРЕС документации шага — знание того же рода, что и схема логики, и агент
    проставляет его сам, выбирая из каталога допустимых схем.

Крупные входы и выходы ходят ПУТЯМИ ФАЙЛОВ, а не телом вызова: сервер живёт на
машине агента (stdio), и гнать zip-архив через контекст модели base64-ом —
расточительство. YAML, который агент только что построил сам, по-прежнему
принимается текстом; оба вида входа смешиваются в одном вызове.

УДАЛЕНИЙ НЕТ НИ ОДНОГО — осознанно (решение пользователя 2026-08-10). Снос узла
уводит поддерево, связи, доки и спеки; такое делают глазами, а не «на всякий
случай» из разговора. Правки статуса достаточно, чтобы пометить лишнее
выводимым, а физически убрать его человек может кнопкой «Принять переход».

Два набора. Локальный (stdio, сервер на машине агента) — весь TOOLS. Удалённый
(/mcp в процессе бэкенда ArchMap, docs/plan-remote-mcp.md) — без инструментов,
работающих с диском (LOCAL_ONLY): там «диск агента» — это диск СЕРВЕРА; зовут его через
call_remote, который отказывает ДО любого обработчика. Флаг writes у инструмента —
«нужны права на запись» (превью тоже: они на ручках редактора); токену «только чтение»
пишущие не показываются и не исполняются.

Каждый инструмент, работающий с проектом, требует его ЯВНО (`project` — имя или
uuid). «Текущего проекта» в сервере нет намеренно: скрытое состояние на стороне
сервера делает результат зависимым от порядка вызовов, а агент этот порядок не
контролирует.
"""

from __future__ import annotations

import io
import json as jsonlib
import os
import tempfile
import uuid as uuidlib
import zipfile
from contextlib import suppress
from pathlib import Path
from typing import Any

import yaml

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

# Роль учётки агента в проекте (my_role) словами: что агенту там можно.
ROLE_WORDS = {"owner": "владелец", "editor": "редактор", "reader": "чтение"}


async def t_projects(client: ArchMapClient, args: dict[str, Any]) -> str:
    # Сервер отдаёт только проекты, доступные учётке агента, — фильтровать нечего.
    projects = await client.request("GET", "/projects")
    if not projects:
        return "Проектов нет."
    lines = []
    for p in projects:
        tail = f" — {p['description']}" if p.get("description") else ""
        archived = " (в архиве)" if p.get("archived_at") else ""
        role = ROLE_WORDS.get(p.get("my_role") or "")
        badge = f" [{role}]" if role else ""
        lines.append(
            f"• {p['name']}{archived}{badge}: {p.get('object_count', '?')} объектов{tail}"
            f"  id={p['id']}"
        )
    return "\n".join(lines)


async def t_schema(client: ArchMapClient, args: dict[str, Any]) -> str:
    pid, pname = await resolve_project(client, args["project"])
    nodes = await client.request("GET", "/nodes/all", project_id=pid)
    edge_list = await client.request("GET", "/edges", project_id=pid)
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
        # Источник — чем ArchMap опознает объект при следующем обновлении из кода.
        # Печатаем ВСЕГДА, в том числе «нет»: у объекта без источника переименование
        # рождает дубль, и агент вправе знать это до правки, а не после.
        render.anchor_line(node),
    ]
    # Размещение — строка «Размещение» страницы объекта: где он крутится (свои площадки
    # или унаследованные от контейнера). Нет размещения — нет и строки: площадки в
    # проекте могут вовсе не вестись, и «не указано» в каждой карточке было бы шумом.
    placement = render.placement_line(node)
    if placement:
        out.append(placement)
    # Статус страницы — пилюля у имени в интерфейсе. У контейнера он складывается из
    # детей: счётчик — по прямым детям из того же /nodes/all, без лишнего запроса.
    approval = render.approval_line(
        node, [n for n in all_nodes if str(n.get("parent_id")) == str(node["id"])]
    )
    if approval:
        out.append(approval)
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

    # Участие в процессах — вопрос про ОБЪЕКТ (линия жизни), а не про его схемы:
    # участником узел бывает и без единой схемы логики. Раздела нет, когда объект
    # ни в одном процессе не занят: пустой заголовок в каждой карточке — шум.
    processes = await client.request("GET", f"/nodes/{node_id}/processes", project_id=pid)
    if processes:
        title, lines = render.node_processes(processes)
        out.append("")
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


async def t_deployment(client: ArchMapClient, args: dict[str, Any]) -> str:
    """Схема развёртывания: площадки деревом с составом либо размещение одного объекта.

    Состав — из /nodes/all, а не из графа развёртывания: граф — вход холста (поддерево
    одного уровня, связи и раскладка), а здесь нужен весь проект. В /nodes/all
    действующее размещение есть у каждого объекта (NodeResponse.sites, свои — без
    inherited_from_id)."""
    pid, pname = await resolve_project(client, args["project"])
    sites = await client.request("GET", "/deployment/sites", project_id=pid)
    if not sites:
        return f"Проект «{pname}». {render.NO_SITES}."
    nodes = await client.request("GET", "/nodes/all", project_id=pid)
    node_id = args.get("node_id")
    if node_id:
        by_id = {str(n["id"]): n for n in nodes}
        if node_id not in by_id:
            raise ArchMapError(f"Объект {node_id} не найден в проекте «{pname}».")
        return "\n".join([f"Проект «{pname}»", *render.node_placement(by_id[node_id], by_id, sites)])
    head = f"Проект «{pname}» — площадки развёртывания ({len(sites)}):"
    return "\n".join([head, *render.deployment_tree(sites, nodes)])


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
        return f"Проект «{pname}» — бизнес-процессы:\n" + render.process_list(items)

    detail = await client.request("GET", f"/processes/{args['process_id']}", project_id=pid)
    head = f"Процесс «{detail['name']}» (проект «{pname}»)"
    return f"{head}\n\n{render.process_detail(detail)}"


SEARCH_KINDS = [
    "node", "doc", "spec", "table", "column", "channel", "field", "param", "process", "step",
]


async def t_search(client: ArchMapClient, args: dict[str, Any]) -> str:
    """Поиск по знанию проекта. Матчинг и ранжирование — на бэкенде (app/search.py):
    здесь только доставка запроса и свёртка выдачи в текст по объектам."""
    pid, pname = await resolve_project(client, args["project"])
    params: dict[str, Any] = {"q": args["query"]}
    if args.get("limit"):
        params["limit"] = int(args["limit"])
    if args.get("kinds"):
        # Повторяемый параметр (?kinds=doc&kinds=spec): httpx раскладывает список сам.
        params["kinds"] = list(args["kinds"])
    data = await client.request("GET", "/search", project_id=pid, params=params)
    return f"Проект «{pname}» — поиск\n\n{render.search_results(data)}"


async def t_doc(client: ArchMapClient, args: dict[str, Any]) -> str:
    """Одна схема логики по doc_id.

    Эндпоинт адресует схему через объект (/nodes/{node_id}/docs/{doc_id}), а у
    агента на руках только doc_id — объект находим по мете схем в плоском списке
    узлов: он уже несёт id всех схем, лишнего запроса на каждый объект нет.
    """
    pid, pname = await resolve_project(client, args["project"])
    doc_id = str(args["doc_id"])
    nodes = await client.request("GET", "/nodes/all", project_id=pid)
    owner = next(
        (n for n in nodes if any(str(d.get("id")) == doc_id for d in n.get("docs") or [])),
        None,
    )
    if owner is None:
        raise ArchMapError(
            f"Схема {doc_id} не найдена в проекте «{pname}». doc_id берут из "
            "archmap_search, archmap_node или шага archmap_processes."
        )
    detail = await client.request(
        "GET", f"/nodes/{owner['id']}/docs/{doc_id}", project_id=pid
    )
    return f"Проект «{pname}»\n{render.doc_card(detail)}"


async def t_step_docs(client: ArchMapClient, args: dict[str, Any]) -> str:
    """Каталог схем, которыми ЗАКОННО задокументировать шаг.

    Считает его бэкенд: правило владельца и скоуп (поддеревья обоих участников) —
    доменное знание, и вторая его реализация здесь разошлась бы с первой. Задача
    инструмента — не угадывать, а показать агенту допустимый выбор.
    """
    pid, pname = await resolve_project(client, args["project"])
    path = f"/processes/{args['process_id']}/messages/{args['message_id']}/docs"
    data = await client.request("GET", path, project_id=pid)
    return f"Проект «{pname}» — чем можно задокументировать шаг\n\n" + render.step_docs(data)


async def t_bind_step(client: ArchMapClient, args: dict[str, Any]) -> str:
    pid, pname = await resolve_project(client, args["project"])
    if "doc_id" not in args:
        raise ArchMapError(
            "Не передан doc_id: id схемы из archmap_step_docs либо null (снять привязку)."
        )
    # ⚠️ Тело — РОВНО два поля: MessageUpdate несёт ещё caption и order, а бэкенд
    # применяет пришедшие через exclude_unset — лишний ключ переписал бы подпись.
    # doc_id кладём ВСЕГДА, в том числе null: пропуск ключа для бэка означает «не
    # трогать привязку», а не «отвязать», и снятие молча ничего бы не сделало.
    # Пустая строка — тот же null: клиенты MCP охотно выбрасывают из аргументов
    # настоящий null, и без этого синонима снятие стало бы невыразимым.
    body: dict[str, Any] = {
        "doc_id": args["doc_id"] or None,
        "base_version": args["base_version"],
    }
    path = f"/processes/{args['process_id']}/messages/{args['message_id']}"
    msg = await client.request("PATCH", path, project_id=pid, json=body)
    return f"Проект «{pname}» — привязка шага обновлена\n\n" + render.step_bound(msg)


async def t_export(client: ArchMapClient, args: dict[str, Any]) -> str:
    pid, pname = await resolve_project(client, args["project"])
    path = f"/export/{args['node_id']}" if args.get("node_id") else "/export"
    data = await client.request("GET", path, project_id=pid)
    # ⚠️ Поле контракта — content (ExportResponse), НЕ «yaml»: по несуществующему
    # ключу инструмент годами отдавал агенту пустой экспорт с одной шапкой, и
    # ловилось это только живым прогоном (подменённый транспорт форму не судит).
    return f"# Проект «{pname}» — семантический экспорт\n{data.get('content', '')}"


# Пределы чтения с диска и из ответа (аудит P-11): файл ввоза больше предела запроса
# бэкенда (MAX_REQUEST_MB) сервер всё равно отвергнет — незачем тянуть его в память.
MAX_INPUT_BYTES = 64 * 1024 * 1024
MAX_MANIFEST_BYTES = 1024 * 1024


def _export_target(raw: str, export_dir: str, overwrite: bool) -> Path:
    """Куда писать архив (аудит P-10): путь задаёт модель, поэтому — только файл .zip,
    не символическая ссылка (через висячую ссылку перезаписался бы чужой файл) и, если
    задан ARCHMAP_EXPORT_DIR, только внутри него (относительный путь — от него же)."""
    path = Path(raw).expanduser()
    if export_dir:
        root = Path(export_dir).expanduser().resolve()
        path = path if path.is_absolute() else root / path
        if not path.resolve().is_relative_to(root):
            raise ArchMapError(f"out_path {path}: архив пишется только внутри ARCHMAP_EXPORT_DIR={root}.")
    if path.suffix.lower() != ".zip":
        raise ArchMapError(f"out_path {path}: архив проекта пишется в файл .zip.")
    if path.is_symlink():
        raise ArchMapError(f"out_path {path} — символическая ссылка; укажите обычный файл.")
    if path.exists() and not path.is_file():
        raise ArchMapError(f"out_path {path} — не файл.")
    if path.exists() and not overwrite:
        raise ArchMapError(
            f"Файл {path} уже существует. Перезапись только явным overwrite=true "
            "или укажите другой out_path."
        )
    return path


def _write_atomic(path: Path, payload: bytes) -> None:
    """Через временный файл рядом и os.replace: оборванная запись не оставляет на месте
    архива огрызок. Права 600 — в архиве весь проект."""
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=path.parent, prefix=f".{path.name}.", suffix=".part")
    try:
        with os.fdopen(fd, "wb") as f:
            f.write(payload)
        os.replace(tmp, path)
    except BaseException:
        with suppress(FileNotFoundError):
            os.unlink(tmp)
        raise


async def t_export_archive(client: ArchMapClient, args: dict[str, Any]) -> str:
    """Полный архив знания проекта (zip) — В ФАЙЛ на диске агента.

    Почему файлом, а не телом ответа: архив несёт всё содержимое доков, спек и
    таблиц; вернуть его в разговор — выложить весь проект в контекст модели, а
    нужен он для бэкапа и переноса (тем же путём он и заезжает обратно —
    archmap_import_apply/paths). Имя файла задаёт вызывающий: в заголовке ответа
    оно ASCII-огрызок, истинное имя проекта живёт в манифесте.
    """
    pid, pname = await resolve_project(client, args["project"])
    path = _export_target(str(args["out_path"]), client.config.export_dir, bool(args.get("overwrite")))

    payload = await client.request_bytes("GET", "/export/archive", project_id=pid)
    try:
        with zipfile.ZipFile(io.BytesIO(payload)) as zf:
            names = zf.namelist()
            manifest_raw = ""
            if "manifest.yaml" in names:
                if zf.getinfo("manifest.yaml").file_size > MAX_MANIFEST_BYTES:
                    raise ArchMapError(f"Манифест архива проекта «{pname}» больше 1 МБ — это не архив ArchMap.")
                manifest_raw = zf.read("manifest.yaml").decode("utf-8")
    except (zipfile.BadZipFile, KeyError, UnicodeDecodeError) as exc:
        raise ArchMapError(f"ArchMap вернул не архив проекта «{pname}»: {exc}") from exc
    parsed = yaml.safe_load(manifest_raw) if manifest_raw else {}
    manifest: dict[str, Any] = parsed if isinstance(parsed, dict) else {}

    _write_atomic(path, payload)
    return render.archive_summary(
        manifest, files=len(names), size=len(payload), path=str(path)
    )


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
    data = await client.request("GET", "/projects/import/prompt", params=params)
    return str(data["prompt"])


async def t_docs_prompt(client: ArchMapClient, args: dict[str, Any]) -> str:
    pid, _ = await resolve_project(client, args["project"])
    params: dict[str, Any] = {"include": args.get("include", "both")}
    for key in ("node_id", "target"):
        if args.get(key):
            params[key] = args[key]
    _variant(args, params)
    data = await client.request("GET", "/docs-import/prompt", project_id=pid, params=params)
    return str(data["prompt"])


# ── Запись пачкой: превью → применение ───────────────────────────────────────

def _docs(args: dict[str, Any]) -> list[dict[str, str]]:
    return [{"name": f["name"], "content": f["content"]} for f in args["files"]]


YAML_MIME = "text/yaml"
ZIP_MIME = "application/zip"
INPUT_SUFFIXES = {".yaml": YAML_MIME, ".yml": YAML_MIME, ".zip": ZIP_MIME}


def _read_input(path: Path, used: int) -> bytes:
    """Файл ввоза с диска — с проверкой размера ДО чтения (used — сколько уже набрано)."""
    size = path.stat().st_size
    if used + size > MAX_INPUT_BYTES:
        raise ArchMapError(
            f"Файл {path}: входы ввоза вместе больше {MAX_INPUT_BYTES // 1024 // 1024} МБ — "
            "столько ArchMap за один запрос не принимает."
        )
    return path.read_bytes()


def _inputs(args: dict[str, Any]) -> list[tuple[str, tuple[str, bytes, str]]]:
    """Входы единого ввоза → multipart-файлы В ПОРЯДКЕ: сначала files, потом paths.

    Порядок значим: бэкенд адресует замечания и кандидатов спора номером входа
    («вход 2», origin), и агент должен уметь сопоставить номер со своим списком.

    Два входа не от богатства выбора: YAML агент только что построил сам — ему
    естественно отдать текстом; архив лежит файлом и весит мегабайты — гнать его
    через контекст модели base64-ом расточительно.
    """
    out: list[tuple[str, tuple[str, bytes, str]]] = []
    used = 0
    for i, f in enumerate(args.get("files") or [], 1):
        name = str(f.get("name") or f"вход-{i}.yaml")
        content = str(f.get("content", "")).encode("utf-8")
        used += len(content)
        out.append(("files", (name, content, YAML_MIME)))
    for raw in args.get("paths") or []:
        path = Path(str(raw)).expanduser()
        if not path.is_file():
            raise ArchMapError(f"Файл не найден: {path}")
        mime = INPUT_SUFFIXES.get(path.suffix.lower())
        if mime is None:
            raise ArchMapError(
                f"Файл {path}: ввозятся только .yaml/.yml (схема C4) и .zip (архив знания)."
            )
        data = _read_input(path, used)
        used += len(data)
        out.append(("files", (path.name, data, mime)))
    if not out:
        raise ArchMapError(
            "Не передан ни один вход: files — YAML текстом, paths — файлы .yaml/.zip с диска."
        )
    return out


def _archives(args: dict[str, Any]) -> list[tuple[str, tuple[str, bytes, str]]]:
    """Входы ДОГРУЗКИ к живому проекту: только .zip и только путями с диска.

    YAML сюда не берут намеренно. Заливка схемы C4 в СУЩЕСТВУЮЩИЙ проект — это
    синк (archmap_sync_preview / archmap_sync_apply) со своими политиками имён,
    пропаж и возвратов, а не мердж архивов; бэкенд такой вход и не примет.
    """
    out: list[tuple[str, tuple[str, bytes, str]]] = []
    used = 0
    for raw in args.get("paths") or []:
        path = Path(str(raw)).expanduser()
        if not path.is_file():
            raise ArchMapError(f"Файл не найден: {path}")
        if path.suffix.lower() != ".zip":
            raise ArchMapError(
                f"Файл {path}: к живому проекту догружаются только .zip-архивы знания. "
                "YAML схемы заливают синком — archmap_sync_preview / archmap_sync_apply."
            )
        data = _read_input(path, used)
        used += len(data)
        out.append(("files", (path.name, data, ZIP_MIME)))
    if not out:
        raise ArchMapError(
            "Не передан ни один архив: paths — файлы .zip с диска. YAML к живому "
            "проекту заливают синком (archmap_sync_preview)."
        )
    return out


def _resolutions(args: dict[str, Any]) -> str | None:
    """Решения по спорам → поле формы. ⚠️ Именно СТРОКОЙ: multipart несёт файлы,
    и словарь бэкенд разбирает из JSON-текста (_parse_resolutions)."""
    chosen = args.get("resolutions")
    if not chosen:
        return None
    if not isinstance(chosen, dict):
        raise ArchMapError('resolutions — объект «id спора» → «cand:<N>» либо «all».')
    return jsonlib.dumps(chosen, ensure_ascii=False)


async def t_import_preview(client: ArchMapClient, args: dict[str, Any]) -> str:
    data = await client.request(
        "POST", "/projects/import/unified-preview", files=_inputs(args)
    )
    return render.unified_preview(data)


async def t_import_apply(client: ArchMapClient, args: dict[str, Any]) -> str:
    data = await client.request(
        "POST",
        "/projects/import-unified",
        files=_inputs(args),
        data={
            "name": args.get("name"),
            "description": args.get("description"),
            "resolutions": _resolutions(args),
        },
    )
    return render.unified_result(data)


async def t_import_into_preview(client: ArchMapClient, args: dict[str, Any]) -> str:
    pid, pname = await resolve_project(client, args["project"])
    data = await client.request(
        "POST",
        f"/projects/{pid}/import-archive/preview",
        project_id=pid,
        files=_archives(args),
    )
    return f"Проект «{pname}» — план догрузки архивов\n\n" + render.into_preview(data)


async def t_import_into_apply(client: ArchMapClient, args: dict[str, Any]) -> str:
    pid, pname = await resolve_project(client, args["project"])
    data = await client.request(
        "POST",
        f"/projects/{pid}/import-archive/apply",
        project_id=pid,
        files=_archives(args),
        data={
            "resolutions": _resolutions(args),
            # ⚠️ Обе ревизии инструмент требует, хотя на бэке они опциональны:
            # без fence это слепая запись поверх чужой параллельной правки.
            "base_graph_rev": str(args["base_graph_rev"]),
            "base_meta_rev": str(args["base_meta_rev"]),
        },
    )
    return f"Проект «{pname}» — архивы догружены\n\n" + render.into_result(data)


async def t_sync_preview(client: ArchMapClient, args: dict[str, Any]) -> str:
    pid, pname = await resolve_project(client, args["project"])
    body = _sync_body(args)
    data = await client.request("POST", f"/projects/{pid}/sync/preview", project_id=pid, json=body)
    return f"Проект «{pname}» — план обновления из кода\n\n" + _sync_report(data)


async def t_sync_apply(client: ArchMapClient, args: dict[str, Any]) -> str:
    pid, pname = await resolve_project(client, args["project"])
    body = _sync_body(args)
    if args.get("base_graph_rev") is not None:
        body["base_graph_rev"] = args["base_graph_rev"]
    data = await client.request("POST", f"/projects/{pid}/sync/apply", project_id=pid, json=body)
    return f"Проект «{pname}» обновлён из кода\n\n" + _sync_applied_report(data)


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


def _sync_basis(action: dict[str, Any]) -> str:
    """Хвост строки плана: ЧЕМ узел опознан (update) либо КАКОЙ источник он получит
    (create). Синк — единственное место, где ошибка опознания сразу пишется в
    живой проект: «нашли по имени» и «нашли по коду» — разной надёжности решения,
    и агенту незачем угадывать, какое из них применилось (Ф2/Ф4 источников)."""
    kind = action.get("action")
    if kind == "update" and action.get("matched_by"):
        return " — " + render.basis_label(str(action["matched_by"]), str(action.get("path", "")))
    if kind == "create":
        return " — " + render.anchor_note(action.get("source"))
    return ""


# Сколько действий каждого рода — и КАК они называются в контракте. ⚠️ Ключи
# счётчиков собираются из ИМЕНИ ДЕЙСТВИЯ («create», не «created»): SyncPlan.summary
# складывает их как f"nodes_{action}". Раньше отчёт читал «nodes_created» и прочие
# несуществующие ключи прямо из корня ответа — и печатал агенту сплошные нули на
# любом плане (полевая находка Ф4; на моках такое не видно).
SYNC_COUNTS: list[tuple[str, str]] = [
    ("nodes_create", "создать объектов"),
    ("nodes_update", "обновить"),
    ("nodes_unchanged", "без изменений"),
    ("nodes_missing", "пропало из кода"),
    ("nodes_returned", "вернулось"),
    ("edges_create", "связей создать"),
]


def _sync_report(data: dict[str, Any]) -> str:
    """План синка (SyncPreviewOut) словами: счётчики, действия с основанием матча."""
    if not data.get("ok", True):
        rows = [str(e) for e in (data.get("errors") or [])] or ["причина не названа"]
        return "Прогон разобрать не удалось:\n" + "\n".join("  • " + r for r in rows)

    raw = data.get("summary")
    summary: dict[str, Any] = raw if isinstance(raw, dict) else {}
    out = ["Будет сделано: " + ", ".join(f"{title}: {summary.get(key, 0)}" for key, title in SYNC_COUNTS)]
    if data.get("is_noop"):
        # Фикспойнт синка: повторный прогон на том же входе обязан быть пустым.
        out.append("Схема уже соответствует прогону — менять нечего.")
    changed = [
        a for a in data.get("nodes", []) if a.get("action") in ("create", "update", "missing")
    ]
    if changed:
        out.append("")
        out.append("ОБЪЕКТЫ:")
        for a in changed[:60]:
            fields = f" ({', '.join(a['fields'])})" if a.get("fields") else ""
            out.append(f"  {a['action']}: {a['path']}{fields}{_sync_basis(a)}")
        if len(changed) > 60:
            out.append(f"  … и ещё {len(changed) - 60}")
    for key, title in (("conflicts", "Расхождения (решены правилом)"), ("warnings", "Проверьте")):
        rows = [str(r) for r in (data.get(key) or [])]
        if rows:
            out.append("")
            out.append(f"{title} ({len(rows)}):")
            out.extend("  • " + r for r in rows[:20])
    out.append(
        f"\nНичего не записано — для записи вызовите archmap_sync_apply "
        f"с base_graph_rev={data.get('graph_rev', 0)} (защита от параллельной правки: "
        "разошлась схема — 409, тогда перечитайте план)."
    )
    return "\n".join(out)


# Что вернулось из применения (SyncApplyOut). Форма СВОЯ, не «план ещё раз»:
# сервер пересчитывает план у себя и докладывает списками путей, а не действиями.
SYNC_APPLIED: list[tuple[str, str]] = [
    ("created_nodes", "Создано объектов"),
    ("updated_nodes", "Обновлено"),
    ("deprecated_nodes", "Помечено выводимыми"),
    ("created_edges", "Создано связей"),
    ("skipped", "Пропущено (цель исчезла между расчётом и записью)"),
]


def _sync_applied_report(data: dict[str, Any]) -> str:
    out: list[str] = []
    for key, title in SYNC_APPLIED:
        rows = [str(r) for r in (data.get(key) or [])]
        if not rows:
            continue
        out.append(f"{title}: {len(rows)}")
        out.extend("  • " + r for r in rows[:40])
        if len(rows) > 40:
            out.append(f"  … и ещё {len(rows) - 40}")
    if not out:
        out.append("Ничего не изменилось — схема уже соответствовала прогону.")
    out.append(f"\nНовый курсор схемы: graph_rev={data.get('graph_rev', 0)}.")
    return "\n".join(out)


async def t_docs_preview(client: ArchMapClient, args: dict[str, Any]) -> str:
    pid, pname = await resolve_project(client, args["project"])
    data = await client.request(
        "POST", "/docs-import/preview", project_id=pid, json=_docs_body(args)
    )
    return f"Проект «{pname}» — план дозаливки\n\n" + render.docs_report(data, applied=False)


async def t_docs_apply(client: ArchMapClient, args: dict[str, Any]) -> str:
    pid, pname = await resolve_project(client, args["project"])
    data = await client.request(
        "POST", "/docs-import/apply", project_id=pid, json=_docs_body(args)
    )
    return f"Проект «{pname}» — дозаливка применена\n\n" + render.docs_report(data, applied=True)


def _docs_body(args: dict[str, Any]) -> dict[str, Any]:
    body: dict[str, Any] = {"files": _docs(args), "overwrite": bool(args.get("overwrite", False))}
    if args.get("only"):
        body["only"] = args["only"]
    if args.get("node_id"):
        body["node_id"] = args["node_id"]
    return body


# ── Разведка точек входа ─────────────────────────────────────────────────────

async def t_recon_prompt(client: ArchMapClient, args: dict[str, Any]) -> str:
    pid, _ = await resolve_project(client, args["project"])
    # node_id обязателен и у ручки: перечень принадлежит объекту, разведка без
    # адреса бессмысленна. Промпт СРЕЗА СХЕМЫ НЕ НЕСЁТ и ранее разведанного
    # перечня тоже — разведка всегда идёт от кода, иначе второй заход унаследует
    # пропуски первого (решение пользователя, §3 docs/plan-recon.md).
    params: dict[str, Any] = {"node_id": args["node_id"]}
    _variant(args, params)
    data = await client.request("GET", "/recon/prompt", project_id=pid, params=params)
    return str(data["prompt"])


def _recon_body(args: dict[str, Any]) -> dict[str, Any]:
    # Поля overwrite здесь НЕТ и не будет (Р13 плана разведки): применение только
    # создаёт недостающие заглушки, описанное не трогается ни при какой политике.
    body: dict[str, Any] = {"files": _docs(args)}
    if args.get("node_id"):
        body["node_id"] = args["node_id"]
    return body


async def t_recon_preview(client: ArchMapClient, args: dict[str, Any]) -> str:
    pid, pname = await resolve_project(client, args["project"])
    data = await client.request(
        "POST", "/recon/preview", project_id=pid, json=_recon_body(args)
    )
    return (
        f"Проект «{pname}» — план разведки точек входа\n\n"
        + render.recon_report(data, applied=False)
    )


async def t_recon_apply(client: ArchMapClient, args: dict[str, Any]) -> str:
    pid, pname = await resolve_project(client, args["project"])
    data = await client.request(
        "POST", "/recon/apply", project_id=pid, json=_recon_body(args)
    )
    return (
        f"Проект «{pname}» — разведка применена\n\n"
        + render.recon_report(data, applied=True)
    )


# ── Семьи табличных фактов ───────────────────────────────────────────────────

# Семья → префикс ручек. ТРИ инструмента с аргументом family, а не девять по числу
# ручек (решение 1 плана эпика): поток у семей один и тот же — промпт, превью,
# применение, — и различаются они только сущностью, которую описывают. Девять имён
# в каталоге агент читал бы как девять разных умений.
FACT_PATH = {
    "tables": "/data-import",
    "channels": "/channels-import",
    "config": "/config-import",
}

# Какой форме объекта принадлежит семья — тем же словом, каким названа форма в
# карточке. Ошибка «канал у сервиса» дешевле всего лечится текстом описания.
FACT_OWNER = {
    "tables": "структура БД — у объектов формы database",
    "channels": "каналы — у объектов формы broker",
    "config": "параметры конфигурации — у объектов формы service",
}


def _family(args: dict[str, Any]) -> str:
    """Семья из аргумента. Неизвестная — ошибка СО СПИСКОМ допустимых: модель
    промахивается мимо значения enum регулярно, и «422 от сервера» ей ничего не
    подсказывает, а перечень подсказывает."""
    family = str(args.get("family") or "")
    if family not in FACT_PATH:
        raise ArchMapError(
            f"Неизвестная семья фактов «{family}». Допустимые: "
            + ", ".join(f"{k} ({FACT_OWNER[k]})" for k in FACT_PATH)
            + "."
        )
    return family


async def t_facts_prompt(client: ArchMapClient, args: dict[str, Any]) -> str:
    pid, _ = await resolve_project(client, args["project"])
    family = _family(args)
    params: dict[str, Any] = {}
    _variant(args, params)
    data = await client.request(
        "GET", f"{FACT_PATH[family]}/prompt", project_id=pid, params=params
    )
    return str(data["prompt"])


def _facts_body(args: dict[str, Any]) -> dict[str, Any]:
    # Форма тела у всех трёх семей одна: files (записи {name, content}), node_id и
    # overwrite. Сверено со схемами DataImportIn / ChannelsImportIn / ConfigImportIn.
    body: dict[str, Any] = {"files": _docs(args), "overwrite": bool(args.get("overwrite", False))}
    if args.get("node_id"):
        body["node_id"] = args["node_id"]
    return body


async def t_facts_preview(client: ArchMapClient, args: dict[str, Any]) -> str:
    pid, pname = await resolve_project(client, args["project"])
    family = _family(args)
    data = await client.request(
        "POST", f"{FACT_PATH[family]}/preview", project_id=pid, json=_facts_body(args)
    )
    return (
        f"Проект «{pname}» — план дозаливки фактов\n\n"
        + render.facts_report(data, family, applied=False)
    )


async def t_facts_apply(client: ArchMapClient, args: dict[str, Any]) -> str:
    pid, pname = await resolve_project(client, args["project"])
    family = _family(args)
    data = await client.request(
        "POST", f"{FACT_PATH[family]}/apply", project_id=pid, json=_facts_body(args)
    )
    return (
        f"Проект «{pname}» — дозаливка фактов применена\n\n"
        + render.facts_report(data, family, applied=True)
    )


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
    # Источник при создании (NodeCreate.source): объект рождается опознаваемым из
    # кода, без второго вызова. Пустого объекта здесь не бывает — «создать без
    # источника» это просто не передать source.
    if args.get("source"):
        body["source"] = args["source"]
    data = await client.request("POST", "/nodes", project_id=pid, json=body)
    return (
        f"В проекте «{pname}» создан объект «{data['name']}». id={data['id']}\n"
        + render.anchor_line(data)
    )


async def _site_ids(client: ArchMapClient, pid: str, pname: str, names: list[Any]) -> list[str]:
    """Имена площадок → id для PATCH site_ids. Имя — точное, иначе единственное без
    учёта регистра. Неизвестное имя — отказ с перечнем площадок проекта: создавать
    площадку молча из разговора нельзя (их заводит человек или импорт YAML)."""
    if not names:
        return []
    sites = await client.request("GET", "/deployment/sites", project_id=pid)
    by_name = {str(s["name"]): str(s["id"]) for s in sites}
    ids: list[str] = []
    missing: list[str] = []
    for raw in names:
        name = str(raw).strip()
        site_id = by_name.get(name)
        if site_id is None:
            folded = [n for n in by_name if n.casefold() == name.casefold()]
            site_id = by_name[folded[0]] if len(folded) == 1 else None
        if site_id is None:
            missing.append(name)
        elif site_id not in ids:
            ids.append(site_id)
    if missing:
        known = ", ".join(f"«{n}»" for n in sorted(by_name)[:30])
        what = "Площадки" if len(missing) == 1 else "Площадок"
        raise ArchMapError(
            f"{what} {', '.join(f'«{m}»' for m in missing)} в проекте «{pname}» нет. "
            + (f"Есть: {known}. " if known else "Площадок в проекте нет. ")
            + "Через MCP площадки не создаются — их заводит человек на холсте "
            "«Развёртывание» или импорт YAML с разделом deployment."
        )
    return ids


async def t_update_node(client: ArchMapClient, args: dict[str, Any]) -> str:
    pid, pname = await resolve_project(client, args["project"])
    body = {
        k: args[k]
        for k in (
            "name", "description", "role", "technology", "shape", "status", "is_external",
            "approval",
        )
        if args.get(k) is not None
    }
    # ⚠️ Источник — ОТДЕЛЬНОЙ веткой, мимо фильтра «не None»: пустой объект {} у
    # source не пустая правка, а ОЧИСТКА источника, и отбросить его значило бы молча
    # проигнорировать просьбу. Отсутствие ключа source источник не трогает.
    if "source" in args and args["source"] is not None:
        body["source"] = args["source"]
    # Размещение — тоже мимо фильтра «не None»: пустой список [] не пустая правка, а
    # СНЯТИЕ своего размещения. Набор целиком (PATCH site_ids), отсутствие ключа его
    # не трогает.
    if "sites" in args and args["sites"] is not None:
        body["site_ids"] = await _site_ids(client, pid, pname, list(args["sites"]))
    if not body:
        raise ArchMapError("Нечего менять: не передано ни одного поля.")
    data = await client.request("PATCH", f"/nodes/{args['node_id']}", project_id=pid, json=body)
    tail = "\n" + render.anchor_line(data) if "source" in body else ""
    # Статус страницы — подтверждение тем же словом, что в карточке. Правка бывает
    # только у листа (у контейнера сервер отвечает 422), поэтому дети здесь не нужны.
    if "approval" in body:
        tail += "\n" + (render.approval_line(data, []) or "")
    # Размещение — строкой карточки по ответу сервера: после [] у объекта может
    # остаться унаследованное от контейнера, и агент должен это увидеть.
    if "site_ids" in body:
        tail += "\n" + (render.placement_line(data) or "Размещение: не указано")
    fields = ["sites" if k == "site_ids" else k for k in body]
    return f"В проекте «{pname}» обновлён «{data['name']}»: {', '.join(fields)}." + tail


async def t_create_edge(client: ArchMapClient, args: dict[str, Any]) -> str:
    pid, pname = await resolve_project(client, args["project"])
    body = {
        "source_id": args["source_id"],
        "target_id": args["target_id"],
        "label": args.get("label"),
        "technology": args.get("technology"),
        "is_synchronous": args.get("is_synchronous"),
    }
    data = await client.request("POST", "/edges", project_id=pid, json=body)
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


# ── Версии документации (docs/tasks/doc-versions.md §8) ──────────────────────
#
# Чтение версий, дельта, текст на версии и фиксация. Отката и удаления версий здесь
# нет и не будет: откат удаляет объекты, появившиеся после версии, а удаления через
# агента исключены принципиально (как «Принять переход» — человек глазами).

# Какой текст на версии отдаёт archmap_version_doc: аргумент → сегмент пути ручки,
# слово заголовка и ограда тела.
VERSION_TEXTS = {
    "doc_id": ("doc", "Схема логики", "mermaid"),
    "spec_node_id": ("spec", "OpenAPI-спека", "yaml"),
    "process_id": ("process", "Процесс", "mermaid"),
}


def _versions_path(node_id: str | None) -> str:
    """Префикс ручек версий: у объекта — под его путём, без него — корень проекта."""
    return f"/nodes/{node_id}/versions" if node_id else "/versions"


async def _version_owner(
    client: ArchMapClient, pid: str, pname: str, node_id: str | None
) -> tuple[str, str]:
    """Чьи версии — для заголовков: (заголовок списка, имя в начале строки дельты).
    Имя объекта — одним GET /nodes/{id}: дерево проекта ради одного имени не грузим."""
    if not node_id:
        return f"Версии всего проекта «{pname}»", f"Проект «{pname}»"
    node = await client.request("GET", f"/nodes/{node_id}", project_id=pid)
    name = str(node.get("name", "?"))
    return f"Версии «{name}» (проект «{pname}»)", f"«{name}»"


async def t_versions(client: ArchMapClient, args: dict[str, Any]) -> str:
    pid, pname = await resolve_project(client, args["project"])
    node_id = args.get("node_id") or None
    title, _ = await _version_owner(client, pid, pname, node_id)
    data = await client.request("GET", _versions_path(node_id), project_id=pid)
    return render.version_list(title, data)


async def t_version_diff(client: ArchMapClient, args: dict[str, Any]) -> str:
    """Дельта версии: список элементов или, с item, одна дельта текстом.

    Без version берётся последняя версия объекта — наибольший номер из списка версий,
    а не их число: после удаления версии номера идут с пропуском."""
    pid, pname = await resolve_project(client, args["project"])
    node_id = args.get("node_id") or None
    path = _versions_path(node_id)
    _, owner = await _version_owner(client, pid, pname, node_id)

    number = args.get("version")
    if number is None:
        listing = await client.request("GET", path, project_id=pid)
        numbers = [int(v["number"]) for v in listing.get("versions") or []]
        if not numbers:
            return f"{owner}: версий ещё нет — сравнивать нечего."
        number = max(numbers)
    number = int(number)
    # base передаём всегда, и умолчание тоже: так запрос однозначен и виден в журнале.
    base = str(args.get("base") or "prev")
    params = {"base": base}

    item = args.get("item")
    if not item:
        data = await client.request("GET", f"{path}/{number}/diff", project_id=pid, params=params)
        return render.version_diff(owner, data)
    detail = await client.request(
        "GET", f"{path}/{number}/diff/{item}", project_id=pid, params=params
    )
    return render.version_item(
        owner, number, base, detail, with_sides=bool(args.get("with_sides"))
    )


async def t_version_doc(client: ArchMapClient, args: dict[str, Any]) -> str:
    # Ровно один адрес текста — до любого запроса: угадывать, какой из двух имелся в
    # виду, значит показать агенту не тот текст.
    given = [k for k in VERSION_TEXTS if args.get(k)]
    if len(given) != 1:
        raise ArchMapError(
            "Нужен ровно один из doc_id, spec_node_id, process_id. id — часть item после "
            "двоеточия у элементов doc:, spec:, process: из archmap_version_diff."
        )
    key = given[0]
    segment, label, fence = VERSION_TEXTS[key]
    pid, _ = await resolve_project(client, args["project"])
    number = int(args["version"])
    path = f"{_versions_path(args.get('node_id') or None)}/{number}/{segment}/{args[key]}"
    data = await client.request("GET", path, project_id=pid)
    return render.version_text(label, number, data, fence=fence)


async def t_version_create(client: ArchMapClient, args: dict[str, Any]) -> str:
    pid, _ = await resolve_project(client, args["project"])
    # Комментарий — как пришёл: пустой отвергнет сервер (422) своими словами.
    body = {"comment": str(args.get("comment") or "")}
    data = await client.request(
        "POST", _versions_path(args.get("node_id") or None), project_id=pid, json=body
    )
    return render.version_created(data)


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

FAMILY_ARG = {
    "type": "string",
    "enum": ["tables", "channels", "config"],
    "description": (
        "Семья табличных фактов: tables — структура БД (объекты формы database); "
        "channels — каналы брокера (форма broker); config — параметры конфигурации "
        "сервиса (форма service, значений сред не бывает — только дефолт из кода)."
    ),
}

# Политика занятых полей у всех трёх семей одна: дефолт «не трогать заполненное»
# делает результат независимым от порядка загрузки пакетов («побеждает описанное
# раньше»), а один канал или сервис описывают прогоны разных репозиториев.
OVERWRITE_ARG = {
    "type": "boolean",
    "description": "Перезаписывать уже заполненные поля. По умолчанию false — описанное раньше побеждает.",
}

# ИСТОЧНИК объекта (docs/plan-anchor-ux.md). Описание — выжимка принятого текста
# пояснения: агент задаёт источник по тем же правилам, что человек в карточке
# объекта, и должен знать про очистку пустым объектом (иначе снять источник нечем).
SOURCE_ARG = {
    "type": "object",
    "description": (
        "Источник объекта — чем ArchMap опознаёт его при обновлениях из кода "
        "(переименованный сервис остаётся тем же объектом, а не дублем). Видов два, "
        "и они взаимоисключающи: КОД — repo «github.com/org/repo» (можно вставить "
        "адрес клона целиком) и необязательный path до каталога компонента внутри "
        "репозитория («src/api»); ИМЯ ЗАВИСИМОСТИ — host: одно имя без порта и схемы, "
        "как в docker-compose или в имени k8s Service («postgres», «kafka», «payments»), "
        "для базы, брокера или соседнего продукта, чьего кода в продукте нет. "
        "Адреса сред (localhost, 127.0.0.1, конкретные серверы) источником не бывают — "
        "будет отказ. Пустой объект {} — снять источник (объект вернётся к опознаванию "
        "по имени внутри контейнера)."
    ),
    "properties": {
        "repo": {"type": "string", "description": "Репозиторий: «github.com/org/repo» или адрес клона."},
        "path": {"type": "string", "description": "Каталог компонента внутри репозитория: «src/api». Только вместе с repo."},
        "host": {"type": "string", "description": "Имя зависимости без порта и схемы: «postgres». Не вместе с repo."},
    },
}

# Размещение объекта (docs/tasks/deployment-view.md): набор площадок ЦЕЛИКОМ, как у
# окна «Размещение» в интерфейсе. Создавать площадки агенту не дано — только ставить.
SITES_ARG = {
    "type": "array",
    "items": {"type": "string"},
    "description": (
        "Площадки, где объект стоит САМ, — имена из archmap_deployment. Набор целиком: "
        "перечисленные ставятся, прочие свои снимаются; [] — снять своё размещение "
        "(останется унаследованное от контейнера). Без ключа размещение не трогается. "
        "Площадки через MCP не создаются — их заводит человек на холсте «Развёртывание» "
        "или импорт YAML с разделом deployment."
    ),
}

NODE_ID_ARG = {"type": "string", "description": "id объекта (из archmap_schema, archmap_search или archmap_node)."}
SUBTREE_ARG = {"type": "string", "description": "id объекта: показать только его поддерево."}
# Объект версий необязателен: без него — версии корня, то есть всего проекта.
VERSION_NODE_ARG = {
    "type": "string",
    "description": "id объекта (из archmap_schema, archmap_search или archmap_node); без него — срез всего проекта.",
}
VERSION_NUMBER_ARG = {"type": "integer", "description": "Номер версии (vN из archmap_versions)."}
PROCESS_ID_ARG = {"type": "string", "description": "id процесса (из archmap_processes без process_id)."}
SHAPE_ARG = {
    "type": "string",
    "enum": ["service", "database", "broker", "person"],
    "description": "Форма C4: service — сервис, database — база, broker — брокер, person — человек (только корневой).",
}
STATUS_ARG = {
    "type": "string",
    "enum": ["existing", "planned", "deprecated"],
    "description": "Жизненный цикл: existing — есть, planned — планируется, deprecated — выводится.",
}
APPROVAL_ARG = {
    "type": "string",
    "enum": ["in_progress", "approved"],
    "description": "Статус страницы: in_progress — в работе, approved — согласовано. Ставить ТОЛЬКО по явной просьбе человека: согласование — решение архитектора.",
}
EXTERNAL_ARG = {"type": "boolean", "description": "Внешний объект: чужая система за границей продукта."}
SYNC_ARG = {"type": "boolean", "description": "Связь синхронная (вызов с ответом). false — событие: у асинхронного канала нет ответного плеча."}
DOCS_ONLY_ARG = {
    "type": "string",
    "enum": ["logic", "api"],
    "description": "Взять из пакета только схемы логики (logic) или только OpenAPI-спеки (api). Без него — всё.",
}
DOCS_OVERWRITE_ARG = {
    "type": "boolean",
    "description": "Перезаписывать занятые слоты (схему с тем же именем, уже заполненную спеку). По умолчанию false.",
}
DOCS_SCOPE_ARG = {"type": "string", "description": "Ограничить область этим объектом: адреса файлов ищутся в его поддереве."}
FACTS_NODE_ARG = {"type": "string", "description": "Объект-адресат записей без адреса в файле."}
RECON_NODE_ARG = {"type": "string", "description": "Объект-адресат строк перечня без строки «node:»."}
# Политики синка (app/sync_plan.SyncPolicies): все выключены по умолчанию — самый
# осторожный режим. Превью и применение получают одни и те же флаги.
SYNC_POLICY_ARGS = {
    "update_descriptions": {"type": "boolean", "description": "Перезаписывать описания объектов прозой прогона (описание могли выправить руками)."},
    "update_names": {"type": "boolean", "description": "Переименовывать объекты по прогону. Переименование видно в плане и без флага."},
    "sync_components": {"type": "boolean", "description": "Синхронизировать и слой компонентов (третий уровень C4); без флага — только системы и контейнеры."},
    "mark_missing_deprecated": {"type": "boolean", "description": "Пропавшим из прогона объектам ставить статус deprecated. Удаления нет никогда."},
    "restore_returned": {"type": "boolean", "description": "Снимать deprecated с объектов, которые снова появились в прогоне (пометку мог поставить человек)."},
}

FILES_ARG = {
    "type": "array",
    "description": "Файлы прогона агента: [{name, content}].",
    "items": {
        "type": "object",
        "properties": {
            "name": {"type": "string", "description": "Имя файла — им файл называют замечания превью."},
            "content": {"type": "string", "description": "Текст файла целиком."},
        },
        "required": ["name", "content"],
    },
}

PATHS_ARG = {
    "type": "array",
    "description": "Файлы С ДИСКА машины агента: .yaml/.yml (схема C4) и .zip (архив знания ArchMap) вперемешку. Идут ПОСЛЕ files в нумерации входов.",
    "items": {"type": "string"},
}

ARCHIVE_PATHS_ARG = {
    "type": "array",
    "description": "Архивы знания ArchMap (.zip) файлами С ДИСКА машины агента. YAML сюда не подают: схему C4 в живой проект заливает синк.",
    "items": {"type": "string"},
}

RESOLUTIONS_ARG = {
    "type": "object",
    "description": "Решения по спорам содержимого из превью: «id спора» → «cand:<номер кандидата>» либо «all» (где превью разрешило). Без него применяется дефолт каждого спора.",
    "additionalProperties": {"type": "string"},
}

TOOLS: list[dict[str, Any]] = [
    {
        "name": "archmap_projects",
        "writes": False,
        "description": "Список проектов ArchMap, доступных учётке: имя, роль в проекте ([владелец], [редактор] — можно править; [чтение] — только смотреть), число объектов, id. С него начинают — дальше проект указывают именем.",
        "schema": {"type": "object", "properties": {}},
        "handler": t_projects,
    },
    {
        "name": "archmap_schema",
        "writes": False,
        "description": "Архитектура проекта: дерево объектов и все связи. node_id — показать только поддерево этого объекта.",
        "schema": {
            "type": "object",
            "properties": {"project": PROJECT_ARG, "node_id": SUBTREE_ARG},
            "required": ["project"],
        },
        "handler": t_schema,
    },
    {
        "name": "archmap_search",
        "writes": False,
        "description": "Поиск по ВСЕМУ знанию проекта: объекты, схемы логики построчно, OpenAPI-спеки, структура БД, каналы брокера с полями, параметры конфигурации, процессы и шаги. Строку лога или текст ошибки вставляйте ЦЕЛИКОМ, как есть: переменные части (пути, id, имена устройств) не мешают — решают редкие слова, а не общие. Ищите ПЕРЕД тем, как открывать карточки объектов подряд. Поиск идёт по словам, а не по смыслу: для вопроса без строки лога передавайте характерные слова (имя параметра, таблицы, протокола), а не фразу вопроса. Выдача сгруппирована по объектам; у находки — адрес (путь объекта, схема и номер строки) и id для следующего шага: archmap_doc(doc_id) — схема целиком, archmap_node(node_id) — карточка объекта, archmap_processes(process_id) — процесс. limit — сколько находок (по умолчанию 20, максимум 100); kinds — только эти виды.",
        "schema": {
            "type": "object",
            "properties": {
                "project": PROJECT_ARG,
                "query": {
                    "type": "string",
                    "description": "Строка лога, текст ошибки или ключевые слова — целиком.",
                },
                "limit": {"type": "integer", "minimum": 1, "maximum": 100, "description": "Сколько находок вернуть: по умолчанию 20, не больше 100."},
                "kinds": {
                    "type": "array",
                    "items": {"type": "string", "enum": SEARCH_KINDS},
                    "description": "Виды находок: node — объект, doc — схема логики, spec — строка OpenAPI, table/column — структура БД, channel/field — каналы брокера, param — конфигурация, process/step — процессы.",
                },
            },
            "required": ["project", "query"],
        },
        "handler": t_search,
    },
    {
        "name": "archmap_node",
        "writes": False,
        "description": "Карточка объекта: путь, мета, источник (чем объект опознаётся при обновлениях из кода — «код github.com/org/repo, путь src/api», «имя зависимости postgres» либо «нет — опознаётся по имени»), размещение (площадки, где объект крутится: свои или «от контейнера»; строки нет, если размещения нет), входящие и исходящие связи, схемы логики (вид, привязка к операции, метка «не описана» у заглушек разведки, участие схемы в бизнес-процессах), процессы, в которых участвует сам объект, наличие OpenAPI-спеки и семья табличных фактов по форме объекта — структура БД с колонками у базы, каналы с полями сообщений у брокера, параметры конфигурации у сервиса. include_docs/include_spec — вернуть тексты схем и спеки целиком.",
        "schema": {
            "type": "object",
            "properties": {
                "project": PROJECT_ARG,
                "node_id": NODE_ID_ARG,
                "include_docs": {"type": "boolean", "description": "Вернуть тексты всех схем логики целиком (для одной схемы дешевле archmap_doc)."},
                "include_spec": {"type": "boolean", "description": "Вернуть OpenAPI-спеку объекта целиком."},
            },
            "required": ["project", "node_id"],
        },
        "handler": t_node,
    },
    {
        "name": "archmap_doc",
        "writes": False,
        "description": "Одна схема логики целиком по doc_id (из archmap_search, archmap_node или шага archmap_processes): путь объекта, имя, вид, эндпоинт, «не описана» у заглушки разведки, в каких процессах схема документирует шаги, и полный текст mermaid. Когда нужна одна схема, это дешевле archmap_node с include_docs.",
        "schema": {
            "type": "object",
            "properties": {
                "project": PROJECT_ARG,
                "doc_id": {"type": "string", "description": "id схемы логики (из archmap_search, archmap_node или шага процесса)."},
            },
            "required": ["project", "doc_id"],
        },
        "handler": t_doc,
    },
    {
        "name": "archmap_deployment",
        "writes": False,
        "description": "Схема развёртывания — где крутятся объекты. Без node_id — площадки деревом (вид, технология, объекты, поставленные на площадку сами; контейнер — вместе с вложенными без своего размещения), затем объекты без размещения. С node_id — действующее размещение объекта: площадки путями, свои или унаследованные от контейнера. Площадки заводит человек на холсте «Развёртывание» или импорт YAML с разделом deployment; поставить объект на существующие площадки — archmap_update_node с sites.",
        "schema": {
            "type": "object",
            "properties": {"project": PROJECT_ARG, "node_id": NODE_ID_ARG},
            "required": ["project"],
        },
        "handler": t_deployment,
    },
    {
        "name": "archmap_versions",
        "writes": False,
        "description": "Версии документации объекта (у контейнера — вместе с поддеревом), новые сверху: номер, комментарий (номер релиза или задачи), дата, автор, автоверсии отката словами и что изменено относительно предыдущей версии. Первой строкой — есть ли незафиксированные изменения с последней версии и какие. Без node_id — срез всего проекта. Дальше — archmap_version_diff.",
        "schema": {
            "type": "object",
            "properties": {"project": PROJECT_ARG, "node_id": VERSION_NODE_ARG},
            "required": ["project"],
        },
        "handler": t_versions,
    },
    {
        "name": "archmap_version_diff",
        "writes": False,
        "description": "Что изменилось в версии документации: элементы (свойства, связи, схемы логики, OpenAPI, таблицы, каналы, конфигурация, статус страницы, процессы) со статусом, подробностью и item. version — номер (без него — последняя версия); base — с чем сравнивать: prev — с предыдущей версией (по умолчанию), live — от версии до текущего состояния («что изменилось с версии N»), номер — с этой версией. item из списка элементов — одна дельта текстом: построчно у схем и спек, таблицей у свойств, связей, фактов и шагов процесса; with_sides — ещё «было» и «стало» целиком. Без node_id — срез всего проекта. Отката через MCP нет.",
        "schema": {
            "type": "object",
            "properties": {
                "project": PROJECT_ARG,
                "node_id": VERSION_NODE_ARG,
                "version": {"type": "integer", "description": "Номер версии; без него — последняя версия объекта."},
                "base": {
                    "type": ["string", "integer"],
                    "description": "С чем сравнивать: prev — с предыдущей версией (по умолчанию), live — от версии до текущего состояния, номер — с этой версией.",
                },
                "item": {"type": "string", "description": "item элемента из списка дельты («doc:<id>», «process:<id>»…): одна дельта текстом."},
                "with_sides": {"type": "boolean", "description": "Вместе с item: показать ещё «было» и «стало» целиком. По умолчанию false."},
            },
            "required": ["project"],
        },
        "handler": t_version_diff,
    },
    {
        "name": "archmap_version_doc",
        "writes": False,
        "description": "Текст на версии: схема логики (doc_id), OpenAPI-спека объекта (spec_node_id) или процесс в mermaid (process_id) — ровно один из трёх. id — часть item после двоеточия у элементов doc:, spec:, process: из archmap_version_diff (или из archmap_node, archmap_processes). Без node_id — срез всего проекта.",
        "schema": {
            "type": "object",
            "properties": {
                "project": PROJECT_ARG,
                "node_id": VERSION_NODE_ARG,
                "version": VERSION_NUMBER_ARG,
                "doc_id": {"type": "string", "description": "id схемы логики (item «doc:<id>»)."},
                "spec_node_id": {"type": "string", "description": "id объекта со спекой OpenAPI (item «spec:<id>»)."},
                "process_id": {"type": "string", "description": "id процесса (item «process:<id>»)."},
            },
            "required": ["project", "version"],
        },
        "handler": t_version_doc,
    },
    {
        "name": "archmap_alerts",
        "writes": False,
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
        "writes": False,
        "description": "Бизнес-процессы проекта: без process_id — список (область и число шагов), с ним — участники, шаги сценария и фрагменты. У каждого шага видно, чем он задокументирован (схема логики с путём объекта) либо что привязки нет, а также его id и version — вход archmap_step_docs и archmap_bind_step.",
        "schema": {
            "type": "object",
            "properties": {
                "project": PROJECT_ARG,
                "process_id": {"type": "string", "description": "id процесса: без него — список процессов."},
            },
            "required": ["project"],
        },
        "handler": t_processes,
    },
    {
        "name": "archmap_step_docs",
        "writes": False,
        "description": "Схемы логики, которыми МОЖНО задокументировать шаг процесса: каталог считает сервер (схемы обоих участников и их потомков, схемы исполнителя шага — первыми и с пометкой «исполнитель»; «не описана» — заглушка разведки). Отсюда берут doc_id для archmap_bind_step. id и version самого шага — в выдаче archmap_processes с process_id.",
        "schema": {
            "type": "object",
            "properties": {
                "project": PROJECT_ARG,
                "process_id": PROCESS_ID_ARG,
                "message_id": {"type": "string", "description": "Шаг процесса (id из archmap_processes)."},
            },
            "required": ["project", "process_id", "message_id"],
        },
        "handler": t_step_docs,
    },
    {
        "name": "archmap_bind_step",
        "writes": True,
        "description": "Привязывает шаг процесса к схеме логики — говорит, ЧЕМ шаг задокументирован. Порядок: archmap_processes с process_id (у шага есть id и version) → archmap_step_docs (допустимые схемы) → сюда с выбранным doc_id. doc_id null (или пустая строка) — снять привязку; удалений тут нет, снятие обратимо. base_version — version шага из выдачи процесса: если шаг изменили в другой сессии, будет конфликт версий и надо перечитать процесс.",
        "schema": {
            "type": "object",
            "properties": {
                "project": PROJECT_ARG,
                "process_id": PROCESS_ID_ARG,
                "message_id": {"type": "string", "description": "Шаг процесса (id из archmap_processes)."},
                "doc_id": {
                    "type": ["string", "null"],
                    "description": "Схема логики из archmap_step_docs. null — снять привязку.",
                },
                "base_version": {
                    "type": "integer",
                    "description": "version шага из archmap_processes (защита от параллельной правки).",
                },
            },
            "required": ["project", "process_id", "message_id", "doc_id", "base_version"],
        },
        "handler": t_bind_step,
    },
    {
        "name": "archmap_export",
        "writes": False,
        "description": "Схема проекта в YAML формата ArchMap (семантика без раскладки) — то, что подают обратно на импорт и синк. node_id — только поддерево. Это СРЕЗ для чтения: схемы логики, спеки, таблицы, каналы, конфигурация и процессы в него не входят — полное знание проекта выгружает archmap_export_archive.",
        "schema": {
            "type": "object",
            "properties": {"project": PROJECT_ARG, "node_id": SUBTREE_ARG},
            "required": ["project"],
        },
        "handler": t_export,
    },
    {
        "name": "archmap_export_archive",
        "writes": False,
        "description": "ПОЛНЫЙ АРХИВ знания проекта в zip-файл на диске: C4, схемы логики, спеки OpenAPI, структура БД, каналы брокеров, конфигурация, процессы. Для бэкапа и переноса; тем же архивом проект восстанавливается (archmap_import_apply с paths). Отличие от archmap_export: тот отдаёт только семантический YAML в ответ, этот пишет ФАЙЛ и возвращает сводку манифеста.",
        "schema": {
            "type": "object",
            "properties": {
                "project": PROJECT_ARG,
                "out_path": {
                    "type": "string",
                    "description": "Куда записать архив: файл .zip на машине агента (символическая ссылка не годится). Каталоги создаются. Если на сервере задан ARCHMAP_EXPORT_DIR — путь внутри него, относительный считается от него.",
                },
                "overwrite": {
                    "type": "boolean",
                    "description": "Перезаписать существующий файл. По умолчанию false — иначе чужой бэкап затирается молча.",
                },
            },
            "required": ["project", "out_path"],
        },
        "handler": t_export_archive,
    },
    {
        "name": "archmap_import_prompt",
        "writes": False,
        "description": "ПРАВИЛА ФОРМАТА: как построить YAML архитектуры по исходникам репозитория. Вызывать ДО построения YAML — промпт задаёт слои C4, правила связей и запреты. variant — какой промпт вернуть: строительный (по умолчанию), оркестраторный с аудитом скептика (для него нужны субагенты) или один аудит.",
        "schema": {
            "type": "object",
            "properties": {
                "system_name": {"type": "string", "description": "Имя системы в схеме."},
                "depth": {"type": "integer", "description": "Глубина C4: 2 или 3 (по умолчанию 3)."},
                "hints": {"type": "string", "description": "Подсказки про систему свободным текстом."},
                "variant": VARIANT_ARG,
            },
            "required": ["system_name"],
        },
        "handler": t_import_prompt,
    },
    {
        "name": "archmap_docs_prompt",
        "writes": False,
        "description": "ПРАВИЛА ФОРМАТА: как оформить схемы логики (.mmd с шапкой «%% archmap-name») и OpenAPI-спеки для дозаливки. include: logic | api | both. target — одна точка входа за прогон (после разведки: имя заглушки). variant — строительный промпт (по умолчанию), оркестраторный с аудитом скептика (нужны субагенты) или один аудит.",
        "schema": {
            "type": "object",
            "properties": {
                "project": PROJECT_ARG,
                "node_id": {"type": "string", "description": "Объект, для которого готовим доки."},
                "include": {
                    "type": "string",
                    "enum": ["logic", "api", "both"],
                    "description": "Что описывать: logic — схемы логики, api — OpenAPI-спеки, both — то и другое (по умолчанию).",
                },
                "target": {
                    "type": "string",
                    "description": "Описать ОДНУ точку входа: имя заглушки разведки (воркер) или «METHOD /путь» (операция). Для крупных сервисов — по точке за прогон.",
                },
                "variant": VARIANT_ARG,
            },
            "required": ["project"],
        },
        "handler": t_docs_prompt,
    },
    {
        "name": "archmap_import_preview",
        "writes": True,
        "description": "Проверить входы будущего проекта БЕЗ записи: N входов вперемешку — YAML архитектуры (files, текстом) и zip-архивы знания (paths, файлы с диска). Показывает разбор и слияние C4, что приедет по семьям фактов, СПОРЫ содержимого (один факт описан по-разному) и откуда возьмётся имя проекта. Проект не создаётся. Порядок входов = порядок нумерации в замечаниях («вход 2»): сначала files, потом paths.",
        "schema": {
            "type": "object",
            "properties": {"files": FILES_ARG, "paths": PATHS_ARG},
        },
        "handler": t_import_preview,
    },
    {
        "name": "archmap_import_apply",
        "writes": True,
        "description": "СОЗДАЁТ НОВЫЙ ПРОЕКТ из тех же входов, что проверял archmap_import_preview (порядок входов тот же). name обязателен ВСЕГДА, кроме одного случая: единственный вход — zip-архив, тогда имя и описание приедут из его манифеста. resolutions — решения по спорам содержимого из превью: объект «id спора» → «cand:<номер кандидата>» либо «all» (взять все — только там, где превью пометило allow_all). Без resolutions применяется дефолт каждого спора.",
        "schema": {
            "type": "object",
            "properties": {
                "name": {"type": "string", "description": "Имя нового проекта. Можно опустить только при единственном входе-архиве."},
                "description": {"type": "string", "description": "Описание нового проекта."},
                "files": FILES_ARG,
                "paths": PATHS_ARG,
                "resolutions": RESOLUTIONS_ARG,
            },
        },
        "handler": t_import_apply,
    },
    {
        "name": "archmap_import_into_preview",
        "writes": True,
        "description": "План ДОГРУЗКИ архивов знания к СУЩЕСТВУЮЩЕМУ проекту, без записи: что появится нового (объекты, связи, содержимое семей) и о чём придётся выбрать. Входы — ТОЛЬКО .zip-архивы путями с диска (paths); YAML схемы в живой проект заливают синком (archmap_sync_preview / archmap_sync_apply), это другая механика. Догрузка аддитивна: дефолт каждого спора с живым — «оставить моё», ничего не удаляется. Печатает base_graph_rev/base_meta_rev — их передают в применение.",
        "schema": {
            "type": "object",
            "properties": {"project": PROJECT_ARG, "paths": ARCHIVE_PATHS_ARG},
            "required": ["project", "paths"],
        },
        "handler": t_import_into_preview,
    },
    {
        "name": "archmap_import_into_apply",
        "writes": True,
        "description": "ДОГРУЖАЕТ архивы (.zip путями с диска) к существующему проекту. Вызывать после archmap_import_into_preview с теми же входами. YAML схемы сюда не подают — для него archmap_sync_apply. base_graph_rev и base_meta_rev — из превью: они защищают от параллельной правки проекта, при расхождении будет конфликт версий (тогда перечитайте превью). resolutions — как у archmap_import_apply; живое перетирается ТОЛЬКО там, где выбран кандидат из архива.",
        "schema": {
            "type": "object",
            "properties": {
                "project": PROJECT_ARG,
                "paths": ARCHIVE_PATHS_ARG,
                "resolutions": RESOLUTIONS_ARG,
                "base_graph_rev": {"type": "integer", "description": "Из превью догрузки."},
                "base_meta_rev": {"type": "integer", "description": "Из превью догрузки."},
            },
            "required": ["project", "paths", "base_graph_rev", "base_meta_rev"],
        },
        "handler": t_import_into_apply,
    },
    {
        "name": "archmap_sync_preview",
        "writes": True,
        "description": "План обновления СУЩЕСТВУЮЩЕГО проекта по свежему прогону кода, без записи: что создастся, что обновится, что пропало из кода.",
        "schema": {
            "type": "object",
            "properties": {
                "project": PROJECT_ARG,
                "files": FILES_ARG,
                **SYNC_POLICY_ARGS,
            },
            "required": ["project", "files"],
        },
        "handler": t_sync_preview,
    },
    {
        "name": "archmap_sync_apply",
        "writes": True,
        "description": "ПРИМЕНЯЕТ обновление проекта из кода. Синк не удаляет объекты и не трогает раскладку. Вызывать после archmap_sync_preview.",
        "schema": {
            "type": "object",
            "properties": {
                "project": PROJECT_ARG,
                "files": FILES_ARG,
                **SYNC_POLICY_ARGS,
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
        "writes": True,
        "description": "План дозаливки схем логики (.mmd) и OpenAPI-спек БЕЗ записи: куда что уедет и что займёт занятый слот.",
        "schema": {
            "type": "object",
            "properties": {
                "project": PROJECT_ARG,
                "files": FILES_ARG,
                "overwrite": DOCS_OVERWRITE_ARG,
                "only": DOCS_ONLY_ARG,
                "node_id": DOCS_SCOPE_ARG,
            },
            "required": ["project", "files"],
        },
        "handler": t_docs_preview,
    },
    {
        "name": "archmap_docs_apply",
        "writes": True,
        "description": "ПРИМЕНЯЕТ дозаливку схем логики и спек. Вызывать после archmap_docs_preview.",
        "schema": {
            "type": "object",
            "properties": {
                "project": PROJECT_ARG,
                "files": FILES_ARG,
                "overwrite": DOCS_OVERWRITE_ARG,
                "only": DOCS_ONLY_ARG,
                "node_id": DOCS_SCOPE_ARG,
            },
            "required": ["project", "files"],
        },
        "handler": t_docs_apply,
    },
    {
        "name": "archmap_recon_prompt",
        "writes": False,
        "description": (
            "ПРАВИЛА ФОРМАТА: как обойти репозиторий и составить ПЕРЕЧЕНЬ точек входа объекта — "
            "операций его API и фоновых воркеров. Это НУЛЕВОЙ шаг документирования монолита: "
            "перечень — оглавление, а не документация. Сценарий целиком: archmap_recon_prompt → "
            "агент читает код и пишет перечень в формате промпта → archmap_recon_preview → "
            "archmap_recon_apply (строки лягут ЗАГЛУШКАМИ — схемами логики с пустым телом) → "
            "дальше каждую точку входа описывают адресно: archmap_docs_prompt с node_id и target "
            "(имя заглушки) → archmap_docs_preview/apply. Без разведки задание «опиши логику сервиса» безадресно, "
            "и модель сама решает, где остановиться (полевой факт: 13 схем на 201 точку входа). "
            "variant — строительный промпт (по умолчанию), оркестраторный с двумя прогонами, "
            "объединением и аудитом скептика (нужны субагенты) или один аудит."
        ),
        "schema": {
            "type": "object",
            "properties": {
                "project": PROJECT_ARG,
                "node_id": {
                    "type": "string",
                    "description": "Объект, чьи точки входа разведываем. Обязателен: перечень принадлежит объекту.",
                },
                "variant": VARIANT_ARG,
            },
            "required": ["project", "node_id"],
        },
        "handler": t_recon_prompt,
    },
    {
        "name": "archmap_recon_preview",
        "writes": True,
        "description": (
            "План разведки БЕЗ записи: какие точки входа станут заглушками, какие заглушки уже "
            "есть, какие УЖЕ ОПИСАНЫ (их не тронут ни при какой политике) и какие есть в "
            "документации, но не найдены в коде. Он же дифф повторной разведки после релиза. "
            "node_id — объект-адресат для строк перечня без строки «node:»."
        ),
        "schema": {
            "type": "object",
            "properties": {
                "project": PROJECT_ARG,
                "files": FILES_ARG,
                "node_id": RECON_NODE_ARG,
            },
            "required": ["project", "files"],
        },
        "handler": t_recon_preview,
    },
    {
        "name": "archmap_recon_apply",
        "writes": True,
        "description": (
            "ПРИМЕНЯЕТ перечень: создаёт недостающие заглушки схем логики. Только создаёт — "
            "описанные схемы не перезаписывает, не удаляет ничего, поэтому перечень можно "
            "приносить повторно после релиза (даст дифф, а не дубли). Вызывать после "
            "archmap_recon_preview; описывают заглушки потом через archmap_docs_prompt/apply."
        ),
        "schema": {
            "type": "object",
            "properties": {
                "project": PROJECT_ARG,
                "files": FILES_ARG,
                "node_id": RECON_NODE_ARG,
            },
            "required": ["project", "files"],
        },
        "handler": t_recon_apply,
    },
    {
        "name": "archmap_facts_prompt",
        "writes": False,
        "description": (
            "ПРАВИЛА ФОРМАТА для ТАБЛИЧНЫХ ФАКТОВ — третьего слоя документации после схемы и "
            "схем логики. family выбирает семью: tables — структура БД (таблицы и колонки, у "
            "объектов формы database), channels — каналы брокера с полями сообщений (форма "
            "broker), config — параметры конфигурации сервиса (форма service). Формат файлов "
            "задаёт сам промпт — вызывать ДО прогона агента. ⚠ Конфигурация НЕ НЕСЁТ ЗНАЧЕНИЙ "
            "СРЕД: хранится только текст дефолта из кода. Обращения к таблицам, каналам и "
            "параметрам этими пакетами не приезжают — они живут пометками в тексте схем логики. "
            "variant — строительный промпт (по умолчанию), оркестраторный с аудитом скептика "
            "(нужны субагенты) или один аудит."
        ),
        "schema": {
            "type": "object",
            "properties": {
                "project": PROJECT_ARG,
                "family": FAMILY_ARG,
                "variant": VARIANT_ARG,
            },
            "required": ["project", "family"],
        },
        "handler": t_facts_prompt,
    },
    {
        "name": "archmap_facts_preview",
        "writes": True,
        "description": (
            "План дозаливки табличных фактов БЕЗ записи: какие таблицы, каналы или параметры "
            "приедут, к какому объекту и что с ними станет (новая, перезапись, пропуск занятого, "
            "без изменений). family — tables | channels | config. node_id — объект-адресат для "
            "записей без адреса в файле."
        ),
        "schema": {
            "type": "object",
            "properties": {
                "project": PROJECT_ARG,
                "family": FAMILY_ARG,
                "files": FILES_ARG,
                "overwrite": OVERWRITE_ARG,
                "node_id": FACTS_NODE_ARG,
            },
            "required": ["project", "family", "files"],
        },
        "handler": t_facts_preview,
    },
    {
        "name": "archmap_facts_apply",
        "writes": True,
        "description": (
            "ПРИМЕНЯЕТ дозаливку табличных фактов выбранной семьи. Удалений нет ни при какой "
            "политике: агент не сносит то, чего не увидел. Вызывать после archmap_facts_preview."
        ),
        "schema": {
            "type": "object",
            "properties": {
                "project": PROJECT_ARG,
                "family": FAMILY_ARG,
                "files": FILES_ARG,
                "overwrite": OVERWRITE_ARG,
                "node_id": FACTS_NODE_ARG,
            },
            "required": ["project", "family", "files"],
        },
        "handler": t_facts_apply,
    },
    {
        "name": "archmap_create_node",
        "writes": True,
        "description": "Создать один объект. parent_id — внутри какого объекта (без него — корневой уровень). shape: service | database | broker | person; person ВСЕГДА корневой (человек живёт за границей системы). status: existing | planned | deprecated. source — источник объекта (два вида, см. аргумент): объект сразу становится опознаваемым при обновлениях из кода, без второго вызова.",
        "schema": {
            "type": "object",
            "properties": {
                "project": PROJECT_ARG,
                "name": {"type": "string", "description": "Имя объекта."},
                "description": {"type": "string", "description": "Что делает объект — одна-две фразы."},
                "role": {"type": "string", "description": "Роль: «сервис», «БД», «брокер»."},
                "technology": {"type": "string", "description": "Технология: Python, Kafka, Redis."},
                "parent_id": {"type": "string", "description": "id объекта-родителя; без него — корневой уровень."},
                "shape": SHAPE_ARG,
                "is_external": EXTERNAL_ARG,
                "status": STATUS_ARG,
                "source": SOURCE_ARG,
            },
            "required": ["project", "name"],
        },
        "handler": t_create_node,
    },
    {
        "name": "archmap_update_node",
        "writes": True,
        "description": "Правка объекта: имя, описание, роль, технология, форма, статус, внешность и ИСТОЧНИК (source — два вида: код репозитория с путём либо имя зависимости; пустой объект {} снимает источник). sites — размещение: имена площадок из archmap_deployment набором целиком, [] снимает своё; площадки через MCP не создаются. approval — статус СТРАНИЦЫ (в работе / согласовано, не жизненный цикл): только по явной просьбе человека и только у объекта без детей — у контейнера он складывается из детей. Удаления объектов через MCP нет — чтобы убрать лишнее, поставьте status=deprecated, физически удалит человек кнопкой «Принять переход».",
        "schema": {
            "type": "object",
            "properties": {
                "project": PROJECT_ARG,
                "node_id": NODE_ID_ARG,
                "name": {"type": "string", "description": "Новое имя."},
                "description": {"type": "string", "description": "Новое описание."},
                "role": {"type": "string", "description": "Роль: «сервис», «БД», «брокер»."},
                "technology": {"type": "string", "description": "Технология: Python, Kafka, Redis."},
                "shape": SHAPE_ARG,
                "status": STATUS_ARG,
                "is_external": EXTERNAL_ARG,
                "source": SOURCE_ARG,
                "approval": APPROVAL_ARG,
                "sites": SITES_ARG,
            },
            "required": ["project", "node_id"],
        },
        "handler": t_update_node,
    },
    {
        "name": "archmap_create_edge",
        "writes": True,
        "description": "Создать связь между двумя объектами. Направление — от инициатора вызова. is_synchronous: false — событие (у асинхронного канала нет ответного плеча).",
        "schema": {
            "type": "object",
            "properties": {
                "project": PROJECT_ARG,
                "source_id": {"type": "string", "description": "id объекта — инициатора вызова."},
                "target_id": {"type": "string", "description": "id объекта, которого вызывают."},
                "label": {"type": "string", "description": "Что передаётся: «создать заказ»."},
                "technology": {"type": "string", "description": "REST, gRPC, Kafka."},
                "is_synchronous": SYNC_ARG,
            },
            "required": ["project", "source_id", "target_id"],
        },
        "handler": t_create_edge,
    },
    {
        "name": "archmap_update_edge",
        "writes": True,
        "description": "Правка связи: подпись, технология, тип канала.",
        "schema": {
            "type": "object",
            "properties": {
                "project": PROJECT_ARG,
                "edge_id": {"type": "string", "description": "id связи (из archmap_schema или archmap_node)."},
                "label": {"type": "string", "description": "Что передаётся: «создать заказ»."},
                "technology": {"type": "string", "description": "REST, gRPC, Kafka."},
                "is_synchronous": SYNC_ARG,
            },
            "required": ["project", "edge_id"],
        },
        "handler": t_update_edge,
    },
    {
        "name": "archmap_version_create",
        "writes": True,
        "description": "Фиксирует версию документации объекта с комментарием (номер релиза или задачи) — ТОЛЬКО по явной просьбе человека: версия — его решение, агент её не придумывает. У контейнера в версию входит всё поддерево; без node_id — срез всего проекта. Ответ — номер версии и что изменено относительно предыдущей. Отката и удаления версий через MCP нет, потому что откат удаляет объекты, появившиеся после версии; его делают в интерфейсе.",
        "schema": {
            "type": "object",
            "properties": {
                "project": PROJECT_ARG,
                "node_id": VERSION_NODE_ARG,
                "comment": {"type": "string", "description": "Комментарий версии — номер релиза или задачи, как сказал человек."},
            },
            "required": ["project", "comment"],
        },
        "handler": t_version_create,
    },
]

BY_NAME = {t["name"]: t for t in TOOLS}


async def call(name: str, args: dict[str, Any], client: ArchMapClient) -> str:
    tool = BY_NAME.get(name)
    if tool is None:
        raise ArchMapError(f"Неизвестный инструмент: {name}")
    handler = tool["handler"]
    return str(await handler(client, args))


# ── Удалённый набор (/mcp в процессе бэкенда; docs/plan-remote-mcp.md, Р5, Р6) ────

# Работают с файлами на машине агента. В удалённом режиме это был бы диск СЕРВЕРА
# ArchMap (ключ подписи, /etc…), поэтому их там нет вовсе.
LOCAL_ONLY = frozenset({"archmap_export_archive", "archmap_import_into_preview", "archmap_import_into_apply"})
# Аргументы-пути. Схема удалённого набора их не объявляет, но SDK лишних свойств не
# запрещает — отказ на диспетчере, по ключу, у ЛЮБОГО инструмента.
DISK_ARGS = frozenset({"paths", "out_path"})

_REMOTE_IMPORT_TAIL = (
    " Архив знания (zip) так не ввозят: его ввозят в интерфейсе ArchMap — «Новый проект» → "
    "«Импорт»."
)

# Удалённые варианты описаний и схем: без paths и без упоминания локальных инструментов.
REMOTE_OVERRIDES: dict[str, dict[str, Any]] = {
    "archmap_export": {
        "description": "Схема проекта в YAML формата ArchMap (семантика без раскладки) — то, что подают обратно на импорт и синк. node_id — только поддерево. Это СРЕЗ для чтения: схемы логики, спеки, таблицы, каналы, конфигурация и процессы в него не входят — полный архив знания проекта выгружают в интерфейсе ArchMap.",
    },
    "archmap_import_preview": {
        "description": "Проверить входы будущего проекта БЕЗ записи: YAML архитектуры текстом (files) — один или несколько прогонов. Показывает разбор и слияние C4 и замечания по входам. Проект не создаётся. Порядок входов = порядок нумерации в замечаниях («вход 2»)."
        + _REMOTE_IMPORT_TAIL,
        "schema": {"type": "object", "properties": {"files": FILES_ARG}, "required": ["files"]},
    },
    "archmap_import_apply": {
        "description": "СОЗДАЁТ НОВЫЙ ПРОЕКТ из тех же входов, что проверял archmap_import_preview (порядок входов тот же). name обязателен. resolutions — решения по спорам содержимого из превью: объект «id спора» → «cand:<номер кандидата>» либо «all» (взять все — только там, где превью пометило allow_all). Без resolutions применяется дефолт каждого спора."
        + _REMOTE_IMPORT_TAIL,
        "schema": {
            "type": "object",
            "properties": {
                "name": {"type": "string", "description": "Имя нового проекта."},
                "description": {"type": "string", "description": "Описание нового проекта."},
                "files": FILES_ARG,
                "resolutions": RESOLUTIONS_ARG,
            },
            "required": ["name", "files"],
        },
    },
}

REMOTE_TOOLS: list[dict[str, Any]] = [
    {**t, **REMOTE_OVERRIDES.get(t["name"], {})} for t in TOOLS if t["name"] not in LOCAL_ONLY
]
REMOTE_BY_NAME = {t["name"]: t for t in REMOTE_TOOLS}


def remote_catalog(read_only: bool) -> list[dict[str, Any]]:
    """Удалённый набор; токену «только чтение» — без пишущих. Это лишь подсказка агенту:
    защищают call_remote и бэкенд (403 по методу)."""
    return [t for t in REMOTE_TOOLS if not (read_only and t["writes"])]


async def call_remote(name: str, args: dict[str, Any], client: ArchMapClient, read_only: bool) -> str:
    """Вызов в удалённом режиме. Все отказы — ДО обработчика: локальный инструмент и
    аргумент-путь не должны дойти до кода, читающего или пишущего файлы."""
    if name in LOCAL_ONLY:
        raise ArchMapError(
            f"Инструмент {name} работает с файлами на машине агента и в подключении по адресу "
            "недоступен. Архив проекта выгружают и ввозят в интерфейсе ArchMap или локальным "
            "MCP-сервером ArchMap."
        )
    tool = REMOTE_BY_NAME.get(name)
    if tool is None:
        raise ArchMapError(f"Неизвестный инструмент: {name}")
    disk = sorted(DISK_ARGS & args.keys())
    if disk:
        raise ArchMapError(
            f"Аргумент {', '.join(disk)} в подключении по адресу не принимается: файлы с машины "
            "агента сюда не передаются. YAML передают текстом в files, архив проекта ввозят в "
            "интерфейсе ArchMap."
        )
    if read_only and tool["writes"]:
        raise ArchMapError(
            f"Токен только для чтения: {name} меняет данные. Для правок выпустите токен без "
            "«только чтение» в меню профиля → «Токены для MCP»."
        )
    return str(await tool["handler"](client, args))
