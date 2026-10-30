"""Импорт схемы из YAML в формате экспорта (зеркало app/export.py).

Принимает ровно тот документ, что строит build_export: {nodes: <дерево через
children>, edges: <список по именам>}. Гарантия roundtrip: любой вывод
build_export импортируется без ошибок с той же семантикой (имя, форма, элемент
архитектуры, статус, роль, технология, external, описание, якорь source, вложенность,
связи с каналом и типом sync). Тёзок (одно имя в одном родителе) экспорт адресует путём с
уточнителем — якорным «путь @ ключ» или порядковым «путь @ #N», — резолвер связей
его понимает (app/node_ref.py). Размещение (docs/tasks/deployment-view.md): раздел
deployment.sites — площадки с вложенностью по имени родителя, у узла sites — имена
площадок, где он стоит сам. Элемент архитектуры (element: system | container,
docs/plan-c4-elements.md) — необязательный: нет ключа — «не сказано»; недопустимое
значение (у не-сервиса, у контейнера с базой внутри, у компонента) снимается с
замечанием, а не валит документ (app/import_element). Раскладки в формате
нет — координаты не пишем, холст разложит авто-ELK; вложенные документы (доки
логики node_docs, openapi_spec) в формат не входят → останутся пустыми
(наполнение доков — BYOA-дозаливка, этап 2 plan-agent-docs.md).

parse_import разбирает и валидирует текст: ошибки копятся СПИСКОМ человеческих
строк (RU), каждая с путём до места («nodes[2].children[0]: …», «edges[5]: …»),
а не обрывом на первой. seed_import пишет разобранное в проект. Разделены, чтобы
dry-run превью единого ввоза (POST /projects/import/unified-preview) и его
применение пользовались одним валидатором (старый путь ввоза YAML текстами —
/import/preview и start="import" — снесён 2026-09-05).
"""

import re
import uuid
from collections import defaultdict
from dataclasses import dataclass, field, replace
from difflib import SequenceMatcher

import yaml
from sqlalchemy.orm import Session

from app import yaml_io
from app.deployment import unit_placements
from app.domain_types import (
    NODE_ELEMENTS,
    NODE_SHAPES,
    NODE_STATUSES,
    SITE_KINDS,
    NodeElement,
    NodeShape,
    NodeStatus,
    SiteKind,
    pick,
)
from app.element_marks import ElementRow, build_elements
from app.identity import SourceRef, source_keys
from app.import_element import sanitize_elements
from app.models.deployment_instance import DeploymentInstance
from app.models.deployment_site import DeploymentSite
from app.models.edge import Edge
from app.models.node import Node
from app.name_match import HINT_CUTOFF, HINT_MAX_DIFF, tiny_diff
from app.node_ref import RefIndex
from app.text import loose_name

# Лимиты щедрые (реальный экспорт не упрётся) — защита от «бомбы» в textarea.
MAX_NODES = 2000
MAX_EDGES = 4000
MAX_DEPTH = 32
# Площадок в документе (объявленных и неявных вместе) — тот же «щедрый» предел.
MAX_SITES = 1000

_SHAPES = NODE_SHAPES
_STATUSES = NODE_STATUSES


@dataclass
class _ImpNode:
    name: str
    shape: NodeShape
    status: NodeStatus
    role: str | None
    technology: str | None
    is_external: bool
    description: str | None
    parent_idx: int | None  # индекс родителя в ParsedImport.nodes (родители раньше детей)
    # Канонические ключи источника (app/identity): чем узел опознаётся между
    # прогонами агента поверх имени. Пусто — якорей нет, тождество решает имя.
    source_keys: list[str] = field(default_factory=list)
    # Имена площадок, где узел стоит САМ (ключ sites), без повторов. Унаследованное
    # от контейнера сюда не входит: оно производное и восстанавливается само.
    sites: list[str] = field(default_factory=list)
    # Элемент архитектуры (ключ element). None — «не сказано»: у узла с детьми это
    # система, и слияние уступает такое значение любому заданному (Р30).
    element: NodeElement | None = None


@dataclass
class _ImpSite:
    """Площадка раздела deployment.sites (docs/tasks/deployment-view.md)."""

    name: str
    kind: SiteKind
    technology: str | None
    description: str | None
    parent_idx: int | None  # индекс родителя в ParsedImport.sites (родители раньше детей)
    # Объявлена разделом deployment, а не только названа в sites узла. Неявная площадка
    # (вид «другое», без технологии) — догадка разбора, и слияние уступает её поля
    # площадке, объявленной в другом файле.
    declared: bool = True


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
    # Тип канала (sync: true/false). None — поле не прислано, канал живёт на
    # дефолте «синхронный» (edge_is_synchronous); явное значение переносится
    # как есть — иначе асинхронный канал приезжал бы «синхронным» молча (Д2).
    is_synchronous: bool | None = None


@dataclass
class ParsedImport:
    nodes: list[_ImpNode]
    edges: list[_ImpEdge]
    roots: list[str]  # имена корневых узлов (для сводки в превью импорта)
    # Замечания РАЗБОРА, не мешающие ввозу (поля снятых видов якоря). Ошибки
    # отдаются вторым элементом кортежа parse_import и валят импорт; эти — нет,
    # их подхватывает parse_and_merge/единый импорт и кладёт в отчёт с адресацией
    # тому файлу, где они найдены.
    warnings: list[str] = field(default_factory=list)
    # Площадки развёртывания: родители раньше детей (order_sites). Пусто — документ
    # без раздела deployment и без sites у узлов, то есть прежний формат.
    sites: list[_ImpSite] = field(default_factory=list)
    # Родители узлов, КАК ИХ ЗАПИСАЛ ДОКУМЕНТ, — если разбор их поменял (база или брокер
    # вынесены из контейнера, app/import_element). Пусто — совпадают с parent_idx.
    # Нужны адресам «своего» входа: семьи фактов архива, привязки процессов и карта
    # догрузки написаны путями документа, а не путями поправленного дерева.
    doc_parents: list[int | None] = field(default_factory=list)


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
        doc = yaml_io.safe_load(content)
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


def _opt_str(raw: dict, key: str, path: str, max_len: int | None, errors: list[str]) -> str | None:
    """Опциональное строковое поле (None — отсутствует или кривое, ошибка — в errors)."""
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


# --- площадки развёртывания (раздел deployment) -------------------------------
# Площадку называют ИМЕНЕМ: имя уникально в проекте (DeploymentSite), путь не нужен.
# Ошибки — как у узлов: списком с путём до места, а не обрывом на первой.

_SITE_KINDS_TEXT = " | ".join(SITE_KINDS)


def _site_name(val: object) -> str | None:
    """Имя площадки без краевых пробелов (так его хранит ручка) или None, если это
    не непустая строка."""
    if not isinstance(val, str) or not val.strip():
        return None
    return val.strip()


@dataclass
class _SiteDraft:
    """Площадки документа до упорядочения: в порядке объявления, родитель — именем."""

    sites: list[_ImpSite] = field(default_factory=list)
    paths: list[str] = field(default_factory=list)
    parent_refs: list[str | None] = field(default_factory=list)
    index: dict[str, int] = field(default_factory=dict)

    def add(self, site: _ImpSite, path: str, parent: str | None) -> None:
        self.index[site.name] = len(self.sites)
        self.sites.append(site)
        self.paths.append(path)
        self.parent_refs.append(parent)


def _parse_site(raw: object, path: str, draft: _SiteDraft, errors: list[str]) -> None:
    """Одна площадка раздела → в draft (кривая — только ошибка)."""
    if not isinstance(raw, dict):
        errors.append(f"{path}: площадка должна быть словарём (mapping)")
        return
    name = _site_name(raw.get("name"))
    if name is None:
        errors.append(f"{path}: name — обязательная непустая строка")
        return
    if len(name) > 256:
        errors.append(f"{path}: name длиннее 256 символов")
        return
    if name in draft.index:
        errors.append(f"{path}: площадка «{name}» объявлена дважды")
        return
    raw_kind = raw.get("kind", "other")
    kind = pick(raw_kind, SITE_KINDS)
    if kind is None:
        errors.append(f"{path}: kind {raw_kind!r} не поддерживается ({_SITE_KINDS_TEXT})")
        kind = "other"
    raw_parent = raw.get("parent")
    parent = _site_name(raw_parent)
    if raw_parent is not None and parent is None:
        errors.append(f"{path}.parent: ожидается имя площадки строкой")
    site = _ImpSite(
        name=name,
        kind=kind,
        technology=_opt_str(raw, "technology", path, 128, errors),
        description=_opt_str(raw, "description", path, None, errors),
        parent_idx=None,
    )
    draft.add(site, path, parent)


def _parse_sites(doc: dict, errors: list[str]) -> _SiteDraft:
    """Раздел deployment.sites → площадки в порядке объявления. Родители — именем:
    сослаться можно и на площадку, объявленную ниже; разрешает их _site_parents."""
    draft = _SiteDraft()
    raw_dep = doc.get("deployment")
    if raw_dep is None:
        return draft
    if not isinstance(raw_dep, dict):
        errors.append("deployment: ожидается словарь с ключом sites")
        return draft
    raw_sites = raw_dep.get("sites") or []  # явный `sites:` без значения — None
    if not isinstance(raw_sites, list):
        errors.append("deployment.sites: ожидается список площадок")
        return draft
    if len(raw_sites) > MAX_SITES:
        errors.append(f"Слишком много площадок (больше {MAX_SITES})")
        return draft
    for i, raw in enumerate(raw_sites):
        _parse_site(raw, f"deployment.sites[{i}]", draft, errors)
    return draft


def _site_parents(draft: _SiteDraft, errors: list[str]) -> list[int | None]:
    """Родитель каждой площадки индексом в draft.sites; кривые ссылки и циклы — ошибки.

    Цикл ищется подъёмом от каждой площадки (с seen — подъём не зацикливается) и
    называется ОДИН раз, первой по порядку объявления площадкой цикла."""
    parents: list[int | None] = []
    for i, ref in enumerate(draft.parent_refs):
        p = None if ref is None else draft.index.get(ref)
        if ref is not None and p is None:
            errors.append(f"{draft.paths[i]}.parent: площадка «{ref}» не объявлена в deployment.sites")
        elif p == i:
            errors.append(f"{draft.paths[i]}.parent: площадка не может быть вложена сама в себя")
            p = None
        parents.append(p)
    in_cycle: set[int] = set()
    for i in range(len(parents)):
        if i in in_cycle:
            continue
        chain = [i]
        seen = {i}
        cur = parents[i]
        while cur is not None and cur not in seen:
            chain.append(cur)
            seen.add(cur)
            cur = parents[cur]
        if cur == i and len(chain) > 1:
            in_cycle.update(chain)
            names = " → ".join(f"«{draft.sites[k].name}»" for k in [*chain, i])
            errors.append(f"{draft.paths[i]}.parent: цикл вложенности площадок ({names})")
    return parents


def _site_refs(raw: dict, path: str, errors: list[str]) -> list[str]:
    """Ключ sites узла → имена площадок без повторов (повтор схлопывается молча)."""
    val = raw.get("sites")
    if val is None:
        return []
    if not isinstance(val, list):
        errors.append(f"{path}.sites: ожидается список имён площадок")
        return []
    out: list[str] = []
    for j, item in enumerate(val):
        name = _site_name(item)
        if name is None:
            errors.append(f"{path}.sites[{j}]: ожидается имя площадки строкой")
        elif len(name) > 256:
            errors.append(f"{path}.sites[{j}]: имя площадки длиннее 256 символов")
        elif name not in out:
            out.append(name)
    return out


def order_sites(sites: list[_ImpSite], parents: list[int | None]) -> list[_ImpSite]:
    """Площадки в порядке «родители раньше детей» с перенумерованными parent_idx.

    parents — родитель каждой площадки индексом во ВХОДНОМ списке. Порядок устойчивый:
    корни — в порядке входа, за каждой площадкой — её поддерево в порядке входа (так же
    пишет раздел экспорт). Член цикла (циклы отвергают раньше, это страховка) выходит
    корневым: обход не зацикливается и площадку не теряет."""
    kids: dict[int | None, list[int]] = defaultdict(list)
    for i, p in enumerate(parents):
        kids[p].append(i)
    new_idx: dict[int, int] = {}
    out: list[_ImpSite] = []

    def emit(start: int) -> None:
        stack: list[tuple[int, int | None]] = [(start, None)]
        while stack:
            i, parent_new = stack.pop()
            if i in new_idx:
                continue
            new_idx[i] = len(out)
            out.append(replace(sites[i], parent_idx=parent_new))
            stack.extend((k, new_idx[i]) for k in reversed(kids.get(i, [])))

    for root in kids.get(None, []):
        emit(root)
    for i in range(len(sites)):
        emit(i)
    return out


# --- did-you-mean к «узел не найден» -----------------------------------------
# Полевой промах агента (docs/qa-federation-matrix.md, находка 2): перечень
# компонентов в замечании превью предлагает «zabbix-ui / web-api», агент берёт
# ИМЯ компонента, но приклеивает его к ЧУЖОМУ контейнеру — пишет в связи
# «zabbix-server / web-api». Без подсказки слабая модель гадает заново; лишний
# круг случился дважды (изолированный Zabbix и федерация).
#
# Пороги и правило мелкого расхождения — общие с дозаливкой доков (app/name_match.py,
# Ф8ж), и ниже их не опускать: ложная подсказка ХУЖЕ её отсутствия — слабая модель
# копирует предложенное имя не глядя, и вместо битой ссылки получается ссылка, битая
# по-другому. У соседей по контейнеру общий длинный префикс, и difflib даёт им 0.75+
# на совершенно разных именах листа; у настоящих кандидатов расхождение мелкое.
# Разделители, которыми одно и то же имя пишут по-разному: «web-api» / «web_api».


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
       окончание, разделитель): порог HINT_CUTOFF И не больше HINT_MAX_DIFF
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
    norm = loose_name(path)
    if not norm:  # ссылка из одних разделителей — сравнивать нечем
        return None
    matcher = SequenceMatcher(None)
    matcher.set_seq2(norm)  # b индексируется один раз, меняем только a
    best: tuple[float, int] | None = None
    for i, full in enumerate(fulls):
        cand = loose_name(full)
        # Длина отсеивает даром: расхождение в HINT_MAX_DIFF символов невозможно
        # при большей разнице длин (документ бывает на MAX_NODES узлов).
        if abs(len(cand) - len(norm)) > HINT_MAX_DIFF or not resolvable(i):
            continue
        matcher.set_seq1(cand)
        if matcher.real_quick_ratio() < HINT_CUTOFF or matcher.quick_ratio() < HINT_CUTOFF:
            continue
        ratio = tiny_diff(matcher, cand, norm)
        if ratio is None:
            continue
        if best is None or ratio > best[0]:  # равенство оставляет первого по документу
            best = (ratio, i)
    return fulls[best[1]] if best is not None else None


# --- перечень кандидатов к «имя неоднозначно» ---------------------------------
# Сколько путей называем, прежде чем свернуть остаток в счётчик. Кап — как у
# соседних перечней слияния (_MAX_GROUP_NAMES, merge_warnings.py): замечания уезжают
# агенту одним списком, и полсотни одноимённых узлов вытеснили бы всё остальное.
# Хвост считаем, а не молчим о нём: агент должен знать, что выбор шире показанного.
_MAX_AMBIGUOUS_PATHS = 6


def parse_import(content: str, *, live: bool = False) -> tuple[ParsedImport | None, list[str]]:
    """Разбор + валидация YAML импорта. Возвращает (результат, ошибки): при любой
    ошибке результат None, список — все найденные проблемы (не первая попавшаяся).
    Неизвестные ключи игнорируются молча (форвард-совместимость формата).

    live=True — документ это снимок ЖИВОГО проекта (вход №0 догрузки): его объекты
    санитизация элемента не переносит, а живой контейнер с живой базой внутри не
    трогает (догрузка живое дерево не перестраивает и живое не судит).

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
    # Замечания разбора, не мешающие ввозу (см. ParsedImport.warnings).
    warnings: list[str] = []
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
        return _opt_str(raw, key, path, max_len, errors)

    # Площадки раздела deployment — до узлов: их sites ссылаются на имена отсюда.
    site_draft = _parse_sites(doc, errors)

    def parse_source(raw: dict, path: str) -> list[str]:
        """Блок source узла → канонические ключи (app/identity). Блок целиком
        опционален; кривой тип — ошибка, но узел от неё не пропадает (якоря
        необязательны, без них тождество решает имя). Неизвестные вложенные ключи
        игнорируются молча, как и на верхнем уровне формата.

        image/deployment — поля СНЯТЫХ видов якоря (образ и объект k8s, убраны
        2026-09-04, docs/plan-anchor-ux.md). Они не ошибка: пакеты, собранные
        прежним промптом, обязаны ввозиться. Но и не ключ — только предупреждение,
        одно на узел."""
        raw_src = raw.get("source")
        if raw_src is None:
            return []
        if not isinstance(raw_src, dict):
            errors.append(f"{path}.source: ожидается словарь (repo/path/host)")
            return []
        sp = f"{path}.source"
        if raw_src.get("image") is not None or raw_src.get("deployment") is not None:
            warnings.append(f"{sp}: образ и деплоймент больше не источник — поле проигнорировано")
        return source_keys(
            SourceRef(
                repo=opt_str(raw_src, "repo", sp, 512),
                path=opt_str(raw_src, "path", sp, 512),
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

        raw_shape = raw.get("shape", "service")
        shape = pick(raw_shape, _SHAPES)
        if shape is None:
            errors.append(f"{path}: shape {raw_shape!r} не поддерживается ({' | '.join(_SHAPES)})")
            shape = "service"
        # Элемент архитектуры: нет ключа (или null) — «не сказано»; чужое значение —
        # ошибка, как у shape. Допустимость по месту в дереве проверяется в конце
        # разбора (sanitize_elements): для неё нужно всё дерево.
        raw_element = raw.get("element")
        element: NodeElement | None = None
        if raw_element is not None:
            element = pick(raw_element, NODE_ELEMENTS)
            if element is None:
                errors.append(
                    f"{path}: element {raw_element!r} не поддерживается "
                    f"({' | '.join(NODE_ELEMENTS)})"
                )
        raw_status = raw.get("status", "existing")
        status = pick(raw_status, _STATUSES)
        if status is None:
            errors.append(f"{path}: status {raw_status!r} не поддерживается ({' | '.join(_STATUSES)})")
            status = "existing"
        ext = raw.get("external", False)
        if not isinstance(ext, bool):
            errors.append(f"{path}.external: ожидается true/false")
            ext = False
        node_sites = _site_refs(raw, path, errors)
        if node_sites and shape == "person":
            # Пользователь живёт вне системы — размещения у него не бывает (ручка
            # отвечает на это 422). Документ из-за этого не отвергаем.
            warnings.append(f"{path}.sites: у пользователя нет размещения — список проигнорирован")
            node_sites = []

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
                sites=node_sites,
                element=element,
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

    def exact(ref: str) -> list[int]:
        """Точный полный путь, иначе голое имя, иначе однозначный ХВОСТ пути."""
        hits = by_path.get(ref) or by_bare.get(ref) or []
        if not hits and " / " in ref:
            tail = f" / {ref}"
            hits = [i for i, full in enumerate(fulls) if full.endswith(tail)]
        return hits

    def slashed(ref: str) -> list[int]:
        """Слабые модели пишут путь слэшем без пробелов («worker/queue-reader»):
        нормализуем разделитель и повторяем точный путь + однозначный хвост.
        Тот же фолбэк давно живёт в резолвере дозаливки доков; здесь он стал
        нужен, когда промпт начал требовать адресовать связи компонентов.
        Фолбэк ПОСЛЕДНИЙ — настоящие имена со слэшем матчатся раньше."""
        if "/" not in ref:
            return []
        norm = " / ".join(part.strip() for part in ref.split("/") if part.strip())
        hits = by_path.get(norm) or []
        if not hits:
            tail = f" / {norm}"
            hits = [i for i, full in enumerate(fulls) if full.endswith(tail)]
        return hits

    # Карта для ссылок с уточнителями (app/node_ref.py) — строится один раз и лениво:
    # без тёзок она не нужна вовсе.
    ref_index: list[RefIndex] = []

    def index() -> RefIndex:
        if not ref_index:
            ref_index.append(RefIndex(
                [n.name for n in nodes], [n.parent_idx for n in nodes],
                [n.source_keys for n in nodes],
            ))
        return ref_index[0]

    def ready_refs(hits: list[int]) -> list[str] | None:
        """Готовые ссылки на кандидатов, каждая из которых резолвится ровно в своего:
        уникальный путь — как есть, путь тёзок и их потомков — с якорным уточнителем
        на сегменте тёзки (app/node_ref.py). Хоть одного кандидата так не назвать
        (тёзка без якоря, одинаковые якоря) — None: порядковый номер агентам не
        объявляется, а неполный перечень толкнул бы агента к чужому узлу."""
        ready = index().addresses(anchors_only=True)
        out: set[str] = set()
        for i in hits:
            ref = ready[i]
            if ref is None:
                return None
            out.add(ref)
        return sorted(out)

    def resolve(ref: str, path: str) -> int | None:
        """Ссылка из edges → индекс узла: точный полный путь, иначе голое имя
        (если уникально), иначе однозначный ХВОСТ пути («backend / api» находит
        «Система / backend / api»). Тексты ошибок — как в ТЗ витрины импорта;
        к «не найден» добавляется did-you-mean, когда кандидат уверенный
        (_closest_node), — без него слабая модель гадает имя заново.

        Уточнители тёзок («Ярмарка / Каталог-БД @ git:… / reader», «Ярмарка / api
        @ #2», пишет экспорт): только когда точного пути нет, и ДО слэш-фолбэка — в
        ключе законны слэши, и нормализация пути разрезала бы его. Путь проходится
        посегментно (RefIndex): полный от корня, иначе голое имя или хвост пути;
        якорь фильтрует тёзок, «#N» берёт N-го по порядку документа."""
        hits = exact(ref)
        if not hits:
            if " @ " in ref:
                hits = index().resolve(ref) or []
            if not hits:
                hits = slashed(ref)
        if not hits:
            if ref not in hints:
                hints[ref] = _closest_node(ref, fulls, by_bare, by_path)
            hint = hints[ref]
            # Уверенного кандидата нет — текст остаётся БАЙТ-В-БАЙТ прежним.
            suffix = f' — есть "{hint}"' if hint is not None else ""
            errors.append(f'{path}: узел "{ref}" не найден{suffix}')
            return None
        if len(hits) > 1:
            # Кандидаты уже в руках — их же считали, чтобы обнаружить неоднозначность.
            # Перечисляем, как в потоке каналов (channels_import.py): агент видит,
            # МЕЖДУ ЧЕМ выбирать, и чинит ссылку копированием готового пути, а не
            # вторым кругом переписки. Формулировка утвердительная («укажите один из
            # них»): текст, предлагающий выбрать СПОСОБ записи, уже давал слабой модели
            # колебательный контур. Порядок — по алфавиту, а не по документу:
            # перестановка узлов во входном YAML не должна шевелить текст замечания.
            # Законные тёзки (путь один на двоих) называются путём с уточнителем-
            # якорем; без тёзок перечень — прежние пути байт-в-байт.
            cands = ready_refs(hits) or sorted({fulls[i] for i in hits})
            if len(cands) > 1:
                shown = ", ".join(f'"{c}"' for c in cands[:_MAX_AMBIGUOUS_PATHS])
                extra = len(cands) - _MAX_AMBIGUOUS_PATHS
                tail = f" и ещё {extra}" if extra > 0 else ""
                errors.append(
                    f'{path}: имя "{ref}" неоднозначно (есть {shown}{tail})'
                    " — укажите один из них"
                )
            else:
                # Узел-близнец повторён в документе: пути совпадают, называть нечего —
                # такой перечень вёл бы обратно в «неоднозначно», а это хуже молчания
                # (порог Ф8ж). Текст остаётся прежним байт-в-байт.
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
        sync = raw_e.get("sync")
        if sync is not None and not isinstance(sync, bool):
            errors.append(f"{path}.sync: ожидается true/false")
            sync = None
        edges.append(
            _ImpEdge(
                source_idx=src_idx,
                target_idx=dst_idx,
                label=opt_str(raw_e, "label", path, 256),
                technology=opt_str(raw_e, "technology", path, 128),
                channel=opt_str(raw_e, "channel", path, 256),
                is_synchronous=sync,
            )
        )

    # Площадка, названная в sites узла, но не объявленная разделом, создаётся неявно:
    # вывод агента ввозится, как и с прочими мелкими промахами, — с замечанием.
    for imp in nodes:
        for name in imp.sites:
            if name not in site_draft.index:
                implicit = _ImpSite(name=name, kind="other", technology=None, description=None,
                                    parent_idx=None, declared=False)
                site_draft.add(implicit, "", None)
                warnings.append(
                    f"площадка «{name}» не объявлена в deployment — создана с видом «другое»"
                )
    if len(site_draft.sites) > MAX_SITES:
        errors.append(f"Слишком много площадок (больше {MAX_SITES})")
    site_parents = _site_parents(site_draft, errors)

    if errors:
        return None, errors
    # Элемент архитектуры — по всему дереву: у не-сервиса и у компонентов значение
    # снимается, база и брокер выносятся из контейнера на уровень выше — с замечанием
    # (пути — те же «Корень / … / Имя», что у замечаний слияния о том же узле). Связи
    # уже разрешены по путям документа (fulls, by_path, RefIndex), перенос их не задевает.
    doc_parents = [n.parent_idx for n in nodes]
    warnings.extend(
        sanitize_elements(
            nodes, fulls,
            pinned=(lambda _i: True) if live else None,
            live_element=(lambda _i: True) if live else None,
        )
    )
    moved = any(n.parent_idx != p for n, p in zip(nodes, doc_parents, strict=True))
    roots = [n.name for n in nodes if n.parent_idx is None]
    return ParsedImport(
        nodes=nodes,
        edges=edges,
        roots=roots,
        warnings=warnings,
        sites=order_sites(site_draft.sites, site_parents),
        doc_parents=doc_parents if moved else [],
    ), []


def seed_import(db: Session, project_id: uuid.UUID, parsed: ParsedImport) -> list[uuid.UUID]:
    """Записать разобранный импорт в проект: узлы (родители раньше детей — порядок
    списка это гарантирует по построению walk), flush, затем связи. Строк
    view_layout не создаём (координат в формате нет). Площадки (родители раньше
    детей — порядок parsed.sites) и экземпляры узлов — после связей; «Пользователь»
    не размещается никогда, даже если слияние сделало его таким. Коммит на вызывающей
    стороне (как у сидера демо-пакета, app/demo_package.py).

    Возвращает id созданных узлов В ПОРЯДКЕ parsed.nodes: единый импорт (Ф2а,
    docs/plan-unified-import.md) вешает семьи фактов на узлы по ИНДЕКСУ плана, а
    не по пути — пути неоднозначны (якорь source_ref разводит тёзок в одном
    родителе). Прежним вызывающим возврат не мешает: они его игнорируют."""
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
                element=n.element,
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
                is_synchronous=e.is_synchronous,
            )
        )
    seed_placements(db, project_id, parsed, ids)
    return ids


def seed_placements(
    db: Session, project_id: uuid.UUID, parsed: ParsedImport, ids: list[uuid.UUID]
) -> None:
    """Площадки и экземпляры разобранного импорта в НОВЫЙ проект: ids — узлы в порядке
    parsed.nodes (возврат seed_import). Размещение достаётся единицам — контейнерам (в
    том числе листьям): своё объявление — себе, объявление системы — её контейнерам без
    своего (app/deployment.unit_placements). Элементы — по разобранным узлам: проект
    новый, дерево целиком в документе. Догрузка в живой проект — своим путём
    (unified_into): там площадки сперва ищутся по имени среди живых."""
    if not parsed.sites:
        return
    site_ids: list[uuid.UUID] = []
    by_name: dict[str, uuid.UUID] = {}
    for s in parsed.sites:
        sid = uuid.uuid4()
        site_ids.append(sid)
        by_name[s.name] = sid
        db.add(
            DeploymentSite(
                id=sid,
                project_id=project_id,
                name=s.name,
                kind=s.kind,
                technology=s.technology,
                description=s.description,
                parent_id=None if s.parent_idx is None else site_ids[s.parent_idx],
            )
        )
    db.flush()
    parent_of = {
        node_id: (ids[n.parent_idx] if n.parent_idx is not None else None)
        for n, node_id in zip(parsed.nodes, ids, strict=True)
    }
    elements = build_elements(
        ElementRow(node_id, parent_of[node_id], n.shape, n.element, n.name)
        for n, node_id in zip(parsed.nodes, ids, strict=True)
    )
    declared: dict[uuid.UUID, list[uuid.UUID]] = {}
    for n, node_id in zip(parsed.nodes, ids, strict=True):
        site_ids_of = [by_name[name] for name in n.sites if name in by_name]
        if site_ids_of and n.shape != "person":
            declared[node_id] = site_ids_of
    for node_id, placed in unit_placements(parent_of, declared, elements).items():
        for site_id in placed:
            db.add(DeploymentInstance(project_id=project_id, node_id=node_id, site_id=site_id))
