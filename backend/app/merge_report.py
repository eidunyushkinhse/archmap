"""Отчёт слияния импортов: замечания, склейки и СТРУКТУРНЫЙ ОСТАТОК, который превью
разбирает вопросами. Вынесен из app/import_merge.py (аудит Q-18): слияние пишет отчёт,
анализаторы содержимого (app/merge_warnings.py) его дополняют, превью читает."""

from collections.abc import Iterable
from dataclasses import dataclass, field
from typing import TypeGuard

from app.domain_types import NodeElement
from app.import_yaml import (
    ParsedImport,
)

# ── СТРУКТУРНЫЙ ОСТАТОК СЛИЯНИЯ (Ф-E, docs/plan-byoa-quality.md) ─────────────
# Те же находки, что уезжают строками в conflicts/warnings, записанные ИНДЕКСАМИ
# слитого дерева: по ним превью задаёт пользователю вопросы, а применение меняет
# дерево до записи в БД. Строки остаются на месте (их читает MCP, и на них стоит
# инвариант «объединение корзин == плоские списки») — структура их ДОПОЛНЯЕТ.
#
# warning_idx — индекс строки report.warnings, породившей запись; None означает
# «строки нет» (её съел общий кап _MAX_WARNINGS). По нему сборщик остатка
# отделяет замечания, превращённые в вопросы, от тех, что остались текстом.


@dataclass
class FieldDispute:
    """Спор о поле узла между РАВНО содержательными вкладами (П2 остаётся в силе:
    содержательный вклад бьёт заглушку молча, и спора там нет).

    Кандидаты — в порядке файлов, без повторов значения: три файла, спорящие об
    одном поле, дают ОДНУ запись с тремя кандидатами, а не два спора подряд."""

    node_idx: int
    field: str  # role | technology | description | shape | status | element
    contributions: list[tuple[int, str]]  # (индекс файла, значение)


@dataclass
class ContainerEdgeRec:
    """Конец связи, легший на контейнер с компонентами. Оба конца в контейнерах —
    ДВЕ записи на одну связь (и одну строку замечания)."""

    edge_idx: int
    end: str  # «source» | «target»
    container_idx: int
    warning_idx: int | None = None


@dataclass
class IsolatedGroupRec:
    """Группа, оторванная от ядра схемы. Капа _MAX_ISOLATED_GROUPS здесь нет: кап —
    дело ТЕКСТА замечания, а вопрос пользователю положен каждой группе."""

    node_idxs: list[int]
    warning_idx: int | None = None


@dataclass
class FuzzyPairRec:
    """Пара похожих имён из разных файлов — кандидат на склейку рукой человека."""

    a_idx: int
    b_idx: int
    parent_idx: int | None
    warning_idx: int | None = None


@dataclass
class MergeReport:
    """Человеческий отчёт слияния для превью модалки. errors — только нарушение
    суммарных лимитов (per-file лимиты держит parse_import).

    Плоские списки (conflicts/warnings/errors) — исторический контракт превью, их
    наполнение не меняется. Поверх них живёт РАЗМЕТКА ПРИРОДЫ замечания (Ф6): пакет
    собирают N агентов, каждый видит только свой репозиторий и переписывает только
    свой файл, поэтому замечание, порождённое содержимым одного файла, адресуемо
    его агенту, а свойство слитой картины — только человеку (split_remarks).

    Адресат считается по ПРОИСХОЖДЕНИЮ виновных сущностей, а не по классу замечания
    (Ф7, находка пользователя): класс давал разный ответ на один и тот же файл в
    зависимости от того, сколько документов лежит рядом в панели. Правило одно на все
    классы: собери виновные сущности замечания; есть файл, внёсший вклад в каждую из
    них, — ему замечание и адресуется (при нескольких кандидатах — наименьший номер,
    _least), нет — схемная корзина."""

    files: int
    merged_paths: list[str] = field(default_factory=list)  # узлы, склеенные из ≥2 файлов
    # ОСНОВАНИЕ каждой склейки — строка в строку с merged_paths (Ф2 якорей):
    # «code» | «dependency» | «name». Доклад, а не решение: на исход слияния не влияет.
    merged_basis: list[str] = field(default_factory=list)
    conflicts: list[str] = field(default_factory=list)  # расхождения полей (кто победил — в тексте)
    warnings: list[str] = field(default_factory=list)  # fuzzy-пары, разные корни, похожие рёбра
    dropped_edges: int = 0  # выброшенные точные дубли рёбер
    errors: list[str] = field(default_factory=list)
    # ── разметка природы замечаний (Ф6, docs/plan-skeptic-audit.md) ────────────
    # Для каждой строки warnings/errors — индекс файла-виновника (с 0) либо None
    # («виноватого» файла нет: свойство слитой картины или отношений между файлами).
    # Длины держатся равными len(warnings)/len(errors) методами warn()/error().
    warning_files: list[int | None] = field(default_factory=list)
    error_files: list[int | None] = field(default_factory=list)
    # Ошибки РАЗБОРА отдельных файлов, БЕЗ префикса «файл N: » (адресация уже в
    # структуре). Плоский список ошибок собирает parse_and_merge — с префиксом, как раньше.
    file_errors: dict[int, list[str]] = field(default_factory=dict)
    # Служебная атрибуция слитого дерева (не для показа): какие файлы внесли вклад
    # в каждый узел / каждую связь. По ней проверки содержания решают, кому
    # адресовать замечание о конкретном объекте.
    node_files: list[set[int]] = field(default_factory=list)
    edge_files: list[set[int]] = field(default_factory=list)
    # Происхождение вкладов с точностью ДО УЗЛА ВХОДНОГО ФАЙЛА (Ф0 единого импорта,
    # docs/plan-unified-import.md): для каждого merged-узла (индексация та же, что у
    # node_files и merged.nodes) список (индекс файла, индекс узла в этом файле) в
    # порядке поступления файлов. node_files огрубляет это до множества файлов —
    # проверкам содержания хватает «кто виноват», а перевеске семей фактов архивов
    # (доки, БД, каналы, конфиги) на merged-узлы в Ф1 нужен адрес конкретного узла:
    # семья адресована путём по C4 СВОЕГО архива, и её надо довести до узла слитого
    # дерева. Каждый узел каждого входа встречается ровно один раз.
    node_contribs: list[list[tuple[int, int]]] = field(default_factory=list)
    # Основание склейки КАЖДОГО merged-узла (индексация та же, что у node_contribs):
    # None — узел пришёл из одного файла и ни с кем не склеивался; иначе СИЛЬНЕЙШЕЕ
    # основание среди его вкладов (code > dependency > name). Нужно догрузке: она
    # называет пользователю, чем найден каждый живой узел, к которому едет знание.
    node_basis: list[str | None] = field(default_factory=list)
    # ── структурный остаток (Ф-E): то же, что в строках, но индексами ─────────
    # Индексация — по merged.nodes / merged.edges, как у node_files и edge_files.
    field_disputes: list[FieldDispute] = field(default_factory=list)
    container_edges: list[ContainerEdgeRec] = field(default_factory=list)
    isolated_groups: list[IsolatedGroupRec] = field(default_factory=list)
    fuzzy_pairs: list[FuzzyPairRec] = field(default_factory=list)
    # Узлы слитого дерева ДО санитизации элемента (settle_elements): родитель, элемент,
    # площадки — индексация по merged.nodes. Применение берёт их, когда ответ на спор
    # элемента снял с узла «контейнер»: его поддерево возвращается к документу (базы и
    # брокеры, вынесенные из-за «контейнера», — обратно), и санитизация применения решает
    # уже по ответу (Ф13а). Пусто — слияния не было (один вход).
    pre_settle: list[tuple[int | None, NodeElement | None, list[str]]] = field(
        default_factory=list
    )
    # Номера строк warnings, которые написала сама санитизация слияния: только их может
    # отменить ответ «Система» (замечания разбора отдельного файла остаются в силе).
    settle_warnings: range = range(0)

    def forget_cut_warnings(self, kept: int) -> None:
        """Строк после kept больше нет (общий кап) — записи остаются, ссылка на
        строку гаснет. Иначе индекс указывал бы на чужую строку: после удаления
        хвоста на его месте оказывается «…и ещё N предупреждений»."""
        записи: list[ContainerEdgeRec | IsolatedGroupRec | FuzzyPairRec] = [
            *self.container_edges, *self.isolated_groups, *self.fuzzy_pairs
        ]
        for rec in записи:
            if rec.warning_idx is not None and rec.warning_idx >= kept:
                rec.warning_idx = None

    def warn(self, text: str, file: int | None = None) -> None:
        """Предупреждение: в плоский список (как раньше) и в разметку природы."""
        self.warnings.append(text)
        self.warning_files.append(file)

    def error(self, text: str, file: int | None = None) -> None:
        self.errors.append(text)
        self.error_files.append(file)

    def _common(self, attribution: list[set[int]], idxs: Iterable[int]) -> set[int]:
        """Файлы, внёсшие вклад в КАЖДЫЙ из названных объектов (пересечение
        атрибуций). Пусто — общего файла нет: замечание не адресуемо ни одному
        агенту и уедет пользователю. Ложная адресация вреднее пропущенной.

        Пересечение, а не «ровно один файл на все объекты» (Ф7): узел, склеенный из
        двух прогонов, принадлежит обоим — и не должен лишать адресата замечание,
        где остальные виновники из одного файла."""
        common: set[int] | None = None
        for i in idxs:
            if i >= len(attribution):
                return set()
            common = set(attribution[i]) if common is None else common & attribution[i]
            if not common:
                return set()
        return common or set()

    def files_of_nodes(self, idxs: Iterable[int]) -> set[int]:
        return self._common(self.node_files, idxs)

    def files_of_edges(self, idxs: Iterable[int]) -> set[int]:
        """Для связи «внёс вклад» = принёс ровно её (первоисточник или принесший
        тот же дубль); ссылки внутри файла резолвит parse_import, поэтому файл
        связи заведомо объявил и оба её конца."""
        return self._common(self.edge_files, idxs)

    def owner_of_nodes(self, idxs: Iterable[int]) -> int | None:
        return _least(self.files_of_nodes(idxs))

    def owner_of_edges(self, idxs: Iterable[int]) -> int | None:
        return _least(self.files_of_edges(idxs))


@dataclass
class FileRemarks:
    """Замечания к ОДНОМУ входному файлу — то, что чинит агент его репозитория:
    он видит только свой код и переписывает только свой YAML-документ."""

    file: int  # номер файла с 1 — та же нумерация, что в текстах «(файл 2)» и в чипах UI
    errors: list[str] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)


# Сколько склеек перечисляем в превью поимённо (полное число рядом, merged_count).
MAX_PREVIEW_MERGED = 8


def merged_with_basis(report: MergeReport, limit: int = MAX_PREVIEW_MERGED) -> list[tuple[str, str]]:
    """Склейки для превью: (путь, основание) — первые limit пар.

    Два параллельных списка отчёта сводятся здесь, а не в каждом сборщике превью:
    сборщиков у ImportPreviewOut два (обычный импорт и единая панель), и разъехаться
    им нельзя."""
    return list(zip(report.merged_paths, report.merged_basis, strict=True))[:limit]


def count_without_anchor(merged: ParsedImport) -> int:
    """Сколько узлов слитого дерева придут БЕЗ якоря (Ф2 docs/plan-anchor-ux.md).

    Такой узел следующий прогон агента опознает только по имени внутри своего
    контейнера: переименуют — появится дубль. Названо счётчиком, а не списком:
    при создании проекта новые все узлы, и перечень был бы шумом."""
    return sum(1 for n in merged.nodes if not n.source_keys)


def split_remarks(report: MergeReport) -> tuple[list[FileRemarks], list[str], list[str]]:
    """Разложить замечания превью по ПРИРОДЕ: (пофайловые, ошибки слитой схемы,
    предупреждения слитой схемы). Записей пофайловых замечаний ровно столько,
    сколько входных файлов, — включая файлы без единого замечания (фронт адресует
    их по индексу активного чипа).

    Конфликты слияния всегда в схемной корзине: конфликт — это и есть расхождение
    ДВУХ файлов, рассудить его может только тот, кто видит оба репозитория.

    Одно-файловый режим НЕ особый (Ф7): у единственного файла все сущности его, и
    общее правило само уводит каждое замечание — включая изоляцию и прочую «слитую
    картину» — в file_remarks[0], оставляя схемные корзины пустыми. Отдельной ветки
    «при files==1 клади всё в первый файл» здесь быть не должно: она и означала бы,
    что адресат зависит от состава панели, а не от происхождения виновных."""
    per_errors: list[list[str]] = [[] for _ in range(report.files)]
    per_warnings: list[list[str]] = [[] for _ in range(report.files)]
    schema_errors: list[str] = []
    schema_warnings: list[str] = []

    def put(bucket: list[list[str]], schema: list[str], text: str, file: int | None) -> None:
        if file is None:
            schema.append(text)
        else:
            bucket[file].append(text)

    for i, errs in report.file_errors.items():
        per_errors[i].extend(errs)
    for text, owner in zip(report.errors, report.error_files, strict=True):
        put(per_errors, schema_errors, text, owner)
    for text in report.conflicts:
        put(per_warnings, schema_warnings, text, None)
    for text, owner in zip(report.warnings, report.warning_files, strict=True):
        put(per_warnings, schema_warnings, text, owner)
    files = [
        FileRemarks(file=i + 1, errors=per_errors[i], warnings=per_warnings[i])
        for i in range(report.files)
    ]
    return files, schema_errors, schema_warnings

def _least(files: set[int]) -> int | None:
    """Адресат из множества кандидатов — файл с наименьшим номером; пусто → None.

    Наименьший не произволен: при слиянии выигрывает первый по порядку файл (имя,
    родитель, канал — всё решается в его пользу; поля — при равной содержательности
    вкладов, П2), значит именно его правка доедет до слитой схемы и погасит
    замечание."""
    return min(files) if files else None


def _fill(val: str | None) -> TypeGuard[str]:
    # TypeGuard: после проверки val сужается до str (используется в _merge_str
    # для безопасного .strip() и передачи в _conflict без повторных null-чеков).
    return val is not None and val.strip() != ""
