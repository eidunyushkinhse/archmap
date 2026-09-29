"""Дозаливка КОНФИГУРАЦИИ сервиса от агента (BYOA, Ф3 plan-config-docs.md).

Зеркало channels_import по устройству (толерантный разбор, адрес ведущим комментарием
«# archmap-node: …», удалений нет, слияние дублей внутри пакета), но заметно короче — и
короче не случайно: у параметра нет второго уровня (полей/колонок), нет группы и нет
чужого владельца, поэтому здесь нет ни доливки членов, ни ключа «узел+группа+имя», ни
разбора «чей это канал».

Политика слияния прежняя и по той же причине: побеждает ОПИСАННОЕ РАНЬШЕ, а расхождение
выносится предупреждением. Один сервис может описываться несколькими прогонами (разные
части монорепо), и молча перетереть чужое значение значило бы поставить смысл карты в
зависимость от порядка загрузки пакетов.

⚠️ ЗНАЧЕНИЙ МЫ НЕ ХРАНИМ (§2.5 плана), и запрет держится ТОЛЬКО текстом промпта —
модели проекта в дисциплине правил измеренно ненадёжны. Поэтому приёмник считает
подозрительные дефолты и говорит о них человеку: не режет (отличить секрет от
безобидного дефолта наверняка нельзя), но и не молчит.

Зависимости («какая развилка от ручки зависит») сюда не приезжают: они живут пометками
«зависит от:» в тексте схем логики (§5 плана).
"""

import re
import uuid
from dataclasses import dataclass, field

import yaml
from sqlalchemy.orm import Session

from app.data_import import NODE_HEADER
from app.docs_import import _node_paths
from app.models.config_param import ConfigParam
from app.models.node import Node
from app.node_ref import qualified_node_hits
from app.schemas.config_import import ConfigImportReport, ConfigParamItem

# «Файл ПОХОЖ на наш» — по разделу верхнего уровня. Нужен, чтобы отличить чужой файл
# пакета (схему логики, спеку, структуру БД, каналы) от НАШЕГО, но с битым YAML: молча
# пропустив второй, мы сказали бы «в пакете нет файлов с конфигурацией», хотя она там
# есть, — ровно та ошибка, которую разбирали на дозаливке структуры БД.
LOOKS_LIKE_CONFIG = re.compile(r"^config:", re.MULTILINE)

# Мета параметра, расхождение которой между файлами значимо. description сюда НЕ
# входит — как и у каналов: два прогона опишут ручку разными словами почти всегда, и
# предупреждение об этом было бы шумом, хоронящим настоящие.
META_KEYS = ("value_type", "required", "default_value")
# Ключи меты в терминах ПАКЕТА: замечание уходит агенту, и он должен узнать своё поле.
PKG_KEY = {"value_type": "type", "required": "required", "default_value": "default"}

# Кап предупреждений о параметрах, описанных несколькими файлами: замечания уезжают
# агенту ОДНИМ списком, и один класс не должен вытеснить остальные.
MAX_DUPLICATE_WARNINGS = 8
# Свой кап у подозрительных дефолтов — чтобы класс не съел квоту остальных.
MAX_SECRET_WARNINGS = 8

# Имя ручки, у которой значение по определению секретно. Проверяем ИМЯ, а не значение:
# отличить пароль от безобидной строки нельзя, а вот «в поле default у PASSWORD
# что-то есть» — факт, о котором обязан узнать человек.
#
# ⚠️ ЯКОРЬ НА КОНЕЦ ИМЕНИ — находка полевого прогона (docs/qa-config-field.md):
# вхождение где угодно ловило «ACCESS_TOKEN_EXPIRE_MINUTES», а это срок жизни, а не
# секрет. Класс превратился бы в шум на всех «*_TOKEN_TTL» и «*_SECRET_ROTATION_DAYS»,
# а шумное замечание хоронит настоящие. Секрет — то, чем имя КОНЧАЕТСЯ: «*_PASSWORD»,
# «*_TOKEN», «*_SECRET», «SECRET_KEY», «AWS_SECRET_ACCESS_KEY», «SENTRY_DSN».
# Голого «key» в перечне нет намеренно: PARTITION_KEY и SORT_KEY — не секреты.
SECRET_NAME = re.compile(
    r"(?i)(password|passwd|secret|secret[_-]?key|token|api[_-]?key|apikey|"
    r"private[_-]?key|access[_-]?key|credentials?|dsn)$"
)


@dataclass
class ParamIn:
    name: str
    value_type: str = ""
    required: bool = False
    default_value: str = ""
    description: str | None = None

    def meta(self, key: str) -> str:
        """Значение меты по ключу — для сверки с описанным раньше."""
        v = getattr(self, key)
        return str(v) if not isinstance(v, bool) else ("true" if v else "")


@dataclass
class ParsedConfig:
    node_ref: str | None = None
    params: list[ParamIn] = field(default_factory=list)
    # В YAML верхнего уровня есть КЛЮЧ «archmap-node»: агент потерял решётку, и адрес
    # стал невидимым (урок Н11 полевого QA — записи молча уехали к объекту окна).
    has_node_key: bool = False


def _as_bool(v: object) -> bool:
    return v is True or (isinstance(v, str) and v.strip().lower() in {"true", "да", "yes", "1"})


def _as_str(v: object) -> str:
    # bool отдельно: str(True) дало бы «True» в поле дефолта, а в YAML агент пишет
    # «false» — и такое значение в карте выглядело бы как чужой язык.
    if isinstance(v, bool):
        return "true" if v else "false"
    return "" if v is None else str(v).strip()


def parse_config_file(content: str) -> ParsedConfig | None:
    """Разобрать файл пакета. None — файл не про конфигурацию (пусть его смотрит
    другой разборщик: в пакете рядом лежат схемы логики, спеки, таблицы и каналы)."""
    try:
        doc = yaml.safe_load(content)
    except yaml.YAMLError:
        return None
    if not isinstance(doc, dict) or "config" not in doc:
        return None
    m = NODE_HEADER.search(content)
    out = ParsedConfig(
        node_ref=m.group(1) if m else None,
        has_node_key="archmap-node" in doc,
    )
    for raw in doc.get("config") or []:
        if not isinstance(raw, dict) or not _as_str(raw.get("name")):
            continue
        out.params.append(
            ParamIn(
                name=_as_str(raw.get("name")),
                value_type=_as_str(raw.get("type")),
                required=_as_bool(raw.get("required")),
                default_value=_as_str(raw.get("default")),
                description=_as_str(raw.get("description")) or None,
            )
        )
    return out


@dataclass
class ConfigPlan:
    """План дозаливки: что создастся, что уже такое."""

    report: ConfigImportReport = field(default_factory=ConfigImportReport)
    # (узел-владелец, разобранный параметр, источник)
    params: list[tuple[Node, ParamIn, str]] = field(default_factory=list)
    path_of: dict[uuid.UUID, str] = field(default_factory=dict)


@dataclass
class _Merged:
    """Параметр плана: первое вхождение плюс всё, что долили следующие файлы пакета."""

    owner: Node
    param: ParamIn
    source: str
    files: list[str] = field(default_factory=list)
    meta_notes: list[str] = field(default_factory=list)


def _service_nodes_hint(flat: list[Node], fulls: list[str]) -> str:
    """Перечень узлов-сервисов проекта для текстов ошибок.

    Слабая модель адрес ВЫДУМЫВАЕТ, а «объект не найден» без списка допустимых
    заставляет её гадать вслепую — раунд переписки за раунд (уроки Н8/Н11).
    """
    paths = [fulls[i] for i, n in enumerate(flat) if n.shape == "service"]
    return ", ".join(paths) if paths else "в проекте их нет"


def _resolve_node(
    ref: str | None,
    fname: str,
    flat: list[Node],
    fulls: list[str],
    by_bare: dict[str, list[int]],
    by_path: dict[str, list[int]],
    window: uuid.UUID | None,
    plan: ConfigPlan,
    hint: str,
) -> Node | None:
    """Узел по адресу: полный путь либо голое имя (как в дозаливке доков). Без
    адреса — объект окна."""
    if ref is None:
        if window is None:
            plan.report.errors.append(
                f"{fname}: не указан объект, а окно не сказало, к какому применять"
            )
            return None
        for n in flat:
            if n.id == window:
                return n
        plan.report.errors.append(f"{fname}: объект окна не найден")
        return None
    hits = by_path.get(ref) or by_bare.get(ref) or []
    if not hits:
        # ЧАСТИЧНЫЙ путь («Ярмарка / Платежи» при корне «Маркетплейс …»): агент видит
        # только свой репозиторий и корневого контейнера не знает. Совпадение по
        # хвосту — по границе « / », чтобы «…/ payments» не цеплялось к «…/ my payments».
        hits = [i for i, full in enumerate(fulls) if full.endswith(f" / {ref}")]
    if not hits:
        # Тёзка (одно имя в одном родителе) и его потомки адресуются путём с
        # уточнителем на сегменте тёзки — якорным «@ git:…» или порядковым «@ #N»;
        # так пишут архив и синтетические файлы единого импорта (app/node_ref.py).
        hits = qualified_node_hits(ref, flat)
    if not hits:
        plan.report.errors.append(
            f"{fname}: объект «{ref}» не найден; узлы-сервисы проекта: {hint}"
        )
        return None
    if len(hits) > 1:
        plan.report.errors.append(
            f'{fname}: имя «{ref}» неоднозначно ({", ".join(fulls[i] for i in hits)}) — '
            "укажите полный путь"
        )
        return None
    return flat[hits[0]]


def build_config_plan(
    db: Session,
    nodes: list[Node],
    files: list[tuple[str, str]],
    window: uuid.UUID | None,
    overwrite: bool,
) -> ConfigPlan:
    plan = ConfigPlan()
    flat, fulls, by_bare, by_path = _node_paths(nodes)
    path_of = {n.id: fulls[i] for i, n in enumerate(flat)}
    plan.path_of = path_of
    hint = _service_nodes_hint(flat, fulls)

    parsed: list[tuple[str, ParsedConfig]] = []
    for fname, content in files:
        pc = parse_config_file(content)
        if pc is not None:
            parsed.append((fname, pc))
        elif LOOKS_LIKE_CONFIG.search(content):
            plan.report.errors.append(
                f"{fname}: похоже на файл конфигурации, но YAML не разобрался. Частая "
                "причина — двоеточие с пробелом внутри значения (например "
                "«описание: таймаут: секунды»): возьмите такое значение в кавычки"
            )
    if not parsed:
        plan.report.errors.append("В пакете нет файлов с конфигурацией (config)")
        return plan

    for fname, pc in parsed:
        # Адрес без решётки: YAML-ключ вместо ведущего комментария. Разбор прежний
        # (ключ игнорируется), но тишина тут стоила бы пользователю потерянных ручек —
        # он бы решил, что адресовал пакет, а тот уехал к объекту окна.
        if pc.has_node_key:
            plan.report.warnings.append(
                f"{fname}: ключ archmap-node адресом не является — адрес пишется "
                "комментарием «# archmap-node: …»; параметры уедут к объекту окна"
            )

    # Параметр плана — один на «узел + имя», сколькими бы файлами он ни был описан.
    merged: dict[tuple[uuid.UUID, str], _Merged] = {}
    for fname, pc in parsed:
        if not pc.params:
            continue
        owner = _resolve_node(
            pc.node_ref, fname, flat, fulls, by_bare, by_path, window, plan, hint
        )
        if owner is None:
            continue
        # Форма — ПРЕДУПРЕЖДЕНИЕ, а не ошибка, в отличие от каналов у брокера. Там
        # применённое стало бы невидимым (секция рендерится только у shape=broker), и
        # молчать было нельзя. Здесь секция конфигурации показывает записи у ЛЮБОЙ
        # формы (с предупреждением, как легаси-схемы логики), поэтому данные не
        # пропадают — а значит, повода отклонять пакет целиком нет.
        if owner.shape != "service":
            plan.report.warnings.append(
                f"{fname}: объект «{path_of.get(owner.id, owner.name)}» — не сервис; "
                "конфигурацию описывают у сервиса, чей код её читает. "
                f"Узлы-сервисы проекта: {hint}"
            )
        for p in pc.params:
            key = (owner.id, p.name)
            m = merged.get(key)
            if m is None:
                merged[key] = _Merged(owner=owner, param=p, source=fname, files=[fname])
            else:
                _merge_duplicate(m, fname, p)

    _warn_duplicates(plan, list(merged.values()))
    _warn_secret_defaults(plan, list(merged.values()))

    # Живое состояние берём ОДНИМ запросом после слияния: до него не известно, к
    # скольким владельцам приехал пакет, а строка превью нужна одна на параметр.
    live_by_key: dict[tuple[uuid.UUID, str], ConfigParam] = {}
    owner_ids = {m.owner.id for m in merged.values()}
    if owner_ids:
        for cp in db.query(ConfigParam).filter(ConfigParam.node_id.in_(owner_ids)).all():
            live_by_key[(cp.node_id, cp.name)] = cp

    for key, m in merged.items():
        p, owner = m.param, m.owner
        live = live_by_key.get(key)
        action = "create" if live is None else ("overwrite" if overwrite else "unchanged")
        if live is not None and not overwrite:
            _warn_meta_conflicts(plan, m.source, live, p)
        plan.report.params.append(
            ConfigParamItem(
                node_path=path_of.get(owner.id, owner.name), source=m.source,
                name=p.name, value_type=p.value_type, required=p.required,
                action=action,  # type: ignore[arg-type]
            )
        )
        plan.params.append((owner, p, m.source))

    return plan


def _merge_duplicate(m: _Merged, fname: str, p: ParamIn) -> None:
    """Долить в параметр плана его же описание из другого файла ЭТОГО пакета.

    Политика — та же, что у каналов: побеждает описанное раньше, пустое значение
    спором не считается («не вижу из своего среза кода» не должно вытеснять «вижу»).
    Иначе смысл карты зависел бы от порядка файлов в пакете, а он случаен.
    """
    if fname not in m.files:
        m.files.append(fname)
    first = m.param
    for key in META_KEYS:
        theirs, ours = p.meta(key), first.meta(key)
        if not theirs or theirs == ours:
            continue
        if not ours:
            setattr(first, key, getattr(p, key))
            continue
        m.meta_notes.append(
            f"{fname}: параметр «{first.name}» — {PKG_KEY[key]} «{theirs}», а в "
            f"{m.source} «{ours}»; оставлено значение из {m.source} (описан раньше)"
        )
    # description намеренно без замечания (как и в META_KEYS).
    if not first.description:
        first.description = p.description


def _warn_duplicates(plan: ConfigPlan, merged: list[_Merged]) -> None:
    """Параметр описан НЕСКОЛЬКИМИ файлами пакета — план сливает его в одну строку.

    Урок каналов (Ф3 полевого QA): без слияния превью показывало бы две строки
    «create», а применение падало бы на уникальности (node_id, name). Дубль внутри
    пакета — норма: файлы собраны разными прогонами по разным частям репозитория.
    """
    dups = [m for m in merged if len(m.files) > 1 or m.meta_notes]
    for m in dups[:MAX_DUPLICATE_WARNINGS]:
        if len(m.files) > 1:
            plan.report.warnings.append(
                f"параметр «{m.param.name}» описан в нескольких файлах пакета "
                f'({", ".join(m.files)}): останется одна запись, при расхождении '
                "побеждает первый файл"
            )
        plan.report.warnings.extend(m.meta_notes)
    if len(dups) > MAX_DUPLICATE_WARNINGS:
        plan.report.warnings.append(
            f"…ещё {len(dups) - MAX_DUPLICATE_WARNINGS} параметров описаны в "
            "нескольких файлах пакета"
        )


def _warn_secret_defaults(plan: ConfigPlan, merged: list[_Merged]) -> None:
    """У ручки с секретным ИМЕНЕМ заполнен дефолт — говорим человеку.

    Запрет на значения держится только текстом промпта (флаг «секрет» в модели
    отклонён решением §2.3), а модели в дисциплине правил ненадёжны. Резать нельзя:
    у `DATABASE_URL` в `.env.example` законно стоит «postgres://localhost/dev», и
    отличить такой дефолт от утёкшего боевого значения приёмник не может. Поэтому
    единственное честное действие — показать: человек видит строку в окне ДО
    применения и решает сам.
    """
    suspicious = [
        m for m in merged if m.param.default_value and SECRET_NAME.search(m.param.name)
    ]
    for m in suspicious[:MAX_SECRET_WARNINGS]:
        plan.report.warnings.append(
            f"{m.source}: у параметра «{m.param.name}» заполнено значение по умолчанию "
            f"«{m.param.default_value}» — проверьте, что это дефолт из кода, а не "
            "боевое значение: ArchMap значений не хранит"
        )
    if len(suspicious) > MAX_SECRET_WARNINGS:
        plan.report.warnings.append(
            f"…ещё у {len(suspicious) - MAX_SECRET_WARNINGS} параметров с секретными "
            "именами заполнено значение по умолчанию"
        )


def _warn_meta_conflicts(
    plan: ConfigPlan, fname: str, live: ConfigParam, p: ParamIn
) -> None:
    """Пакет называет мету иначе, чем уже описано, — предупреждаем поимённо.

    Пустое значение в пакете конфликтом НЕ считается: прогон по другой части кода
    просто не видит того, что видел первый. Побеждает описанное раньше.
    """
    for key in META_KEYS:
        theirs = p.meta(key)
        ours = str(getattr(live, key)) if not isinstance(getattr(live, key), bool) else (
            "true" if getattr(live, key) else ""
        )
        if theirs and ours and theirs != ours:
            plan.report.warnings.append(
                f"{fname}: параметр «{p.name}» — {PKG_KEY[key]} в пакете «{theirs}», "
                f"в ArchMap «{ours}»; оставлено значение из ArchMap (перезапись выключена)"
            )


def apply_config_plan(db: Session, plan: ConfigPlan, overwrite: bool) -> None:
    """Применить план. Ничего не удаляем; заполненное перетираем только по overwrite."""
    r = plan.report
    for owner, p, _src in plan.params:
        param = (
            db.query(ConfigParam)
            .filter(ConfigParam.node_id == owner.id, ConfigParam.name == p.name)
            .first()
        )
        if param is None:
            db.add(
                ConfigParam(
                    node_id=owner.id, name=p.name, value_type=p.value_type,
                    required=p.required, default_value=p.default_value,
                    description=p.description,
                )
            )
            r.params_written += 1
        elif overwrite:
            # Перетираем ТОЛЬКО заполненное пакетом: пустое поле у агента значит «не
            # видно из моего среза кода», а не «этого нет» (см. промпт конфигурации).
            if p.value_type:
                param.value_type = p.value_type
            if p.default_value:
                param.default_value = p.default_value
            if p.description:
                param.description = p.description
            # required — булево, «пусто» у него нет: пакет либо утверждает
            # обязательность, либо молчит, и молчание не должно снимать уже описанную.
            param.required = param.required or p.required
            param.version += 1
            r.params_written += 1
        db.flush()

    r.applied = True
