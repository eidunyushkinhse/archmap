"""Дозаливка доков от ИИ-агента: разбор пакета archmap-docs + план применения.

Пакет — САМОДОСТАТОЧНЫЕ файлы, файла-описи нет (docs/plan-docs-mmd.md):
схема логики приезжает .mmd-файлом с метаданными в шапке («%% archmap-*»,
разбирает mmd_header), спека — самим файлом OpenAPI. Оба вида превращаются в
PkgEntry — единую внутреннюю запись «этому узлу такие-то документы», — и дальше
работает общий конвейер: build_docs_plan мержит записи против ЖИВОГО дерева
проекта в действия (create | overwrite | skip | unchanged) + отчёт,
apply_docs_plan пишет их в БД. Разделение — ради общего dry-run превью.

Mermaid здесь НЕ валидируется (валидатора на бэке нет — проверяет фронт по
текстам из превью); OpenAPI проверяется советующе (yaml + эвристика
openapi/paths, серверное зеркало docValidate) — warnings, не блокеры.
"""

import re
import uuid
from collections.abc import Callable, Iterable
from dataclasses import dataclass, field
from difflib import SequenceMatcher, get_close_matches
from typing import TYPE_CHECKING

import yaml
from sqlalchemy.orm import Session

from app.mmd_header import parse_mmd_header
from app.models.node import Node
from app.models.node_doc import NodeDoc

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

    Чем закрываем пропуски в шапке: имя — именем файла, вид — «обзор», адрес —
    объектом окна. Ничего не блокирует импорт: слабая модель шапку забудет, а
    поправить имя и вид пользователь сможет прямо в превью (override).

    Содержимое сохраняем ЦЕЛИКОМ, вместе с шапкой: mermaid её игнорирует, зато
    метаданные не теряются при обратной выгрузке, а повторная заливка того же
    файла остаётся идемпотентной.
    """
    header = parse_mmd_header(content)
    notes = [f"{fname}: {p}" for p in header.problems]
    name = (override.name if override and override.name else None) or header.name or _name_from_file(fname)
    kind = (override.kind if override and override.kind else None) or header.kind or "overview"
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
    карты резолва — зеркало ref_name экспорта / resolve импорта."""
    by_id = {n.id: n for n in nodes}
    kids: dict[uuid.UUID | None, list[Node]] = {}
    for n in nodes:
        parent = n.parent_id if n.parent_id in by_id else None
        kids.setdefault(parent, []).append(n)
    for group in kids.values():
        group.sort(key=lambda n: n.name)

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
            plan.errors.append(f"{fname}: не указан объект, а окно не сказало, к какому применять")
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
}
# «ambiguous» общий для обеих семей, а починка разная — текст выбирается по режиму.
_AMBIGUOUS_CHANNEL = "имя неоднозначно, укажите «Брокер / канал»"

# Порог похожести для подсказки «похоже на …». НИЖЕ НЕ ОПУСКАТЬ: ложная подсказка
# хуже её отсутствия — слабая модель копирует предложенное имя не глядя, и вместо
# битой пометки получается пометка, битая по-другому.
_HINT_CUTOFF = 0.5
# Суффиксным матчем короткие хвосты не проверяем: «id» есть в конце половины имён.
_HINT_MIN_TAIL = 3


def _closest_name(tail: str, names: Iterable[str]) -> str | None:
    """Ближайшее описанное имя к хвосту битой ссылки — или None.

    Сначала СУФФИКС: «messages» → «zerver_message». Разрыв «имя ORM-класса против
    имени таблицы» почти всегда состоит из префикса приложения и числа (находка №1
    docs/qa-zulip-brokers.md), и difflib на нём как раз слабоват — «messages» против
    «zerver_message» не дотягивает до порога. difflib идёт добором, для опечаток.

    Подсказка ОДНА и только уверенная: не нашли — замечание остаётся как было.
    """
    by_low: dict[str, str] = {}
    for name in names:
        if name != tail:  # точное совпадение чинить нечем — там дело не в имени
            by_low.setdefault(name.lower(), name)
    if not by_low:
        return None
    low = tail.lower()
    # Единственное и множественное: агент пишет имя таблицы во множественном
    # («messages»), а в DDL она в единственном («zerver_message»), и наоборот.
    variants = [v for v in (low, low[:-1] if low.endswith("s") else "") if len(v) >= _HINT_MIN_TAIL]
    hits = [
        orig
        for cand, orig in by_low.items()
        if any(cand.endswith(f"_{v}") or cand.endswith(v) for v in variants)
    ]
    if hits:
        return min(hits, key=lambda n: (-SequenceMatcher(None, low, n.lower()).ratio(), n))
    close = get_close_matches(low, list(by_low), n=1, cutoff=_HINT_CUTOFF)
    return by_low[close[0]] if close else None


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
        self.data_total = 0  # пометок «читает:/пишет:» в пакете
        self.channel_total = 0  # пометок «публикует:/потребляет:» в пакете
        if db is not None and project_id is not None:
            # Импорт локальный: app.data_refs берёт из этого модуля _node_paths, и
            # верхнеуровневый импорт замкнул бы цикл. Каталог собирается ОДИН раз
            # на план (внутри — весь проект: неоднозначность имени есть свойство
            # проекта, а не одного узла).
            from app.data_refs import catalog_for_project

            self.tables, self.channels, self.node_paths = catalog_for_project(
                db, project_id
            )

    def _hint(self, r: "ResolvedRef") -> str | None:
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
        for tail in dict.fromkeys(t for t in tails if t):
            hit = _closest_name(tail, names)
            if hit is not None:
                return hit
        return None

    def check(self, fname: str, content: str) -> None:
        """Пометки одного файла пакета. Дедуп по (файл, ссылка, статус): одна и та
        же ссылка в режимах «читает» и «пишет» — один промах, а не два."""
        if not content:
            return
        # Локальный импорт — цикл, см. __init__.
        from app.data_refs import CHANNEL_MODES, parse_data_refs, resolve_data_refs

        refs = parse_data_refs(content)
        if not refs:
            return
        for parsed in refs:
            if parsed.mode in CHANNEL_MODES:
                self.saw_channel_refs = True
                self.channel_total += 1
            else:
                self.saw_table_refs = True
                self.data_total += 1
        # Считать — считаем всегда, а резолвить нечем: без db каталогов нет.
        if not self.enabled:
            return
        # Резолвим только те пометки, чей каталог непуст: «структуры ещё нет» — это
        # не промах агента, и гонять по нему нечего (заметку добавит flush).
        usable = [
            r
            for r in refs
            if (self.channels if r.mode in CHANNEL_MODES else self.tables)
        ]
        if not usable:
            return
        for r in resolve_data_refs(usable, self.tables, self.channels, self.node_paths):
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
            hint = self._hint(r)
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
                data_refs.check(fname, logic.mermaid)
                if logic.kind == "operation" and not logic.operation:
                    plan.warnings.append(
                        f'{fname}: схема "{logic.name}" узла «{path}» — kind=operation '
                        f"без поля operation"
                    )
                cur = existing.get(logic.name)
                if cur is None:
                    action, doc_id = "create", None
                elif (
                    cur.content == logic.mermaid
                    and cur.kind == logic.kind
                    and (cur.operation or None) == (logic.operation or None)
                ):
                    action, doc_id = "unchanged", cur.id
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


def apply_docs_plan(db: Session, plan: DocsPlan) -> tuple[int, int, int]:
    """Записать действия плана: (создано доков, перезаписано доков, спек записано).
    Вызывать только при пустых errors; skip/unchanged не трогаются. Бампы
    graph_rev/touch_project и commit — на вызывающей стороне (как seed_import)."""
    created = updated = specs = 0
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
        elif act.action == "overwrite":
            doc = db.get(NodeDoc, act.doc_id)
            if doc is None:
                continue  # удалён между превью и применением — план пересчитывается, но страхуемся
            doc.name = act.name
            doc.kind = act.kind
            doc.operation = act.operation
            doc.content = act.mermaid
            doc.version += 1
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
    return created, updated, specs
