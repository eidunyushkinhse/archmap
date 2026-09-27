"""Пометки обращений к данным и каналам в тексте схем логики (пивот §9 plan-db-docs.md).

Обращение «операция читает/пишет таблицу.колонку» живёт ОДИН раз — строкой в самой
диаграмме: A["Списать средства<br>пишет: accounts.balance"]. Здесь — разбор таких
пометок и их резолв в таблицы структуры. Паттерн doc-комментариев: проза для
человека, пометка в прозе — для машины; индекс из неё производен и разойтись с
текстом не может.

То же самое для событий (docs/plan-broker-docs.md §3): «публикует:/потребляет:»
адресует КАНАЛ брокера — со своими маркерами и своим каталогом. Слова разные не для
красоты: семантика доставки ≠ семантика записи, а раздельные каталоги убирают целый
класс двусмысленностей — одноимённые таблица `orders` и канал `orders` не конфликтуют
по построению, и «пишет: orders» с «публикует: orders» ведут в разные места.

Третья семья — конфигурация (docs/plan-config-docs.md §5): «зависит от:» адресует
ПАРАМЕТР самого сервиса, потому что развилка зависит не только от данных («если
статус paid»), но и от ручек («если FEATURE_X включён»). Каталог тоже свой, но
область поиска у него уже: не проект, а один узел — владелец схемы. Отсюда и
отсутствие квалификатора, и невозможность неоднозначности.

Обе функции ЧИСТЫЕ. Резолв зовётся на чтении (usage, превью, алерты), а не на
записи: он — функция от (пометки, каталоги, пути узлов), и это убирает все точки
инвалидации (переименование таблицы/канала/раздела/узла, удаление колонки/поля).
"""

import re
import uuid
from dataclasses import dataclass
from typing import Literal

from sqlalchemy.orm import Session

from app.docs_import import _node_paths
from app.models.broker_channel import BrokerChannel
from app.models.config_param import ConfigParam
from app.models.db_table import DbTable
from app.models.node import Node

Mode = Literal["read", "write", "publish", "consume", "config"]
RefStatus = Literal[
    "ok",
    # Табличная семья (read/write).
    "unknown_table",
    "unknown_column",
    # Канальная семья (publish/consume).
    "unknown_channel",
    "unknown_field",
    # Конфигурационная семья (config). Пары «нет параметра / нет члена» у неё нет:
    # параметр плоский, второго уровня не бывает.
    "unknown_param",
    # Общий для табличной и канальной: имя подошло нескольким целям, выбрать за
    # пользователя нельзя. Конфигурации он НЕДОСТУПЕН по построению — искать её
    # можно только у владельца схемы, а там имя уникально (см. _resolve_config).
    "ambiguous",
]

# Режимы, адресующие КАНАЛЫ. Каталог у них свой: read/write ищутся только среди
# таблиц, publish/consume — только среди каналов. Смешать их значило бы вернуть
# двусмысленность, которой раздельные маркеры как раз и избегают.
CHANNEL_MODES: frozenset[Mode] = frozenset({"publish", "consume"})
# Режим КОНФИГУРАЦИИ — третий каталог, у которого своя область поиска: не проект, а
# один узел (docs/plan-config-docs.md §5).
CONFIG_MODES: frozenset[Mode] = frozenset({"config"})

# Маркер пометки: слово + двоеточие. Русский и английский — проекты бывают и с
# латинскими подписями. \b отсекает «перечитает:» и подобные вхождения внутри слова.
# Маркер бывает и ИЗ ДВУХ СЛОВ («зависит от»): пробел внутри разворачивается в \s+,
# поэтому «зависит  от:» с двойным пробелом и перенос строки между словами читаются
# так же, как канонический вид.
_MARKER_MODE: dict[str, Mode] = {
    "читает": "read",
    "reads": "read",
    "пишет": "write",
    "writes": "write",
    "публикует": "publish",
    "publishes": "publish",
    "потребляет": "consume",
    "consumes": "consume",
    "зависит от": "config",
    "depends on": "config",
}
_MARKER_WORDS = "|".join(w.replace(" ", r"\s+") for w in _MARKER_MODE)
# Хвост — до терминатора: конец строки, кавычка подписи, закрывающая скобка
# mermaid-вершины или начало тега (<br>). mermaid НЕ парсим: пометка в подписи ребра
# или заголовке subgraph тоже считается — это дешевле и предсказуемее разбора
# синтаксиса, а слово «читает:» в прозе трактуем как обещание факта (spec.md).
#
# СЛИТНАЯ форма «читает/пишет:» («reads/writes:», «публикует/потребляет:», пробелы
# вокруг слэша допустимы) — естественная для языка: агент пишет её сам (полевой QA
# Zabbix 7). Раньше из неё бралось только «пишет», и читающая половина факта молча
# терялась; теперь маркер обещает ОБА факта, и каждая ссылка после него даёт две
# пометки. Смешанные слитные формы («пишет/публикует:») грамматика не запрещает —
# каждая половина просто резолвится по своему каталогу.
_MENTION = re.compile(
    rf"(?i)\b({_MARKER_WORDS})((?:\s*/\s*(?:{_MARKER_WORDS}))*)\s*:\s*([^\n\"\]\)\}}<|]*)"
)
# Пометка в подписи РЕБРА без кавычек не имеет своего терминатора: за ней сразу идёт
# стрелка mermaid («A -- читает: orders --> B», петля «J -.зависит от: X.->J»), и
# хвост уезжал в ссылку («orders --> B», «X.->J» — находка P4 замеров docs-quality).
# Режем по началу стрелки: «--», «==», «.-»/«-.» (пунктир) или пробел перед
# стрелочным символом. Подпись «-->|пишет: x|» закрывает «|» — он в терминаторах выше.
# В именах таблиц и каналов эти пары не встречаются: одиночные точка и дефис — да.
_EDGE_TAIL = re.compile(r"\s*(?:-{2,}|={2,}|\.-|-\.)|\s+[-=.>]")


@dataclass(frozen=True)
class DataRefIn:
    """Разобранная пометка: как написано в доке + режим."""

    ref: str
    mode: Mode


def _modes_of(marker: str) -> list[Mode]:
    """Режимы маркера в порядке написания: у слитного их два, у обычного один."""
    out: list[Mode] = []
    for word in marker.split("/"):
        # Схлопываем внутренние пробелы: маркер бывает из двух слов, и «зависит  от»
        # с двойным пробелом (или с переносом строки) — тот же самый маркер.
        mode = _MARKER_MODE.get(" ".join(word.split()).lower())
        if mode is not None and mode not in out:
            out.append(mode)
    return out


def parse_data_refs(content: str) -> list[DataRefIn]:
    """Извлечь пометки из текста дока. Дедуп по (ссылка, режим), порядок появления."""
    out: list[DataRefIn] = []
    seen: set[tuple[str, str]] = set()
    for m in _MENTION.finditer(content):
        modes = _modes_of(m.group(1) + m.group(2))
        for raw in _EDGE_TAIL.split(m.group(3), maxsplit=1)[0].split(","):
            ref = " ".join(raw.split())  # схлопнуть переносы/двойные пробелы
            if not ref:
                continue
            for mode in modes:
                key = (ref, mode)
                if key in seen:
                    continue
                seen.add(key)
                out.append(DataRefIn(ref=ref, mode=mode))
    return out


@dataclass(frozen=True)
class CatalogTable:
    """Таблица структуры в виде, достаточном для резолва (без ORM)."""

    id: uuid.UUID
    node_id: uuid.UUID
    schema_name: str
    name: str
    columns: dict[str, uuid.UUID]  # имя колонки → id


@dataclass(frozen=True)
class CatalogChannel:
    """Канал структуры брокера — зеркало CatalogTable для событий.

    Группа канала (vhost/namespace/account) играет ту же роль, что раздел у таблицы,
    а поле сообщения — ту же, что колонка: грамматика ссылки от этого одна и та же.
    ОТЛИЧИЕ ОДНО: точка бывает частью самого имени («orders.created» — норма Kafka),
    поэтому у каналов резолв пробует ещё две гипотезы (см. _pick).
    """

    id: uuid.UUID
    node_id: uuid.UUID
    group_name: str
    name: str
    fields: dict[str, uuid.UUID]  # имя поля → id


@dataclass(frozen=True)
class ResolvedRef:
    ref: str
    mode: Mode
    status: RefStatus
    # Табличная семья. Заполнены при status ok/unknown_column (unknown_column =
    # таблица нашлась, колонки нет — обращение считается к таблице целиком, но
    # подсвечивается).
    table_id: uuid.UUID | None = None
    column_id: uuid.UUID | None = None
    column_name: str | None = None
    # Канальная семья — то же самое по построению (unknown_field = канал нашёлся,
    # поля нет → обращение к каналу целиком).
    channel_id: uuid.UUID | None = None
    field_id: uuid.UUID | None = None
    field_name: str | None = None
    # Конфигурационная семья. Второго поля («член») нет и не будет: параметр плоский.
    param_id: uuid.UUID | None = None


# Голая часть ссылки — токен без пробелов: буквы/цифры/_/-/точки. Проза после
# маркера («читает: договор из архива») токеном не является и резолв не пройдёт —
# осознанно: маркер обещает факт, невыполненное обещание должно быть видно.
_TOKEN = re.compile(r"^[\w.\-]+$")
# У каналов в имени законно и двоеточие: ключи Redis Pub/Sub («timeline:public»,
# «timeline:hashtag:rails») — норма именования, как точка у Kafka. Таблицам его не
# даём: там «x:y» не бывает, и лишняя гибкость только маскировала бы опечатки.
_CHANNEL_TOKEN = re.compile(r"^[\w.\-:]+$")


def _node_matches(path: str, qualifier: str) -> bool:
    """Квалификатор узла: полный путь, суффикс пути по границе « / » или голое имя."""
    if path == qualifier or path.endswith(f" / {qualifier}"):
        return True
    return path.rpartition(" / ")[2] == qualifier


@dataclass(frozen=True)
class _Entry:
    """Обезличенная запись каталога: владелец → (группа) → имя → члены.

    Универсальная форма §2а плана: у таблицы это «БД → раздел → таблица → колонки»,
    у канала — «брокер → группа → канал → поля сообщения». Общая часть резолва
    (гипотезы, квалификатор, неоднозначность) написана ОДИН раз против неё, иначе
    две копии грамматики разъехались бы на первой же правке.
    """

    id: uuid.UUID
    node_id: uuid.UUID
    group: str
    name: str
    members: dict[str, uuid.UUID]


@dataclass(frozen=True)
class _Pick:
    """Итог общей части: что нашлось и какой член запрошен."""

    entry: _Entry | None
    member: str | None
    ambiguous: bool = False


def _pick(
    ref: str,
    entries: list[_Entry],
    node_paths: dict[uuid.UUID, str],
    dotted_name: bool = False,
) -> _Pick:
    """Найти цель ссылки в каталоге. Никакой магии предпочтений: неоднозначное имя
    требует квалификатора «Узел / имя», а не угадывается по связям.

    dotted_name — «точка может быть ЧАСТЬЮ ИМЕНИ» (каналы: «orders.created» —
    норма именования Kafka). Асимметрия осознанная: у таблиц точки в именах редки,
    и лишние гипотезы там только плодили бы неоднозначность на ровном месте. Тот же
    флаг пускает в имя двоеточие (_CHANNEL_TOKEN) — оно делителем не служит никогда.
    """
    qualifier, _, bare = ref.rpartition(" / ")
    parts = bare.split(".")
    token = _CHANNEL_TOKEN if dotted_name else _TOKEN
    # Пустой сегмент («orders.», «.status», «a..b») — битая ссылка, а не «таблица
    # с неизвестной колонкой»: гадать о намерении не берёмся.
    if not token.match(bare) or any(not p for p in parts):
        return _Pick(entry=None, member=None)

    scope = (
        [e for e in entries if _node_matches(node_paths.get(e.node_id, ""), qualifier)]
        if qualifier
        else entries
    )

    # Гипотезы (группа, имя, член). У «x.y» их ДВЕ: «таблица x, колонка y» и
    # «раздел x, таблица y» — обе сработали → неоднозначно, молча выбирать нельзя.
    hypos: list[tuple[str | None, str, str | None]] = []
    if len(parts) == 1:
        hypos.append((None, parts[0], None))
    elif len(parts) == 2:
        hypos += [(None, parts[0], parts[1]), (parts[0], parts[1], None)]
    elif len(parts) == 3:
        hypos.append((parts[0], parts[1], parts[2]))
    elif not dotted_name:
        # Четыре сегмента и больше — за пределами «раздел.таблица.колонка».
        return _Pick(entry=None, member=None)

    if dotted_name and len(parts) > 1:
        # ЕЩЁ ДВЕ гипотезы, равноправные с остальными: имя канала целиком
        # («orders.created», «orders.created.v2») и имя минус последний сегмент —
        # он тогда поле («orders.created.user_id»). Совпало больше одной гипотезы —
        # обычная неоднозначность, лечится квалификатором «Брокер / канал».
        hypos.append((None, bare, None))
        hypos.append((None, bare.rpartition(".")[0], parts[-1]))
    # Дедуп с сохранением порядка: «x.y» даёт «канал x, поле y» и классической
    # гипотезой, и новой — один и тот же смысл не должен считаться двумя попаданиями.
    hypos = list(dict.fromkeys(hypos))

    hits: list[tuple[_Entry, str | None]] = []
    for group, name, member in hypos:
        for e in scope:
            if e.name == name and (group is None or e.group == group):
                hits.append((e, member))

    if not hits:
        return _Pick(entry=None, member=None)
    if len(hits) > 1:
        return _Pick(entry=None, member=None, ambiguous=True)
    entry, member = hits[0]
    return _Pick(entry=entry, member=member)


def resolve_data_refs(
    refs: list[DataRefIn],
    tables: list[CatalogTable],
    channels: list[CatalogChannel],
    node_paths: dict[uuid.UUID, str],
    *,
    owner_params: dict[str, uuid.UUID],
) -> list[ResolvedRef]:
    """Резолв пометок по СВОЕМУ каталогу: read/write — только по таблицам,
    publish/consume — только по каналам, «зависит от:» — только по конфигурации
    ВЛАДЕЛЬЦА схемы. Одноимённые таблица, канал и параметр друг друга не видят:
    разные маркеры адресуют разные миры (решение §7.1 plan-broker-docs.md).

    owner_params — параметры узла, которому принадлежит РАЗБИРАЕМЫЙ текст
    («имя → id»), обязательный аргумент. Именно обязательный, а не с дефолтом:
    забытый каталог давал бы не пустой ответ, а поток ложных «параметра нет», и
    решение «конфигурации здесь нет» обязано быть осознанным на каждом вызове.
    """
    table_entries = [
        _Entry(id=t.id, node_id=t.node_id, group=t.schema_name, name=t.name, members=t.columns)
        for t in tables
    ]
    channel_entries = [
        _Entry(id=c.id, node_id=c.node_id, group=c.group_name, name=c.name, members=c.fields)
        for c in channels
    ]
    out: list[ResolvedRef] = []
    for r in refs:
        if r.mode in CONFIG_MODES:
            out.append(_resolve_config(r, owner_params))
        elif r.mode in CHANNEL_MODES:
            out.append(_resolve_channel(r, channel_entries, node_paths))
        else:
            out.append(_resolve_table(r, table_entries, node_paths))
    return out


def _resolve_config(r: DataRefIn, owner_params: dict[str, uuid.UUID]) -> ResolvedRef:
    """Резолв «зависит от:» — точным совпадением имени среди параметров ВЛАДЕЛЬЦА.

    Ни _pick, ни его гипотез здесь нет, и это не упрощение задним числом, а свойство
    семьи (docs/plan-config-docs.md §3): у пометки ровно одно место, где цель может
    найтись, — конфигурация этого же объекта. Отсюда всё сразу:
      • квалификатор «Узел / имя» не нужен — искать за пределами узла незачем;
      • точка НЕ делит ссылку («feature.new_checkout» — целое имя параметра, а не
        «группа feature, параметр new_checkout»): групп у конфигурации нет;
      • «ambiguous» невозможен — имя параметра уникально в пределах узла (БД сторожит
        это ограничением), а второго кандидата взять просто неоткуда.
    Регистр значим: LOG_LEVEL и log_level в окружении — разные переменные.
    """
    param_id = owner_params.get(r.ref)
    if param_id is None:
        return ResolvedRef(ref=r.ref, mode=r.mode, status="unknown_param")
    return ResolvedRef(ref=r.ref, mode=r.mode, status="ok", param_id=param_id)


def _resolve_table(
    r: DataRefIn, entries: list[_Entry], node_paths: dict[uuid.UUID, str]
) -> ResolvedRef:
    got = _pick(r.ref, entries, node_paths)
    if got.entry is None:
        status: RefStatus = "ambiguous" if got.ambiguous else "unknown_table"
        return ResolvedRef(ref=r.ref, mode=r.mode, status=status)
    if got.member is None:
        return ResolvedRef(ref=r.ref, mode=r.mode, status="ok", table_id=got.entry.id)
    col_id = got.entry.members.get(got.member)
    if col_id is None:
        return ResolvedRef(
            ref=r.ref, mode=r.mode, status="unknown_column", table_id=got.entry.id
        )
    return ResolvedRef(
        ref=r.ref,
        mode=r.mode,
        status="ok",
        table_id=got.entry.id,
        column_id=col_id,
        column_name=got.member,
    )


def _resolve_channel(
    r: DataRefIn, entries: list[_Entry], node_paths: dict[uuid.UUID, str]
) -> ResolvedRef:
    # dotted_name=True — только у каналов: «orders.created» это ОДНО имя топика, а
    # не «группа orders, канал created» (см. _pick).
    got = _pick(r.ref, entries, node_paths, dotted_name=True)
    if got.entry is None:
        status: RefStatus = "ambiguous" if got.ambiguous else "unknown_channel"
        return ResolvedRef(ref=r.ref, mode=r.mode, status=status)
    if got.member is None:
        return ResolvedRef(ref=r.ref, mode=r.mode, status="ok", channel_id=got.entry.id)
    field_id = got.entry.members.get(got.member)
    if field_id is None:
        # Поля нет → обращение к каналу ЦЕЛИКОМ (зеркало unknown_column): событие
        # всё равно ходит через этот канал, а расхождение подсветит алерт.
        return ResolvedRef(
            ref=r.ref, mode=r.mode, status="unknown_field", channel_id=got.entry.id
        )
    return ResolvedRef(
        ref=r.ref,
        mode=r.mode,
        status="ok",
        channel_id=got.entry.id,
        field_id=field_id,
        field_name=got.member,
    )


# ── ORM-адаптер: каталог из БД ────────────────────────────────────────────────
# Единственное место, где чистый резолв встречается с базой. Кэша нет и не будет
# (§9.3 плана): каталог собирается на каждом чтении — сотни таблиц в памяти дешевле
# любой инвалидации (переименование таблицы/раздела/узла, удаление колонки).


def catalog_for_project(
    db: Session, project_id: uuid.UUID
) -> tuple[
    list[CatalogTable],
    list[CatalogChannel],
    dict[uuid.UUID, dict[str, uuid.UUID]],
    dict[uuid.UUID, str],
]:
    """Таблицы, каналы и конфигурация проекта в виде каталогов + полные пути узлов.

    Первые два каталога — по ВСЕМУ проекту, а не по одному узлу: неоднозначность
    имени есть свойство проекта, и «orders» обязано считаться неоднозначным
    независимо от того, чью страницу сейчас читают. Пути — те же, что у импорта
    (`_node_paths`): квалификатор пометки пишется так же, как адрес узла в пакете
    агента.

    Конфигурация же приходит РАЗЛОЖЕННОЙ ПО УЗЛАМ («узел → имя параметра → id»), и
    иначе быть не может: её резолв смотрит только на владельца схемы, так что общий
    плоский список был бы для него не просто лишним, а вредным — он позволил бы
    сослаться на чужую ручку.
    """
    nodes: list[Node] = db.query(Node).filter(Node.project_id == project_id).all()
    flat, fulls, _by_bare, _by_path = _node_paths(nodes)
    node_paths: dict[uuid.UUID, str] = {n.id: fulls[i] for i, n in enumerate(flat)}

    tables: list[DbTable] = (
        db.query(DbTable)
        .join(Node, Node.id == DbTable.node_id)
        .filter(Node.project_id == project_id)
        .all()
    )
    table_catalog = [
        CatalogTable(
            id=t.id,
            node_id=t.node_id,
            schema_name=t.schema_name,
            name=t.name,
            columns={c.name: c.id for c in t.columns},
        )
        for t in tables
    ]

    channels: list[BrokerChannel] = (
        db.query(BrokerChannel)
        .join(Node, Node.id == BrokerChannel.node_id)
        .filter(Node.project_id == project_id)
        .all()
    )
    channel_catalog = [
        CatalogChannel(
            id=c.id,
            node_id=c.node_id,
            group_name=c.group_name,
            name=c.name,
            fields={f.name: f.id for f in c.fields},
        )
        for c in channels
    ]

    params: list[ConfigParam] = (
        db.query(ConfigParam)
        .join(Node, Node.id == ConfigParam.node_id)
        .filter(Node.project_id == project_id)
        .all()
    )
    params_by_node: dict[uuid.UUID, dict[str, uuid.UUID]] = {}
    for p in params:
        params_by_node.setdefault(p.node_id, {})[p.name] = p.id

    return table_catalog, channel_catalog, params_by_node, node_paths
