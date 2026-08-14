"""Дозаливка КАНАЛОВ брокера от агента (BYOA, Ф4 plan-broker-docs.md).

Зеркало data_import по устройству (толерантный разбор, адрес ведущим комментарием
«# archmap-node: …», удалений нет), но с другой политикой слияния — и она вытекает не
из вкуса, а из того, что у брокера НЕТ репозитория-владельца (§5 плана). Каналы
объявлены в коде публикующих и потребляющих, поэтому один и тот же топик приезжает
пакетами из РАЗНЫХ репозиториев, и второй пакет обязан ДОЛИТЬ поля к уже описанному
каналу, а не переоткрыть его.

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
from dataclasses import dataclass, field

import yaml
from sqlalchemy.orm import Session

from app.data_import import NODE_HEADER
from app.docs_import import _node_paths
from app.models.broker_channel import BrokerChannel
from app.models.channel_field import ChannelField
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
        for rf in raw.get("fields") or []:
            if not isinstance(rf, dict) or not _as_str(rf.get("name")):
                continue
            c.fields.append(
                FieldIn(
                    name=_as_str(rf.get("name")),
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
        existing = {
            (c.group_name, c.name): c
            for c in db.query(BrokerChannel).filter(BrokerChannel.node_id == owner.id).all()
        }
        for c in pc.channels:
            live = existing.get((c.group_name, c.name))
            action = "create" if live is None else ("overwrite" if overwrite else "unchanged")
            if live is not None and not overwrite:
                _warn_meta_conflicts(plan, fname, live, c)
            plan.report.channels.append(
                ChannelItem(
                    node_path=path_of.get(owner.id, owner.name), source=fname,
                    group_name=c.group_name, name=c.name, fields=len(c.fields),
                    action=action,  # type: ignore[arg-type]
                )
            )
            plan.channels.append((owner, c, fname))

    return plan


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
        if channel is None:
            channel = BrokerChannel(
                node_id=owner.id, name=c.name, group_name=c.group_name, kind=c.kind,
                partition_key=c.partition_key, delivery=c.delivery, retention=c.retention,
                description=c.description,
            )
            db.add(channel)
            db.flush()
            r.channels_written += 1
        elif overwrite:
            # Перетираем ТОЛЬКО заполненное пакетом: пустое поле у агента значит «не
            # видно из моего репозитория», а не «этого нет» (см. промпт каналов).
            for key in META_KEYS:
                if c.meta(key):
                    setattr(channel, key, c.meta(key))
            if c.description:
                channel.description = c.description
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
