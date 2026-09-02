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

from dataclasses import asdict, dataclass, field
from typing import Literal

import yaml

from app.archive_import import ArchiveError, _Archive, _listed, _read_zip
from app.channels_import import ChannelIn, parse_channels_file
from app.config_import import ParamIn, parse_config_file
from app.data_import import LOOKS_LIKE_DATA, NODE_HEADER, TableIn, parse_data_file
from app.import_merge import MergeReport, merge_imports, split_remarks, warn_content
from app.import_yaml import ParsedImport, parse_import
from app.mmd_header import parse_mmd_header, strip_header
from app.schemas.project import FileRemarksOut, ImportPreviewOut
from app.schemas.unified_import import (
    FamilyCandidateOut,
    FamilyConflictOut,
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
    items: list[FamilyItem] = field(default_factory=list)
    conflicts: list[FamilyConflict] = field(default_factory=list)
    processes: list[ProcessItem] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)  # верхнеуровневые (не адресуемы входу)
    input_remarks: list[list[str]] = field(default_factory=list)  # по записи на вход
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


class _Resolver:
    """Адрес файла семьи → узел СЛИТОГО дерева, через C4 своего входа.

    Промах и тёзки — замечание входу, файл пропускается: та же норма, что у всех
    приёмников (archive_import.resolve), деградация видимая."""

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

    def resolve(self, path: str | None, fname: str) -> int | None:
        hits = self.by_path.get(path or "", [])
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
            body=strip_header(content).lstrip("\n"),
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

    items, conflicts, counts = _resolve_families(raws, node_paths, remarks)
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
        items=items,
        conflicts=conflicts,
        processes=processes,
        warnings=warnings,
        input_remarks=remarks,
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
    raws: list[_Raw], node_paths: list[str], remarks: list[list[str]]
) -> tuple[list[FamilyItem], list[FamilyConflict], FamilyCounts]:
    """Дедуп равных тел и конфликт-объекты по ключу (семья, merged-узел, ключ)."""
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


# ── Превью (то же самое человеку и фронту) ───────────────────────────────────


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
                candidates=[
                    FamilyCandidateOut(
                        origin=k.origin,
                        origin_label=k.origin_label,
                        summary=k.summary,
                        body=k.body,
                        truncated=k.truncated,
                        current=k.current,
                    )
                    for k in c.candidates
                ],
                default=c.default,
                allow_all=c.allow_all,
            )
            for c in plan.conflicts
        ],
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
    "preview_from_plan",
]