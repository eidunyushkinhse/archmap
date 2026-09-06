"""Дозаливка КАНАЛОВ брокера от агента (BYOA, Ф4 plan-broker-docs.md).

Зеркало data_import по устройству (толерантный разбор, адрес ведущим комментарием
«# archmap-node: …», удалений нет), но с другой политикой слияния — и она вытекает не
из вкуса, а из того, что у брокера НЕТ репозитория-владельца (§5 плана). Каналы
объявлены в коде публикующих и потребляющих, поэтому один и тот же топик приезжает
пакетами из РАЗНЫХ репозиториев, и второй пакет обязан ДОЛИТЬ поля к уже описанному
каналу, а не переоткрыть его.

Тот же дубль бывает и ВНУТРИ одного пакета: файлы собраны разными прогонами агента,
и перечень очередей брокера пересекается с подробным файлом по одной из них. Правило
одно на оба случая — слить в один канал, первый описавший побеждает (_merge_duplicate).

Отсюда конфликт меты: два репозитория честно видят разное (у продюсера настроен
retention, консьюмер знает свою гарантию доставки). Молча перетереть значение —
худшее из решений: карта начнёт менять смысл от порядка загрузки пакетов. Поэтому
без overwrite побеждает УЖЕ ОПИСАННОЕ, а расхождение выносится предупреждением —
человек видит его в окне и может скопировать агенту.

Обращения («кто публикует orders.created») сюда не приезжают: они живут пометками
«публикует:/потребляет:» в тексте схем логики (пивот §1).
"""

import re
import uuid
from collections import defaultdict
from dataclasses import dataclass, field

import yaml
from sqlalchemy.orm import Session

from app.data_import import NODE_HEADER
from app.docs_import import _closest_name, _node_paths
from app.models.broker_channel import BrokerChannel
from app.models.channel_field import ChannelField
from app.models.edge import Edge
from app.models.node import Node
from app.schemas.channels_import import ChannelItem, ChannelsImportReport

# «Файл ПОХОЖ на наш» — по разделу верхнего уровня. Нужен, чтобы отличить чужой файл
# пакета (схему логики, спеку, структуру БД) от НАШЕГО, но с битым YAML: молча
# пропустив второй, мы сказали бы «в пакете нет файлов с каналами», хотя каналы там
# есть, — ровно та ошибка, которую разбирали на дозаливке структуры БД.
LOOKS_LIKE_CHANNELS = re.compile(r"^channels:", re.MULTILINE)

# Мета канала, расхождение которой между пакетами РАЗНЫХ репозиториев значимо: по ней
# принимают решения (порядок применения, идемпотентность, глубина переигрывания).
# Ключи — как в YAML пакета: замечание уходит агенту, и он должен узнать своё поле.
# description сюда НЕ входит намеренно: два репозитория опишут канал разными словами
# почти всегда, и предупреждение об этом было бы шумом, хоронящим настоящие.
META_KEYS = ("kind", "partition_key", "delivery", "retention")

# Кап предупреждений о сомнительной адресации на весь план: замечания уезжают агенту
# ОДНИМ списком, и один класс не должен вытеснить остальные (приём пометок данных).
MAX_ADDRESS_WARNINGS = 8
# Свой кап у непокрытых каналов связей — чтобы один класс не съедал квоту другого.
MAX_COVERAGE_WARNINGS = 8
# Свой кап у каналов, описанных НЕСКОЛЬКИМИ файлами пакета. Считает КАНАЛЫ, а не
# строки: к заметке о дубле может добавиться расхождение меты между файлами.
MAX_DUPLICATE_WARNINGS = 8
# ЗАГЛУШКА КАНАЛА ПО СВЯЗИ. Импорт C4 заводит брокеру запись на каждое имя канала,
# названное связью (Edge.channel), — иначе честная схема сильной модели сразу после
# ввоза тонула в «канал «X» не найден у брокера» (Ф-D эпика BYOA: 59 из 60 замечаний).
# Текст — сразу и объяснение пользователю в карточке канала, и признак «не описан» для
# машины: сверка покрытия (Ф8е) такие каналы описанием брокера НЕ считает, а пакет
# каналов, описавший канал, заполняет заглушку целиком и без overwrite (это её
# первое описание, а не спор с описанным раньше). Правит описание человек — маркер
# уходит, канал считается описанным им. КОНСТАНТУ НЕ МЕНЯТЬ без миграции данных:
# записи в БД узнаются по ней.
EDGE_STUB_DESCRIPTION = (
    "Заведён импортом по связи схемы: канал назван на стрелке, но структурой брокера "
    "ещё не описан — дозалейте пакет каналов или заполните поля."
)


def split_channel_names(raw: str | None) -> list[str]:
    """Имена каналов из поля связи (Edge.channel), в порядке написания, без дублей.

    Перечень («email, notify_orders») расщепляем по запятой и «;»: превью импорта
    такую связь ругает (Ф8г), но в живом проекте она уже может быть, и работать надо
    с ИМЕНАМИ, а не со строкой целиком.
    """
    if not raw:
        return []
    out: list[str] = []
    for part in raw.replace(";", ",").split(","):
        name = part.strip()
        if name and name not in out:
            out.append(name)
    return out


def is_edge_stub(channel: BrokerChannel) -> bool:
    """Заглушка по связи, а не описание брокера (см. EDGE_STUB_DESCRIPTION)."""
    return channel.description == EDGE_STUB_DESCRIPTION


def seed_edge_channel_stubs(
    db: Session, project_id: uuid.UUID, edges: list[Edge] | None = None
) -> int:
    """Завести заглушки каналов по связям проекта; вернуть число заведённых.

    Перечень — ТОТ ЖЕ минимум пакета, который просит промпт каналов и сверяет превью
    (edge_channel_minimum): у моста «брокер → брокер» имя достаётся обоим концам,
    перечень «a, b» в channel даёт заглушку на каждое имя (сама связь при этом
    остаётся под AL31 — ей велено разделиться). Имя, которое брокер уже знает —
    точно либо в форме «группа.канал» (_names_channel, послабления AL31), — не
    дублируется. Зовётся ПОСЛЕ семей фактов: пакет каналов архива описывает канал
    первым, заглушка закрывает только оставшиеся дыры.

    edges — какие связи смотреть: единый импорт отдаёт все связи нового проекта,
    догрузка — только созданные ею (живые связи без канала у брокера — состояние
    проекта до догрузки, а она живого не трогает).
    """
    nodes = db.query(Node).filter(Node.project_id == project_id).all()
    broker_ids = {n.id for n in nodes if n.shape == "broker"}
    if not broker_ids:
        return 0
    if edges is None:
        edges = db.query(Edge).filter(Edge.project_id == project_id).all()
    minimum = edge_channel_minimum(edges, broker_ids)
    if not minimum:
        return 0
    known: dict[uuid.UUID, set[tuple[str, str]]] = defaultdict(set)
    for ch in db.query(BrokerChannel).filter(BrokerChannel.node_id.in_(list(minimum))).all():
        known[ch.node_id].add((ch.group_name, ch.name))
    created = 0
    # Порядок брокеров из словаря зависит от порядка связей в БД — сортируем, чтобы
    # порядок записей (и их created_at) не скакал от прогона к прогону.
    for broker_id in sorted(minimum, key=str):
        for named in minimum[broker_id]:
            if _names_channel(known[broker_id], named):
                continue
            db.add(BrokerChannel(node_id=broker_id, name=named, description=EDGE_STUB_DESCRIPTION))
            known[broker_id].add(("", named))
            created += 1
    db.flush()
    return created


def _stub_by_name(db: Session, node_id: uuid.UUID, name: str) -> BrokerChannel | None:
    """Заглушка по связи с таким именем (группа у заглушек всегда пустая)."""
    return (
        db.query(BrokerChannel)
        .filter(
            BrokerChannel.node_id == node_id,
            BrokerChannel.group_name == "",
            BrokerChannel.name == name,
            BrokerChannel.description == EDGE_STUB_DESCRIPTION,
        )
        .first()
    )


def edge_channel_minimum(
    edges: list[Edge], broker_ids: set[uuid.UUID]
) -> dict[uuid.UUID, dict[str, Edge]]:
    """«Брокер → {имя канала: связь, которая его называет}» — МИНИМУМ пакета.

    Один и тот же перечень уходит в промпт каналов (Ф8д) и сверяется превью (Ф8е):
    обещание, которое даёт промпт, и проверка, которая его контролирует, обязаны
    считать одно и то же — иначе агент выполнит одно, а спросят с него другое.

    У моста «брокер → брокер» имя достаётся обоим концам: чей это канал, схема не
    говорит, а угадывать за пользователя тут нечего.
    """
    out: dict[uuid.UUID, dict[str, Edge]] = {}
    for e in edges:
        names = split_channel_names(e.channel)
        if not names:
            continue
        for end in dict.fromkeys((e.source_id, e.target_id)):
            if end in broker_ids:
                bucket = out.setdefault(end, {})
                for n in names:
                    bucket.setdefault(n, e)  # для текста замечания хватит первой связи
    return out


@dataclass
class FieldIn:
    name: str
    type: str = ""
    required: bool = False
    description: str | None = None


@dataclass
class ChannelIn:
    name: str
    group_name: str = ""
    kind: str = ""
    partition_key: str = ""
    delivery: str = ""
    retention: str = ""
    description: str | None = None
    fields: list[FieldIn] = field(default_factory=list)

    def meta(self, key: str) -> str:
        """Значение меты по ключу пакета — для сверки с описанным раньше."""
        return str(getattr(self, key))


@dataclass
class ParsedChannels:
    node_ref: str | None = None
    channels: list[ChannelIn] = field(default_factory=list)
    # В YAML верхнего уровня есть КЛЮЧ «archmap-node»: агент потерял решётку, и адрес
    # стал невидимым (урок Н11 полевого QA — записи молча уехали к объекту окна).
    # Адресом ключ не считаем (поведение прежнее), но молчать о нём нельзя.
    has_node_key: bool = False


def _as_bool(v: object) -> bool:
    return v is True or (isinstance(v, str) and v.strip().lower() in {"true", "да", "yes", "1"})


def _as_str(v: object) -> str:
    return "" if v is None else str(v).strip()


def parse_channels_file(content: str) -> ParsedChannels | None:
    """Разобрать файл пакета. None — файл не про каналы (пусть его смотрит другой
    разборщик: в пакете рядом лежат и схемы логики, и спеки, и структура БД)."""
    try:
        doc = yaml.safe_load(content)
    except yaml.YAMLError:
        return None
    if not isinstance(doc, dict) or "channels" not in doc:
        return None
    m = NODE_HEADER.search(content)
    out = ParsedChannels(
        node_ref=m.group(1) if m else None,
        has_node_key="archmap-node" in doc,
    )

    for raw in doc.get("channels") or []:
        if not isinstance(raw, dict) or not _as_str(raw.get("name")):
            continue
        c = ChannelIn(
            name=_as_str(raw.get("name")),
            group_name=_as_str(raw.get("group")),
            kind=_as_str(raw.get("kind")),
            partition_key=_as_str(raw.get("partition_key")),
            delivery=_as_str(raw.get("delivery")),
            retention=_as_str(raw.get("retention")),
            description=_as_str(raw.get("description")) or None,
        )
        seen_fields: set[str] = set()
        for rf in raw.get("fields") or []:
            if not isinstance(rf, dict) or not _as_str(rf.get("name")):
                continue
            field_name = _as_str(rf.get("name"))
            # Одно имя поля дважды в одном канале — та же неряшливость агента, что и
            # поле без имени выше, и молча пропустить её тут дешевле, чем ловить
            # уникальностью (channel_id, name) уже на записи: превью показало бы
            # завышенное число полей, а применение упало бы 500-й.
            if field_name in seen_fields:
                continue
            seen_fields.add(field_name)
            c.fields.append(
                FieldIn(
                    name=field_name,
                    type=_as_str(rf.get("type")),
                    required=_as_bool(rf.get("required")),
                    description=_as_str(rf.get("description")) or None,
                )
            )
        out.channels.append(c)

    return out


@dataclass
class ChannelsPlan:
    """План дозаливки: что создастся, что дольётся, что уже такое."""

    report: ChannelsImportReport = field(default_factory=ChannelsImportReport)
    # (узел-владелец, разобранный канал, источник)
    channels: list[tuple[Node, ChannelIn, str]] = field(default_factory=list)
    # Пути узлов проекта: нужны и плану, и применению (резолв адреса владельца).
    path_of: dict[uuid.UUID, str] = field(default_factory=dict)


@dataclass
class _Merged:
    """Канал плана: первое вхождение плюс всё, что долили следующие файлы пакета."""

    owner: Node
    channel: ChannelIn
    # Файл ПЕРВОГО вхождения — он и стоит источником в строке превью.
    source: str
    # Все файлы пакета, описавшие этот канал, в порядке пакета и без повторов.
    files: list[str] = field(default_factory=list)
    # Расхождения меты МЕЖДУ файлами пакета — поимённо, как у расхождения с ArchMap.
    meta_notes: list[str] = field(default_factory=list)


def _broker_nodes_hint(flat: list[Node], fulls: list[str]) -> str:
    """Перечень узлов-брокеров проекта для текстов ошибок.

    Слабая модель адрес ВЫДУМЫВАЕТ, а «объект не найден» без списка допустимых
    заставляет её гадать вслепую — раунд переписки за раунд (уроки Н8/Н11).
    """
    paths = [fulls[i] for i, n in enumerate(flat) if n.shape == "broker"]
    return ", ".join(paths) if paths else "в проекте их нет"


def _resolve_node(
    ref: str | None,
    fname: str,
    flat: list[Node],
    fulls: list[str],
    by_bare: dict[str, list[int]],
    by_path: dict[str, list[int]],
    window: uuid.UUID | None,
    plan: ChannelsPlan,
    broker_hint: str,
) -> Node | None:
    """Узел по адресу: полный путь либо голое имя (как в дозаливке доков). Без
    адреса — объект окна."""
    if ref is None:
        if window is None:
            plan.report.errors.append(
                f"{fname}: не указан объект, а окно не сказало, к какому применять"
            )
            return None
        for i, n in enumerate(flat):
            if n.id == window:
                return flat[i]
        plan.report.errors.append(f"{fname}: объект окна не найден")
        return None
    hits = by_path.get(ref) or by_bare.get(ref) or []
    if not hits:
        # ЧАСТИЧНЫЙ путь («Ярмарка / events» при корне «Маркетплейс …»): агент видит
        # только свой репозиторий и корневого контейнера не знает. Совпадение по
        # хвосту — по границе « / », чтобы «…/ events» не цеплялось к «…/ my events».
        hits = [i for i, full in enumerate(fulls) if full.endswith(f" / {ref}")]
    if not hits:
        plan.report.errors.append(
            f"{fname}: объект «{ref}» не найден; узлы-брокеры проекта: {broker_hint}"
        )
        return None
    if len(hits) > 1:
        plan.report.errors.append(
            f'{fname}: имя «{ref}» неоднозначно ({", ".join(fulls[i] for i in hits)}) — '
            "укажите полный путь"
        )
        return None
    return flat[hits[0]]


def build_channels_plan(
    db: Session,
    nodes: list[Node],
    files: list[tuple[str, str]],
    window: uuid.UUID | None,
    overwrite: bool,
) -> ChannelsPlan:
    plan = ChannelsPlan()
    flat, fulls, by_bare, by_path = _node_paths(nodes)
    path_of = {n.id: fulls[i] for i, n in enumerate(flat)}
    plan.path_of = path_of
    broker_hint = _broker_nodes_hint(flat, fulls)

    parsed: list[tuple[str, ParsedChannels]] = []
    for fname, content in files:
        pc = parse_channels_file(content)
        if pc is not None:
            parsed.append((fname, pc))
        elif LOOKS_LIKE_CHANNELS.search(content):
            plan.report.errors.append(
                f"{fname}: похоже на файл каналов, но YAML не разобрался. Частая причина — "
                "двоеточие с пробелом внутри значения (например «status: new: paid»): "
                "возьмите такое значение в кавычки"
            )
    if not parsed:
        plan.report.errors.append("В пакете нет файлов с каналами (channels)")
        return plan

    for fname, pc in parsed:
        # Адрес без решётки: YAML-ключ вместо ведущего комментария. Разбор прежний
        # (ключ игнорируется), но тишина тут стоила бы пользователю потерянных каналов —
        # он бы решил, что адресовал пакет, а тот уехал к объекту окна.
        if pc.has_node_key:
            plan.report.warnings.append(
                f"{fname}: ключ archmap-node адресом не является — адрес пишется "
                "комментарием «# archmap-node: …»; каналы уедут к объекту окна"
            )

    # Канал плана — один на «узел + группа + имя», сколькими бы файлами пакета он ни
    # был описан. Порядок вставки = порядок пакета, он же порядок строк превью.
    merged: dict[tuple[uuid.UUID, str, str], _Merged] = {}
    for fname, pc in parsed:
        if not pc.channels:
            continue
        owner = _resolve_node(
            pc.node_ref, fname, flat, fulls, by_bare, by_path, window, plan, broker_hint
        )
        if owner is None:
            continue
        # Зеркало CRUD-правила «каналы — контракт узла-брокера» (routers/broker_channels):
        # применённое на сервисе стало бы НЕВИДИМЫМ (секцию «Каналы» страница рендерит
        # только у shape=broker), поэтому не предупреждение, а ошибка. Проверяется и
        # объект окна: адрес мог быть не написан вовсе.
        if owner.shape != "broker":
            plan.report.errors.append(
                f"{fname}: объект «{path_of.get(owner.id, owner.name)}» — не брокер; "
                "каналы может иметь только узел-брокер (форма broker). "
                f"Узлы-брокеры проекта: {broker_hint}"
            )
            continue
        for c in pc.channels:
            # Ключ канала — тот же, что у уникальности в БД: узел + группа + имя.
            # Одно имя у РАЗНЫХ брокеров — законно разные каналы (два движка возят
            # одноимённое), и сливать их нельзя.
            key = (owner.id, c.group_name, c.name)
            m = merged.get(key)
            if m is None:
                merged[key] = _Merged(owner=owner, channel=c, source=fname, files=[fname])
            else:
                _merge_duplicate(m, fname, c)

    _warn_duplicate_channels(plan, list(merged.values()))

    # Живое состояние берём ОДНИМ запросом после слияния: до него не известно, к
    # скольким владельцам приехал пакет, а строка превью нужна одна на канал.
    live_by_key: dict[tuple[uuid.UUID, str, str], BrokerChannel] = {}
    owner_ids = {m.owner.id for m in merged.values()}
    if owner_ids:
        for ch in db.query(BrokerChannel).filter(BrokerChannel.node_id.in_(owner_ids)).all():
            live_by_key[(ch.node_id, ch.group_name, ch.name)] = ch

    for key, m in merged.items():
        c, owner = m.channel, m.owner
        live = live_by_key.get(key)
        if live is None:
            action = "create"
        elif overwrite or is_edge_stub(live):
            action = "overwrite"  # заглушку по связи пакет описывает и без overwrite
        else:
            action = "unchanged"
            # Сверяем СЛИТУЮ мету: после слияния пакет говорит одним голосом, и
            # спорить с ArchMap ему тоже положено один раз, а не по разу на файл.
            _warn_meta_conflicts(plan, m.source, live, c)
        plan.report.channels.append(
            ChannelItem(
                node_path=path_of.get(owner.id, owner.name), source=m.source,
                group_name=c.group_name, name=c.name, fields=len(c.fields),
                action=action,  # type: ignore[arg-type]
            )
        )
        plan.channels.append((owner, c, m.source))

    _warn_wrong_broker(db, plan, flat)
    _warn_uncovered_edge_channels(db, plan, flat)
    return plan


def _merge_duplicate(m: _Merged, fname: str, c: ChannelIn) -> None:
    """Долить в канал плана его же описание из другого файла ЭТОГО пакета.

    Политика — та же, что у доливки пакетов РАЗНЫХ репозиториев (§5): поля
    объединяются по имени, а при расхождении побеждает описанное раньше. Иначе смысл
    карты зависел бы от порядка файлов в пакете — а он случаен, агент кладёт файлы
    как получилось, и один прогон уже давал «deferred_work» и с пятью полями, и с
    нулём.

    Пустое значение спором не считается ни здесь, ни у меты из ArchMap: файл про
    один срез кода не видит того, что видел другой, и «не знаю» не должно вытеснять
    «знаю».
    """
    if fname not in m.files:
        m.files.append(fname)
    first = m.channel
    for key in META_KEYS:
        theirs, ours = c.meta(key), first.meta(key)
        if not theirs or theirs == ours:
            continue
        if not ours:
            setattr(first, key, theirs)
            continue
        m.meta_notes.append(
            f"{fname}: канал «{first.name}» — {key} «{theirs}», а в {m.source} "
            f"«{ours}»; оставлено значение из {m.source} (описан раньше)"
        )
    # description намеренно без замечания (как и в META_KEYS): два файла опишут канал
    # разными словами почти всегда, и такой шум хоронил бы настоящие расхождения.
    if not first.description:
        first.description = c.description

    by_name = {f.name: f for f in first.fields}
    for f in c.fields:
        earlier = by_name.get(f.name)
        if earlier is None:
            # Новое поле встаёт в конец: порядок полей — это порядок В СООБЩЕНИИ, и
            # доливка чужого файла не вправе его перемешивать.
            first.fields.append(f)
            by_name[f.name] = f
            continue
        # Имя совпало — побеждает поле первого файла, доливаем только пустое.
        # Поимённого замечания на каждое такое поле нет: об этом уже сказано
        # заметкой о канале, а построчно вышел бы шум на весь пакет.
        earlier.type = earlier.type or f.type
        earlier.description = earlier.description or f.description
        earlier.required = earlier.required or f.required


def _warn_duplicate_channels(plan: ChannelsPlan, merged: list[_Merged]) -> None:
    """Канал описан НЕСКОЛЬКИМИ файлами пакета — план сливает его в одну строку.

    Находка полевого QA Ф3: в пакете Zulip четыре очереди приехали в двух файлах
    каждая (перечень очередей rabbitmq плюс подробный файл по конкретной). Превью
    молчало и показывало их ДВУМЯ строками «create» с разным числом полей, а
    применение падало 500-й: второй файл лил одноимённое поле в канал, только что
    созданный первым (duplicate key uq_channel_field_name). Дубль внутри пакета —
    норма (у брокера нет репозитория-владельца, файлы собраны разными прогонами),
    поэтому сливаем и предупреждаем, а не падаем и не молчим.

    Порядок — как в пакете: он осмыслен, в отличие от произвольного порядка строк из
    БД у соседних эвристик, который приходится сортировать.
    """
    dups = [m for m in merged if len(m.files) > 1 or m.meta_notes]
    for m in dups[:MAX_DUPLICATE_WARNINGS]:
        if len(m.files) > 1:
            plan.report.warnings.append(
                f"канал «{m.channel.name}» описан в нескольких файлах пакета "
                f'({", ".join(m.files)}): поля сольются в один канал, при совпадении '
                "имени поля и расхождении меты побеждает первый файл"
            )
        plan.report.warnings.extend(m.meta_notes)
    if len(dups) > MAX_DUPLICATE_WARNINGS:
        plan.report.warnings.append(
            f"…ещё {len(dups) - MAX_DUPLICATE_WARNINGS} каналов описаны в нескольких "
            "файлах пакета"
        )


def _names_channel(pairs: set[tuple[str, str]], named: str) -> bool:
    """Знает ли брокер канал под таким именем.

    Послабления — те же, что у алерта AL31 (_channel_known в app/alerts.py): точное
    имя, включая имя С ТОЧКАМИ целиком («orders.created» — норма Kafka), либо
    «группа.канал» (vhost RabbitMQ, namespace Pulsar, account NATS). Квалификатора
    «Брокер / …» тут не бывает по построению: брокер задан концом связи.
    """
    return any(name == named or (group and f"{group}.{name}" == named) for group, name in pairs)


def _warn_wrong_broker(db: Session, plan: ChannelsPlan, flat: list[Node]) -> None:
    """Канал пакета лежит у одного брокера, а связь схемы называет его у другого.

    Находка №1 полевого QA (docs/qa-sentry-brokers.md): валидатор проверял ФОРМУ
    владельца («брокер ли»), но не «тот ли брокер», и слабая модель сложила все 136
    каналов Sentry на kafka — вместе с Celery-очередями, чьё место на sentry-redis.
    Превью было зелёным, второй брокер остался пуст, и промах вылез только четырьмя
    непонятными AL31 у его связей.

    Схема знает ответ: связь «сервис → брокер» называет свой канал (Ф3), и если
    канал назван у брокера B, а пакет кладёт его брокеру A, то расходятся ДВА
    источника — это и есть повод спросить. Молчим, когда канал есть и у B (два
    брокера законно возят одноимённые каналы) и когда A сам стоит концом этой связи.
    """
    if not plan.channels:
        return
    project_id = flat[0].project_id
    shape_by_id = {n.id: n.shape for n in flat}
    name_by_id = {n.id: n.name for n in flat}
    # Брокер один — спорить не с кем: адресовать каналы больше некуда.
    if sum(1 for n in flat if n.shape == "broker") < 2:
        return

    # Что каждый брокер знает: описанное в проекте раньше + приехавшее ЭТИМ пакетом
    # (второй файл пакета законно кладёт тот же канал соседнему брокеру).
    known: dict[uuid.UUID, set[tuple[str, str]]] = defaultdict(set)
    for ch in (
        db.query(BrokerChannel)
        .join(Node, Node.id == BrokerChannel.node_id)
        .filter(Node.project_id == project_id)
        .all()
    ):
        known[ch.node_id].add((ch.group_name, ch.name))
    # Имя канала, как его может написать связь → кому пакет его адресовал.
    addressed: dict[str, list[Node]] = defaultdict(list)
    for owner, c, _src in plan.channels:
        known[owner.id].add((c.group_name, c.name))
        addressed[c.name].append(owner)
        if c.group_name:
            addressed[f"{c.group_name}.{c.name}"].append(owner)

    seen: set[tuple[str, uuid.UUID, uuid.UUID]] = set()
    found: list[str] = []
    for e in db.query(Edge).filter(Edge.project_id == project_id).all():
        named = (e.channel or "").strip()
        if not named or named not in addressed:
            continue
        # Концы-брокеры связи; fromkeys — на случай петли «узел сам на себя».
        ends = [
            nid
            for nid in dict.fromkeys((e.source_id, e.target_id))
            if shape_by_id.get(nid) == "broker"
        ]
        for owner in addressed[named]:
            if owner.id in ends:
                continue  # связь называет канал у ТОГО ЖЕ брокера — всё сходится
            for b in ends:
                if _names_channel(known[b], named):
                    continue  # канал есть и у него — одноимённые каналы законны
                key = (named, owner.id, b)
                if key in seen:
                    continue
                seen.add(key)
                found.append(
                    f"канал «{named}» адресован брокеру "
                    f"«{plan.path_of.get(owner.id, owner.name)}», но связь "
                    f"«{name_by_id.get(e.source_id, '?')} → {name_by_id.get(e.target_id, '?')}» "
                    f"называет его у брокера «{plan.path_of.get(b, name_by_id.get(b, '?'))}» — "
                    "проверьте адресацию"
                )
    # Порядок связей из БД произволен — сортируем, иначе список замечаний скакал бы
    # от прогона к прогону (и кап резал бы каждый раз другое).
    found.sort()
    plan.report.warnings.extend(found[:MAX_ADDRESS_WARNINGS])
    if len(found) > MAX_ADDRESS_WARNINGS:
        plan.report.warnings.append(
            f"…ещё {len(found) - MAX_ADDRESS_WARNINGS} каналов адресованы вразрез со связями"
        )


def _warn_uncovered_edge_channels(db: Session, plan: ChannelsPlan, flat: list[Node]) -> None:
    """Канал, который называет СВЯЗЬ, пакетом не описан и живым не значится.

    Полевая проверка Ф8: импортный прогон ВЫДУМАЛ имя канала на связи (в коде такого
    слова нет нигде, есть похожее), а канальный пакет пришёл идеальным — полсотни
    каналов, ноль замечаний. Обе стороны шва выглядели здоровыми поодиночке, и
    расхождение молчало до кривого AL31 у связи. Промпт этот минимум прямо просит
    (Ф8д), но правило без машинной проверки исполняется через раз — сверяем ТЕМ ЖЕ
    перечнем, которым просили (edge_channel_minimum).

    Кто из двух источников ошибся, машина не знает: либо канал в коде зовётся иначе
    (чинится пакет), либо имя на связи неточно (чинится схема). Поэтому замечание
    называет ОБЕ ветки и подсказывает ближайшее описанное имя.

    ⚠ Хвост про «не добавляйте канал в пакет» — анти-соглашательство (П12 тюнинга
    федерации): на это замечание модель добавила НЕСУЩЕСТВУЮЩИЙ канал-обёртку, лишь
    бы валидатор замолчал. Ветка «имя на связи неточно» должна быть названа выходом
    прямым текстом, иначе слабая модель выбирает ту, что гасит замечание быстрее.

    Сверяем только брокеров, которых пакет АДРЕСУЕТ: пакет одного репозитория не
    может описать каналы чужого брокера, и требовать это значило бы шуметь на
    прогоне, который отработал честно.
    """
    if not plan.channels:
        return
    project_id = flat[0].project_id
    name_by_id = {n.id: n.name for n in flat}
    broker_ids = {n.id for n in flat if n.shape == "broker"}

    # Что брокер знает: описанное в проекте раньше + приехавшее ЭТИМ пакетом.
    known: dict[uuid.UUID, set[tuple[str, str]]] = defaultdict(set)
    for ch in (
        db.query(BrokerChannel)
        .join(Node, Node.id == BrokerChannel.node_id)
        .filter(Node.project_id == project_id)
        .all()
    ):
        if is_edge_stub(ch):
            continue  # заглушка по связи — не описание брокера: иначе после любого
            # импорта C4 сверка ослепла бы (каждое имя со связи «значилось бы живым»)
        known[ch.node_id].add((ch.group_name, ch.name))
    targets: set[uuid.UUID] = set()
    for owner, c, _src in plan.channels:
        known[owner.id].add((c.group_name, c.name))
        targets.add(owner.id)

    edges = db.query(Edge).filter(Edge.project_id == project_id).all()
    minimum = edge_channel_minimum(edges, broker_ids)
    found: list[str] = []
    for broker_id in targets:
        for named, e in minimum.get(broker_id, {}).items():
            if _names_channel(known[broker_id], named):
                continue  # шов цел: канал есть у этого брокера живым или в пакете
            if any(
                _names_channel(known[other], named) for other in targets if other != broker_id
            ):
                # Пакет положил этот канал СОСЕДНЕМУ брокеру — про такое расхождение
                # уже говорит эвристика адресации (Ф7б), второй строкой не дублируем.
                continue
            # Подсказка — ТА ЖЕ эвристика, что чинит пометки в превью доков (Ф8б,
            # _closest_name: суффикс впереди difflib, порог 0.5): своя копия
            # разъехалась бы с ней на первой правке порога. Кандидаты — имена, которые
            # брокер знает, в обеих формах послабления: голое и «группа.канал».
            candidates = [n for _g, n in known[broker_id]]
            candidates += [f"{g}.{n}" for g, n in known[broker_id] if g]
            hint = _closest_name(named, candidates)
            похоже = f" (похоже на «{hint}»)" if hint else ""
            found.append(
                f"связь «{name_by_id.get(e.source_id, '?')} → "
                f"{name_by_id.get(e.target_id, '?')}» называет канал «{named}», но его "
                f"нет ни в пакете, ни в описании брокера — либо в коде он зовётся "
                f"иначе{похоже}, либо имя на связи неточно: проверьте связь. "
                f"Канала нет в коде — НЕ добавляйте его в пакет: чините имя на связи."
            )
    # Порядок связей и брокеров из БД произволен — сортируем, иначе список замечаний
    # скакал бы от прогона к прогону (и кап резал бы каждый раз другое).
    found.sort()
    plan.report.warnings.extend(found[:MAX_COVERAGE_WARNINGS])
    if len(found) > MAX_COVERAGE_WARNINGS:
        plan.report.warnings.append(
            f"…ещё {len(found) - MAX_COVERAGE_WARNINGS} каналов, названных связями, "
            "не описаны"
        )


def _warn_meta_conflicts(
    plan: ChannelsPlan, fname: str, live: BrokerChannel, c: ChannelIn
) -> None:
    """Пакет называет мету иначе, чем уже описано, — предупреждаем поимённо.

    Пустое значение в пакете конфликтом НЕ считается: репозиторий-потребитель просто
    не видит настроек продюсера, и «не знаю» не должно спорить со «знаю». Побеждает
    описанное раньше — иначе смысл карты зависел бы от порядка загрузки пакетов.
    """
    for key in META_KEYS:
        theirs = c.meta(key)
        ours = str(getattr(live, key))
        if theirs and ours and theirs != ours:
            plan.report.warnings.append(
                f"{fname}: канал «{c.name}» — {key} в пакете «{theirs}», в ArchMap "
                f"«{ours}»; оставлено значение из ArchMap (перезапись выключена)"
            )


def apply_channels_plan(db: Session, plan: ChannelsPlan, overwrite: bool) -> None:
    """Применить план. Ничего не удаляем; заполненное перетираем только по overwrite."""
    r = plan.report
    for owner, c, _src in plan.channels:
        channel = (
            db.query(BrokerChannel)
            .filter(
                BrokerChannel.node_id == owner.id,
                BrokerChannel.group_name == c.group_name,
                BrokerChannel.name == c.name,
            )
            .first()
        )
        if channel is None and c.group_name:
            # Заглушка по связи знает канал формы «группа.канал» одним именем без
            # группы — пакет, описавший его с группой, описывает ТУ ЖЕ заглушку.
            channel = _stub_by_name(db, owner.id, f"{c.group_name}.{c.name}")
            if channel is not None:
                channel.group_name, channel.name = c.group_name, c.name
        if channel is None:
            channel = BrokerChannel(
                node_id=owner.id, name=c.name, group_name=c.group_name, kind=c.kind,
                partition_key=c.partition_key, delivery=c.delivery, retention=c.retention,
                description=c.description,
            )
            db.add(channel)
            db.flush()
            r.channels_written += 1
        elif overwrite or is_edge_stub(channel):
            # Перетираем ТОЛЬКО заполненное пакетом: пустое поле у агента значит «не
            # видно из моего репозитория», а не «этого нет» (см. промпт каналов).
            # Заглушку по связи пакет заполняет и без overwrite: это её первое
            # описание, а не спор с описанным раньше.
            stub = is_edge_stub(channel)
            for key in META_KEYS:
                if c.meta(key):
                    setattr(channel, key, c.meta(key))
            if c.description:
                channel.description = c.description
            elif stub:
                channel.description = None  # маркер снят: канал описан пакетом
            channel.version += 1
            r.channels_written += 1

        live_fields = {f.name: f for f in channel.fields}
        # Новые поля встают В КОНЕЦ уже описанного: пакет второго репозитория доливает
        # свои поля к чужому каналу, и нумерация с нуля перемешала бы порядок сообщения.
        next_order = max((f.order for f in channel.fields), default=-1) + 1
        for f in c.fields:
            live = live_fields.get(f.name)
            if live is None:
                db.add(
                    ChannelField(
                        channel_id=channel.id, name=f.name, type=f.type,
                        required=f.required, description=f.description, order=next_order,
                    )
                )
                next_order += 1
                r.fields_written += 1
            elif overwrite:
                live.type = f.type or live.type
                live.required = f.required
                if f.description:
                    live.description = f.description
                r.fields_written += 1
        db.flush()

    r.applied = True
