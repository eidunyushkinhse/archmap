"""Дозаливка доков от ИИ-агента: разбор пакета archmap-docs + план применения.

Пакет — САМОДОСТАТОЧНЫЕ файлы, файла-описи нет (docs/plan-docs-mmd.md):
схема логики приезжает .mmd-файлом с метаданными в шапке («%% archmap-*»,
разбирает mmd_header), спека — самим файлом OpenAPI. Оба вида превращаются в
PkgEntry — единую внутреннюю запись «этому узлу такие-то документы», — и дальше
работает общий конвейер: build_docs_plan мержит записи против ЖИВОГО дерева
проекта в действия (create | fill | overwrite | skip | unchanged) + отчёт,
apply_docs_plan пишет их в БД. Разделение — ради общего dry-run превью.

Mermaid здесь НЕ валидируется (валидатора на бэке нет — проверяет фронт по
текстам из превью); OpenAPI проверяется советующе (yaml + эвристика
openapi/paths, серверное зеркало docValidate) — warnings, не блокеры.
"""

import re
import uuid
from collections.abc import Callable, Iterable
from dataclasses import dataclass, field
from difflib import SequenceMatcher
from typing import TYPE_CHECKING

import yaml
from sqlalchemy.orm import Session

from app.mmd_header import fix_unpaired_brackets, parse_mmd_header
from app.models.node import Node
from app.models.node_doc import NodeDoc
from app.node_ref import qualified_node_hits, sibling_sorter

if TYPE_CHECKING:
    # Только для аннотаций: app.data_refs берёт из ЭТОГО модуля _node_paths, и
    # верхнеуровневый импорт замкнул бы цикл (в рантайме — локальные импорты).
    from app.data_refs import CatalogChannel, CatalogTable, ResolvedRef

# Схем на объект. Поднято с 50 при переезде на .mmd: там схема — отдельный файл,
# и потолок пакета стал ближе (docs/plan-docs-mmd.md, таблица лимитов).
MAX_LOGIC_PER_NODE = 100
MAX_MERMAID_LEN = 200_000
MAX_SPEC_LEN = 2_000_000
# Кап предупреждений о нерезолвящихся пометках данных на весь план: замечания
# уезжают агенту ОДНИМ списком, и сотня строк одного класса вытеснит остальное.
MAX_DATA_REF_WARNINGS = 12

_ORIGINS = ("found", "generated", "synthesized")


@dataclass
class LogicIn:
    name: str
    kind: str
    operation: str | None
    mermaid: str


@dataclass
class OpenapiIn:
    # Имя файла спеки среди загруженных. Инлайн-спеки не бывает: спека приезжает
    # файлом (её копирует инструмент агента, а не перепечатывает модель).
    file: str
    origin: str | None  # None — происхождение не указано (warning в плане)


@dataclass
class PkgEntry:
    # None — «объект, из окна которого открыта дозаливка»: так адресуют себя
    # файлы .mmd без строки «%% archmap-node».
    node_ref: str | None
    logic: list[LogicIn]
    openapi: OpenapiIn | None


@dataclass
class ParsedPkg:
    entries: list[PkgEntry]


@dataclass
class MmdOverride:
    """Правка строки превью пользователем: что он исправил руками перед записью."""

    name: str | None = None
    kind: str | None = None
    node: str | None = None


def _is_stub(doc: NodeDoc) -> bool:
    """Схема — ЗАГЛУШКА разведки: тело пусто (docs/plan-recon.md, §5).

    «Пусто» — по strip(), ровно как считают признак «описана» (NodeDoc.described,
    выражение в БД) и резолвер пометок: схема из одних пробелов документацией не
    становится, и три места обязаны понимать пустоту одинаково.
    """
    return not doc.content.strip()


def _name_from_file(fname: str) -> str:
    """Имя схемы из имени файла: «orders-create.mmd» → «orders-create»."""
    stem = fname.rsplit("/", 1)[-1]
    for ext in (".mmd", ".mermaid", ".txt"):
        if stem.lower().endswith(ext):
            return stem[: -len(ext)] or stem
    return stem


_ORIGIN_COMMENT_RE = re.compile(r"^[#/ ]*archmap-origin:[ \t]*(\w+)[ \t]*$", re.MULTILINE)


def pkg_from_spec(fname: str, content: str) -> ParsedPkg:
    """Голый файл спеки → «манифест» из одной записи для объекта окна.

    Окно спеки открыто ДЛЯ узла, спека у него одна — конверт-манифест здесь не
    нёс ничего, кроме происхождения; его агент пишет комментарием в первых
    строках самой спеки («# archmap-origin: generated»)."""
    match = _ORIGIN_COMMENT_RE.search(content[:2000])
    origin = match.group(1) if match and match.group(1) in _ORIGINS else None
    return ParsedPkg(
        entries=[
            PkgEntry(
                node_ref=None,
                logic=[],
                openapi=OpenapiIn(file=fname, origin=origin),
            )
        ]
    )


def pkg_from_mmd(
    fname: str,
    content: str,
    override: MmdOverride | None = None,
) -> tuple[ParsedPkg, list[str]]:
    """Файл .mmd → «манифест» из одной схемы. (манифест, замечания).

    Так весь дальнейший конвейер (резолв узла, конфликты слотов, действия
    create/overwrite/skip) переиспользуется без изменений.

    Чем закрываем пропуски в шапке: имя — именем файла, вид — «операция», адрес —
    объектом окна. Ничего не блокирует импорт: слабая модель шапку забудет, а
    поправить имя и вид пользователь сможет прямо в превью (override).

    Содержимое сохраняем ЦЕЛИКОМ, вместе с шапкой: mermaid её игнорирует, зато
    метаданные не теряются при обратной выгрузке, а повторная заливка того же
    файла остаётся идемпотентной.
    """
    header = parse_mmd_header(content)
    notes = [f"{fname}: {p}" for p in header.problems]
    content, fixed = fix_unpaired_brackets(content)
    if fixed:
        notes.append(f"{fname}: исправлено фигур с непарной скобкой («{{…]» или «[…}}»): {fixed}")
    name = (override.name if override and override.name else None) or header.name or _name_from_file(fname)
    kind = (override.kind if override and override.kind else None) or header.kind or "operation"
    node_ref = (override.node if override and override.node else None) or header.node
    entry = PkgEntry(
        node_ref=node_ref,
        logic=[LogicIn(name=name, kind=kind, operation=header.operation, mermaid=content)],
        openapi=None,
    )
    return ParsedPkg(entries=[entry]), notes


@dataclass
class LogicAction:
    node_id: uuid.UUID
    node_path: str
    # Файл-источник: по нему превью привязывает правку пользователя к файлу
    # (правка едет обратно полем overrides — файла-описи больше нет).
    source: str
    name: str
    kind: str
    operation: str | None
    mermaid: str
    action: str  # create | overwrite | skip | unchanged
    doc_id: uuid.UUID | None  # существующий док (для overwrite)


@dataclass
class SpecAction:
    node_id: uuid.UUID
    node_path: str
    source: str  # имя файла спеки
    origin: str | None
    content: str
    action: str  # create | overwrite | skip | unchanged
    valid_yaml: bool
    looks_openapi: bool
    oas_version: str | None


@dataclass
class DocsPlan:
    logic: list[LogicAction] = field(default_factory=list)
    specs: list[SpecAction] = field(default_factory=list)
    errors: list[str] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)
    conflicts: list[str] = field(default_factory=list)
    # Сколько пометок каждой семьи РАСПОЗНАНО в схемах пакета (до резолва: числу
    # всё равно, битая ссылка или здоровая). Нужны окну, чтобы сравнить попытки
    # агента и поймать ампутацию — находка №2 docs/qa-sentry-brokers.md.
    data_refs_total: int = 0
    channel_refs_total: int = 0


def _node_paths(nodes: list[Node]) -> tuple[list[Node], list[str], dict[str, list[int]], dict[str, list[int]]]:
    """Полные пути живых узлов (родители раньше детей, сиблинги по имени) +
    карты резолва — зеркало ref_name экспорта / resolve импорта.

    Порядок сиблингов — ПОРЯДОК ДОКУМЕНТА экспорта (node_ref.sibling_sorter): тёзки
    идут по содержательному ключу, и порядковый уточнитель «путь @ #N», который
    пишут архив и синтетические файлы единого импорта (node_ref.node_addresses),
    здесь находит того же N-го тёзку."""
    by_id = {n.id: n for n in nodes}
    kids: dict[uuid.UUID | None, list[Node]] = {}
    for n in nodes:
        parent = n.parent_id if n.parent_id in by_id else None
        kids.setdefault(parent, []).append(n)
    sort = sibling_sorter(nodes)
    for parent, group in kids.items():
        kids[parent] = sort(group)

    flat: list[Node] = []
    fulls: list[str] = []
    by_bare: dict[str, list[int]] = {}
    by_path: dict[str, list[int]] = {}

    def walk(n: Node, prefix: str) -> None:
        full = f"{prefix} / {n.name}" if prefix else n.name
        idx = len(flat)
        flat.append(n)
        fulls.append(full)
        by_bare.setdefault(n.name, []).append(idx)
        by_path.setdefault(full, []).append(idx)
        for kid in kids.get(n.id, []):
            walk(kid, full)

    for root in kids.get(None, []):
        walk(root, "")
    return flat, fulls, by_bare, by_path


def spec_check(content: str) -> tuple[bool, bool, str | None]:
    """(валидный YAML, похоже на OpenAPI, версия OAS) — серверное зеркало docValidate."""
    try:
        doc = yaml.safe_load(content)
    except yaml.YAMLError:
        return False, False, None
    if not isinstance(doc, dict):
        return True, False, None
    ver = doc.get("openapi") or doc.get("swagger")
    looks = ver is not None and isinstance(doc.get("paths"), dict)
    return True, looks, str(ver) if looks else None


# Сколько адресов перечислять в замечании. Кап нужен: на монолите узлов бывают
# сотни, и полный перечень утопил бы остальные замечания (тот же довод, что у капов
# пометок). Хвост назван числом — «показали не всё» обязано быть видно.
MAX_NODES_HINT = 12


def _nodes_hint(flat: list[Node]) -> str:
    """Перечень адресов объектов проекта для замечания об отсутствующем адресе.

    Имена, а не полные пути: приёмник резолвит и голое имя (см. resolve), а путь у
    вложенного компонента длинный и в замечании только шумит.
    """
    names = [n.name for n in flat[:MAX_NODES_HINT]]
    tail = f" и ещё {len(flat) - MAX_NODES_HINT}" if len(flat) > MAX_NODES_HINT else ""
    return (", ".join(f"«{n}»" for n in names) + tail) if names else "в проекте их нет"


def _resolve_entry(
    entry: PkgEntry,
    fname: str,
    resolve: Callable[[str, str], int | None],
    flat: list[Node],
    by_node_id: dict[uuid.UUID, int],
    window_node_id: uuid.UUID | None,
    scope_ids: set[uuid.UUID] | None,
    plan: DocsPlan,
) -> int | None:
    """Какому узлу принадлежит запись. Без адреса — объект окна; с адресом из
    .mmd — он же, но не дальше своего поддерева."""
    if entry.node_ref is None:
        if window_node_id is None or window_node_id not in by_node_id:
            # ⚠️ Замечание обязано содержать ОТВЕТ, а не только диагноз — правило Н8,
            # применённое у данных, каналов и конфигурации, но забытое здесь. Цена
            # забывчивости измерена полевым прогоном (docs/qa-zobnin-field.md): на
            # «не указан объект» слабая модель выдумала заголовок «archmap-object» из
            # слова «объект» в самом замечании и приписала схемы трём узлам, которых в
            # проекте нет. Поэтому здесь и синтаксис строки, и перечень адресов.
            plan.errors.append(
                f"{fname}: не указан объект. Впишите ведущей строкой файла "
                f'"%% archmap-node: <адрес>" — именно с этим именем заголовка. '
                f"Адреса объектов проекта: {_nodes_hint(flat)}"
            )
            return None
        return by_node_id[window_node_id]
    idx = resolve(entry.node_ref, fname)
    if idx is None:
        return None
    if scope_ids is not None and flat[idx].id not in scope_ids:
        plan.errors.append(
            f'{fname}: объект «{entry.node_ref}» не относится к тому, для которого открыто окно'
        )
        return None
    return idx


_DATA_REF_PROBLEM: dict[str, str] = {
    "unknown_table": "таблица не найдена в структуре проекта",
    "ambiguous": "имя неоднозначно, укажите «Узел-БД / таблица»",
    "unknown_column": "колонки нет в таблице",
    # Канальная семья («публикует:/потребляет:») — свои слова: посылать агента искать
    # топик в структуре базы значит гарантированно получить неверную правку.
    "unknown_channel": "канал не найден у брокеров проекта",
    "unknown_field": "поля нет в канале",
    # Конфигурационная семья («зависит от:»). Искать негде, кроме самого объекта, —
    # это и говорим, чтобы агент не пошёл сверять имя по чужим узлам.
    "unknown_param": "параметра нет в конфигурации этого объекта",
}
# «ambiguous» общий для обеих семей, а починка разная — текст выбирается по режиму.
_AMBIGUOUS_CHANNEL = "имя неоднозначно, укажите «Брокер / канал»"

# Порог похожести для подсказки «похоже на …». НИЖЕ НЕ ОПУСКАТЬ: ложная подсказка
# хуже её отсутствия — слабая модель копирует предложенное имя не глядя, и вместо
# битой пометки получается пометка, битая по-другому. Полевая валидация Ф8 показала
# это буквально: по подсказкам-мусору модель «починила» три пометки в СЕМАНТИЧЕСКИ
# ДРУГИЕ таблицы, а сильные подсказки того же круга исполнила верно.
_HINT_CUTOFF = 0.75
# Суффиксным матчем короткие хвосты не проверяем: «id» есть в конце половины имён.
_HINT_MIN_TAIL = 3
# Сколько символов ВСЕГО (на обе строки) может не совпасть у «того же имени, записанного
# иначе». Одной похожести мало: у таблиц одного приложения общий длинный префикс, и
# difflib даёт «sentry_projectoptions» ↔ «sentry_projectcodeowners» целых 0.79 при
# девяти несовпавших символах — это РАЗНЫЕ таблицы. У настоящих же кандидатов расхождение
# АБСОЛЮТНО мелкое: разделитель, окончание, опечатка (0–3 символа).
_HINT_MAX_DIFF = 3
# Разделители, которыми одно и то же имя пишут по-разному: «...member_teams» против
# «...memberteam», «task-worker» против «taskworker».
_SEPARATORS = str.maketrans("", "", "_-. ")


def _norm_name(s: str) -> str:
    """Имя без регистра и разделителей — для сравнения «то же имя, записанное иначе»."""
    return s.lower().translate(_SEPARATORS)


def _tiny_diff(ref: str, cand: str) -> float | None:
    """Похожесть, если имена расходятся ТОЛЬКО мелочью, иначе None.

    Два условия, и второе главное: похожесть выше порога И абсолютное расхождение не
    больше _HINT_MAX_DIFF символов. Порога одного недостаточно — соседи по префиксу
    приложения набирают 0.75+ на общем начале, ничего общего не имея по смыслу.
    """
    m = SequenceMatcher(None, ref, cand)
    ratio = m.ratio()
    if ratio < _HINT_CUTOFF:
        return None
    matched = sum(block.size for block in m.get_matching_blocks())
    if (len(ref) - matched) + (len(cand) - matched) > _HINT_MAX_DIFF:
        return None
    return ratio


def _closest_name(tail: str, names: Iterable[str]) -> str | None:
    """Ближайшее описанное имя к хвосту битой ссылки — или None.

    Сначала СУФФИКС: «messages» → «app_message». Разрыв «имя ORM-класса против имени
    таблицы» почти всегда состоит из префикса приложения и числа (находка №1
    docs/qa-zulip-brokers.md), а difflib на нём слабеет тем сильнее, чем длиннее
    префикс: «queues» против «background_jobs_queue» — 0.37, ниже порога. Сравниваем
    имена БЕЗ РАЗДЕЛИТЕЛЕЙ, иначе «user_profile» не узнаёт себя в «zerver_userprofile».

    difflib идёт добором и только на мелких расхождениях (_tiny_diff): опечатка,
    окончание, разделитель. Подсказка ОДНА и только уверенная — не нашли уверенного
    кандидата, замечание остаётся как было.
    """
    by_low: dict[str, str] = {}
    for name in names:
        if name != tail:  # точное совпадение чинить нечем — там дело не в имени
            by_low.setdefault(name.lower(), name)
    if not by_low:
        return None
    norm = _norm_name(tail)
    # Единственное и множественное: агент пишет имя таблицы во множественном
    # («messages»), а в DDL она в единственном («app_message»), и наоборот.
    variants = [
        v for v in (norm, norm[:-1] if norm.endswith("s") else "") if len(v) >= _HINT_MIN_TAIL
    ]
    hits = [
        orig for cand, orig in by_low.items() if any(_norm_name(cand).endswith(v) for v in variants)
    ]
    if hits:
        return min(hits, key=lambda n: (-SequenceMatcher(None, norm, _norm_name(n)).ratio(), n))
    by_norm: dict[str, str] = {}
    for cand, orig in by_low.items():
        by_norm.setdefault(_norm_name(cand), orig)
    best: tuple[float, str] | None = None
    for cand in sorted(by_norm):  # порядок каталога произволен — выбор должен быть один
        ratio = _tiny_diff(norm, cand)
        if ratio is not None and (best is None or ratio > best[0]):
            best = (ratio, cand)
    return by_norm[best[1]] if best is not None else None


class _DataRefCheck:
    """Резолв пометок «читает:/пишет:» и «публикует:/потребляет:» в текстах пакета —
    та же проверка, что показывает плашка редактора схемы (app/data_refs.py).

    Зачем в превью: детерминированные классы ошибок агента закрываются промптом, а
    дисциплина пометок — нет (полевой QA docs/qa-zabbix-7.md, раунд 3: 46 битых
    пометок при том же промпте, что в прошлом раунде дал 7). Лечится машинно —
    кнопка «Скопировать замечания для агента» должна унести КОНКРЕТНЫЕ битые
    ссылки, а не правило.

    Пустой каталог (структуры БД или каналов в проекте ещё нет) — не повод шуметь на
    каждую пометку: доки грузят раньше структуры, и это нормальный порядок. Тогда —
    одна заметка на весь план, и заметки ДВЕ НЕЗАВИСИМЫЕ: описанные таблицы ничего
    не говорят о каналах, и наоборот.

    СЧЁТ пометок ведётся ВСЕГДА — и без каталога, и без db: он производен от разбора,
    а не от резолва. Числа уезжают в отчёт, и окно сравнивает попытки агента (упало
    число — пометки, скорее всего, удалены, а не починены).
    """

    def __init__(self, db: Session | None, project_id: uuid.UUID | None) -> None:
        self.tables: list[CatalogTable] = []
        self.channels: list[CatalogChannel] = []
        self.node_paths: dict[uuid.UUID, str] = {}
        self.enabled = db is not None and project_id is not None
        self.seen: set[tuple[str, str, str]] = set()  # (файл, ссылка, статус)
        self.warnings: list[str] = []
        self.over = 0  # сколько ссылок не поместилось в кап
        self.saw_table_refs = False
        self.saw_channel_refs = False
        self.saw_config_refs = False
        self.data_total = 0  # пометок «читает:/пишет:» в пакете
        self.channel_total = 0  # пометок «публикует:/потребляет:» в пакете
        # Конфигурационные пометки («зависит от:») в СЧЁТЧИКИ ОТЧЁТА не идут: те
        # объявлены как число пометок данных и каналов, и подмешать в них третью
        # семью значило бы испортить сравнение попыток агента, ради которого числа и
        # заведены. Проверяются они при этом полноценно — промах даёт замечание.
        self.params_by_node: dict[uuid.UUID, dict[str, uuid.UUID]] = {}
        if db is not None and project_id is not None:
            # Импорт локальный: app.data_refs берёт из этого модуля _node_paths, и
            # верхнеуровневый импорт замкнул бы цикл. Каталог собирается ОДИН раз
            # на план (внутри — весь проект: неоднозначность имени есть свойство
            # проекта, а не одного узла).
            from app.data_refs import catalog_for_project

            (
                self.tables,
                self.channels,
                self.params_by_node,
                self.node_paths,
            ) = catalog_for_project(db, project_id)

    def _hint(self, r: "ResolvedRef", owner_params: dict[str, uuid.UUID]) -> str | None:
        """Подсказка «похоже на …» к битой ссылке: имя из каталога, если оно есть.

        Замечание без ответа даёт слабой модели колебательный контур (находка №1
        docs/qa-zulip-brokers.md): из двух путей починки — «сверь имя» и «добавь
        квалификатор» — она оба круга выбирала дешёвый механический, а имя так и не
        сверила. Подсказка закрывает петлю в один заход, как подсказка про кавычки
        закрыла класс битого YAML: каталог имён у превью уже есть, и молчать о нём
        значит требовать от агента работы, которую машина делает точнее.
        """
        names: list[str] = []
        tails: list[str] = []
        bare = r.ref.rpartition(" / ")[2]  # квалификатор узла в сравнении не участвует
        parts = bare.split(".")
        if r.status == "unknown_table":
            for t in self.tables:
                names.append(t.name)
                if t.schema_name:
                    names.append(f"{t.schema_name}.{t.name}")
            # «таблица.колонка» и «раздел.таблица» в ссылке неотличимы — пробуем оба
            # чтения (первое сработавшее и даёт подсказку) и ссылку целиком.
            tails = [*parts[:2], bare]
        elif r.status == "unknown_channel":
            for c in self.channels:
                names.append(c.name)
                if c.group_name:
                    names.append(f"{c.group_name}.{c.name}")
            # У каналов точка чаще ЧАСТЬ имени («orders.created»): первым — хвост
            # целиком, затем он же без последнего сегмента (тот был бы полем).
            tails = [bare, bare.rpartition(".")[0], parts[0]]
        elif r.status == "unknown_column":
            # Таблица нашлась (её id в ResolvedRef) — кандидаты только её колонки.
            names = [c for t in self.tables if t.id == r.table_id for c in t.columns]
            tails = [parts[-1]]
        elif r.status == "unknown_field":
            names = [f for c in self.channels if c.id == r.channel_id for f in c.fields]
            tails = [parts[-1]]
        elif r.status == "unknown_param":
            # Кандидаты — ручки ЭТОГО объекта, других мест у ссылки нет. Хвост берём
            # целиком: точка в имени параметра («feature.new_checkout») его не делит.
            names = list(owner_params)
            tails = [bare]
        for tail in dict.fromkeys(t for t in tails if t):
            hit = _closest_name(tail, names)
            if hit is not None:
                return hit
        return None

    def check(self, fname: str, content: str, owner_id: uuid.UUID) -> None:
        """Пометки одного файла пакета. Дедуп по (файл, ссылка, статус): одна и та
        же ссылка в режимах «читает» и «пишет» — один промах, а не два.

        owner_id — узел, которому принадлежит схема: конфигурация ищется только у
        него, и без владельца третья семья не проверяема в принципе.
        """
        if not content:
            return
        # Локальный импорт — цикл, см. __init__.
        from app.data_refs import (
            CHANNEL_MODES,
            CONFIG_MODES,
            parse_data_refs,
            resolve_data_refs,
        )

        refs = parse_data_refs(content)
        if not refs:
            return
        owner_params = self.params_by_node.get(owner_id, {})
        for parsed in refs:
            if parsed.mode in CONFIG_MODES:
                self.saw_config_refs = True
            elif parsed.mode in CHANNEL_MODES:
                self.saw_channel_refs = True
                self.channel_total += 1
            else:
                self.saw_table_refs = True
                self.data_total += 1
        # Считать — считаем всегда, а резолвить нечем: без db каталогов нет.
        if not self.enabled:
            return

        def каталог(mode: str) -> object:
            """Каталог семьи пометки — тот, по которому её будут резолвить."""
            if mode in CONFIG_MODES:
                return owner_params
            return self.channels if mode in CHANNEL_MODES else self.tables

        # Резолвим только те пометки, чей каталог непуст: «структуры ещё нет» — это
        # не промах агента, и гонять по нему нечего (заметку добавит flush). У
        # конфигурации каталог СВОЙ У КАЖДОГО УЗЛА, поэтому пустота проверяется не
        # по проекту, а по владельцу схемы: сервис без описанных ручек молчит, а его
        # сосед с описанными — проверяется.
        usable = [r for r in refs if каталог(r.mode)]
        if not usable:
            return
        for r in resolve_data_refs(
            usable,
            self.tables,
            self.channels,
            self.node_paths,
            owner_params=owner_params,
        ):
            if r.status == "ok":
                continue
            key = (fname, r.ref, r.status)
            if key in self.seen:
                continue
            self.seen.add(key)
            if len(self.warnings) >= MAX_DATA_REF_WARNINGS:
                self.over += 1
                continue
            problem = (
                _AMBIGUOUS_CHANNEL
                if r.status == "ambiguous" and r.mode in CHANNEL_MODES
                else _DATA_REF_PROBLEM[r.status]
            )
            # «ambiguous» подсказки не получает: имя там как раз НАШЛОСЬ, и лечится
            # оно квалификатором — предлагать «похожее» значило бы звать не туда.
            hint = self._hint(r, owner_params)
            tail = f" — похоже на «{hint}»" if hint else ""
            self.warnings.append(f"{fname}: пометка «{r.ref}» — {problem}{tail}")

    def flush(self, plan: DocsPlan) -> None:
        # Счётчики — часть отчёта, а не резолва: без каталога они тоже осмысленны
        # (окно сравнивает попытки агента, а не проверяет структуру).
        plan.data_refs_total = self.data_total
        plan.channel_refs_total = self.channel_total
        if not self.enabled:
            return
        plan.warnings.extend(self.warnings)
        if self.over:
            plan.warnings.append(f"…ещё {self.over} пометок не резолвится")
        # Заметки о неописанной структуре независимы: таблицы могут быть описаны, а
        # каналы нет (порядок Р4 плана — структура раньше доков — соблюдают не всегда).
        if self.saw_table_refs and not self.tables:
            plan.warnings.append(
                "В пакете есть пометки данных (читает:/пишет:), а структура БД в "
                "проекте ещё не описана — резолв пометок проверится, когда она появится"
            )
        if self.saw_channel_refs and not self.channels:
            plan.warnings.append(
                "В пакете есть пометки каналов (публикует:/потребляет:), а каналы "
                "брокеров в проекте ещё не описаны — резолв пометок проверится, когда "
                "они появятся"
            )
        if self.saw_config_refs and not self.params_by_node:
            plan.warnings.append(
                "В пакете есть пометки конфигурации (зависит от:), а параметры "
                "объектов в проекте ещё не описаны — резолв пометок проверится, когда "
                "они появятся"
            )


def build_docs_plan(
    nodes: list[Node],
    entries: list[tuple[str, ParsedPkg]],
    assets: dict[str, str],
    overwrite: bool,
    window_node_id: uuid.UUID | None = None,
    scope_ids: set[uuid.UUID] | None = None,
    db: Session | None = None,
    project_id: uuid.UUID | None = None,
) -> DocsPlan:
    """Мердж записей пакета против живого дерева → действия + отчёт. Идентичность
    дока = (узел, точное имя схемы), спеки = узел; дубль слота внутри ОДНОГО
    файла — ошибка, из РАЗНЫХ файлов — первый побеждает + конфликт.

    БД не пишет (dry-run превью и применение зовут одно и то же); db/project_id —
    только чтение каталога структуры для резолва пометок данных, без них проверка
    пометок просто выключена.

    window_node_id — объект, из окна которого открыта дозаливка: к нему уезжают
    записи без адреса (файлы .mmd без «%% archmap-node»). scope_ids — его
    поддерево: адрес в шапке дальше него не действует, иначе схема тихо приехала
    бы чужому сервису."""
    plan = DocsPlan()
    data_refs = _DataRefCheck(db, project_id)
    flat, fulls, by_bare, by_path = _node_paths(nodes)
    by_node_id = {n.id: i for i, n in enumerate(flat)}
    # Кто из узлов — контейнер (есть дети). Собственные доки у контейнера законны, но
    # продукт считает их запахом: их ловит алерт AL24 и лечит «распределение» по детям.
    # Блокировать пакет из-за этого жестоко — предупреждаем (полевой QA Zabbix 7).
    with_children = {n.parent_id for n in nodes if n.parent_id is not None}

    def resolve(ref: str, where: str) -> int | None:
        hits = by_path.get(ref)
        if not hits:
            hits = by_bare.get(ref)
        if not hits and " / " in ref:
            tail = f" / {ref}"
            hits = [i for i, full in enumerate(fulls) if full.endswith(tail)]
        if not hits and " @ " in ref:
            # Тёзка (одно имя в одном родителе) и его потомки адресуются путём с
            # уточнителем на сегменте тёзки — якорным «@ git:…» или порядковым
            # «@ #N» (так пишет архив, app/node_ref.py). ДО слэш-фолбэка: в ключе
            # законны слэши, и нормализация пути разрезала бы его.
            hits = qualified_node_hits(ref, flat)
        if not hits and "/" in ref:
            # Слабые модели пишут путь слэшем без пробелов («microblog/api»,
            # стресс-тест) — нормализуем в канонический разделитель « / » и
            # повторяем точный путь + однозначный хвост. Фолбэк последний:
            # настоящие имена с «/» (редкость) он не задевает — те матчатся выше.
            norm = " / ".join(part.strip() for part in ref.split("/") if part.strip())
            hits = by_path.get(norm)
            if not hits:
                tail = f" / {norm}"
                hits = [i for i, full in enumerate(fulls) if full.endswith(tail)]
        if not hits:
            plan.errors.append(f'{where}: узел "{ref}" не найден в проекте')
            return None
        if len(hits) > 1:
            plan.errors.append(f'{where}: имя "{ref}" неоднозначно, укажите путь через " / "')
            return None
        return hits[0]

    logic_owner: dict[tuple[uuid.UUID, str], str] = {}  # слот → имя файла-первоисточника
    spec_owner: dict[uuid.UUID, str] = {}
    used_assets: set[str] = set()
    # Заглушки узла по адресу операции + уже занятые заглушки пакета (Р27). Индекс
    # общий на все файлы: узел приезжает несколькими записями, и вторая не должна
    # снова целиться в ту же заглушку.
    stub_ops: dict[uuid.UUID, dict[str, list[NodeDoc]]] = {}
    claimed: set[uuid.UUID] = set()

    def stubs_by_operation(node: Node) -> dict[str, list[NodeDoc]]:
        index = stub_ops.get(node.id)
        if index is None:
            index = {}
            for doc in node.docs:
                if doc.operation and _is_stub(doc):
                    index.setdefault(doc.operation, []).append(doc)
            stub_ops[node.id] = index
        return index

    for fname, pkg in entries:
        for entry in pkg.entries:
            idx = _resolve_entry(
                entry, fname, resolve, flat, by_node_id, window_node_id, scope_ids, plan
            )
            if idx is None:
                continue
            node, path = flat[idx], fulls[idx]
            existing = {d.name: d for d in node.docs}

            if entry.logic and node.id in with_children:
                plan.warnings.append(
                    f"{fname}: «{path}» — контейнер; собственные доки контейнеров попадают "
                    "в алерт «Контейнеры со своей документацией» — лучше адресовать "
                    "листовым узлам"
                )

            for logic in entry.logic:
                slot = (node.id, logic.name)
                owner = logic_owner.get(slot)
                if owner == fname:
                    plan.errors.append(
                        f'{fname}: дубль схемы "{logic.name}" у узла «{path}» в одном файле'
                    )
                    continue
                if owner is not None:
                    plan.conflicts.append(
                        f'схема "{logic.name}" узла «{path}» уже задана файлом {owner} — '
                        f"вход из {fname} пропущен"
                    )
                    continue
                logic_owner[slot] = fname
                # Пометки проверяем у схем, которые ДОЙДУТ до плана: у пропущенных
                # дублей их текст всё равно не применится.
                data_refs.check(fname, logic.mermaid, node.id)
                if logic.kind == "operation" and not logic.operation:
                    plan.warnings.append(
                        f'{fname}: схема "{logic.name}" узла «{path}» — kind=operation '
                        f"без поля operation"
                    )
                cur = existing.get(logic.name)
                if cur is None and logic.operation and logic.mermaid.strip():
                    # Р27: конвенция «имя схемы = METHOD /путь» — правило, а правило
                    # слабее примера: агент вправе назвать схему «Создание заказа» и
                    # положить адрес в operation. По имени она не сойдётся, и рядом с
                    # заглушкой выросла бы ВТОРАЯ схема на ту же операцию, а заглушка
                    # осталась бы пустой навсегда — счётчик «описано N из M» начал бы
                    # врать в обе стороны. Ищем ТОЛЬКО среди заглушек: описанную схему
                    # с той же операцией не трогаем никогда, это чужая работа.
                    свободные = [
                        d
                        for d in stubs_by_operation(node).get(logic.operation, [])
                        if d.id not in claimed
                    ]
                    if len(свободные) == 1:
                        cur = свободные[0]
                    elif len(свободные) > 1:
                        имена = sorted(d.name for d in свободные)
                        хвост = (
                            f" …и ещё {len(имена) - 3}" if len(имена) > 3 else ""
                        )
                        plan.warnings.append(
                            f'{fname}: схема "{logic.name}" узла «{path}» — заглушек с '
                            f"операцией «{logic.operation}» несколько "
                            f'({", ".join(имена[:3])}{хвост}), какую заполнить — не '
                            f"угадываем: создана новая схема"
                        )
                if cur is not None and cur.id in claimed:
                    # Заглушку уже забрал файл выше (нашёл по операции) — второй раз
                    # писать в ту же строку нельзя: одна из двух схем пропала бы молча.
                    plan.conflicts.append(
                        f'заглушку "{cur.name}" узла «{path}» уже заполняет другой файл — '
                        f'схема "{logic.name}" из {fname} пропущена'
                    )
                    continue
                if cur is None:
                    action, doc_id = "create", None
                elif (
                    cur.content == logic.mermaid
                    and cur.kind == logic.kind
                    and (cur.operation or None) == (logic.operation or None)
                ):
                    action, doc_id = "unchanged", cur.id
                elif _is_stub(cur) and logic.mermaid.strip():
                    # Р25: политика «не перезаписывать» защищает РАБОТУ, а в заглушке
                    # разведки её нет — иначе разведка сама себя и заблокировала бы:
                    # двести пустых слотов пропустили бы всю дозаливку с отчётом
                    # «занято». Обратное направление (пустое поверх описанного) сюда
                    # НЕ попадает и остаётся на прежней политике: это стирание.
                    action, doc_id = "fill", cur.id
                    claimed.add(cur.id)
                else:
                    action, doc_id = ("overwrite" if overwrite else "skip"), cur.id
                plan.logic.append(
                    LogicAction(
                        node_id=node.id,
                        node_path=path,
                        source=fname,
                        name=logic.name,
                        kind=logic.kind,
                        operation=logic.operation,
                        mermaid=logic.mermaid,
                        action=action,
                        doc_id=doc_id,
                    )
                )

            if entry.openapi is None:
                continue
            owner = spec_owner.get(node.id)
            if owner == fname:
                plan.errors.append(f"{fname}: дубль OpenAPI-спеки у узла «{path}» в одном файле")
                continue
            if owner is not None:
                plan.conflicts.append(
                    f"OpenAPI-спека узла «{path}» уже задана файлом {owner} — "
                    f"вход из {fname} пропущен"
                )
                continue
            spec_owner[node.id] = fname
            content = assets.get(entry.openapi.file)
            if content is None:
                plan.errors.append(
                    f'{fname}: файл спеки "{entry.openapi.file}" не найден среди загруженных'
                )
                continue
            used_assets.add(entry.openapi.file)
            source = entry.openapi.file
            if entry.openapi.origin is None:
                plan.warnings.append(
                    f"{fname}: у спеки узла «{path}» не указано происхождение (origin)"
                )
            valid_yaml, looks, ver = spec_check(content)
            if not valid_yaml:
                plan.warnings.append(f"спека узла «{path}» ({source}) не разбирается как YAML")
            elif not looks:
                plan.warnings.append(
                    f"спека узла «{path}» ({source}) не похожа на OpenAPI: нет openapi/paths"
                )
            cur_spec = node.openapi_spec or ""
            if not cur_spec.strip():
                action = "create"
            elif cur_spec == content:
                action = "unchanged"
            else:
                action = "overwrite" if overwrite else "skip"
            plan.specs.append(
                SpecAction(
                    node_id=node.id,
                    node_path=path,
                    source=source,
                    origin=entry.openapi.origin,
                    content=content,
                    action=action,
                    valid_yaml=valid_yaml,
                    looks_openapi=looks,
                    oas_version=ver,
                )
            )

    for name in sorted(set(assets) - used_assets):
        plan.warnings.append(f'файл "{name}" не пригодился — ни схема, ни спека')
    data_refs.flush(plan)
    return plan


def apply_docs_plan(db: Session, plan: DocsPlan) -> tuple[int, int, int, int]:
    """Записать действия плана: (создано доков, перезаписано доков, спек записано,
    заполнено заглушек). Заполнение идёт тем же путём, что перезапись (та же строка
    БД, тот же бамп CAS-версии), но считается ОТДЕЛЬНО: перезапись трогает работу,
    заполнение — пустой слот.
    Вызывать только при пустых errors; skip/unchanged не трогаются. Бампы
    graph_rev/touch_project и commit — на вызывающей стороне (как seed_import)."""
    created = updated = specs = filled = 0
    for act in plan.logic:
        if act.action == "create":
            db.add(
                NodeDoc(
                    node_id=act.node_id,
                    name=act.name,
                    kind=act.kind,
                    operation=act.operation,
                    content=act.mermaid,
                )
            )
            created += 1
        elif act.action in ("overwrite", "fill"):
            doc = db.get(NodeDoc, act.doc_id)
            if doc is None:
                continue  # удалён между превью и применением — план пересчитывается, но страхуемся
            # Имя пишется и при заполнении: заглушку могли найти по операции, а не по
            # имени (Р27), и осмысленное имя от агента ценнее адреса-заголовка.
            doc.name = act.name
            doc.kind = act.kind
            doc.operation = act.operation
            doc.content = act.mermaid
            doc.version += 1
            if act.action == "fill":
                filled += 1
            else:
                updated += 1
    for spec in plan.specs:
        if spec.action not in ("create", "overwrite"):
            continue
        node = db.get(Node, spec.node_id)
        if node is None:
            continue
        node.openapi_spec = spec.content
        node.version += 1
        specs += 1
    return created, updated, specs, filled
