"""Единый импорт проекта: N входов ЛЮБОГО типа → один план (Ф1, docs/plan-unified-import.md).

Вход — список (label, payload) в порядке пользователя; каждый payload это либо
zip-архив знания (магические байты «PK»), либо текст C4-YAML. Ничего нового не
парсим: C4 архива берётся из contents.c4 и идёт тем же parse_import, что и голый
YAML, семьи фактов — родными парсерами BYOA (data/channels/config/mmd_header),
процессы — перечнем манифеста.

Конвейер один на все сценарии эпика::

    входы → parse_import каждого C4 → merge_imports (происхождение вкладов)
          → семьи каждого архива перевешиваются на merged-узлы (по происхождению)
          → дедуп равных тел / конфликт-объекты
          → план (превью здесь, применение — Ф2)

ПРОИСХОЖДЕНИЕ — центральная механика: адрес файла семьи («# archmap-node: путь»)
разрешается по C4 СВОЕГО архива, а оттуда через MergeReport.node_contribs (Ф0)
доводится до узла СЛИТОГО дерева. Прямая адресация по слитым путям была бы
неверной: слияние переименовывает и переклеивает узлы.

КОНФЛИКТ — два вклада РАЗНЫХ входов в один merged-узел с одинаковым ключом и
разным телом (дока-тёзка, две спеки, тёзки таблиц/каналов/параметров). Равные
тела дедуплицируются молча (у доков сравнение — ПОСЛЕ strip_header: шапка несёт
node-путь и разъезжается между архивами при одинаковом теле). Вклады ОДНОГО
входа с одним ключом — не конфликт, а замечание этому входу (внутриархивный
дубль): рассудить его может только автор архива.

Деградация видимая, а не тихая: нечитаемый вход не роняет превью 500-кой, а
адресуется чипу («уберите кривой файл»); промах адреса семьи — замечание входу,
остальное живо.
"""

import re
from collections.abc import Callable
from dataclasses import asdict, dataclass, field
from typing import Literal

import yaml

from app.archive_import import ArchiveError, _Archive, _listed, _read_zip
from app.channels_import import ChannelIn, parse_channels_file
from app.config_import import ParamIn, parse_config_file
from app.data_import import LOOKS_LIKE_DATA, NODE_HEADER, TableIn, parse_data_file
from app.import_merge import (
    MergeReport,
    _norm,
    carry_parse_warnings,
    count_without_anchor,
    merge_imports,
    merged_with_basis,
    split_remarks,
    warn_content,
)
from app.import_yaml import ParsedImport, parse_import
from app.mmd_header import fix_unpaired_brackets, parse_mmd_header, strip_header
from app.node_ref import RefIndex
from app.schemas.project import FileRemarksOut, ImportPreviewOut, MergedNodeOut
from app.schemas.unified_import import (
    ComponentOut,
    ContainerEdgeOut,
    FamilyCandidateOut,
    FamilyConflictOut,
    FieldDisputeOut,
    FuzzyPairOut,
    IsolatedGroupOut,
    RemainderCandidateOut,
    RemainderOut,
    UnfixableOut,
    UnifiedFamilyCountsOut,
    UnifiedPreviewOut,
)

# Максимум входов за раз — тот же щедрый предел, что у голого мульти-YAML импорта
# (MAX_IMPORT_FILES): мульти-репо BYOA присылает файл на репозиторий, и системе из
# восьмидесяти сервисов тесно в любом меньшем.
MAX_INPUTS = 256
# Из них АРХИВОВ — не больше шестнадцати: архив распаковывается в память целиком
# (капы _read_zip держат каждый по отдельности, но не их сумму), да и шестнадцать
# архивов знания — это уже федерация продуктов, а не пакет репозиториев.
MAX_ARCHIVES = 16
# Сколько символов тела кандидата едет в превью. Пользователь выбирает из
# кандидатов глазами, и мегабайтная спека в JSON-ответе никому не помогает.
MAX_BODY = 4000
# Разделитель полного пути узла — тот же, что у processes.node_path и у адресов
# «# archmap-node: …» в файлах архива.
SEP = " / "

Family = Literal["doc", "spec", "table", "channel", "config"]
# Порядок разбора семей внутри одного архива — он же порядок конфликтов в превью.
_FAMILY_ORDER: tuple[Family, ...] = ("doc", "table", "channel", "config", "spec")


class UnifiedImportError(Exception):
    """План невозможен целиком (пустой запрос, превышен кап входов) — 400 наружу.

    Беды ОТДЕЛЬНОГО входа сюда не попадают: они едут ошибкой, адресованной входу,
    и пользователь убирает кривой чип, не теряя остальные."""


# ── Разобранные вклады семей ─────────────────────────────────────────────────


@dataclass
class DocIn:
    """Схема логики как вклад архива: тело БЕЗ шапки (заглушка остаётся заглушкой)."""

    name: str
    kind: str
    operation: str | None
    body: str


FamilyValue = DocIn | str | TableIn | ChannelIn | ParamIn


@dataclass
class FamilyItem:
    """Бесконфликтный вклад семьи, уже привязанный к узлу СЛИТОГО дерева (Ф2 применит)."""

    family: Family
    node_idx: int
    key: str  # человеческий ключ, он же хвост id конфликта
    origin: int  # индекс входа
    origin_label: str
    value: FamilyValue
    fname: str = ""  # файл-источник вклада: им зовут синтетический файл применения


@dataclass
class FamilyCandidate:
    """Один вариант тела в конфликте: происхождение + человеческая сводка + текст."""

    origin: int
    origin_label: str
    summary: str
    body: str
    truncated: bool
    value: FamilyValue  # полезная нагрузка для применения (Ф2), в схему не едет
    fname: str = ""  # файл-источник вклада (в схему не едет, нужен применению)
    # Вклад ТЕКУЩЕГО проекта (вход №0 догрузки, Ф3): его кандидат — «оставить моё»,
    # и дефолт спора стоит на нём. При создании проекта входа №0 нет — всегда false.
    current: bool = False


@dataclass
class FamilyConflict:
    """Спор о теле одного ключа у одного merged-узла.

    id стабилен между превью и применением: мердж детерминирован, поэтому путь
    merged-узла и ключ не зависят от того, сколько раз посчитали план."""

    id: str
    family: Family
    node_idx: int
    node_path: str
    key: str
    candidates: list[FamilyCandidate]
    default: str  # «cand:<i>» либо «all»
    allow_all: bool  # разрешён ли выбор «взять все» (только доки: имена тёзок разводятся суффиксом)


@dataclass
class ProcessItem:
    """Процесс входа: только имя и текст. Разбирать глубже нечем и незачем —
    участники резолвятся по узлам ЖИВОГО проекта, а его в превью ещё нет."""

    origin: int
    origin_label: str
    name: str
    text: str


@dataclass
class FamilyCounts:
    """Что приедет при ДЕФОЛТНЫХ резолюциях конфликтов (доки — все, прочие — первый)."""

    docs: int = 0
    specs: int = 0
    tables: int = 0
    channels: int = 0
    params: int = 0
    processes: int = 0


@dataclass
class UnifiedPlan:
    """Полный план ввоза: C4 + семьи + конфликты + процессы + замечания.

    ok=False — план непригоден к применению (нечитаемый вход, неразобранный C4,
    нарушенные лимиты слияния); merged при этом None, а errors адресованы входам."""

    labels: list[str]
    kinds: list[Literal["yaml", "archive"]]
    ok: bool
    errors: list[str]
    report: MergeReport
    merged: ParsedImport | None = None
    node_paths: list[str] = field(default_factory=list)  # пути узлов СЛИТОГО дерева
    # Пути узлов КАЖДОГО входа в его СОБСТВЕННОЙ системе координат (порядок входов).
    # Нужны применению (Ф2а): адрес «%% archmap-doc: путь / имя» в тексте процесса
    # входа K написан путями архива K, а в новом проекте узел может лежать иначе.
    origin_paths: list[list[str]] = field(default_factory=list)
    # Те же узлы АДРЕСАМИ входа (app/node_ref.py): у тёзок и их потомков — с
    # уточнителями, как их пишет архив в «%% archmap-doc:» и «%% archmap-node:»
    # процессов. По ним привязки шагов и участники переписываются в новый проект.
    origin_addresses: list[list[str]] = field(default_factory=list)
    items: list[FamilyItem] = field(default_factory=list)
    conflicts: list[FamilyConflict] = field(default_factory=list)
    processes: list[ProcessItem] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)  # верхнеуровневые (не адресуемы входу)
    input_remarks: list[list[str]] = field(default_factory=list)  # по записи на вход
    # Внутриархивный дубль (вход, номер замечания) → входы, у которых в том же ключе
    # того же узла лежит РАВНОЕ тело. Догрузке это Р3: дубль, повторяющий запись
    # живого проекта, нового знания не теряет (тёзки без якоря, склеенные мерджем
    # второго входа, дают такой дубль на собственном архиве), и пунктом свёртки он
    # быть не должен. Само замечание остаётся в сырых строках входа (MCP).
    dup_echoes: dict[tuple[int, int], set[int]] = field(default_factory=dict)
    counts: FamilyCounts = field(default_factory=FamilyCounts)
    name_source: Literal["manifest", "fields"] = "fields"
    manifest_name: str | None = None
    manifest_description: str | None = None


# ── Чтение входов ────────────────────────────────────────────────────────────


@dataclass
class _Input:
    label: str
    kind: Literal["yaml", "archive"]
    archive: _Archive | None = None
    c4: str | None = None
    error: str | None = None


def _read_input(label: str, payload: bytes) -> _Input:
    """Распознать тип входа ПО СОДЕРЖИМОМУ и достать из него C4.

    Имя файла не спрашиваем намеренно: чип может приехать из буфера обмена, а
    расширение — соврать. Магия zip («PK») однозначна."""
    if payload.startswith(b"PK"):
        try:
            archive = _read_zip(payload)
        except ArchiveError as e:
            return _Input(label=label, kind="archive", error=str(e))
        c4_name = (archive.manifest.get("contents") or {}).get("c4")
        c4 = archive.files.get(c4_name) if isinstance(c4_name, str) else None
        if not c4:
            return _Input(
                label=label, kind="archive", archive=archive,
                error="В архиве нет файла C4 (contents.c4)",
            )
        return _Input(label=label, kind="archive", archive=archive, c4=c4)
    try:
        text = payload.decode("utf-8")
    except UnicodeDecodeError:
        return _Input(
            label=label, kind="yaml",
            error="Файл не читается ни как zip-архив, ни как текст в UTF-8",
        )
    return _Input(label=label, kind="yaml", c4=text.lstrip("﻿"))


# ── Пути и происхождение ─────────────────────────────────────────────────────


def _paths(parsed: ParsedImport) -> list[str]:
    """Полные пути узлов разобранного импорта (родители раньше детей — инвариант
    parse_import и merge_imports, на нём же стоит seed_import)."""
    out: list[str] = []
    for n in parsed.nodes:
        out.append(n.name if n.parent_idx is None else f"{out[n.parent_idx]}{SEP}{n.name}")
    return out


def _index(parsed: ParsedImport) -> RefIndex:
    """Карта ссылок с уточнителями по разобранному импорту (порядок разбора — это
    порядок документа)."""
    return RefIndex(
        [n.name for n in parsed.nodes],
        [n.parent_idx for n in parsed.nodes],
        [n.source_keys for n in parsed.nodes],
    )


def _addresses(parsed: ParsedImport) -> list[str]:
    """Адреса узлов разобранного импорта: полный путь, у тёзок и их потомков — с
    уточнителями по тем же правилам, по каким их пишет экспорт."""
    return [a or "" for a in _index(parsed).addresses()]


class _Resolver:
    """Адрес файла семьи → узел СЛИТОГО дерева, через C4 своего входа.

    Адрес — точный полный путь; тёзку (путь один на двоих) и его потомков архив
    адресует путём с уточнителем на сегменте тёзки (app/node_ref.py): якорным
    «@ git:…» — тогда тёзки фильтруются по якорю разобранного узла, — или
    порядковым «@ #N» — тогда берётся N-й из них в порядке документа. Промах и
    тёзки без уточнителя — замечание входу, файл пропускается: та же норма, что у
    всех приёмников, деградация видимая."""

    def __init__(
        self,
        origin: int,
        parsed: ParsedImport,
        contribs: dict[tuple[int, int], int],
        remarks: list[str],
    ) -> None:
        self.origin = origin
        self.contribs = contribs
        self.remarks = remarks
        self.by_path: dict[str, list[int]] = {}
        for i, p in enumerate(_paths(parsed)):
            self.by_path.setdefault(p, []).append(i)
        self.index = _index(parsed)

    def _hits(self, path: str) -> list[int]:
        """Точный путь первым (имя с законным « @ » работает), иначе уточнители.
        Адрес архива — полный путь: хвост и голое имя тут не угадываются."""
        hits = self.by_path.get(path, [])
        if not hits:
            hits = self.index.resolve_full(path) or []
        return hits

    def resolve(self, path: str | None, fname: str) -> int | None:
        hits = self._hits(path) if path else []
        if len(hits) == 1:
            merged = self.contribs.get((self.origin, hits[0]))
            if merged is None:  # инвариант Ф0 нарушен — молчать нельзя
                self.remarks.append(f"{fname}: узел «{path}» потерялся при слиянии — файл пропущен")
            return merged
        if not path:
            self.remarks.append(f"{fname}: нет адреса узла — файл пропущен")
        elif not hits:
            self.remarks.append(f"{fname}: узел «{path}» не найден — файл пропущен")
        else:
            self.remarks.append(f"{fname}: путь «{path}» неоднозначен (узлы-тёзки) — файл пропущен")
        return None


# ── Сырые вклады (до дедупа) ─────────────────────────────────────────────────


@dataclass
class _Raw:
    family: Family
    node_idx: int
    key: tuple[str, ...]  # ключ сравнения (schema+name у таблиц, группа+имя у каналов…)
    key_str: str  # тот же ключ человеку и в id конфликта
    origin: int
    label: str
    fname: str
    value: FamilyValue


def _strip_node_comment(text: str) -> str:
    """Текст спеки без адресной строки. Строка может стоять не первой (её пишет
    экспорт, но файл мог править человек) — фильтруем все, как archive_import."""
    return "".join(
        ln for ln in text.splitlines(keepends=True)
        if not ln.lstrip().startswith("# archmap-node:")
    )


def _collect(inp: _Input, origin: int, res: _Resolver, remarks: list[str]) -> list[_Raw]:
    """Все вклады семей одного архива, привязанные к узлам слитого дерева."""
    archive = inp.archive
    assert archive is not None  # вызывается только для читаемых архивов
    out: list[_Raw] = []

    def add(family: Family, node_idx: int, key: tuple[str, ...], key_str: str,
            fname: str, value: FamilyValue) -> None:
        out.append(_Raw(family=family, node_idx=node_idx, key=key, key_str=key_str,
                        origin=origin, label=inp.label, fname=fname, value=value))

    # ── Схемы логики: метаданные в шапке файла, тело — без неё.
    for fname, content in _listed(archive, "docs"):
        header = parse_mmd_header(content)
        node = res.resolve(header.node, fname)
        if node is None:
            continue
        name = header.name or fname.rsplit("/", 1)[-1].rsplit(".", 1)[0]
        add("doc", node, ("doc", name), name, fname, DocIn(
            name=name,
            kind=header.kind or "operation",
            operation=header.operation,
            # Фигуру с непарной скобкой чиним молча: архив — наш формат, вклад семьи не
            # несёт замечаний, а схема без починки не рендерится вовсе.
            body=fix_unpaired_brackets(strip_header(content).lstrip("\n"))[0],
        ))

    # ── Структура БД / каналы / конфигурация: родные парсеры, адрес — в файле.
    for fname, content in _listed(archive, "db"):
        data = parse_data_file(content)
        if data is None:
            remarks.append(
                f"{fname}: похоже на файл структуры данных, но YAML не разобрался — файл пропущен"
                if LOOKS_LIKE_DATA.search(content)
                else f"{fname}: не похож на файл структуры данных — файл пропущен"
            )
            continue
        node = res.resolve(data.node_ref, fname)
        if node is None:
            continue
        for t in data.tables:
            key_str = f"{t.schema_name}.{t.name}" if t.schema_name else t.name
            add("table", node, ("table", t.schema_name, t.name), key_str, fname, t)

    for fname, content in _listed(archive, "channels"):
        chans = parse_channels_file(content)
        if chans is None:
            remarks.append(f"{fname}: не разбирается как файл каналов — файл пропущен")
            continue
        node = res.resolve(chans.node_ref, fname)
        if node is None:
            continue
        for c in chans.channels:
            key_str = f"{c.group_name}/{c.name}" if c.group_name else c.name
            add("channel", node, ("channel", c.group_name, c.name), key_str, fname, c)

    for fname, content in _listed(archive, "config"):
        conf = parse_config_file(content)
        if conf is None:
            remarks.append(f"{fname}: не разбирается как файл конфигурации — файл пропущен")
            continue
        node = res.resolve(conf.node_ref, fname)
        if node is None:
            continue
        for p in conf.params:
            add("config", node, ("config", p.name), p.name, fname, p)

    # ── Спеки: адрес ведущим комментарием, храним текст без него. Ключ один на
    #    узел — спека у узла ровно одна (Node.openapi_spec).
    for fname, content in _listed(archive, "specs"):
        m = NODE_HEADER.search(content)
        node = res.resolve(m.group(1) if m else None, fname)
        if node is None:
            continue
        add("spec", node, ("spec",), "openapi", fname, _strip_node_comment(content))

    return out


# ── Представление вклада человеку ────────────────────────────────────────────


def _plural(n: int, one: str, few: str, many: str) -> str:
    n10, n100 = n % 10, n % 100
    if n10 == 1 and n100 != 11:
        word = one
    elif 2 <= n10 <= 4 and not 12 <= n100 <= 14:
        word = few
    else:
        word = many
    return f"{n} {word}"


def _lines(text: str) -> int:
    return len(text.strip().splitlines())


def _size(text: str) -> str:
    n = len(text.encode("utf-8"))
    return f"{round(n / 1024)} КБ" if n >= 1024 else f"{n} Б"


def _yaml(doc: dict) -> str:
    """Те же настройки дампа, что у архива: порядок ключей осознанный, юникод как есть."""
    return yaml.safe_dump(doc, allow_unicode=True, sort_keys=False, default_flow_style=False)


def _table_doc(t: TableIn) -> dict:
    d: dict = {"name": t.name}
    if t.schema_name:
        d["schema"] = t.schema_name
    if t.description:
        d["description"] = t.description
    cols = []
    for c in t.columns:
        cd: dict = {"name": c.name}
        if c.type:
            cd["type"] = c.type
        if c.pk:
            cd["pk"] = True
        if c.required:
            cd["required"] = True
        if c.references:
            cd["references"] = c.references
        if c.description:
            cd["description"] = c.description
        cols.append(cd)
    if cols:
        d["columns"] = cols
    return d


def _channel_doc(c: ChannelIn) -> dict:
    d: dict = {"name": c.name}
    for key, val in (("group", c.group_name), ("kind", c.kind),
                     ("partition_key", c.partition_key), ("delivery", c.delivery),
                     ("retention", c.retention), ("description", c.description)):
        if val:
            d[key] = val
    fields = []
    for f in c.fields:
        fd: dict = {"name": f.name}
        if f.type:
            fd["type"] = f.type
        if f.required:
            fd["required"] = True
        if f.description:
            fd["description"] = f.description
        fields.append(fd)
    if fields:
        d["fields"] = fields
    return d


def _param_doc(p: ParamIn) -> dict:
    d: dict = {"name": p.name}
    if p.value_type:
        d["type"] = p.value_type
    if p.required:
        d["required"] = True
    if p.default_value:
        d["default"] = p.default_value
    if p.description:
        d["description"] = p.description
    return d


def _body_of(raw: _Raw) -> str:
    """Текст представления вклада: тело доки/спеки как есть, факты — YAML своего
    ввозного формата (пользователь уже видел эти файлы в архиве)."""
    v = raw.value
    if isinstance(v, DocIn):
        return v.body
    if isinstance(v, str):
        return v
    if isinstance(v, TableIn):
        return _yaml(_table_doc(v))
    if isinstance(v, ChannelIn):
        return _yaml(_channel_doc(v))
    return _yaml(_param_doc(v))


def _summary_of(raw: _Raw) -> str:
    v = raw.value
    if isinstance(v, DocIn):
        if not v.body.strip():
            return "заглушка (пустое тело)"
        return _plural(_lines(v.body), "строка", "строки", "строк")
    if isinstance(v, str):
        return f"{_plural(_lines(v), 'строка', 'строки', 'строк')}, {_size(v)}"
    if isinstance(v, TableIn):
        return _plural(len(v.columns), "колонка", "колонки", "колонок")
    if isinstance(v, ChannelIn):
        parts = [_plural(len(v.fields), "поле", "поля", "полей")]
        if v.delivery:
            parts.append(v.delivery)
        return ", ".join(parts)
    parts = [f"тип {v.value_type}"] if v.value_type else []
    parts.append(f"дефолт «{v.default_value}»" if v.default_value else "без дефолта")
    if v.required:
        parts.append("обязательный")
    return ", ".join(parts)


def _same_body(a: _Raw, b: _Raw) -> bool:
    """Равенство тел (дедуп молча). У доков сравниваем ПОСЛЕ снятия шапки —
    иначе одинаковые схемы двух архивов разошлись бы по node-пути в шапке."""
    x, y = a.value, b.value
    if isinstance(x, DocIn) or isinstance(y, DocIn):
        if not (isinstance(x, DocIn) and isinstance(y, DocIn)):
            return False
        return ((x.kind, x.operation or "", x.body.strip())
                == (y.kind, y.operation or "", y.body.strip()))
    if isinstance(x, str) or isinstance(y, str):
        return isinstance(x, str) and isinstance(y, str) and x.strip() == y.strip()
    # Остались структурные семьи (таблица/канал/параметр) — сравнение по полям.
    return type(x) is type(y) and asdict(x) == asdict(y)


_DUP_WORD: dict[Family, str] = {
    "doc": "схема",
    "spec": "спека OpenAPI",
    "table": "таблица",
    "channel": "канал",
    "config": "параметр",
}


def _dup_remark(raw: _Raw) -> str:
    """Внутриархивный дубль: рассудить его может только автор архива, поэтому это
    замечание входу, а не конфликт эпика."""
    what = _DUP_WORD[raw.family]
    if raw.family == "spec":
        return f"{raw.fname}: спека узла уже задана другим файлом этого входа — файл пропущен"
    return f"{raw.fname}: {what} «{raw.key_str}» у узла уже описана этим входом — запись пропущена"


# ── Сборка плана ─────────────────────────────────────────────────────────────


def _failed(inputs: list[_Input], errors: list[str], report: MergeReport) -> UnifiedPlan:
    return UnifiedPlan(
        labels=[i.label for i in inputs],
        kinds=[i.kind for i in inputs],
        ok=False,
        errors=errors,
        report=report,
        input_remarks=[[] for _ in inputs],
    )


def build_unified_plan(inputs: list[tuple[str, bytes]]) -> UnifiedPlan:
    """План ввоза N входов (label, payload) в порядке пользователя.

    Порядок входов значим: от него зависят tie-break C4-мерджа и дефолт «первый
    кандидат» у конфликтов семей — поэтому входы НЕ сортируются нигде."""
    if not inputs:
        raise UnifiedImportError("Не передан ни один файл")
    if len(inputs) > MAX_INPUTS:
        raise UnifiedImportError(f"Больше {MAX_INPUTS} файлов за раз не принимаем")
    # Архивы считаем отдельно и ПО СОДЕРЖИМОМУ (та же магия zip, что у _read_input):
    # у них своя цена — распаковка в память, — и свой, куда более строгий предел.
    if sum(1 for _label, payload in inputs if payload.startswith(b"PK")) > MAX_ARCHIVES:
        raise UnifiedImportError(f"Больше {MAX_ARCHIVES} архивов за раз не принимаем")

    read = [_read_input(label, payload) for label, payload in inputs]
    remarks: list[list[str]] = [[] for _ in read]

    # ── Беды чтения: адресуем входу (пользователь уберёт кривой чип), не 500-кой.
    file_errors = {i: [inp.error] for i, inp in enumerate(read) if inp.error}
    if file_errors:
        errors = [f"вход {i + 1}: {msgs[0]}" for i, msgs in sorted(file_errors.items())]
        return _failed(read, errors, MergeReport(files=len(read), file_errors=file_errors))

    # ── C4 каждого входа — одним parse_import (архивный и голый YAML равноправны).
    parts: list[ParsedImport] = []
    parse_errors: list[str] = []
    parse_by_file: dict[int, list[str]] = {}
    for i, inp in enumerate(read):
        parsed, errs = parse_import(inp.c4 or "")
        if parsed is None:
            parse_errors.extend(f"вход {i + 1}: {e}" for e in errs)
            parse_by_file[i] = list(errs)
        else:
            parts.append(parsed)
    if parse_errors:
        return _failed(read, parse_errors, MergeReport(files=len(read), file_errors=parse_by_file))

    merged, report = merge_imports(parts)
    if report.errors:  # суммарные лимиты — свойство слитой картины
        return _failed(read, list(report.errors), report)
    carry_parse_warnings(parts, report)
    warn_content(merged, report)

    node_paths = _paths(merged)
    contribs = {
        (fi, ni): m for m, cs in enumerate(report.node_contribs) for fi, ni in cs
    }

    # ── Семьи: вход за входом, порядок сохраняется (дефолт «cand:0» = первый вход).
    raws: list[_Raw] = []
    processes: list[ProcessItem] = []
    warnings: list[str] = []
    for i, inp in enumerate(read):
        if inp.archive is None:
            continue
        res = _Resolver(i, parts[i], contribs, remarks[i])
        raws.extend(_collect(inp, i, res, remarks[i]))
        processes.extend(_processes_of(inp, i, remarks[i]))
    _warn_process_namesakes(processes, warnings)

    dup_echoes: dict[tuple[int, int], set[int]] = {}
    items, conflicts, counts = _resolve_families(raws, node_paths, remarks, dup_echoes)
    counts.processes = len(processes)

    name_source: Literal["manifest", "fields"] = (
        "manifest" if len(read) == 1 and read[0].archive is not None else "fields"
    )
    manifest_project: dict = {}
    if name_source == "manifest" and read[0].archive is not None:
        manifest_project = read[0].archive.manifest.get("project") or {}

    return UnifiedPlan(
        labels=[i.label for i in read],
        kinds=[i.kind for i in read],
        ok=True,
        errors=[],
        report=report,
        merged=merged,
        node_paths=node_paths,
        origin_paths=[_paths(p) for p in parts],
        origin_addresses=[_addresses(p) for p in parts],
        items=items,
        conflicts=conflicts,
        processes=processes,
        warnings=warnings,
        input_remarks=remarks,
        dup_echoes=dup_echoes,
        counts=counts,
        name_source=name_source,
        manifest_name=_text_or_none(manifest_project.get("name")),
        manifest_description=_text_or_none(manifest_project.get("description")),
    )


def _text_or_none(v: object) -> str | None:
    return str(v).strip() or None if v is not None else None


def _processes_of(inp: _Input, origin: int, remarks: list[str]) -> list[ProcessItem]:
    """Процессы входа перечнем манифеста. НЕ мерджим никогда: авторские
    sequence-диаграммы не склеиваются (решение груминга)."""
    archive = inp.archive
    assert archive is not None
    out: list[ProcessItem] = []
    for entry in (archive.manifest.get("contents") or {}).get("processes") or []:
        if not isinstance(entry, dict):
            continue
        fname = entry.get("file")
        text = archive.files.get(fname) if isinstance(fname, str) else None
        if not text:
            remarks.append(f"{fname}: файла процесса нет в архиве — пропущен")
            continue
        name = str(entry.get("name") or "").strip()
        if not name:
            name = str(fname).rsplit("/", 1)[-1].rsplit(".", 1)[0]
        out.append(ProcessItem(origin=origin, origin_label=inp.label, name=name, text=text))
    return out


def _warn_process_namesakes(processes: list[ProcessItem], warnings: list[str]) -> None:
    """Тёзки процессов РАЗНЫХ входов приедут оба — второму достанется суффикс.
    Предупреждаем заранее: молча размноженный процесс выглядит как ошибка сервиса."""
    seen: dict[str, list[str]] = {}
    for p in processes:
        seen.setdefault(p.name, []).append(p.origin_label)
    for name, labels in seen.items():
        if len(labels) > 1:
            warnings.append(
                f"процесс «{name}» есть в нескольких входах ({', '.join(labels)}) — "
                "процессы не сливаются, тёзка приедет с суффиксом « (2)»"
            )


def _resolve_families(
    raws: list[_Raw],
    node_paths: list[str],
    remarks: list[list[str]],
    dup_echoes: dict[tuple[int, int], set[int]],
) -> tuple[list[FamilyItem], list[FamilyConflict], FamilyCounts]:
    """Дедуп равных тел и конфликт-объекты по ключу (семья, merged-узел, ключ).
    dup_echoes заполняется для внутриархивных дублей (см. UnifiedPlan.dup_echoes)."""
    groups: dict[tuple[Family, int, tuple[str, ...]], list[_Raw]] = {}
    for r in raws:
        groups.setdefault((r.family, r.node_idx, r.key), []).append(r)

    items: list[FamilyItem] = []
    conflicts: list[FamilyConflict] = []
    counts = FamilyCounts()
    # Порядок конфликтов: по семьям (устойчиво к перестановке файлов внутри входа),
    # внутри семьи — порядок появления. Он же порядок ключей в id.
    ordered = sorted(groups.items(), key=lambda kv: _FAMILY_ORDER.index(kv[0][0]))
    for (family, node_idx, _key), group in ordered:
        seen_origins: set[int] = set()
        kept: list[_Raw] = []
        for r in group:
            if r.origin in seen_origins:
                dup_echoes[(r.origin, len(remarks[r.origin]))] = {
                    o.origin for o in group if o.origin != r.origin and _same_body(o, r)
                }
                remarks[r.origin].append(_dup_remark(r))
                continue
            seen_origins.add(r.origin)
            kept.append(r)
        distinct: list[_Raw] = []
        for r in kept:
            if not any(_same_body(d, r) for d in distinct):
                distinct.append(r)  # равные тела схлопываются молча
        first = distinct[0]
        if len(distinct) == 1:
            items.append(FamilyItem(family=family, node_idx=node_idx, key=first.key_str,
                                    origin=first.origin, origin_label=first.label,
                                    value=first.value, fname=first.fname))
            _bump(counts, family, 1)
            continue
        conflicts.append(FamilyConflict(
            id=f"{family}|{node_paths[node_idx]}|{first.key_str}",
            family=family,
            node_idx=node_idx,
            node_path=node_paths[node_idx],
            key=first.key_str,
            candidates=[_candidate(r) for r in distinct],
            # Доки — «взять все» (схемы дополняют друг друга, тёзкам суффикс);
            # скалярам («одна спека», «один параметр») брать всё некуда.
            default="all" if family == "doc" else "cand:0",
            allow_all=family == "doc",
        ))
        _bump(counts, family, len(distinct) if family == "doc" else 1)
    return items, conflicts, counts


def _candidate(raw: _Raw) -> FamilyCandidate:
    body = _body_of(raw)
    return FamilyCandidate(
        origin=raw.origin,
        origin_label=raw.label,
        summary=_summary_of(raw),
        body=body[:MAX_BODY],
        truncated=len(body) > MAX_BODY,
        value=raw.value,
        fname=raw.fname,
    )


def _bump(counts: FamilyCounts, family: Family, n: int) -> None:
    """Счётчик семьи при ДЕФОЛТНЫХ резолюциях: доки конфликта едут все, скаляры — один."""
    attr = {"doc": "docs", "spec": "specs", "table": "tables",
            "channel": "channels", "config": "params"}[family]
    setattr(counts, attr, getattr(counts, attr) + n)


# ── Остаток слияния структурой (Ф-E, docs/plan-byoa-quality.md) ─────────────
#
# Мердж докладывает СТРОКАМИ всё, чего не решил сам, и до Ф-E пользователь правил
# это руками уже на холсте. Теперь тот же остаток приезжает в превью структурой:
# фронт задаёт по нему вопросы, ответы уезжают применению (decisions). Строки
# остаются нетронутыми (Р1): их читает MCP, и на них стоит инвариант корзин.


# Подпись входа без имени файла: роутер зовёт так вход, пришедший без filename
# (вставленный текстом YAML фронт отправляет с пустым именем).
def _nameless(label: str, origin: int) -> bool:
    return not label.strip() or label == f"вход {origin + 1}"


def source_label(plan: UnifiedPlan, origin: int, current: int | None = None) -> str:
    """ИСТОЧНИК ЗНАНИЯ словами (§4.7 ТЗ Ф-E, правка Ф2г): «Из архива plugin-a.zip»,
    «Из файла shop.yaml», «Из файла 2», «Из проекта».

    Панель ввоза НЕ ЗНАЕТ, откуда пользователь взял файл: это может быть сессия
    агента, давно закрытая, или перенос между проектами. Поэтому ни «агента», ни
    имени корня (раньше им звали «агента файла») в подписи нет — только то, что
    пользователь сам положил в панель: имя архива или файла. У входа без имени
    (YAML, вставленный текстом) — номер его чипа."""
    if current is not None and origin == current:
        return "Из проекта"
    label = plan.labels[origin] if origin < len(plan.labels) else ""
    kind = plan.kinds[origin] if origin < len(plan.kinds) else "yaml"
    слово = "Из архива" if kind == "archive" else "Из файла"
    return f"{слово} {origin + 1}" if _nameless(label, origin) else f"{слово} {label}"


# Класс замечания узнаётся по устойчивой подстроке текста. Порядок значим: сначала
# самые узкие формулировки (тексты соседних классов делят общие слова).
_REMARK_CLASSES: tuple[tuple[str, str], ...] = (
    ("слиты в ОДИН объект", "absorbed"),
    ("указывают один источник", "shared_source"),
    ("встречается в файлах как РАЗНЫЕ объекты", "namesakes"),
    ("разные подписи из разных файлов", "edge_labels"),
    ("не имеют общих корневых узлов", "roots"),
    ("внутри системы оказались люди", "actors"),
    ("объектов без единой связи", "lonely"),
    ("иерархия уже выражает вложенность", "descendant"),
    ("в channel перечень", "channel_list"),
    ("канал не указан", "broker"),
)
# Хвосты-счётчики («…ещё N таких …») своего пункта не образуют: они приклеиваются
# к последнему замечанию СВОЕГО класса. Порядок значим по той же причине —
# «таких связей» есть подстрока «таких связей с брокером».
_REMARK_TAILS: tuple[tuple[str, str], ...] = (
    ("таких склеек по общему источнику", "absorbed"),
    ("таких источников", "shared_source"),
    ("таких связей с собственным потомком", "descendant"),
    ("таких связей с брокером", "broker"),
    ("таких связей с перечнем в channel", "channel_list"),
    ("таких групп", "isolated"),
    ("таких связей", "container"),
)

# ── Пункты свёртки «Придется подправить вручную» (Ф2г, тексты финальные) ─────
#
# Сырые строки мерджа адресованы агенту («задайте source.path», «выдайте файл
# заново»), а панель ввоза не знает, был ли агент вообще. Поэтому пункт свёртки —
# тот же факт другими словами: ЧТО не так и что с этим придётся сделать руками.
# Объекты берутся из сырой строки её же разметкой (маркеры классов выше не
# меняются); не разобралась строка — пункт сырой строкой как есть: правда общими
# словами лучше молчания. Сами строки мерджа НЕ меняются: их читают MCP и отчёты.


def _objects_word(n: int) -> str:
    """«У 1 объекта» / «У 5 объектов»: родительный падеж после «У»."""
    return "объекта" if n % 10 == 1 and n % 100 != 11 else "объектов"


_FRIENDLY: dict[str, tuple[re.Pattern[str], Callable[[re.Match[str]], str]]] = {
    "namesakes": (
        re.compile(r"^(?P<head>.+?) встречается в файлах как РАЗНЫЕ объекты"),
        lambda m: f"{m['head']} в разных файлах имеет разные метаданные. ArchMap не "
        "знает, это один и тот же объект или нет. Если это дубль, его нужно будет "
        "удалить вручную.",
    ),
    "absorbed": (
        re.compile(r"^(?P<names>.+?) слиты в ОДИН объект"),
        lambda m: f"{m['names']} указывают на один и тот же источник, поэтому ArchMap "
        "объединил их в один объект. Если это разные объекты, их нужно будет "
        "разделить вручную.",
    ),
    "shared_source": (
        re.compile(r"^(?P<names>.+?) указывают один источник"),
        lambda m: f"{m['names']} указывают на один и тот же источник. При следующем "
        "обновлении из кода ArchMap узнает только один из них, а второй станет "
        "дублем. Чтобы этого не случилось, поправьте якорь в карточке одного из "
        "объектов.",
    ),
    "edge_labels": (
        re.compile(
            r"^связи (?P<a>.+?) → (?P<b>.+?): разные подписи из разных файлов "
            r"\((?P<labels>.*)\) — "
        ),
        lambda m: f"У связи «{m['a']} → {m['b']}» в разных файлах разные подписи "
        f"({m['labels']}). Если это одна и та же связь, лишнюю нужно будет удалить "
        "вручную.",
    ),
    "roots": (
        re.compile(r"не имеют общих корневых узлов \((?P<names>.*)\) — "),
        lambda m: f"У файлов разные корневые объекты ({m['names']}), поэтому в проекте "
        "будет несколько корней. Если это одна система, их содержимое нужно будет "
        "перенести в один корень вручную.",
    ),
    "actors": (
        re.compile(r"внутри системы оказались люди \((?P<names>.*)\) — по C4"),
        lambda m: f"Внутри системы оказались люди ({m['names']}). Человек пользуется "
        "системой, а не входит в неё, поэтому их нужно будет перенести в корень схемы "
        "вручную.",
    ),
    "lonely": (
        re.compile(r"^объектов без единой связи: (?P<n>\d+) \((?P<names>.*)\) — "),
        lambda m: f"У {m['n']} {_objects_word(int(m['n']))} ({m['names']}) нет ни одной "
        "связи. Проверьте, не потерялись ли связи, и при необходимости проведите их "
        "вручную.",
    ),
    "descendant": (
        re.compile(r"^связь «(?P<edge>.+?)»: «.*иерархия уже выражает вложенность"),
        lambda m: f"Связь «{m['edge']}» ведёт от объекта к его собственной части. Её "
        "нужно будет удалить или перевесить вручную.",
    ),
    "channel_list": (
        re.compile(r"^связь «(?P<edge>.+?)»: в channel перечень «(?P<list>.*)» — "),
        lambda m: f"У связи «{m['edge']}» указано сразу несколько каналов "
        f"(«{m['list']}»). Её нужно будет разделить на отдельные связи вручную.",
    ),
    "broker": (
        re.compile(r"^связь «(?P<edge>.+?)»: конец — брокер «(?P<broker>.+?)», а канал не указан"),
        lambda m: f"У связи «{m['edge']}» с брокером «{m['broker']}» не указан канал. "
        "Его нужно будет вписать в карточке связи вручную.",
    ),
}
_TAIL_RE = re.compile(r"^…ещё (?P<n>\d+) таких")


_PROCESS_MANY = re.compile(r"^процесс «(?P<name>.+?)» есть в нескольких входах \((?P<labels>.+?)\) — ")
# Строка ПРИМЕНЕНИЯ (создание и догрузка): тёзка уже приехал, имя известно точно.
_PROCESS_RENAMED = re.compile(
    r"^процесс «(?P<name>.+?)» из входа «(?P<label>.+?)» приехал под именем «(?P<new>.+)»: "
    r"процессы не сливаются"
)
_PROCESS_LIVE = re.compile(r"^процесс «(?P<name>.+?)» из входа «(?P<label>.+?)» — тёзка уже имеющегося")
_LIVE_NAMESAKES = re.compile(r"^узлы-тёзки «(?P<path>.+?)» слились в один")


def friendly_process_note(text: str) -> str:
    """Пункт свёртки из замечаний о тёзках процессов (создание и догрузка) и о
    тёзках среди живых узлов (догрузка). Незнакомая строка — как есть."""
    if (m := _PROCESS_MANY.search(text)) is not None:
        return (
            f"Процесс «{m['name']}» есть в нескольких файлах ({m['labels']}). Процессы не "
            f"объединяются, поэтому второй приедет под именем «{m['name']} (2)». Если это "
            "один и тот же процесс, лишний нужно будет удалить вручную."
        )
    if (m := _PROCESS_LIVE.search(text)) is not None:
        return (
            f"Процесс «{m['name']}» из «{m['label']}» совпадает по имени с уже имеющимся в "
            f"проекте и приедет под именем «{m['name']} (2)». Если это один и тот же "
            "процесс, лишний нужно будет удалить вручную."
        )
    if (m := _LIVE_NAMESAKES.search(text)) is not None:
        return (
            f"В проекте несколько объектов «{m['path']}», и знание из архива приедет "
            "только к первому из них. Остальные останутся как были."
        )
    if (m := _PROCESS_RENAMED.search(text)) is not None:
        return (
            f"Процесс «{m['name']}» из «{m['label']}» совпал по имени с другим процессом и "
            f"приехал под именем «{m['new']}». Если это один и тот же процесс, лишний нужно "
            "будет удалить вручную."
        )
    return text


# ── Строки отчёта ПРИМЕНЕНИЯ (правка Ф2г-2) ──────────────────────────────────
#
# Отчёт применения («Проект создан» / «Архивы догружены») показывает не сырой
# список warnings (его читает MCP), а ту же свёртку «Придется подправить вручную».
# Строка применения — одно из двух:
#   (а) ИНФОРМАЦИЯ о сделанном, уже видном по счётчикам или по выбору человека
#       («пустовало — залито», «заменено по вашему решению», «Ваши решения: …»,
#       легенда нумерации файлов) — в свёртку не едет;
#   (б) ТРЕБУЕТ ВНИМАНИЯ (в архиве другое значение, а живое оставлено; параметр не
#       догружен; части записи не слились; процесс приехал с суффиксом) — пункт
#       свёртки дружелюбным текстом. Незнакомая строка — сырой как есть.

_APPLY_INFO: tuple[re.Pattern[str], ...] = (
    re.compile(r"^узел «.+?»: поле «[^»]+» пустовало — залито из "),
    re.compile(r"^узел «.+?»: поле «[^»]+» заменено по вашему решению"),
    re.compile(r"^нумерация файлов в замечаниях слияния: "),
    re.compile(r"^Ваши решения: "),
)
_FIELD_KEPT = re.compile(
    r"^узел «(?P<path>.+?)»: поле «(?P<field>[^»]+)» в архиве другое \(«(?P<new>.*)»\) — "
    r"оставлено живое \(«(?P<cur>.*)»\)$"
)
_PARAM_GONE = re.compile(r"^параметр «(?P<name>.+?)»: живой записи уже нет — пропущен")
_EXTRA_PARTS = re.compile(
    r"^(?P<kind>таблица|канал) «(?P<key>.+?)» узла «(?P<path>.+?)»: (?P<part>колонок|полей) "
    r"(?P<names>.+) в архиве нет — оставлены"
)
# Форма и статус едут в строку кодами контракта — человеку их называем словами.
# Зеркало SHAPE_LABEL (questionText.ts) и STATUS_META (graph/colors.ts) фронта.
_CODE_RU: dict[str, dict[str, str]] = {
    "форма": {"service": "Сервис", "database": "База данных", "broker": "Брокер",
              "person": "Пользователь"},
    "статус": {"existing": "Существует", "planned": "Проектируется", "deprecated": "Выводится"},
}


def _human(field_ru: str, value: str) -> str:
    return _CODE_RU.get(field_ru, {}).get(value, value)


def _extra_parts_text(m: re.Match[str]) -> str:
    """«Остались колонки …» с согласованием по числу: одна часть — «осталась
    колонка … которой», несколько — «остались колонки … которых»."""
    one = m["names"].count("«") == 1
    where = (f"В таблице «{m['key']}»" if m["kind"] == "таблица" else f"В канале «{m['key']}»")
    if m["part"] == "колонок":
        what = "осталась колонка" if one else "остались колонки"
        rel, it = ("которой", "она больше не нужна, её") if one else ("которых", "они больше не нужны, их")
    else:
        what = "осталось поле" if one else "остались поля"
        rel, it = ("которого", "оно больше не нужно, его") if one else ("которых", "они больше не нужны, их")
    return (
        f"{where} объекта «{m['path']}» {what} {m['names']}, {rel} нет в архиве: догрузка "
        f"ничего не удаляет. Если {it} нужно будет удалить вручную."
    )


def friendly_apply_note(text: str) -> str | None:
    """Строка отчёта применения → пункт свёртки; None — информация (не показывать).

    Строки процессов и живых тёзок разбирает friendly_process_note; незнакомая
    строка — как есть (правда общими словами лучше молчания)."""
    if any(p.search(text) for p in _APPLY_INFO):
        return None
    if (m := _FIELD_KEPT.search(text)) is not None:
        return (
            f"У объекта «{m['path']}» в архиве другое значение поля «{m['field']}» "
            f"(«{_human(m['field'], m['new'])}»), а в проекте осталось прежнее "
            f"(«{_human(m['field'], m['cur'])}»). Если верно значение из архива, поле нужно "
            "будет поправить в карточке объекта вручную."
        )
    if (m := _PARAM_GONE.search(text)) is not None:
        return (
            f"Параметр «{m['name']}» не догружен: в проекте его уже нет. Если он нужен, его "
            "нужно будет добавить вручную."
        )
    if (m := _EXTRA_PARTS.search(text)) is not None:
        return _extra_parts_text(m)
    return friendly_process_note(text)


def apply_unfixable(lines: list[str]) -> list[UnfixableOut]:
    """Строки, добавленные ПРИМЕНЕНИЕМ, — пунктами свёртки отчёта (без информации)."""
    return [
        UnfixableOut(id=f"apply|{j}", text=t)
        for j, raw in enumerate(lines)
        if (t := friendly_apply_note(raw)) is not None
    ]


def friendly_remark(text: str) -> str:
    """Пункт свёртки из сырой строки замечания (не хвоста); незнакомый класс или
    неразобранная строка — сама строка как есть."""
    cls, _tail = _remark_class(text)
    rule = _FRIENDLY.get(cls)
    m = rule[0].search(text) if rule is not None else None
    return rule[1](m) if rule is not None and m is not None else text


def _tail_sentence(text: str) -> str:
    """Хвост-счётчик «…ещё N таких …» — отдельным предложением к своему пункту."""
    m = _TAIL_RE.search(text)
    return f"И ещё {m['n']} таких же." if m is not None else text


def _remark_class(text: str) -> tuple[str, bool]:
    """(класс замечания, хвост ли это). Пустой класс — незнакомое замечание."""
    if text.startswith("…ещё"):
        for marker, cls in _REMARK_TAILS:
            if marker in text:
                return cls, True
        return "", True
    for marker, cls in _REMARK_CLASSES:
        if marker in text:
            return cls, False
    return "", False


class _Tree:
    """Слитое дерево под вопросы: потомки контейнера, признак «контейнер», связи узла."""

    def __init__(self, plan: UnifiedPlan) -> None:
        merged = plan.merged
        nodes = merged.nodes if merged else []
        self.paths = plan.node_paths
        self.parent = [n.parent_idx for n in nodes]
        self.has_children = [False] * len(nodes)
        for pi in self.parent:
            if pi is not None:
                self.has_children[pi] = True
        self.edges = [0] * len(nodes)
        for e in merged.edges if merged else []:
            self.edges[e.source_idx] += 1
            if e.target_idx != e.source_idx:
                self.edges[e.target_idx] += 1

    def descends(self, child: int, ancestor: int) -> bool:
        pi = self.parent[child]
        while pi is not None:
            if pi == ancestor:
                return True
            pi = self.parent[pi]
        return False

    def components(self, container: int) -> list[int]:
        """ВСЁ поддерево контейнера в порядке обхода дерева (индексы слитого
        дерева идут «родители раньше детей»), без капа: кап — дело фронта."""
        return [i for i in range(len(self.paths)) if self.descends(i, container)]

    def where(self, parent: int | None) -> str:
        return f"внутри «{self.paths[parent]}»" if parent is not None else "на верхнем уровне"


@dataclass
class RemainderIndex:
    """АДРЕСА элементов остатка в слитом дереве: id вопроса → индексы, которыми
    применение правит дерево.

    Строится ТЕМ ЖЕ проходом, что и RemainderOut (remainder_with_index): разойдись
    они — и ответ пользователя применился бы не к тому, о чём его спросили."""

    fields: dict[str, tuple[int, str, list[str]]] = field(default_factory=dict)
    # id → (индекс связи, конец, «путь компонента → его индекс»)
    edges: dict[str, tuple[int, str, dict[str, int]]] = field(default_factory=dict)
    groups: dict[str, list[int]] = field(default_factory=dict)
    pairs: dict[str, tuple[int, int]] = field(default_factory=dict)
    # Путь узла → индекс: концы новой связи пользователь называет путями. Тёзки
    # (якорь разводит их законно) адресуются первым — как и везде в превью.
    nodes: dict[str, int] = field(default_factory=dict)


def remainder_from_plan(plan: UnifiedPlan, current: int | None = None) -> RemainderOut:
    """Остаток слияния структурой (без адресов — они нужны только применению)."""
    return remainder_with_index(plan, current)[0]


def remainder_with_index(
    plan: UnifiedPlan, current: int | None = None
) -> tuple[RemainderOut, RemainderIndex]:
    """Остаток слияния структурой и его адреса. current — индекс входа ЖИВОГО
    проекта (0 у догрузки, None при создании).

    Р3 догрузки: элемент, в котором не участвует ничего нового, в остаток НЕ
    попадает — это дело панели незавершённости, а не догрузки. Догрузка отвечает
    за то, что привезли архивы."""
    merged = plan.merged
    if not plan.ok or merged is None:
        return RemainderOut(), RemainderIndex()
    report = plan.report
    tree = _Tree(plan)
    paths = plan.node_paths
    index = RemainderIndex()
    for i, p in enumerate(paths):
        index.nodes.setdefault(p, i)

    def свой(node_idx: int) -> bool:
        """Узел УЖЕ ЕСТЬ в живом проекте (догрузка). Именно «есть», а не «пришёл
        только оттуда»: архив, повторяющий живой узел, нового объекта не привозит,
        и остаток вокруг таких узлов — дело панели незавершённости, а не догрузки
        (иначе свой же архив, догруженный к себе, задал бы вопросы обо всём)."""
        return current is not None and current in report.node_files[node_idx]

    def кандидат(origin: int, value: str) -> RemainderCandidateOut:
        return RemainderCandidateOut(
            origin=origin,
            origin_label=plan.labels[origin] if origin < len(plan.labels) else "",
            source_label=source_label(plan, origin, current),
            value=value,
            current=origin == current,
        )

    seen: set[str] = set()

    def свежий(eid: str) -> bool:
        """Id адресует ОДИН элемент: столкнувшиеся (узлы-тёзки, разведённые якорем)
        вопросом не становятся — применить ответ было бы некуда."""
        if eid in seen:
            return False
        seen.add(eid)
        return True

    # ── Споры полей: вопрос только там, где вклады равно содержательны (П2).
    fields: list[FieldDisputeOut] = []
    for d in report.field_disputes:
        if all(fi == current for fi, _v in d.contributions):
            continue  # Р3 (по построению недостижимо: спор — это всегда два входа)
        eid = f"field|{paths[d.node_idx]}|{d.field}"
        if not свежий(eid):
            continue
        cands = [кандидат(fi, v) for fi, v in d.contributions]
        # Дефолт — то, что применится без ответа: живой кандидат у догрузки
        # («оставить моё»), первый по порядку файлов при создании.
        default = next((i for i, c in enumerate(cands) if c.current), 0)
        fields.append(FieldDisputeOut(
            id=eid,
            node_path=paths[d.node_idx],
            field=d.field,  # type: ignore[arg-type]  # ровно поля _decide
            candidates=cands,
            default=default,
        ))
        index.fields[eid] = (d.node_idx, d.field, [c.value for c in cands])

    # ── Связи в контейнер. В догрузке — только НОВЫЕ связи: перевесить живую
    #    значило бы тронуть то, о чём не спрашивали (Р3).
    container: list[ContainerEdgeOut] = []
    converted: set[int] = set()
    for rec in report.container_edges:
        if current is not None and current in report.edge_files[rec.edge_idx]:
            continue
        e = merged.edges[rec.edge_idx]
        eid = (
            f"edge|{paths[e.source_idx]}|{paths[e.target_idx]}|{e.label or ''}|{rec.end}"
        )
        if not свежий(eid):
            continue
        comps = tree.components(rec.container_idx)
        container.append(ContainerEdgeOut(
            id=eid,
            from_path=paths[e.source_idx],
            to_path=paths[e.target_idx],
            label=e.label,
            technology=e.technology,
            end=rec.end,  # type: ignore[arg-type]  # «source» | «target» по построению
            container_path=paths[rec.container_idx],
            components=[
                ComponentOut(path=paths[i], has_children=tree.has_children[i]) for i in comps
            ],
        ))
        index.edges[eid] = (rec.edge_idx, rec.end, {paths[i]: i for i in comps})
        if rec.warning_idx is not None:
            converted.add(rec.warning_idx)

    # ── Изолированные группы.
    groups: list[IsolatedGroupOut] = []
    for g in report.isolated_groups:
        if all(свой(i) for i in g.node_idxs):
            continue  # Р3: группа целиком живая — не дело догрузки
        eid = f"group|{paths[g.node_idxs[0]]}"
        if not свежий(eid):
            continue
        groups.append(IsolatedGroupOut(id=eid, node_paths=[paths[i] for i in g.node_idxs]))
        index.groups[eid] = list(g.node_idxs)
        if g.warning_idx is not None:
            converted.add(g.warning_idx)

    # ── Похожие имена. Пара заведомо из РАЗНЫХ входов (мердж не сравнивает узлы
    #    одного файла), поэтому «обе стороны живые» тут невозможно.
    pairs: list[FuzzyPairOut] = []
    for f in report.fuzzy_pairs:
        if свой(f.a_idx) and свой(f.b_idx):
            continue
        eid = f"pair|{paths[f.a_idx]}|{paths[f.b_idx]}"
        if not свежий(eid):
            continue
        pairs.append(FuzzyPairOut(
            id=eid,
            a_path=paths[f.a_idx],
            b_path=paths[f.b_idx],
            a_source=source_label(plan, min(report.node_files[f.a_idx]), current),
            b_source=source_label(plan, min(report.node_files[f.b_idx]), current),
            a_edges=tree.edges[f.a_idx],
            b_edges=tree.edges[f.b_idx],
            where=tree.where(f.parent_idx),
            a_current=свой(f.a_idx),
            b_current=свой(f.b_idx),
        ))
        index.pairs[eid] = (f.a_idx, f.b_idx)
        if f.warning_idx is not None:
            converted.add(f.warning_idx)

    return RemainderOut(
        field_conflicts=fields,
        container_edges=container,
        isolated_groups=groups,
        fuzzy_pairs=pairs,
        unfixable=_unfixable(plan, converted, current),
        converted_warnings=_converted_texts(report.warnings, converted),
        node_paths=list(paths),
        node_has_children=list(tree.has_children),
    ), index


def _converted_texts(warnings: list[str], converted: set[int]) -> list[str]:
    """Тексты строк, ставших вопросами, — в порядке строк и без повторов.

    Текстом, а не индексом: строка живёт в трёх местах отчёта (общий список,
    схемная корзина, корзина своего файла) с разной нумерацией, а текст там один и
    тот же. Повторы гасим: два класса могут сойтись в одной формулировке, а фронту
    нужен набор «что прятать»."""
    out: list[str] = []
    seen: set[str] = set()
    for i in sorted(converted):
        text = warnings[i]
        if text not in seen:
            seen.add(text)
            out.append(text)
    return out


# Сырая строка мерджа о законных тёзках («оставлены раздельно»): имя и родитель.
# Родитель — путь слитого дерева, «на верхнем уровне» — без родителя.
_NAMESAKES = re.compile(
    r"^«(?P<name>.+?)» \((?:внутри «(?P<parent>.+)»|на верхнем уровне)\) "
    r"встречается в файлах как РАЗНЫЕ объекты"
)


def _live_namesakes(plan: UnifiedPlan, text: str, current: int) -> bool:
    """Замечание о тёзках, которые ВСЕ уже живут в проекте (догрузка): Р3 — элемент
    без участия нового в остаток не попадает.

    Строку мердж пишет без владельца (это «отношение файлов»), поэтому общий фильтр
    по владельцу её не гасит, а догрузка своего архива давала бы пункт «разные
    метаданные» о живой паре законных тёзок — той самой, что уже стоит в проекте.
    Узлов строка не несёт — группа восстанавливается по имени и родителю тем же
    сравнением, каким мердж их сопоставлял. Хоть один тёзка новый (архив привёз
    третьего) или строка не разобралась — пункт остаётся: вопрос «дубль ли это»
    тогда законен."""
    m = _NAMESAKES.search(text)
    merged = plan.merged
    if m is None or merged is None:
        return False
    name, parent, paths = _norm(m["name"]), m["parent"], plan.node_paths
    group = [
        i
        for i, n in enumerate(merged.nodes)
        if _norm(n.name) == name
        and (paths[n.parent_idx] if n.parent_idx is not None else None) == parent
    ]
    return bool(group) and all(current in plan.report.node_files[i] for i in group)


def _unfixable(
    plan: UnifiedPlan, converted: set[int], current: int | None = None
) -> list[UnfixableOut]:
    """Свёртка «Придется подправить вручную» (§6 ТЗ, правка Ф2г): ВСЕ замечания
    принятых входов, не ставшие вопросами, — пунктом на замечание.

    Входят и схемные строки (без владельца), и пофайловые: карточки «Замечания к
    файлу N» в панели больше нет, и знать об этом пользователь может только отсюда.
    Туда же — замечания семей архивов (промах адреса, внутриархивный дубль): они
    живут не в строках мерджа, а в input_remarks, и адресованы своему архиву.
    Конфликты полей сюда не едут: расхождение, решённое правилом мерджа, — это
    чтение, а не действие.

    current — вход ЖИВОГО проекта у догрузки: его собственные замечания (одинокие
    объекты, люди внутри системы…) — дело панели незавершённости, а не догрузки (Р3).
    Хвост-счётчик «…ещё N таких …» своего пункта не образует: он приклеен
    предложением к последнему пункту своего класса."""
    report = plan.report
    out: list[UnfixableOut] = []
    last: dict[str, UnfixableOut] = {}
    for i, (text, owner) in enumerate(
        zip(report.warnings, report.warning_files, strict=True)
    ):
        if i in converted or (current is not None and owner == current):
            continue
        cls, tail = _remark_class(text)
        if cls == "namesakes" and current is not None and _live_namesakes(plan, text, current):
            continue
        if tail:
            # Хвост о тех же объектах, что строки перед ним. Класс весь ушёл в
            # вопросы — хвост уходит с ним.
            цель = last.get(cls) or (out[-1] if cls == "" and out else None)
            if цель is not None:
                цель.text = f"{цель.text} {_tail_sentence(text)}"
            continue
        item = UnfixableOut(id=f"remark|{i}", text=friendly_remark(text), file=owner)
        out.append(item)
        last[cls] = item
    # Верхнеуровневые замечания плана (тёзки процессов разных входов) адресовать
    # входу нельзя, и раньше при создании они не показывались нигде. В догрузке
    # тёзок считает она сама (unified_into._process_notes: знает копии живых) —
    # там этот пункт не нужен.
    if current is None:
        out.extend(
            UnfixableOut(id=f"plan|{j}", text=friendly_process_note(w))
            for j, w in enumerate(plan.warnings)
        )
    for k, remarks in enumerate(plan.input_remarks):
        if k == current:
            continue
        # Путь файла внутри архива без имени архива неоднозначен (у двух архивов
        # бывают одинаковые docs/…), поэтому пункт начинается с имени входа.
        label = plan.labels[k] if k < len(plan.labels) else f"вход {k + 1}"
        out.extend(
            UnfixableOut(id=f"input|{k}|{j}", text=f"{label}: {r}", file=k)
            for j, r in enumerate(remarks)
            # Р3: дубль, равный записи живого проекта, знания не теряет.
            if current is None or current not in plan.dup_echoes.get((k, j), ())
        )
    return out


# ── Превью (то же самое человеку и фронту) ───────────────────────────────────


def family_candidate_out(
    plan: UnifiedPlan, k: FamilyCandidate, current: int | None = None
) -> FamilyCandidateOut:
    """Кандидат спора семьи наружу. Один сборщик на создание и догрузку: подпись
    источника (§4.7) у них обязана быть одной и той же."""
    return FamilyCandidateOut(
        origin=k.origin,
        origin_label=k.origin_label,
        source_label=source_label(plan, k.origin, current),
        summary=k.summary,
        body=k.body,
        truncated=k.truncated,
        current=k.current,
    )


def preview_from_plan(plan: UnifiedPlan) -> UnifiedPreviewOut:
    """План → ответ превью единой панели.

    Замечания семей доложены в ПОФАЙЛОВЫЕ корзины C4-отчёта по индексу входа: у
    пользователя один список на чип, а не два рядом. Схемные корзины остаются
    свойством слитой картины (split_remarks), как у обычного импорта."""
    file_remarks, schema_errors, schema_warnings = split_remarks(plan.report)
    remarks_out = [
        FileRemarksOut(
            file=f.file,
            errors=f.errors,
            warnings=[*f.warnings, *plan.input_remarks[i]],
        )
        for i, f in enumerate(file_remarks)
    ]
    merged = plan.merged
    c4 = ImportPreviewOut(
        ok=plan.ok,
        errors=plan.errors,
        node_count=len(merged.nodes) if merged else 0,
        edge_count=len(merged.edges) if merged else 0,
        roots=merged.roots[:8] if merged else [],
        files=len(plan.labels),
        merged_count=len(plan.report.merged_paths),
        merged=plan.report.merged_paths[:8],
        # Ф2 якорей: основание каждой склейки словами и счётчик узлов без якоря.
        merged_nodes=[
            MergedNodeOut(path=path, basis=basis)  # type: ignore[arg-type]  # словарь BASIS_ORDER
            for path, basis in merged_with_basis(plan.report)
        ],
        nodes_without_anchor=count_without_anchor(merged) if merged else 0,
        conflicts=plan.report.conflicts,
        warnings=plan.report.warnings,
        dropped_edges=plan.report.dropped_edges,
        node_names=[n.name for n in merged.nodes] if merged else [],
        file_remarks=remarks_out,
        schema_errors=schema_errors,
        schema_warnings=schema_warnings,
    )
    return UnifiedPreviewOut(
        ok=plan.ok,
        errors=plan.errors,
        c4=c4,
        families=UnifiedFamilyCountsOut(**asdict(plan.counts)),
        family_conflicts=[
            FamilyConflictOut(
                id=c.id,
                family=c.family,
                node_path=c.node_path,
                key=c.key,
                candidates=[family_candidate_out(plan, k) for k in c.candidates],
                default=c.default,
                allow_all=c.allow_all,
            )
            for c in plan.conflicts
        ],
        remainder=remainder_from_plan(plan, None),
        warnings=plan.warnings,
        name_source=plan.name_source,
        manifest_name=plan.manifest_name,
        manifest_description=plan.manifest_description,
    )


__all__ = [
    "MAX_ARCHIVES",
    "MAX_INPUTS",
    "DocIn",
    "FamilyCandidate",
    "FamilyConflict",
    "FamilyCounts",
    "FamilyItem",
    "ProcessItem",
    "UnifiedImportError",
    "UnifiedPlan",
    "build_unified_plan",
    "apply_unfixable",
    "family_candidate_out",
    "friendly_apply_note",
    "friendly_process_note",
    "friendly_remark",
    "preview_from_plan",
    "RemainderIndex",
    "remainder_from_plan",
    "remainder_with_index",
    "source_label",
]