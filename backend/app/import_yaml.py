"""Импорт схемы из YAML в формате экспорта (зеркало app/export.py).

Принимает ровно тот документ, что строит build_export: {nodes: <дерево через
children>, edges: <список по именам>}. Гарантия roundtrip: любой вывод
build_export импортируется без ошибок с той же семантикой (имя, форма, статус,
роль, технология, external, описание, вложенность, связи). Раскладки в формате
нет — координаты не пишем, холст разложит авто-ELK; flowchart/openapi_spec в
формат не входят → останутся пустыми.

parse_import разбирает и валидирует текст: ошибки копятся СПИСКОМ человеческих
строк (RU), каждая с путём до места («nodes[2].children[0]: …», «edges[5]: …»),
а не обрывом на первой. seed_import пишет разобранное в проект. Разделены, чтобы
dry-run превью модалки (POST /projects/import/preview) и создание проекта
(start="import") пользовались одним валидатором.
"""

import re
import uuid
from collections import defaultdict
from dataclasses import dataclass

import yaml
from sqlalchemy.orm import Session

from app.models.edge import Edge
from app.models.node import Node

# Лимиты щедрые (реальный экспорт не упрётся) — защита от «бомбы» в textarea.
MAX_NODES = 2000
MAX_EDGES = 4000
MAX_DEPTH = 32

_SHAPES = ("service", "database", "broker", "person")
_STATUSES = ("existing", "planned", "deprecated")


@dataclass
class _ImpNode:
    name: str
    shape: str
    status: str
    role: str | None
    technology: str | None
    is_external: bool
    description: str | None
    parent_idx: int | None  # индекс родителя в ParsedImport.nodes (родители раньше детей)


@dataclass
class _ImpEdge:
    source_idx: int
    target_idx: int
    label: str | None
    technology: str | None


@dataclass
class ParsedImport:
    nodes: list[_ImpNode]
    edges: list[_ImpEdge]
    roots: list[str]  # имена корневых узлов (для сводки в превью импорта)


def _yaml_error(e: yaml.YAMLError) -> str:
    """Короткая строка из многословной ошибки PyYAML (+ номер строки, если есть)."""
    if isinstance(e, yaml.MarkedYAMLError) and e.problem_mark is not None:
        return f"{e.problem or 'ошибка разметки'} (строка {e.problem_mark.line + 1})"
    return str(e).splitlines()[0] if str(e) else "ошибка разметки"


# fenced-блок ```yaml … ``` — ИИ-агенты часто оборачивают вывод в него и/или
# добавляют строку-преамбулу (проверено dogfood-прогоном слабой моделью).
_FENCE_RE = re.compile(r"```(?:yaml|yml)?[ \t]*\n(.*?)```", re.DOTALL)
# Первая строка верхнего уровня «nodes:» — точка среза преамбулы БЕЗ fence
# (стресс-тест: голая преамбула перед nodes: встречается и без ```-обёртки).
_NODES_LINE_RE = re.compile(r"^nodes:[ \t]*$", re.MULTILINE)


def _load_doc(content: str) -> tuple[dict | None, list[str]]:
    """yaml.safe_load + проверка «словарь с nodes». Ошибки — человеческим списком."""
    try:
        doc = yaml.safe_load(content)
    except yaml.YAMLError as e:
        return None, [f"Некорректный YAML: {_yaml_error(e)}"]
    if not isinstance(doc, dict):
        return None, ["Корень документа должен быть словарём с ключами nodes и edges"]
    return doc, []


def parse_import(content: str) -> tuple[ParsedImport | None, list[str]]:
    """Разбор + валидация YAML импорта. Возвращает (результат, ошибки): при любой
    ошибке результат None, список — все найденные проблемы (не первая попавшаяся).
    Неизвестные ключи игнорируются молча (форвард-совместимость формата).

    Толерантность к выводу ИИ-агентов (пользователь вставляет финальное сообщение
    агента целиком): если сырой текст не разбирается в словарь с nodes, пробуем
    (1) содержимое fenced-блока ```yaml, затем (2) срез от первой строки «nodes:»
    (голая преамбула без обёртки). Валидные документы это не задевает — фолбэки
    срабатывают только при неудаче; ошибки отдаём от последнего кандидата
    (он ближе всего к полезной нагрузке)."""
    doc, load_errors = _load_doc(content)
    if doc is None or "nodes" not in doc:
        candidates: list[str] = []
        m = _FENCE_RE.search(content)
        if m is not None:
            candidates.append(m.group(1))
        n = _NODES_LINE_RE.search(content)
        if n is not None and n.start() > 0:
            candidates.append(content[n.start():])
        for cand in candidates:
            doc2, errs2 = _load_doc(cand)
            if doc2 is not None and "nodes" in doc2:
                doc, load_errors = doc2, errs2
                break
            doc, load_errors = doc2, errs2  # запоминаем последнюю попытку для ошибок
    if doc is None:
        return None, load_errors
    errors: list[str] = []
    raw_nodes = doc.get("nodes")
    if raw_nodes is None:
        return None, ["nodes: обязательный список узлов отсутствует"]
    if not isinstance(raw_nodes, list):
        return None, ["nodes: ожидается список узлов"]
    # edges опционален; явный `edges:` без значения PyYAML отдаёт как None.
    raw_edges = doc.get("edges") or []
    if not isinstance(raw_edges, list):
        errors.append("edges: ожидается список связей")
        raw_edges = []

    nodes: list[_ImpNode] = []
    # Карты для резолвинга ссылок edges — зеркало ref_name экспорта: голое имя
    # (если уникально) либо полный путь «Корень / … / Имя» (разделитель " / ").
    # fulls — полный путь каждого узла: по нему же резолвится ОДНОЗНАЧНЫЙ хвост
    # пути («backend / api» → «Система / backend / api») — ИИ-агенты пишут
    # частичные пути от контейнера, а не от корня (находка dogfood-прогона).
    by_bare: dict[str, list[int]] = defaultdict(list)
    by_path: dict[str, list[int]] = defaultdict(list)
    fulls: list[str] = []
    overflow = False  # превысили MAX_NODES — обход остановлен, ошибка уже в списке

    def opt_str(raw: dict, key: str, path: str, max_len: int | None) -> str | None:
        """Опциональное строковое поле узла/связи (None — отсутствует или кривое)."""
        val = raw.get(key)
        if val is None:
            return None
        if not isinstance(val, str):
            errors.append(f"{path}.{key}: ожидается строка")
            return None
        if max_len is not None and len(val) > max_len:
            errors.append(f"{path}.{key}: длиннее {max_len} символов")
            return None
        return val

    def walk(raw: object, path: str, parent_idx: int | None, prefix: str, depth: int) -> None:
        nonlocal overflow
        if overflow:
            return
        if not isinstance(raw, dict):
            errors.append(f"{path}: узел должен быть словарём (mapping)")
            return
        name = raw.get("name")
        if not isinstance(name, str) or not name.strip():
            errors.append(f"{path}: name — обязательная непустая строка")
            return
        if len(name) > 256:
            errors.append(f"{path}: name длиннее 256 символов")
            return
        if len(nodes) >= MAX_NODES:
            errors.append(f"Слишком много узлов (больше {MAX_NODES})")
            overflow = True
            return

        shape = raw.get("shape", "service")
        if shape not in _SHAPES:
            errors.append(f"{path}: shape {shape!r} не поддерживается ({' | '.join(_SHAPES)})")
            shape = "service"
        status = raw.get("status", "existing")
        if status not in _STATUSES:
            errors.append(f"{path}: status {status!r} не поддерживается ({' | '.join(_STATUSES)})")
            status = "existing"
        ext = raw.get("external", False)
        if not isinstance(ext, bool):
            errors.append(f"{path}.external: ожидается true/false")
            ext = False

        idx = len(nodes)
        nodes.append(
            _ImpNode(
                name=name,
                shape=shape,
                status=status,
                role=opt_str(raw, "role", path, 128),
                technology=opt_str(raw, "technology", path, 128),
                is_external=ext,
                description=opt_str(raw, "description", path, None),
                parent_idx=parent_idx,
            )
        )
        full = f"{prefix} / {name}" if prefix else name
        by_bare[name].append(idx)
        by_path[full].append(idx)
        fulls.append(full)

        kids = raw.get("children")
        if kids is None:
            return
        if not isinstance(kids, list):
            errors.append(f"{path}.children: ожидается список узлов")
            return
        if not kids:
            return
        if depth >= MAX_DEPTH:
            errors.append(f"{path}: вложенность глубже {MAX_DEPTH} уровней")
            return
        for i, kid in enumerate(kids):
            walk(kid, f"{path}.children[{i}]", idx, full, depth + 1)

    for i, raw_n in enumerate(raw_nodes):
        walk(raw_n, f"nodes[{i}]", None, "", 1)

    def resolve(ref: str, path: str) -> int | None:
        """Ссылка из edges → индекс узла: точный полный путь, иначе голое имя
        (если уникально), иначе однозначный ХВОСТ пути («backend / api» находит
        «Система / backend / api»). Тексты ошибок — как в ТЗ витрины импорта."""
        hits = by_path.get(ref)
        if not hits:
            hits = by_bare.get(ref)
        if not hits and " / " in ref:
            tail = f" / {ref}"
            hits = [i for i, full in enumerate(fulls) if full.endswith(tail)]
        if not hits:
            errors.append(f'{path}: узел "{ref}" не найден')
            return None
        if len(hits) > 1:
            errors.append(f'{path}: имя "{ref}" неоднозначно, укажите путь через " / "')
            return None
        return hits[0]

    edges: list[_ImpEdge] = []
    if len(raw_edges) > MAX_EDGES:
        errors.append(f"Слишком много связей (больше {MAX_EDGES})")
        raw_edges = []
    for i, raw_e in enumerate(raw_edges):
        path = f"edges[{i}]"
        if not isinstance(raw_e, dict):
            errors.append(f"{path}: связь должна быть словарём (mapping)")
            continue
        src_ref = raw_e.get("from")
        dst_ref = raw_e.get("to")
        if not isinstance(src_ref, str) or not src_ref:
            errors.append(f"{path}: from — обязательная строка с именем узла")
            continue
        if not isinstance(dst_ref, str) or not dst_ref:
            errors.append(f"{path}: to — обязательная строка с именем узла")
            continue
        src_idx = resolve(src_ref, path)
        dst_idx = resolve(dst_ref, path)
        if src_idx is None or dst_idx is None:
            continue
        edges.append(
            _ImpEdge(
                source_idx=src_idx,
                target_idx=dst_idx,
                label=opt_str(raw_e, "label", path, 256),
                technology=opt_str(raw_e, "technology", path, 128),
            )
        )

    if errors:
        return None, errors
    roots = [n.name for n in nodes if n.parent_idx is None]
    return ParsedImport(nodes=nodes, edges=edges, roots=roots), []


def seed_import(db: Session, project_id: uuid.UUID, parsed: ParsedImport) -> None:
    """Записать разобранный импорт в проект: узлы (родители раньше детей — порядок
    списка это гарантирует по построению walk), flush, затем связи. Строк
    view_layout не создаём (координат в формате нет). Коммит на вызывающей
    стороне (как у seed_template)."""
    ids: list[uuid.UUID] = []
    for n in parsed.nodes:
        nid = uuid.uuid4()
        ids.append(nid)
        db.add(
            Node(
                id=nid,
                project_id=project_id,
                name=n.name,
                description=n.description,
                role=n.role,
                technology=n.technology,
                shape=n.shape,
                status=n.status,
                is_external=n.is_external,
                parent_id=ids[n.parent_idx] if n.parent_idx is not None else None,
            )
        )
    db.flush()
    for e in parsed.edges:
        db.add(
            Edge(
                id=uuid.uuid4(),
                project_id=project_id,
                source_id=ids[e.source_idx],
                target_id=ids[e.target_idx],
                label=e.label,
                technology=e.technology,
            )
        )
