"""Импорт схемы из YAML в формате экспорта (зеркало app/export.py).

Принимает ровно тот документ, что строит build_export: {nodes: <дерево через
children>, edges: <список по именам>}. Гарантия roundtrip: любой вывод
build_export импортируется без ошибок с той же семантикой (имя, форма, статус,
роль, технология, external, описание, вложенность, связи). Раскладки в формате
нет — координаты не пишем, холст разложит авто-ELK; вложенные документы (доки
логики node_docs, openapi_spec) в формат не входят → останутся пустыми
(наполнение доков — BYOA-дозаливка, этап 2 plan-agent-docs.md).

parse_import разбирает и валидирует текст: ошибки копятся СПИСКОМ человеческих
строк (RU), каждая с путём до места («nodes[2].children[0]: …», «edges[5]: …»),
а не обрывом на первой. seed_import пишет разобранное в проект. Разделены, чтобы
dry-run превью модалки (POST /projects/import/preview) и создание проекта
(start="import") пользовались одним валидатором.
"""

import re
import uuid
from collections import defaultdict
from dataclasses import dataclass, field
from difflib import SequenceMatcher

import yaml
from sqlalchemy.orm import Session

from app.identity import SourceRef, source_keys
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
    # Канонические ключи источника (app/identity): чем узел опознаётся между
    # прогонами агента поверх имени. Пусто — якорей нет, тождество решает имя.
    source_keys: list[str] = field(default_factory=list)


@dataclass
class _ImpEdge:
    source_idx: int
    target_idx: int
    label: str | None
    technology: str | None
    # Канал брокера, который называет связь (Edge.channel): у стрелок в брокер он
    # обязателен по конвенции, но парсер его НЕ требует — отсутствие ловит
    # предупреждение слияния (_warn_broker_edges) и алерт AL31, а не отказ импорта.
    channel: str | None = None


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
        # Диагноз без лечения слабую модель не чинит: на замечание «ошибка в строке 29»
        # она добросовестно перепечатывает документ с той же ошибкой (полевой QA
        # Zabbix 7 — два лишних раунда). Подсказка — та же, что у дозаливки данных.
        return None, [
            f"Некорректный YAML: {_yaml_error(e)}. Частая причина — двоеточие с пробелом "
            "внутри значения (например «действий: отправка»): возьмите такое значение "
            "в кавычки"
        ]
    if not isinstance(doc, dict):
        return None, ["Корень документа должен быть словарём с ключами nodes и edges"]
    return doc, []


# --- did-you-mean к «узел не найден» -----------------------------------------
# Полевой промах агента (docs/qa-federation-matrix.md, находка 2): перечень
# компонентов в замечании превью предлагает «zabbix-ui / web-api», агент берёт
# ИМЯ компонента, но приклеивает его к ЧУЖОМУ контейнеру — пишет в связи
# «zabbix-server / web-api». Без подсказки слабая модель гадает заново; лишний
# круг случился дважды (изолированный Zabbix и федерация).
#
# Пороги — ДОСЛОВНО из дозаливки доков (app/docs_import.py, Ф8ж), и ниже их не
# опускать: ложная подсказка ХУЖЕ её отсутствия — слабая модель копирует
# предложенное имя не глядя, и вместо битой ссылки получается ссылка, битая
# по-другому.
_HINT_CUTOFF = 0.75
# Сколько символов ВСЕГО (на обе строки) может не совпасть у «того же пути,
# записанного иначе». Одной похожести мало: у соседей по контейнеру общий длинный
# префикс, и difflib даёт им 0.75+ на совершенно разных именах листа. У настоящих
# же кандидатов расхождение мелкое: разделитель, окончание, опечатка (0–3).
_HINT_MAX_DIFF = 3
# Разделители, которыми одно и то же имя пишут по-разному: «web-api» / «web_api».
_HINT_SEPARATORS = str.maketrans("", "", "_-. ")


def _norm_name(s: str) -> str:
    """Имя без регистра и разделителей — «то же имя, записанное иначе»."""
    return s.lower().translate(_HINT_SEPARATORS)


def _norm_path(ref: str) -> str:
    """Ссылка → канонический путь «A / B» (слэшем без пробелов пишут слабые модели)."""
    if "/" not in ref:
        return ref.strip()
    return " / ".join(part.strip() for part in ref.split("/") if part.strip())


def _closest_node(
    ref: str,
    fulls: list[str],
    by_bare: dict[str, list[int]],
    by_path: dict[str, list[int]],
) -> str | None:
    """Ближайший узел ЭТОГО документа к неразрешённой ссылке — или None (молчим).

    Кандидаты берутся только из разобранного документа: парсер видит один файл, и
    выдумывать соседей ему неоткуда. Порядок поиска — от уверенного к рискованному:

    1. ТОЧНОЕ совпадение имени листа под другим родителем: «zabbix-server /
       web-api» → «zabbix-ui / web-api». Это и есть главный полевой промах —
       имя компонента агент взял верное, потерял привязку, — поэтому подсказка
       здесь выдаётся уверенно. Несколько одноимённых листьев → ближайший по
       difflib к полному пути, при равенстве — первый в порядке документа.
    2. Добор difflib по ПОЛНОМУ пути и только на МЕЛКОМ расхождении (опечатка,
       окончание, разделитель): порог _HINT_CUTOFF И не больше _HINT_MAX_DIFF
       несовпавших символов.
    3. Иначе подсказки нет.

    Подсказка ОДНА, самая уверенная, и только та, которую агент может вписать как
    есть: путь-дубль (одноимённые узлы под одноимёнными предками) дал бы ему
    «имя неоднозначно» вместо починки — такой кандидат отбрасывается.
    """

    def resolvable(i: int) -> bool:
        return len(by_path.get(fulls[i]) or ()) == 1

    path = _norm_path(ref)
    leaf = path.rpartition(" / ")[2]
    same_leaf = [i for i in (by_bare.get(leaf) or []) if resolvable(i)]
    if same_leaf:
        return fulls[
            min(same_leaf, key=lambda i: (-SequenceMatcher(None, path, fulls[i]).ratio(), i))
        ]
    norm = _norm_name(path)
    if not norm:  # ссылка из одних разделителей — сравнивать нечем
        return None
    matcher = SequenceMatcher(None)
    matcher.set_seq2(norm)  # b индексируется один раз, меняем только a
    best: tuple[float, int] | None = None
    for i, full in enumerate(fulls):
        cand = _norm_name(full)
        # Длина отсеивает даром: расхождение в _HINT_MAX_DIFF символов невозможно
        # при большей разнице длин (документ бывает на MAX_NODES узлов).
        if abs(len(cand) - len(norm)) > _HINT_MAX_DIFF or not resolvable(i):
            continue
        matcher.set_seq1(cand)
        if matcher.real_quick_ratio() < _HINT_CUTOFF or matcher.quick_ratio() < _HINT_CUTOFF:
            continue
        ratio = matcher.ratio()
        if ratio < _HINT_CUTOFF:
            continue
        matched = sum(block.size for block in matcher.get_matching_blocks())
        if (len(norm) - matched) + (len(cand) - matched) > _HINT_MAX_DIFF:
            continue
        if best is None or ratio > best[0]:  # равенство оставляет первого по документу
            best = (ratio, i)
    return fulls[best[1]] if best is not None else None


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
    # Кэш did-you-mean: одна и та же битая ссылка приходит из десятка связей.
    hints: dict[str, str | None] = {}
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

    def parse_source(raw: dict, path: str) -> list[str]:
        """Блок source узла → канонические ключи (app/identity). Блок целиком
        опционален; кривой тип — ошибка, но узел от неё не пропадает (якоря
        необязательны, без них тождество решает имя). Неизвестные вложенные ключи
        игнорируются молча, как и на верхнем уровне формата."""
        raw_src = raw.get("source")
        if raw_src is None:
            return []
        if not isinstance(raw_src, dict):
            errors.append(f"{path}.source: ожидается словарь (repo/path/image/deployment/host)")
            return []
        sp = f"{path}.source"
        return source_keys(
            SourceRef(
                repo=opt_str(raw_src, "repo", sp, 512),
                path=opt_str(raw_src, "path", sp, 512),
                image=opt_str(raw_src, "image", sp, 512),
                deployment=opt_str(raw_src, "deployment", sp, 256),
                host=opt_str(raw_src, "host", sp, 256),
            )
        )

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
                source_keys=parse_source(raw, path),
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
        «Система / backend / api»). Тексты ошибок — как в ТЗ витрины импорта;
        к «не найден» добавляется did-you-mean, когда кандидат уверенный
        (_closest_node), — без него слабая модель гадает имя заново."""
        hits = by_path.get(ref)
        if not hits:
            hits = by_bare.get(ref)
        if not hits and " / " in ref:
            tail = f" / {ref}"
            hits = [i for i, full in enumerate(fulls) if full.endswith(tail)]
        if not hits and "/" in ref:
            # Слабые модели пишут путь слэшем без пробелов («worker/queue-reader»):
            # нормализуем разделитель и повторяем точный путь + однозначный хвост.
            # Тот же фолбэк давно живёт в резолвере дозаливки доков; здесь он стал
            # нужен, когда промпт начал требовать адресовать связи компонентов.
            # Фолбэк ПОСЛЕДНИЙ — настоящие имена со слэшем матчатся выше.
            norm = " / ".join(part.strip() for part in ref.split("/") if part.strip())
            hits = by_path.get(norm)
            if not hits:
                tail = f" / {norm}"
                hits = [i for i, full in enumerate(fulls) if full.endswith(tail)]
        if not hits:
            if ref not in hints:
                hints[ref] = _closest_node(ref, fulls, by_bare, by_path)
            hint = hints[ref]
            # Уверенного кандидата нет — текст остаётся БАЙТ-В-БАЙТ прежним.
            suffix = f' — есть "{hint}"' if hint is not None else ""
            errors.append(f'{path}: узел "{ref}" не найден{suffix}')
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
                channel=opt_str(raw_e, "channel", path, 256),
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
                # Сильнейший якорь прогона: по нему будущий синк узнает узел, даже
                # если сервис переименуют (docs/plan-arch-sync.md).
                source_ref=n.source_keys[0] if n.source_keys else None,
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
                channel=e.channel,
            )
        )
