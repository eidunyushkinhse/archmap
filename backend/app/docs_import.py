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

import uuid
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import NamedTuple

from sqlalchemy.orm import Session, selectinload

from app import tree
from app.data_refs import (
    CHANNEL_MODES,
    CONFIG_MODES,
    CatalogChannel,
    CatalogTable,
    DataRefIn,
    ProjectCatalog,
    ResolvedRef,
    catalog_for_project,
    parse_data_refs,
    resolve_data_refs,
)
from app.docs_pkg import (
    MmdOverride,
    ParsedPkg,
    PkgEntry,
    pkg_from_mmd,
    pkg_from_spec,
    spec_check,
)
from app.domain_types import NodeDocKind
from app.element import Elements
from app.element_marks import build_elements, element_rows_of
from app.mmd_header import looks_like_mermaid
from app.models.node import Node
from app.models.node_doc import NodeDoc
from app.name_match import closest_name
from app.node_ref import NodeIndex, qualified_node_hits
from app.schemas.docs_import import DocsOnly

# Кап предупреждений о нерезолвящихся пометках данных на весь план: замечания
# уезжают агенту ОДНИМ списком, и сотня строк одного класса вытеснит остальное.
MAX_DATA_REF_WARNINGS = 12

@dataclass
class LogicAction:
    node_id: uuid.UUID
    node_path: str
    # Файл-источник: по нему превью привязывает правку пользователя к файлу
    # (правка едет обратно полем overrides — файла-описи больше нет).
    source: str
    name: str
    kind: NodeDocKind
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
    window_container: uuid.UUID | None = None,
) -> int | None:
    """Какому узлу принадлежит запись. Без адреса — объект окна; с адресом из
    .mmd — он же, но не дальше своего поддерева.

    Исключение — window_container, контейнер окна компонента (Р12
    docs/plan-c4-elements.md): спецификация — факт контейнера, поэтому запись ТОЛЬКО
    со спецификацией вправе назвать его адресом, хотя он и вне поддерева окна.
    Записи со схемами логики правило окна держит прежним."""
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
        spec_only = entry.openapi is not None and not entry.logic
        if not (spec_only and flat[idx].id == window_container):
            plan.errors.append(
                f'{fname}: объект «{entry.node_ref}» не относится к тому, для которого открыто окно'
            )
            return None
    return idx


def _logic_note(fname: str, path: str, element: str | None) -> str:
    """Предупреждение о схемах логики у узла с вложенными объектами — по элементу
    архитектуры (Р9: у любого такого узла они попадут в «Рекомендации», как сегодня)."""
    if element == "system":
        return (
            f"{fname}: «{path}» — система; схемы логики описывают код и живут у "
            "контейнеров и компонентов, у системы они попадут в «Рекомендации»"
        )
    if element == "container":
        return (
            f"{fname}: «{path}» — контейнер с компонентами; схемы логики описывают код "
            "компонентов — лучше адресовать их компонентам, у контейнера они попадут "
            "в «Рекомендации»"
        )
    return (
        f"{fname}: «{path}» — компонент с вложенными компонентами; схемы логики лучше "
        "адресовать вложенным компонентам, у объекта с вложенными они попадут в "
        "«Рекомендации»"
    )


def _spec_target(
    fname: str,
    idx: int,
    flat: list[Node],
    fulls: list[str],
    by_node_id: dict[uuid.UUID, int],
    elements: Elements[uuid.UUID],
    plan: DocsPlan,
) -> int:
    """Узел, которому достаётся спецификация записи (Р12 docs/plan-c4-elements.md):
    API отдаёт контейнер, поэтому спецификация компонента уезжает его ближайшему
    контейнеру — со строкой в превью. У системы контейнера нет: спецификация остаётся
    у неё с предупреждением (её поймает замечание, как схемы у системы)."""
    node, path = flat[idx], fulls[idx]
    if elements.effective(node.id) == "system":
        plan.warnings.append(
            f"{fname}: «{path}» — система; API отдают её контейнеры, опишите "
            "спецификацию у одного из них"
        )
        return idx
    container = elements.container_of(node.id)
    if container is None or container == node.id or container not in by_node_id:
        return idx
    target = by_node_id[container]
    plan.warnings.append(
        f"{fname}: спецификация узла «{path}» описана у контейнера «{fulls[target]}»: "
        f"API отдаёт контейнер, операции «{node.name}» привязываются к ней в схемах логики"
    )
    return target


def _is_stub(doc: NodeDoc) -> bool:
    """Схема — ЗАГЛУШКА разведки: тело пусто (docs/plan-recon.md, §5).

    «Пусто» — по strip(), ровно как считают признак «описана» (NodeDoc.described,
    выражение в БД) и резолвер пометок: схема из одних пробелов документацией не
    становится, и три места обязаны понимать пустоту одинаково.
    """
    return not doc.content.strip()


_DATA_REF_PROBLEM: dict[str, str] = {
    "unknown_table": "таблица не найдена в структуре проекта",
    "ambiguous": "имя неоднозначно, укажите «Узел-БД / таблица»",
    "unknown_column": "колонки нет в таблице",
    # Канальная семья («публикует:/потребляет:») — свои слова: посылать агента искать
    # топик в структуре базы значит гарантированно получить неверную правку.
    "unknown_channel": "канал не найден у брокеров проекта",
    "unknown_field": "поля нет в канале",
    # Конфигурационная семья («зависит от:»). Искать негде, кроме ближайшего
    # контейнера, — это и говорим, чтобы агент не пошёл сверять имя по чужим узлам.
    # У схемы компонента текст называет контейнер (_DataRefCheck.check).
    "unknown_param": "параметра нет в конфигурации этого объекта",
}
# «ambiguous» общий для обеих семей, а починка разная — текст выбирается по режиму.
_AMBIGUOUS_CHANNEL = "имя неоднозначно, укажите «Брокер / канал»"

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
        # Каталог собирается ОДИН раз на план (внутри — весь проект: неоднозначность
        # имени есть свойство проекта, а не одного узла). Читается по атрибутам —
        # распаковка в отдельные имена молча отставала бы от новых полей (камень 10
        # docs/plan-c4-elements.md).
        self.catalog: ProjectCatalog | None = (
            catalog_for_project(db, project_id)
            if db is not None and project_id is not None
            else None
        )
        self.seen: set[tuple[str, str, str]] = set()  # (файл, ссылка, статус)
        self.warnings: list[str] = []
        self.over = 0  # сколько ссылок не поместилось в кап
        self.saw_table_refs = False
        self.saw_channel_refs = False
        self.data_total = 0  # пометок «читает:/пишет:» в пакете
        self.channel_total = 0  # пометок «публикует:/потребляет:» в пакете
        # Конфигурационные пометки («зависит от:») в СЧЁТЧИКИ ОТЧЁТА не идут: те
        # объявлены как число пометок данных и каналов, и подмешать в них третью
        # семью значило бы испортить сравнение попыток агента, ради которого числа и
        # заведены. Проверяются они при этом полноценно — промах даёт замечание.

    @property
    def enabled(self) -> bool:
        """Резолв возможен: без db каталогов нет, и пометки только считаются."""
        return self.catalog is not None

    @property
    def tables(self) -> list[CatalogTable]:
        return self.catalog.tables if self.catalog is not None else []

    @property
    def channels(self) -> list[CatalogChannel]:
        return self.catalog.channels if self.catalog is not None else []

    def _hint(self, r: ResolvedRef, owner_params: dict[str, uuid.UUID]) -> str | None:
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
            # Кандидаты — ручки ближайшего контейнера владельца (тот же каталог, по
            # которому резолвили), других мест у ссылки нет. Хвост берём целиком:
            # точка в имени параметра («feature.new_checkout») его не делит.
            names = list(owner_params)
            tails = [bare]
        for tail in dict.fromkeys(t for t in tails if t):
            hit = closest_name(tail, names)
            if hit is not None:
                return hit
        return None

    def check(self, fname: str, content: str, owner_id: uuid.UUID) -> None:
        """Пометки одного файла пакета. Дедуп по (файл, ссылка, статус): одна и та
        же ссылка в режимах «читает» и «пишет» — один промах, а не два.

        owner_id — узел, которому принадлежит схема: конфигурация ищется только у
        его ближайшего контейнера (у компонента — контейнера-предка), и без
        владельца третья семья не проверяема в принципе.
        """
        if not content:
            return
        refs = parse_data_refs(content)
        if not refs:
            return
        for parsed in refs:
            if parsed.mode in CHANNEL_MODES:
                self.saw_channel_refs = True
                self.channel_total += 1
            elif parsed.mode not in CONFIG_MODES:
                self.saw_table_refs = True
                self.data_total += 1
        # Считать — считаем всегда, а резолвить нечем: без db каталогов нет.
        catalog = self.catalog
        if catalog is None:
            return
        owner_params = catalog.params_for(owner_id)
        container = catalog.elements.container_of(owner_id)

        config_refs = [r for r in refs if r.mode in CONFIG_MODES]
        if config_refs and not owner_params:
            # Каталог конфигурации у каждого контейнера СВОЙ, и пустой у контейнера
            # владельца — не «структуры ещё нет» (заметки flush — про проект целиком),
            # а промах адресата: после применения каждая такая пометка загорится AL33,
            # а превью молчало (полевой репорт 2026-10-28, п. 2). Одна строка на файл,
            # не на пометку, и без упрёка: логику часто описывают раньше конфигурации.
            key = (fname, "", "no_owner_params")
            if key not in self.seen:
                self.seen.add(key)
                self.warnings.append(
                    self._no_params_note(fname, catalog, owner_id, container, config_refs)
                )

        def каталог(mode: str) -> object:
            """Каталог семьи пометки — тот, по которому её будут резолвить."""
            if mode in CONFIG_MODES:
                return owner_params
            return self.channels if mode in CHANNEL_MODES else self.tables

        # Резолвим только те пометки, чей каталог непуст: «структуры ещё нет» — это
        # не промах агента, и гонять по нему нечего (заметку добавит flush). У
        # конфигурации каталог СВОЙ У КАЖДОГО КОНТЕЙНЕРА, поэтому пустота
        # проверяется не по проекту, а по контейнеру владельца схемы: сервис без
        # описанных ручек молчит, а его сосед с описанными — проверяется.
        usable = [r for r in refs if каталог(r.mode)]
        if not usable:
            return
        for r in resolve_data_refs(
            usable,
            catalog.tables,
            catalog.channels,
            catalog.node_paths,
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
            if r.status == "unknown_param" and container is not None and container != owner_id:
                # Схема компонента: параметр искали у контейнера — его и назвать,
                # иначе агент пойдёт описывать ручку у самого компонента.
                where = catalog.node_paths.get(container, "?")
                problem = f"параметра нет в конфигурации контейнера «{where}»"
            # «ambiguous» подсказки не получает: имя там как раз НАШЛОСЬ, и лечится
            # оно квалификатором — предлагать «похожее» значило бы звать не туда.
            hint = self._hint(r, owner_params)
            tail = f" — похоже на «{hint}»" if hint else ""
            self.warnings.append(f"{fname}: пометка «{r.ref}» — {problem}{tail}")

    @staticmethod
    def _no_params_note(
        fname: str,
        catalog: ProjectCatalog,
        owner_id: uuid.UUID,
        container: uuid.UUID | None,
        config_refs: list[DataRefIn],
    ) -> str:
        """Заметка «искать параметры негде» — называет КОНТЕЙНЕР, у которого их ищут
        (Р11): у компонента это его контейнер-предок, у системы контейнера нет вовсе."""
        names = ", ".join(dict.fromkeys(r.ref for r in config_refs))
        where = catalog.node_paths.get(owner_id, "объект окна")
        if container is None and catalog.elements.effective(owner_id) == "system":
            return (
                f"{fname}: «{where}» — система; пометки «зависит от:» ({names}) ищут "
                "параметры у контейнера, а у системы их нет — адресуйте схему "
                "контейнеру или компоненту"
            )
        if container is not None and container != owner_id:
            return (
                f"{fname}: у контейнера «{catalog.node_paths.get(container, '?')}» "
                f"конфигурация не описана — пометки «зависит от:» в схемах «{where}» "
                f"({names}) останутся ненайденными, пока её не опишут"
            )
        return (
            f"{fname}: у объекта «{where}» конфигурация не описана — пометки "
            f"«зависит от:» ({names}) останутся ненайденными, пока её не опишут"
        )

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
        # У конфигурации общей заметки нет: её каталог у каждого контейнера свой, и
        # пустой у контейнера владельца схемы check называет поимённо (контейнер и
        # пометки).


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
    flat, fulls, by_bare, by_path = NodeIndex.of(nodes)
    by_node_id = {n.id: i for i, n in enumerate(flat)}
    # Кто из узлов с вложенными объектами (есть дети). Собственные схемы логики у
    # такого узла законны, но продукт считает их запахом: их ловит замечание AL24 и
    # лечит перенос по детям. Блокировать пакет из-за этого жестоко — предупреждаем
    # (полевой QA Zabbix 7), словами элемента архитектуры (_logic_note).
    with_children = {n.parent_id for n in nodes if n.parent_id is not None}
    # Элементы архитектуры — одни на план: спецификация едет ближайшему контейнеру
    # (_spec_target), а окно компонента допускает адрес своего контейнера.
    elements = build_elements(element_rows_of(nodes))
    window_container = (
        elements.container_of(window_node_id) if window_node_id is not None else None
    )

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
                entry, fname, resolve, flat, by_node_id, window_node_id, scope_ids, plan,
                window_container,
            )
            if idx is None:
                continue
            node, path = flat[idx], fulls[idx]
            existing = {d.name: d for d in node.docs}

            if entry.logic and node.id in with_children:
                plan.warnings.append(_logic_note(fname, path, elements.effective(node.id)))

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
            # Схемы логики записи остались у её узла, спецификация — у контейнера.
            spec_idx = _spec_target(fname, idx, flat, fulls, by_node_id, elements, plan)
            node, path = flat[spec_idx], fulls[spec_idx]
            owner = spec_owner.get(node.id)
            if owner == fname:
                plan.errors.append(f"{fname}: дубль OpenAPI-спецификации у узла «{path}» в одном файле")
                continue
            if owner is not None:
                plan.conflicts.append(
                    f"OpenAPI-спецификация узла «{path}» уже задана файлом {owner} — "
                    f"вход из {fname} пропущен"
                )
                continue
            spec_owner[node.id] = fname
            content = assets.get(entry.openapi.file)
            if content is None:
                plan.errors.append(
                    f'{fname}: файл спецификации "{entry.openapi.file}" не найден среди загруженных'
                )
                continue
            used_assets.add(entry.openapi.file)
            source = entry.openapi.file
            if entry.openapi.origin is None:
                plan.warnings.append(
                    f"{fname}: у спецификации узла «{path}» не указано происхождение (origin)"
                )
            valid_yaml, looks, ver = spec_check(content)
            if not valid_yaml:
                plan.warnings.append(f"спецификация узла «{path}» ({source}) не разбирается как YAML")
            elif not looks:
                plan.warnings.append(
                    f"спецификация узла «{path}» ({source}) не похожа на OpenAPI: нет openapi/paths"
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
        plan.warnings.append(f'файл "{name}" не пригодился — ни схема, ни спецификация')
    data_refs.flush(plan)
    return plan


class DocsApplyResult(NamedTuple):
    """Итог записи плана доков (аудит Q-25: был безымянный 4-кортеж)."""

    created: int  # создано доков
    updated: int  # перезаписано доков
    specs: int  # спек записано
    filled: int  # заполнено заглушек


def apply_docs_plan(db: Session, plan: DocsPlan) -> DocsApplyResult:
    """Записать действия плана. Заполнение идёт тем же путём, что перезапись (та же строка
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
    return DocsApplyResult(created, updated, specs, filled)


# ── Каталоги для промпта и разбор загруженных файлов (аудит Q-38: жили в роутере) ──

def prompt_name_catalogs(
    db: Session, project_id: uuid.UUID, slice_ids: set[uuid.UUID] | None = None
) -> tuple[dict[str, list[str]], dict[str, list[str]], dict[str, list[str]]]:
    """Каталоги имён для промпта: «путь узла → таблицы», «путь узла → каналы» и «путь
    контейнера → параметры конфигурации». Последний — ТОЛЬКО по контейнерам узлов среза
    slice_ids, включая контейнер-предок вне среза (промпт со страницы компонента режет
    срез до его поддерева, а ручки живут у контейнера, Р11): резолв «зависит от:»
    смотрит на ближайший контейнер владельца схемы, чужие ручки в перечне были бы
    ловушкой. Без среза — все контейнеры с параметрами.

    Имя пишется так, как его видит РЕЗОЛВЕР пометок: у таблицы с разделом и у канала
    с группой — «группа.имя». Каталог по всему проекту (а не по срезу node_id):
    пометка адресует любую базу и любой брокер проекта, и урезанный перечень отправил
    бы агента чинить верные имена (находка №1 docs/qa-zulip-brokers.md).
    """
    catalog = catalog_for_project(db, project_id)
    node_paths = catalog.node_paths
    table_catalog: dict[str, list[str]] = {}
    for t in catalog.tables:
        path = node_paths.get(t.node_id)
        if path is not None:
            table_catalog.setdefault(path, []).append(
                f"{t.schema_name}.{t.name}" if t.schema_name else t.name
            )
    channel_catalog: dict[str, list[str]] = {}
    for c in catalog.channels:
        path = node_paths.get(c.node_id)
        if path is not None:
            channel_catalog.setdefault(path, []).append(
                f"{c.group_name}.{c.name}" if c.group_name else c.name
            )
    containers = (
        {catalog.elements.container_of(n) for n in slice_ids}
        if slice_ids is not None
        else None
    )
    param_catalog: dict[str, list[str]] = {}
    for node_id, names in catalog.params_by_node.items():
        # Свои параметры компонента или системы (данные прежнего правила) пометка не
        # найдёт — в перечень их не несём.
        if catalog.elements.container_of(node_id) != node_id:
            continue
        if containers is not None and node_id not in containers:
            continue
        path = node_paths.get(node_id)
        if path is not None and names:
            param_catalog[path] = sorted(names)
    return table_catalog, channel_catalog, param_catalog


def entry_point_catalogs(
    db: Session, nodes: list[Node]
) -> tuple[dict[str, list[str]], dict[str, list[str]]]:
    """Точки входа среза, разделённые надвое: описанные и ждущие описания (Ф3).

    Каталог — по узлам СРЕЗА (а не всего проекта): адреса в нём должны совпадать с
    путями из вложенного среза схемы, иначе агент увидит перечень для объектов,
    которых в срезе нет.

    Тела схем НЕ грузим: у монолита их две сотни, а вопрос тут булев — тянуть ради
    него мегабайты mermaid нельзя. «Описана» считает выражение в БД (NodeDoc.described,
    длина тела после trim), тем же способом, что признак в мете витрины.
    """
    path_by_id = NodeIndex.of(nodes).path_by_id()
    described: dict[str, list[str]] = {}
    pending: dict[str, list[str]] = {}
    rows = (
        db.query(NodeDoc.node_id, NodeDoc.name, NodeDoc.operation, NodeDoc.described)
        .filter(NodeDoc.node_id.in_(path_by_id))
        .all()
    )
    for node_id, name, operation, is_described in rows:
        path = path_by_id.get(node_id)
        if path is None:
            continue
        # Адрес операции показываем рядом с именем, когда они разошлись: агент назвал
        # схему по-человечески, и без адреса перечень не отвечает «что уже закрыто».
        подпись = f"{name} ({operation})" if operation and operation != name else name
        (described if is_described else pending).setdefault(path, []).append(подпись)
    return described, pending


def plan_from_upload(
    db: Session,
    project_id: uuid.UUID,
    files: list[tuple[str, str]],
    overrides: dict[str, MmdOverride],
    only: DocsOnly | None,
    window: uuid.UUID | None,
    overwrite: bool,
) -> DocsPlan:
    """Разбор загруженных файлов пакета → план. Схема логики опознаётся ПО
    СОДЕРЖИМОМУ (расширение, шапка или начало диаграммы), остальное — кандидат в
    файл спеки. Ошибки блокируют план целиком: частичный план вводил бы в
    заблуждение кнопку «Применить»."""
    entries: list[tuple[str, ParsedPkg]] = []
    assets: dict[str, str] = {}
    errors: list[str] = []
    notes: list[str] = []
    for fname, content in files:
        if looks_like_mermaid(fname, content):
            # Схема логики самодостаточна: метаданные — в её шапке.
            parsed_mmd, mmd_notes = pkg_from_mmd(fname, content, overrides.get(fname))
            entries.append((fname, parsed_mmd))
            notes.extend(mmd_notes)
        else:
            # Всё остальное — ресурс (кандидат в файл спеки). Дубль имени: последний
            # побеждает молча (имена в одной папке уникальны по построению).
            assets[fname] = content
    if only == "api" and window is not None and assets:
        # Окно спеки: пакет — сам файл спеки, конверт не нужен (объект известен
        # из окна, спека у него одна). Из нескольких файлов выбираем похожий на
        # OpenAPI; если таких несколько — спрашиваем, а не угадываем.
        # Условие НЕ «файлов больше нет»: пользователь вправе перетащить всю
        # папку archmap-docs целиком, и спеку в ней надо найти, а не потерять
        # среди схем логики.
        picked = [n for n, c in assets.items() if spec_check(c)[1]] or list(assets)
        if len(picked) == 1:
            entries.append((picked[0], pkg_from_spec(picked[0], assets[picked[0]])))
        elif len(picked) > 1:
            errors.append("в пакете несколько файлов спецификации: " + ", ".join(sorted(picked)))
    if not entries and not errors:
        errors.append("среди загруженных файлов нет ни схемы (.mmd), ни файла спецификации")
    if errors:
        plan = DocsPlan()
        plan.errors = errors
        return plan
    # Тела ЖИВЫХ схем здесь нужны: план сравнивает текст пакета с текущим
    # («unchanged» / заполнение заглушки), а тело — отложенная колонка. Без undefer
    # мердж вытянул бы их по одной на схему — у монолита это две сотни запросов.
    nodes = (
        db.query(Node)
        .options(selectinload(Node.docs).undefer(NodeDoc.content))
        .filter(Node.project_id == project_id)
        .all()
    )
    scope_ids = None
    if window is not None:
        by_id = {n.id: n for n in nodes}
        scope_ids = tree.subtree_ids(by_id, window) if window in by_id else set()
    # db/project_id — только для резолва пометок данных в текстах схем (превью
    # обязано показывать битые «читает:/пишет:» так же, как плашка редактора).
    plan = build_docs_plan(
        nodes, entries, assets, overwrite, window, scope_ids,
        db=db, project_id=project_id,
    )
    plan.warnings.extend(notes)
    # Раздельные окна дозаливки: окно логики применяет только схемы логики, окно
    # спеки — только OpenAPI-спеки (сущности не смешиваются даже в смешанном манифесте).
    if only == "logic":
        plan.specs = []
    elif only == "api":
        plan.logic = []
    return plan
