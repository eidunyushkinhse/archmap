"""Применение единого плана ввоза: план + выбор пользователя → НОВЫЙ проект (Ф2а).

Ф1 построила план (build_unified_plan): слитый C4, вклады семей фактов на узлах
СЛИТОГО дерева и споры о телах с кандидатами. Здесь план становится проектом.

Порядок применения — строго по зависимостям, как у одноархивного импорта:
C4 (узлы и связи) → схемы логики → семьи фактов → спеки → процессы. Процессы
последними не случайно: их шаги привязываются к УЖЕ СОЗДАННЫМ схемам логики.

ТРИ РЕШЕНИЯ, определяющие модуль::

  1. Узел вклада ищется ПО ИНДЕКСУ плана, а не по пути: seed_import отдаёт id
     узлов в порядке parsed.nodes, и карта «индекс → Node» точна даже там, где
     пути неоднозначны (якорь source_ref законно разводит тёзок в одном родителе).
  2. Таблицы, каналы и параметры пишутся РОДНЫМИ приёмниками (build_*_plan /
     apply_*_plan), а не моделями напрямую: у них доменная логика, дублировать
     которую нельзя (гейт «каналы только у брокера», резолюция ссылок
     «таблица.колонка» → references_column_id, did-you-mean в замечаниях).
     Значит вклады-победители надо СОБРАТЬ ОБРАТНО в файлы ввозного формата —
     круговой прогон «вклад → yaml → parse_*_file → вклад» обязан быть точным.
  3. Привязки шагов процессов ПЕРЕПИСЫВАЮТСЯ. Адрес «%% archmap-doc: путь / имя»
     в тексте процесса входа K написан в системе координат АРХИВА K: и путь узла
     (слияние переклеивает и переименовывает), и имя схемы (тёзке при выборе
     «взять все» достаётся суффикс) в новом проекте другие. Схема, ПРОИГРАВШАЯ
     спор, не переписывается вовсе — её тела в проекте нет, и шаг честно остаётся
     без привязки (видимая деградация, как везде).
"""

import json
import re
import uuid
from collections.abc import Callable
from dataclasses import dataclass, field

from sqlalchemy.orm import Session

from app.access import add_owner
from app.channels_import import (
    ChannelIn,
    apply_channels_plan,
    build_channels_plan,
    seed_edge_channel_stubs,
)
from app.config_import import ParamIn, apply_config_plan, build_config_plan
from app.data_import import TableIn, apply_data_plan, build_data_plan
from app.import_yaml import ParsedImport, _ImpEdge, seed_import
from app.models.edge import Edge
from app.models.node import Node
from app.models.node_doc import NodeDoc
from app.models.project import Project
from app.node_ref import node_addresses

# Приватное из соседей — осознанно: регулярка привязки и норма адреса должны быть
# ОДНИМИ И ТЕМИ ЖЕ, что у разбора процессов, иначе переписанный адрес не совпадёт
# с тем, который импорт потом ищет. Тот же приём, что у unified_import с _read_zip.
from app.process_import import _DOC_RE, _NODE_RE, _norm_address
from app.process_import import apply_import as apply_process_import
from app.process_import import build_preview as build_process_preview
from app.schemas.archive import ArchiveImportResult
from app.schemas.channels_import import ChannelsImportReport
from app.schemas.config_import import ConfigImportReport
from app.schemas.data_import import DataImportReport
from app.unified_import import (
    SEP,
    DocIn,
    Family,
    FamilyValue,
    UnifiedImportError,
    UnifiedPlan,
    _channel_doc,
    _param_doc,
    _table_doc,
    _yaml,
    apply_unfixable,
    remainder_from_plan,
    remainder_with_index,
)

# Превью, по которому пользователь отвечал, устарело: план считается заново по тем
# же файлам, и если ответ не находит своего вопроса — применять «похожее» нельзя.
STALE = "Превью устарело — обновите его и повторите"


@dataclass
class _Winner:
    """Вклад, который поедет в проект: бесспорный либо выбранный резолюцией."""

    family: Family
    node_idx: int
    key: str
    origin: int
    fname: str
    value: FamilyValue
    # Пришёл из спора. Для схем логики это значит «имя может получить суффикс», а
    # адрес привязки переписывается только своему входу (у проигравшего тела нет).
    from_conflict: bool


# ── Решения пользователя по остатку слияния (Ф-E) ───────────────────────────
#
# Ответы на вопросы превью приезжают JSON-полем формы decisions и правят СЛИТОЕ
# ДЕРЕВО до записи в БД (склейки — сразу после неё: поглощённый узел уже создан, и
# семьи фактов адресованы индексами плана). Ни один ответ не обязателен: пустые
# decisions дают ровно тот же проект, что и раньше.


@dataclass
class NewEdgeIn:
    """Связь, которую дорисовал человек (ответ на вопрос об изолированной группе).
    ArchMap кандидатов не предлагает — концы, подпись и канал называет он сам."""

    group_id: str
    from_path: str
    to_path: str
    label: str | None = None
    technology: str | None = None
    channel: str | None = None  # «sync» | «async» | None (дефолт движка)


@dataclass
class Decisions:
    """Разобранное поле decisions. Отказы («оставить как есть», «разные объекты»)
    здесь не хранятся: они и есть дефолт, применять по ним нечего."""

    fields: dict[str, int] = field(default_factory=dict)  # id спора → индекс кандидата
    edges: dict[str, str] = field(default_factory=dict)  # id связи → путь компонента
    new_edges: list[NewEdgeIn] = field(default_factory=list)
    merges: dict[str, str] = field(default_factory=dict)  # id пары → имя склеенного

    def empty(self) -> bool:
        return not (self.fields or self.edges or self.new_edges or self.merges)


_SECTIONS = ("fields", "edges", "new_edges", "merges")


def _text(value: object, что: str) -> str | None:
    if value is None:
        return None
    if not isinstance(value, str):
        raise UnifiedImportError(f"Поле decisions: {что} должно быть строкой")
    return value.strip() or None


def parse_decisions(raw: str | None) -> Decisions:
    """Решения пользователя по остатку: JSON-объект в поле формы (multipart несёт
    файлы, поэтому словарь едет текстом).

    Разбор и валидация ФОРМЫ здесь, одинаково для создания и догрузки: кривое поле
    это 400 с человеческим текстом, а не 500 внутри применения. Сверка с ПЛАНОМ —
    отдельно (resolve_decisions): для неё нужен сам план."""
    try:
        data = json.loads(raw) if raw else {}
    except json.JSONDecodeError as e:
        raise UnifiedImportError("Поле decisions не разбирается как JSON") from e
    if not isinstance(data, dict):
        raise UnifiedImportError(
            "Поле decisions должно быть объектом с разделами "
            + ", ".join(_SECTIONS)
        )
    неизвестные = [k for k in data if k not in _SECTIONS]
    if неизвестные:
        raise UnifiedImportError(
            f"Поле decisions: неизвестный раздел «{неизвестные[0]}»"
        )
    out = Decisions()

    for cid, choice in (data.get("fields") or {}).items():
        # bool — подкласс int: «true» вместо номера кандидата это опечатка клиента.
        if not isinstance(choice, int) or isinstance(choice, bool) or choice < 0:
            raise UnifiedImportError(
                f"Поле decisions: выбор значения «{cid}» должен быть номером кандидата"
            )
        out.fields[str(cid)] = choice

    for eid, choice in (data.get("edges") or {}).items():
        if choice == "keep":
            continue  # «оставить на контейнере» — это и есть сегодняшнее поведение
        if not isinstance(choice, dict) or not _text(choice.get("to_path"), "to_path"):
            raise UnifiedImportError(
                f"Поле decisions: ответ о связи «{eid}» — «keep» либо объект с to_path"
            )
        out.edges[str(eid)] = str(choice["to_path"]).strip()

    for item in data.get("new_edges") or []:
        if not isinstance(item, dict):
            raise UnifiedImportError("Поле decisions: new_edges — список объектов")
        начало, конец = _text(item.get("from_path"), "from_path"), _text(item.get("to_path"), "to_path")
        if not начало or not конец:
            raise UnifiedImportError(
                "Поле decisions: у новой связи должны быть начало и конец"
            )
        канал = _text(item.get("channel"), "channel")
        if канал is not None and канал not in ("sync", "async"):
            raise UnifiedImportError(
                "Поле decisions: тип канала новой связи — «sync» либо «async»"
            )
        out.new_edges.append(NewEdgeIn(
            group_id=_text(item.get("group_id"), "group_id") or "",
            from_path=начало,
            to_path=конец,
            label=_text(item.get("label"), "label"),
            technology=_text(item.get("tech"), "tech") or _text(item.get("technology"), "technology"),
            channel=канал,
        ))

    for pid, choice in (data.get("merges") or {}).items():
        if choice == "diff":
            continue  # «разные объекты» — тоже сегодняшнее поведение
        имя = _text(choice.get("name"), "name") if isinstance(choice, dict) else None
        if имя is None:
            raise UnifiedImportError(
                f"Поле decisions: ответ о паре «{pid}» — «diff» либо объект с name"
            )
        out.merges[str(pid)] = имя
    return out


@dataclass
class ResolvedDecisions:
    """Решения, переведённые в ИНДЕКСЫ слитого дерева. Сверка с планом сделана —
    дальше только запись."""

    fields: list[tuple[int, str, str]] = field(default_factory=list)  # узел, поле, значение
    edges: list[tuple[int, str, int]] = field(default_factory=list)  # связь, конец, компонент
    # начало, конец, подпись, технология, синхронность
    new_edges: list[tuple[int, int, str | None, str | None, bool | None]] = field(
        default_factory=list
    )
    merges: list[tuple[int, int, str]] = field(default_factory=list)  # A, B, имя склеенного

    def empty(self) -> bool:
        return not (self.fields or self.edges or self.new_edges or self.merges)


def resolve_decisions(
    plan: UnifiedPlan, decisions: Decisions | None, current: int | None = None
) -> ResolvedDecisions:
    """Сверить решения с планом и перевести их в индексы. ДО любой записи.

    Ответ, не нашедший своего вопроса (или путь не из плана), — отказ, а не тихий
    пропуск: молча применить «не то» пользователь обнаружит уже в проекте."""
    out = ResolvedDecisions()
    if decisions is None or decisions.empty():
        return out
    _, index = remainder_with_index(plan, current)

    for cid, choice in decisions.fields.items():
        адрес = index.fields.get(cid)
        if адрес is None or choice >= len(адрес[2]):
            raise UnifiedImportError(STALE)
        node_idx, fld, values = адрес
        out.fields.append((node_idx, fld, values[choice]))

    for eid, path in decisions.edges.items():
        связь = index.edges.get(eid)
        if связь is None or path not in связь[2]:
            raise UnifiedImportError(STALE)
        edge_idx, end, components = связь
        out.edges.append((edge_idx, end, components[path]))

    for новая in decisions.new_edges:
        if новая.group_id and новая.group_id not in index.groups:
            raise UnifiedImportError(STALE)
        начало, конец = index.nodes.get(новая.from_path), index.nodes.get(новая.to_path)
        if начало is None or конец is None:
            raise UnifiedImportError(STALE)
        if начало == конец:
            raise UnifiedImportError("Начало и конец новой связи — один и тот же объект")
        out.new_edges.append((
            начало, конец, новая.label, новая.technology,
            None if новая.channel is None else новая.channel == "sync",
        ))

    for pid, имя in decisions.merges.items():
        пара = index.pairs.get(pid)
        if пара is None:
            raise UnifiedImportError(STALE)
        out.merges.append((пара[0], пара[1], имя))
    return out


def merge_chain(
    pairs: list[tuple[int, int, str]], live: Callable[[int], bool] | None = None
) -> list[tuple[int, int, str]]:
    """Пары склеек → (выживший, поглощённый, имя) в порядке применения.

    Разыменование до неподвижной точки: если обе стороны пары уже участвовали в
    другой склейке, склеиваем их НЫНЕШНИХ выживших, а не исчезнувшие узлы.
    Выживает живой узел (Р4 догрузки), иначе первый по порядку файлов — то есть с
    меньшим индексом слитого дерева (мердж создаёт узлы в порядке входов)."""
    alias: dict[int, int] = {}

    def deref(i: int) -> int:
        while i in alias:
            i = alias[i]
        return i

    out: list[tuple[int, int, str]] = []
    for a, b, имя in pairs:
        x, y = deref(a), deref(b)
        if x == y:
            continue  # уже один объект — второй раз клеить нечего
        if live is not None and live(y) and not live(x):
            x, y = y, x
        elif not (live is not None and live(x) and not live(y)):
            x, y = min(x, y), max(x, y)
        alias[y] = x
        out.append((x, y, имя))
    return out


def apply_tree_decisions(merged: ParsedImport, res: ResolvedDecisions) -> int:
    """Правки СЛИТОГО ДЕРЕВА до записи в БД: значения полей, перевешенные концы,
    дорисованные связи. Возвращает число выброшенных дублей.

    Дубль возникает от перевеса: связь в контейнер, уточнённая до компонента, может
    совпасть с уже существующей связью к тому же компоненту. Ключ дубля — тот же,
    что у мерджа (пара концов, подпись, технология), поэтому «выброшено» здесь
    значит ровно то же, что и в его отчёте."""
    for node_idx, fld, value in res.fields:
        setattr(merged.nodes[node_idx], fld, value)
    for edge_idx, end, comp_idx in res.edges:
        e = merged.edges[edge_idx]
        if end == "source":
            e.source_idx = comp_idx
        else:
            e.target_idx = comp_idx
    тронутые = {edge_idx for edge_idx, _end, _comp in res.edges}
    for начало, конец, label, tech, sync in res.new_edges:
        тронутые.add(len(merged.edges))
        merged.edges.append(_ImpEdge(начало, конец, label, tech, None, sync))
    if not тронутые:
        return 0

    def подпись(e: _ImpEdge) -> tuple[int, int, str, str]:
        return (e.source_idx, e.target_idx, e.label or "", e.technology or "")

    # Выбрасываем ТОЛЬКО тронутые решением связи: чего не касались, того и не
    # трогаем (два одинаковых ребра в одном документе — дело его автора).
    seen = {подпись(e) for i, e in enumerate(merged.edges) if i not in тронутые}
    kept: list[_ImpEdge] = []
    for i, e in enumerate(merged.edges):
        if i in тронутые:
            if подпись(e) in seen:
                continue
            seen.add(подпись(e))
        kept.append(e)
    dropped = len(merged.edges) - len(kept)
    merged.edges[:] = kept
    return dropped


def decisions_note(res: ResolvedDecisions, merges_done: int) -> str | None:
    """Строка отчёта о применённых решениях — ОДНА, и только если что-то решено.

    Нулевые части опускаем: «склеено объектов 0» это не отчёт, а шум."""
    части = [
        (len(res.edges), "перевешено связей"),
        (len(res.new_edges), "добавлено связей"),
        (merges_done, "склеено объектов"),
        (len(res.fields), "выбрано значений полей"),
    ]
    названо = [f"{слово} {n}" for n, слово in части if n]
    return "Ваши решения: " + " · ".join(названо) if названо else None


# ── Резолюции ────────────────────────────────────────────────────────────────


def _choice_index(conflict_id: str, choice: str, total: int, allow_all: bool) -> int | None:
    """Разбор выбора: None — «взять все». Кривой выбор — 400, а не тихий дефолт:
    молча применённое «не то» пользователь обнаружит уже в проекте."""
    if choice == "all":
        if not allow_all:
            raise UnifiedImportError(
                f"Спор «{conflict_id}»: «взять все» тут не применимо — "
                "значение может быть только одно"
            )
        return None
    idx_text = choice[len("cand:"):] if choice.startswith("cand:") else ""
    if not idx_text.isdigit():
        raise UnifiedImportError(f"Спор «{conflict_id}»: непонятный выбор «{choice}»")
    idx = int(idx_text)
    if idx >= total:
        raise UnifiedImportError(
            f"Спор «{conflict_id}»: выбран вариант {idx}, а их всего {total}"
        )
    return idx


def _winners(plan: UnifiedPlan, resolutions: dict[str, str]) -> list[_Winner]:
    """Победители всех споров + бесспорные вклады. Валидация — ДО любой записи.

    Порядок: сначала бесспорные, потом спорные. Он значим для схем логики: имя
    бесспорной схемы неприкосновенно, а суффикс « (2)» ищет первое свободное — так
    спорная тёзка не отберёт имя у соседки."""
    by_id = {c.id: c for c in plan.conflicts}
    for cid, choice in resolutions.items():
        conflict = by_id.get(cid)
        if conflict is None:
            raise UnifiedImportError(
                f"Резолюция к несуществующему спору «{cid}» — превью устарело, "
                "пересоберите его"
            )
        _choice_index(cid, choice, len(conflict.candidates), conflict.allow_all)

    out = [
        _Winner(family=i.family, node_idx=i.node_idx, key=i.key, origin=i.origin,
                fname=i.fname, value=i.value, from_conflict=False)
        for i in plan.items
    ]
    for c in plan.conflicts:
        idx = _choice_index(
            c.id, resolutions.get(c.id, c.default), len(c.candidates), c.allow_all
        )
        chosen = c.candidates if idx is None else [c.candidates[idx]]
        out.extend(
            _Winner(family=c.family, node_idx=c.node_idx, key=c.key, origin=k.origin,
                    fname=k.fname, value=k.value, from_conflict=True)
            for k in chosen
        )
    return out


# ── Имена и адреса ───────────────────────────────────────────────────────────


def _free_name(base: str, taken: set[str]) -> str:
    """Первое свободное имя вида «Имя», «Имя (2)», «Имя (3)»… — имя схемы уникально
    в пределах узла (uq_node_doc_name), и тёзок надо развести до записи, а не ловить
    500-кой на flush."""
    if base not in taken:
        return base
    n = 2
    while f"{base} ({n})" in taken:
        n += 1
    return f"{base} ({n})"


def _rewrite_doc_addresses(text: str, addresses: dict[str, str]) -> str:
    """Переписать адреса привязок шагов; остальной текст — байт-в-байт.

    Трогаем ТОЛЬКО строки «%% archmap-doc: …» (регистронезависимо, как разбор):
    процесс — авторский документ пользователя, и любое другое изменение его текста
    было бы самоуправством."""
    return _rewrite_lines(text, _DOC_RE, "archmap-doc", addresses)


def _rewrite_node_addresses(text: str, addresses: dict[str, str]) -> str:
    """Переписать адреса узлов участников («%% archmap-node: …», их архив пишет
    участникам с неуникальным именем) из координат архива в координаты проекта."""
    return _rewrite_lines(text, _NODE_RE, "archmap-node", addresses)


def _rewrite_lines(
    text: str, pattern: re.Pattern[str], directive: str, addresses: dict[str, str]
) -> str:
    if not addresses:
        return text
    out: list[str] = []
    for line in text.splitlines(keepends=True):
        m = pattern.match(line.strip())
        new = addresses.get(_norm_address(m.group(1))) if m else None
        if new is None:
            out.append(line)
            continue
        body = line.rstrip("\r\n")
        eol = line[len(body):]
        indent = body[: len(body) - len(body.lstrip())]
        out.append(f"{indent}%% {directive}: {new}{eol}")
    return "".join(out)


# ── Применение ───────────────────────────────────────────────────────────────


def apply_unified_plan(
    db: Session,
    plan: UnifiedPlan,
    resolutions: dict[str, str],
    name: str | None,
    description: str | None,
    user_id: uuid.UUID,
    decisions: Decisions | None = None,
) -> tuple[Project, ArchiveImportResult]:
    """Создать проект по плану с учётом выбора пользователя. Коммит — на вызывающей
    стороне (норма всех приёмников: транзакцией владеет роут).

    resolutions — выбор тела в спорах семей, decisions — ответы на вопросы остатка
    слияния (Ф-E). Ни то, ни другое не обязательно: без них получается ровно тот
    же проект, что и раньше.

    UnifiedImportError — применение невозможно целиком (план непригоден, резолюция
    не из плана, нет имени): проект не создаётся. Частичные промахи (адрес семьи не
    разрешился, канал не у брокера) едут замечаниями в отчёте, как у всех приёмников.
    """
    merged = plan.merged
    if not plan.ok or merged is None:
        raise UnifiedImportError(
            "План непригоден к применению: " + ("; ".join(plan.errors[:5]) or "неизвестно почему")
        )
    # Свёртка отчёта (Ф2г-2) — тот же остаток, что был в превью, и ДО правок дерева
    # решениями (перевес меняет пути — столкнувшийся id выпустил бы закрытую строку).
    # Плановые тёзки процессов (id «plan|…») не берём: фактическое имя тёзки назовёт
    # строка применения «приехал под именем …».
    unfixable = [
        u for u in remainder_from_plan(plan, None).unfixable if not u.id.startswith("plan|")
    ]
    winners = _winners(plan, resolutions)
    # Сверка решений с планом — ДО любой записи, как и у резолюций.
    решения = resolve_decisions(plan, decisions, None)
    # Поля, концы связей и дорисованные связи правим В ДЕРЕВЕ: оно ещё не в БД
    # (совпавшие после перевеса дубли оно же и выбрасывает). Склейки — после
    # посева: узлы уже созданы, а семьи адресованы индексами плана.
    apply_tree_decisions(merged, решения)

    # ── Имя и описание: поля пользователя либо манифест единственного архива (П3).
    project_name = (name or "").strip()
    if not project_name:
        if plan.name_source != "manifest":
            raise UnifiedImportError("Не задано имя проекта")
        project_name = (plan.manifest_name or "").strip() or "Из архива"
    project_description = (description or "").strip() or None
    if project_description is None and plan.name_source == "manifest":
        project_description = plan.manifest_description

    project = Project(
        id=uuid.uuid4(),
        name=project_name,
        description=project_description,
        created_by_id=user_id,
        updated_by_id=user_id,
    )
    db.add(project)
    db.flush()
    # Создатель нового проекта — его владелец (docs/tasks/project-access.md).
    add_owner(db, project.id, user_id)

    # ── C4. Карта «индекс плана → узел» — ТОЛЬКО по возврату seed_import: пути
    #    неоднозначны (тёзки в одном родителе), а индекс точен всегда.
    ids = seed_import(db, project.id, merged)
    db.flush()
    nodes = db.query(Node).filter(Node.project_id == project.id).all()
    by_id = {n.id: n for n in nodes}
    node_of = [by_id[i] for i in ids]  # индекс плана → узел проекта
    # Адреса узлов плана в проекте — для файлов семей родных приёмников и привязок
    # процессов: у тёзок путь один на двоих, и адрес несёт уточнитель на сегменте
    # тёзки (app/node_ref.py).
    addr_of = _addresses_of(nodes, node_of)

    warnings: list[str] = list(plan.warnings)
    for i, remarks in enumerate(plan.input_remarks):
        label = plan.labels[i] if i < len(plan.labels) else f"вход {i + 1}"
        warnings.extend(f"{label}: {r}" for r in remarks)
    # Отсюда начинаются строки самого применения — они и пойдут в свёртку отчёта
    # (плановые уже в ней: остаток и замечания входов — пунктами выше).
    плановые = len(warnings)

    # ── Склейки по ответу пользователя: поглощённый узел отдаёт выжившему связи,
    #    детей и знание (node_of[поглощённый] = выживший) и исчезает. Пути после
    #    этого другие — ими адресуются семьи и привязки шагов, поэтому пересчёт.
    склеено, перевешены = _apply_merges(db, project, решения, node_of)
    склеены_дубли = 0
    if склеено:
        склеены_дубли = dedup_edges(db, project.id, перевешены)
        nodes = db.query(Node).filter(Node.project_id == project.id).all()
        addr_of = _addresses_of(nodes, node_of)

    # ── Схемы логики: напрямую, тело БЕЗ шапки (заглушка остаётся заглушкой, Д4).
    docs_created = 0
    taken: dict[uuid.UUID, set[str]] = {}
    # (вход, узел, исходное имя) → фактическое имя. Карта переименований нужна
    # процессам: их привязки написаны исходными именами своего архива.
    renamed: dict[tuple[int, int, str], str] = {}
    # (узел, исходное имя) → фактическое, для БЕССПОРНЫХ схем: такую схему могли
    # прислать несколько входов с одинаковым телом (дедуп молча), и адрес любого из
    # них ведёт к ней же.
    shared: dict[tuple[int, str], str] = {}
    for w in winners:
        if not isinstance(w.value, DocIn):
            continue
        node = node_of[w.node_idx]
        names = taken.setdefault(node.id, set())
        actual = _free_name(w.value.name, names)
        names.add(actual)
        db.add(NodeDoc(
            node_id=node.id,
            name=actual,
            kind=w.value.kind,
            operation=w.value.operation,
            content=w.value.body,
        ))
        docs_created += 1
        renamed[(w.origin, w.node_idx, w.value.name)] = actual
        if not w.from_conflict:
            shared[(w.node_idx, w.value.name)] = actual
    db.flush()

    # ── Семьи фактов: синтетические файлы ввозного формата → родные приёмники.
    def run_family(family: Family, build, apply):
        files = _synthetic_files(family, winners, addr_of)
        if not files:
            return None
        family_plan = build(db, nodes, files, None, False)
        apply(db, family_plan, False)
        return family_plan.report

    db_report: DataImportReport | None = run_family("table", build_data_plan, apply_data_plan)
    channels_report: ChannelsImportReport | None = run_family(
        "channel", build_channels_plan, apply_channels_plan
    )
    # Каналы, названные связями, но не описанные пакетом, — заглушками: схема знает,
    # что канал у брокера ЕСТЬ, и без записи панель алертов после ввоза врала бы.
    channel_stubs = seed_edge_channel_stubs(db, project.id)
    config_report: ConfigImportReport | None = run_family(
        "config", build_config_plan, apply_config_plan
    )

    # ── Спеки: одна на узел (Node.openapi_spec), текст уже без адресной строки.
    specs_applied = 0
    for w in winners:
        if w.family == "spec" and isinstance(w.value, str):
            node_of[w.node_idx].openapi_spec = w.value
            specs_applied += 1
    db.flush()

    # ── Процессы: не сливаются никогда, тёзкам — суффикс; привязки шагов и адреса
    #    узлов участников переписываются в координаты нового проекта.
    addresses = _address_map(plan, renamed, shared, addr_of)
    participants = _node_address_map(plan, addr_of)
    used_names: dict[str, int] = {}
    process_results = []
    for item in plan.processes:
        seen = used_names.get(item.name, 0) + 1
        used_names[item.name] = seen
        proc_name = item.name if seen == 1 else f"{item.name} ({seen})"
        if seen > 1:
            warnings.append(
                f"процесс «{item.name}» из входа «{item.origin_label}» приехал под именем "
                f"«{proc_name}»: процессы не сливаются"
            )
        text = _rewrite_doc_addresses(item.text, addresses.get(item.origin, {}))
        text = _rewrite_node_addresses(text, participants.get(item.origin, {}))
        preview = build_process_preview(db, project.id, text, proc_name)
        mapping = {p.alias: p.node_id for p in preview.participants}
        _, result = apply_process_import(db, project.id, text, proc_name, mapping)
        process_results.append(result)

    заметка = decisions_note(решения, склеено)
    if заметка:
        warnings.append(заметка)
    unfixable.extend(apply_unfixable(warnings[плановые:]))
    return project, ArchiveImportResult(
        project_id=project.id,
        project_name=project.name,
        # Числа честные: поглощённого склейкой узла в проекте нет, а выброшенный
        # перевесом дубль связи уже не в дереве (apply_tree_decisions).
        nodes=len(merged.nodes) - склеено,
        edges=len(merged.edges) - склеены_дубли,
        docs_created=docs_created,
        specs_applied=specs_applied,
        db=db_report,
        channels=channels_report,
        config=config_report,
        processes=process_results,
        warnings=warnings,
        unfixable=unfixable,
        resolved_conflicts=len(plan.conflicts),
        channel_stubs=channel_stubs,
    )


def _apply_merges(
    db: Session, project: Project, res: ResolvedDecisions, node_of: list[Node]
) -> tuple[int, set[uuid.UUID]]:
    """Склейки «это один объект» — уже в БД: узлы созданы посевом, семьи ещё нет.

    Выживший (первый по порядку файлов) получает выбранное имя, связи и детей
    поглощённого; сам поглощённый удаляется. node_of поглощённого переставляется на
    выжившего — этим все его схемы логики, факты, спеки и адреса процессов уезжают
    к выжившему сами, без второй карты. Ничего иного не удаляется: связь-петля,
    если объекты были связаны друг с другом, остаётся видимой на холсте.

    Знание поглощённого не пропадает вместе с ним (Ф1.1): пустые поля выжившего
    доливаются его значениями, заполненные не трогаются — то же правило, каким
    сливает поля сам мердж. Возвращает (сколько склеек, id перевешенных связей)."""
    if not res.merges:
        return 0, set()
    сделано = 0
    перевешены: set[uuid.UUID] = set()
    for survivor, absorbed, имя in merge_chain(res.merges):
        живёт, уходит = node_of[survivor], node_of[absorbed]
        if живёт.id == уходит.id:
            continue
        for edge in db.query(Edge).filter(
            Edge.project_id == project.id,
            (Edge.source_id == уходит.id) | (Edge.target_id == уходит.id),
        ).all():
            if edge.source_id == уходит.id:
                edge.source_id = живёт.id
            if edge.target_id == уходит.id:
                edge.target_id = живёт.id
            перевешены.add(edge.id)
        for ребёнок in db.query(Node).filter(Node.parent_id == уходит.id).all():
            ребёнок.parent_id = живёт.id
        absorb_knowledge(живёт, уходит)
        живёт.name = имя
        db.delete(уходит)
        db.flush()
        node_of[absorbed] = живёт
        сделано += 1
    return сделано, перевешены


# Поля узла, которые склейка ДОЛИВАЕТ выжившему из поглощённого. Те же, что
# доливает догрузка живому узлу: у формы и статуса нет «пусто», и тихая их смена
# переставила бы секции на странице объекта.
ABSORB_FIELDS = ("description", "role", "technology")


def absorb_knowledge(живёт: Node, уходит: Node) -> bool:
    """Знание поглощённого узла — выжившему: пустое долить, заполненное не трогать.

    Якорь переносится по тому же правилу и по той же причине, что и поля: без
    якоря второго источника следующий синк ТОГО репозитория не узнает склеенный
    объект и привезёт дубль. Занятый якорь не перевешиваем — второго места под
    него нет (множественные якоря за рамками MVP), и выбор между двумя решает
    порядок файлов, как и везде."""
    changed = False
    for fld in ABSORB_FIELDS:
        новое, своё = getattr(уходит, fld), getattr(живёт, fld)
        if (новое or "").strip() and not (своё or "").strip():
            setattr(живёт, fld, новое)
            changed = True
    if not живёт.source_ref and уходит.source_ref:
        живёт.source_ref = уходит.source_ref
        changed = True
    return changed


def dedup_edges(db: Session, project_id: uuid.UUID, moved: set[uuid.UUID]) -> int:
    """Точные дубли (пара концов, подпись, технология) среди ПЕРЕВЕШЕННЫХ склейкой
    связей — по одной.

    Смотрим только на те связи, которым склейка сменила конец: пара одинаковых
    рёбер, написанная автором документа в стороне от склейки, — его дело, и решение
    пользователя о другом объекте её трогать не должно (то же правило, что у дедупа
    в дереве, apply_tree_decisions). Ключ тот же, что у мерджа, — вердикты сходятся."""
    if not moved:
        return 0
    edges = db.query(Edge).filter(Edge.project_id == project_id).all()

    def подпись(e: Edge) -> tuple[uuid.UUID, uuid.UUID, str, str]:
        return (e.source_id, e.target_id, e.label or "", e.technology or "")

    seen = {подпись(e) for e in edges if e.id not in moved}
    dropped = 0
    for edge in edges:
        if edge.id not in moved:
            continue
        if подпись(edge) in seen:
            db.delete(edge)
            dropped += 1
            continue
        seen.add(подпись(edge))
    if dropped:
        db.flush()
    return dropped


def _addresses_of(nodes: list[Node], node_of: list[Node]) -> list[str]:
    """Адрес узла плана для синтетического файла: путь, у тёзок — с уточнителем.
    nodes — ВСЕ узлы проекта: уникальность пути считается по проекту."""
    addresses = node_addresses(nodes)
    return [addresses[n.id] for n in node_of]


def _synthetic_files(
    family: Family, winners: list[_Winner], path_of: list[str]
) -> list[tuple[str, str]]:
    """Вклады-победители семьи → файлы ввозного формата, как их прислал бы агент.

    Файл — один на «вход + исходный файл + узел» (внутри одного файла адресат
    всегда один). Имя файла ОСТАЁТСЯ исходным: его человек увидит в замечаниях
    родного приёмника, и указывать ему на выдуманное «synthetic-3.yaml» бесполезно.
    path_of — АДРЕСА узлов (_addresses_of): законного тёзку голый путь не найдёт.
    """
    buckets: dict[tuple[int, str, int], list[FamilyValue]] = {}
    for w in winners:
        if w.family == family:
            buckets.setdefault((w.origin, w.fname, w.node_idx), []).append(w.value)

    out: list[tuple[str, str]] = []
    for (_origin, fname, node_idx), values in buckets.items():
        if family == "table":
            body = {"tables": [_table_doc(v) for v in values if isinstance(v, TableIn)]}
        elif family == "channel":
            body = {"channels": [_channel_doc(v) for v in values if isinstance(v, ChannelIn)]}
        else:
            body = {"config": [_param_doc(v) for v in values if isinstance(v, ParamIn)]}
        # Адрес — ведущим комментарием с решёткой: YAML-ключ адресом не считается
        # (родные парсеры ищут именно комментарий, и об ошибке предупреждают).
        out.append((fname, f"# archmap-node: {path_of[node_idx]}\n" + _yaml(body)))
    return out


def _origin_addresses(plan: UnifiedPlan, addr_of: list[str]) -> dict[tuple[int, int], list[str]]:
    """(вход, merged-узел) → адреса этого узла в системе координат входа (путь с
    уточнителями тёзок — так их пишет архив). Переводит происхождение вкладов
    (report.node_contribs, Ф0): один merged-узел мог собраться из нескольких узлов
    одного входа, поэтому адресов бывает несколько, и все ведут в одну точку."""
    out: dict[tuple[int, int], list[str]] = {}
    for merged_idx, contribs in enumerate(plan.report.node_contribs):
        for file_idx, node_idx in contribs:
            addrs = plan.origin_addresses[file_idx] if file_idx < len(plan.origin_addresses) else []
            if node_idx < len(addrs) and merged_idx < len(addr_of):
                out.setdefault((file_idx, merged_idx), []).append(addrs[node_idx])
    return out


def _node_address_map(plan: UnifiedPlan, addr_of: list[str]) -> dict[int, dict[str, str]]:
    """Карта «вход → (адрес узла в архиве → адрес узла в проекте)» для строк
    «%% archmap-node:» участников. Узел, в который мердж склеил тёзок одного входа,
    — один на всех: адрес любого из них ведёт к нему."""
    out: dict[int, dict[str, str]] = {}
    for (origin, merged_idx), addrs in _origin_addresses(plan, addr_of).items():
        for a in addrs:
            out.setdefault(origin, {}).setdefault(_norm_address(a), addr_of[merged_idx])
    return out


def _address_map(
    plan: UnifiedPlan,
    renamed: dict[tuple[int, int, str], str],
    shared: dict[tuple[int, str], str],
    path_of: list[str],
) -> dict[int, dict[str, str]]:
    """Карта «вход → (старый адрес привязки → новый)».

    Старый адрес — «адрес узла в архиве этого входа / имя схемы»; новый — «адрес
    узла в новом проекте / фактическое имя». path_of — АДРЕСА узлов плана в проекте
    (_addresses_of): у тёзок путь один на двоих, и привязка к схеме тёзки пишется
    путём с уточнителем (app/node_ref.py) — голый путь не разрешился бы.
    """
    origin_paths = _origin_addresses(plan, path_of)

    out: dict[int, dict[str, str]] = {}

    def bind(origin: int, node_idx: int, old_name: str, actual: str) -> None:
        new = f"{path_of[node_idx]}{SEP}{actual}"
        for p in origin_paths.get((origin, node_idx), []):
            out.setdefault(origin, {}).setdefault(_norm_address(f"{p}{SEP}{old_name}"), new)

    # Сначала пооригинные (спорные тёзки с суффиксом — самый точный случай)…
    for (origin, node_idx, old_name), actual in renamed.items():
        bind(origin, node_idx, old_name, actual)
    # …потом бесспорные: их адрес одинаково верен для ЛЮБОГО входа — схема в проекте
    # одна, кто бы её ни прислал (в том числе для входа, чью копию съел дедуп).
    for (node_idx, old_name), actual in shared.items():
        for origin in range(len(plan.labels)):
            bind(origin, node_idx, old_name, actual)
    return out


__all__ = ["apply_unified_plan"]
