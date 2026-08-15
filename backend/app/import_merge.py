"""Слияние нескольких разобранных импортов в один (сценарий «Из репозитория»:
один промпт × N репозиториев системы → N YAML → один проект).

Мерджим РАЗОБРАННЫЕ структуры (ParsedImport), а не YAML-тексты: ссылки рёбер уже
разрезолвлены parse_import'ом внутри своего файла, поэтому кросс-файловой
неоднозначности имён в ссылках не существует. Идентичность узла — нормализованное
имя в пределах одного СМЕРДЖЕННОГО родителя (то есть фактически путь
«Система / Сервис / …»). Поля сливаются по правилу «богатое побеждает»
(заполненное бьёт пустое, не-дефолт бьёт дефолт); расхождения заполненных
значений не решаются молча — берётся первое по порядку файлов, а факт уходит
строкой в отчёт. Fuzzy-похожие имена НИКОГДА не склеиваются автоматически
(ложная склейка двух разных сервисов хуже дубля) — только предупреждение.

Результат детерминирован; порядок файлов влияет лишь на tie-break конфликтов,
и это видно в отчёте. Выход совместим с seed_import без изменений (порядок
«родители раньше детей» сохраняется по построению).
"""

from collections.abc import Hashable, Iterable
from dataclasses import dataclass, field, replace
from difflib import SequenceMatcher
from typing import TypeGuard, TypeVar

from app.identity import compare_identity, merge_key_sets
from app.import_yaml import (
    MAX_EDGES,
    MAX_NODES,
    ParsedImport,
    _ImpEdge,
    _ImpNode,
    parse_import,
)

# Порог похожести имён сиблингов для предупреждения «возможно, одно и то же».
_FUZZY_RATIO = 0.78
# Группы сиблингов крупнее этого попарно не сравниваем (квадратичная стоимость;
# реальные уровни на порядки меньше — защита от патологического входа).
_FUZZY_GROUP_LIMIT = 250
_MAX_WARNINGS = 30
# Связи в контейнер называем поимённо, но не все: замечания уезжают агенту одним
# списком, и полсотни строк одного класса вытеснят остальное.
_MAX_CONTAINER_EDGES = 10
# Тот же кап у связей в брокер без канала — свой счётчик, чтобы один класс не
# съедал квоту другого.
_MAX_BROKER_EDGES = 10
# И у связей, чей channel несёт ПЕРЕЧЕНЬ каналов вместо одного имени.
_MAX_CHANNEL_LIST_EDGES = 10
# Изолированные группы: сколько групп называем и сколько имён показываем в каждой.
_MAX_ISOLATED_GROUPS = 10
_MAX_GROUP_NAMES = 6

T = TypeVar("T", bound=Hashable)


def connected_components(edges: Iterable[tuple[T, T]]) -> list[list[T]]:
    """Связные компоненты графа РЁБЕР; компоненты из одного узла не возвращаются.

    Ядро, общее с алертом «изолированные группы» (app/alerts.compute_alerts, п.3), и
    трактовка обязана совпадать с ним до буквы — иначе превью и алерты разойдутся в
    вердиктах на одной и той же схеме:
    - иерархия parent СВЯЗЬЮ НЕ СЧИТАЕТСЯ: через дерево связано вообще всё, и такой
      критерий не отличал бы фрагментированную схему от целой;
    - узлы без единой связи в компоненты не входят: о них говорит отдельная проверка
      (в превью — «объектов без единой связи», в алертах — «подвисшие»), и дублировать
      её замечанием про «группу из одного объекта» нельзя.

    Порядок компонент и узлов внутри — от порядка рёбер: детерминирован при том же
    входе, а показываем мы их всё равно отсортированными.
    """
    adjacency: dict[T, set[T]] = {}
    for a, b in edges:
        adjacency.setdefault(a, set()).add(b)
        adjacency.setdefault(b, set()).add(a)
    visited: set[T] = set()
    out: list[list[T]] = []
    for start in adjacency:
        if start in visited:
            continue
        visited.add(start)
        stack = [start]
        comp: list[T] = []
        while stack:
            cur = stack.pop()
            comp.append(cur)
            for nxt in adjacency[cur]:
                if nxt not in visited:
                    visited.add(nxt)
                    stack.append(nxt)
        if len(comp) >= 2:
            out.append(comp)
    return out


@dataclass
class MergeReport:
    """Человеческий отчёт слияния для превью модалки. errors — только нарушение
    суммарных лимитов (per-file лимиты держит parse_import).

    Плоские списки (conflicts/warnings/errors) — исторический контракт превью, их
    наполнение не меняется. Поверх них живёт РАЗМЕТКА ПРИРОДЫ замечания (Ф6): пакет
    собирают N агентов, каждый видит только свой репозиторий и переписывает только
    свой файл, поэтому замечание, порождённое содержимым одного файла, адресуемо
    его агенту, а свойство слитой картины — только человеку (split_remarks)."""

    files: int
    merged_paths: list[str] = field(default_factory=list)  # узлы, склеенные из ≥2 файлов
    conflicts: list[str] = field(default_factory=list)  # расхождения полей (оставлено первое)
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
    # в каждый узел / каждую связь. По ней warn_content решает, кому адресовать
    # замечание о конкретном объекте.
    node_files: list[set[int]] = field(default_factory=list)
    edge_files: list[set[int]] = field(default_factory=list)

    def warn(self, text: str, file: int | None = None) -> None:
        """Предупреждение: в плоский список (как раньше) и в разметку природы."""
        self.warnings.append(text)
        self.warning_files.append(file)

    def error(self, text: str, file: int | None = None) -> None:
        self.errors.append(text)
        self.error_files.append(file)

    def _owner(self, attribution: list[set[int]], idxs: Iterable[int]) -> int | None:
        """Единственный файл, породивший ВСЕ названные объекты, — он и виноват;
        если их несколько (или атрибуции нет) — None: адресовать некому, замечание
        уедет пользователю. Ложная адресация агенту вреднее пропущенной."""
        files: set[int] = set()
        for i in idxs:
            if i >= len(attribution):
                return None
            files |= attribution[i]
            if len(files) > 1:
                return None
        return next(iter(files)) if len(files) == 1 else None

    def owner_of_nodes(self, idxs: Iterable[int]) -> int | None:
        return self._owner(self.node_files, idxs)

    def owner_of_edges(self, idxs: Iterable[int]) -> int | None:
        return self._owner(self.edge_files, idxs)


@dataclass
class FileRemarks:
    """Замечания к ОДНОМУ входному файлу — то, что чинит агент его репозитория:
    он видит только свой код и переписывает только свой YAML-документ."""

    file: int  # номер файла с 1 — та же нумерация, что в текстах «(файл 2)» и в чипах UI
    errors: list[str] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)


def split_remarks(report: MergeReport) -> tuple[list[FileRemarks], list[str], list[str]]:
    """Разложить замечания превью по ПРИРОДЕ: (пофайловые, ошибки слитой схемы,
    предупреждения слитой схемы). Записей пофайловых замечаний ровно столько,
    сколько входных файлов, — включая файлы без единого замечания (фронт адресует
    их по индексу активного чипа).

    Конфликты слияния всегда в схемной корзине: конфликт — это и есть расхождение
    ДВУХ файлов, рассудить его может только тот, кто видит оба репозитория.

    Одно-файловый режим — особый по решению пользователя: агент видит всю систему
    целиком и чинит всё, поэтому схемные корзины пусты, а замечания (включая
    изоляцию и прочую «слитую картину») лежат в единственном файле."""
    per_errors: list[list[str]] = [[] for _ in range(report.files)]
    per_warnings: list[list[str]] = [[] for _ in range(report.files)]
    schema_errors: list[str] = []
    schema_warnings: list[str] = []
    solo = report.files == 1

    def put(bucket: list[list[str]], schema: list[str], text: str, file: int | None) -> None:
        if solo:
            bucket[0].append(text)
        elif file is None:
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


def _norm(name: str) -> str:
    """Нормализация имени для сравнения идентичности: регистр + схлоп пробелов."""
    return " ".join(name.split()).casefold()


def _fill(val: str | None) -> TypeGuard[str]:
    # TypeGuard: после проверки val сужается до str (используется в _merge_str
    # для безопасного .strip() и передачи в _conflict без повторных null-чеков).
    return val is not None and val.strip() != ""


def _similar(a: str, b: str) -> bool:
    """Похожи ли нормализованные имена: вложение подстроки (payments ⊂
    payments-service) либо высокий difflib-ratio (опечатки, суффиксы)."""
    if a == b:
        return False  # равные склеились бы раньше — сюда не попадают
    short, long_ = (a, b) if len(a) <= len(b) else (b, a)
    if len(short) >= 4 and short in long_:
        return True
    return SequenceMatcher(None, a, b).ratio() >= _FUZZY_RATIO


class _Merger:
    """Состояние одного прогона слияния (класс вместо замыканий — читаемость)."""

    def __init__(self, files: int):
        self.report = MergeReport(files=files)
        self.nodes: list[_ImpNode] = []  # копии узлов, порядок «родители раньше детей»
        self.paths: list[str] = []  # полный путь merged-узла (для отчёта)
        self.sources: list[set[int]] = []  # какие файлы внесли вклад в узел
        # (merged-родитель, норм-имя) → кандидаты. Список, а не один idx: якорь
        # может РАЗВЕСТИ двух тёзок в одном родителе (разные репозитории), и оба
        # обязаны остаться адресуемыми для следующих файлов.
        self.by_key: dict[tuple[int | None, str], list[int]] = {}
        # канонический ключ источника → idx узла. Индекс ГЛОБАЛЬНЫЙ (не в пределах
        # родителя): якорь сильнее иерархии — им ловится сервис, которого разные
        # прогоны положили под разных родителей или назвали по-разному.
        self.by_source: dict[str, int] = {}
        self.edges: list[_ImpEdge] = []
        # какие файлы принесли связь (первоисточник + принесшие тот же дубль) —
        # атрибуция замечаний о конкретной связи (Ф6).
        self.edge_files: list[set[int]] = []
        # ключ дубля → (индекс в self.edges, файл-первоисточник). Индекс нужен,
        # чтобы дубль мог ДОЛИТЬ каналом уже принятую связь, а не пропасть целиком.
        self.edge_seen: dict[tuple[int, int, str, str], tuple[int, int]] = {}
        # (src, dst) → [(label, файл)] — для предупреждения о похожих рёбрах.
        self.pair_labels: dict[tuple[int, int], list[tuple[str, int]]] = {}

    # ── узлы ──────────────────────────────────────────────────────────────

    def _conflict(self, idx: int, fld: str, kept: str, dropped: str, fi: int) -> None:
        first = min(self.sources[idx]) + 1
        self.report.conflicts.append(
            f"{self.paths[idx]}: {fld}: оставлено «{kept}» (файл {first}), "
            f"отброшено «{dropped}» (файл {fi + 1})"
        )

    def _merge_str(self, idx: int, fld: str, new: str | None, fi: int) -> None:
        cur = getattr(self.nodes[idx], fld)
        if not _fill(new) or (_fill(cur) and cur.strip() == new.strip()):
            return
        if not _fill(cur):
            setattr(self.nodes[idx], fld, new)
            return
        self._conflict(idx, fld, cur, new, fi)

    def _merge_enum(self, idx: int, fld: str, new: str, default: str, fi: int) -> None:
        # shape/status: не-дефолт бьёт дефолт (явный дефолт после парсинга
        # неотличим от отсутствия поля — считаем его самым слабым утверждением).
        cur = getattr(self.nodes[idx], fld)
        if new == default or new == cur:
            return
        if cur == default:
            setattr(self.nodes[idx], fld, new)
            return
        self._conflict(idx, fld, cur, new, fi)

    def _match_by_source(self, node: _ImpNode, fi: int) -> int | None:
        """Матч по якорю — ГЛОБАЛЬНО, поверх имени и иерархии. Кандидат по слабому
        ключу отбрасывается, если по сильному он противоречит (общий host «api»
        при разных git — разные сервисы двух команд).

        Узлы ОДНОГО файла не склеиваются никогда, даже при совпавшем якоре: внутри
        файла агент развёл их осознанно (тот же принцип, что в warn_fuzzy_siblings).
        Без этого монорепо схлопывалось — агент вешает один git-remote на все свои
        сервисы, и «backend» вместе с поддеревом растворялся во «frontend»
        (найдено прогоном на реальном репозитории 2026-08-07)."""
        for k in node.source_keys:
            hit = self.by_source.get(k)
            if hit is None or fi in self.sources[hit]:
                continue
            if compare_identity(self.nodes[hit].source_keys, node.source_keys) != "different":
                return hit
        return None

    def _match_by_name(self, node: _ImpNode, parent_m: int | None) -> int | None:
        """Матч по имени в пределах слитого родителя — прежнее поведение, но с
        предохранителем: тёзка с противоречащим якорем НЕ склеивается."""
        for idx in self.by_key.get((parent_m, _norm(node.name)), []):
            if compare_identity(self.nodes[idx].source_keys, node.source_keys) == "different":
                # Замечание о ФАЙЛАХ (тёзки из разных прогонов) — виноватого нет.
                self.report.warn(
                    f"«{node.name}» ({self._where(parent_m)}) встречается в файлах как РАЗНЫЕ "
                    f"объекты (различаются источники) — оставлены раздельно"
                )
                continue
            return idx
        return None

    def _where(self, parent_m: int | None) -> str:
        return f"внутри «{self.paths[parent_m]}»" if parent_m is not None else "на верхнем уровне"

    def _register(self, idx: int, node: _ImpNode, parent_m: int | None, fi: int) -> None:
        """Узел адресуем и по имени в родителе, и по каждому своему якорю."""
        self.by_key.setdefault((parent_m, _norm(node.name)), []).append(idx)
        for k in self.nodes[idx].source_keys:
            taken = self.by_source.get(k)
            if taken is not None and fi in self.sources[taken]:
                # Один якорь на два узла ОДНОГО файла: агент повесил общий
                # git-remote на все сервисы монорепо, не различив их путями.
                # Склеивать нельзя (см. _match_by_source), но следующие файлы
                # найдут по этому ключу только первого — предупреждаем.
                # Природа — схемная: имена пары приходят из разных прогонов, а
                # последствие («следующие файлы свяжутся только с первым») — про
                # весь пакет, а не про один документ.
                self.report.warn(
                    f"«{self.nodes[taken].name}» и «{node.name}» указывают один источник "
                    f"({k}) — уточните source.path у каждого, иначе следующие файлы "
                    f"свяжутся только с первым"
                )
                continue
            self.by_source.setdefault(k, idx)

    def add_node(self, node: _ImpNode, parent_m: int | None, fi: int) -> int:
        hit = self._match_by_source(node, fi)
        if hit is None:
            hit = self._match_by_name(node, parent_m)
        if hit is None:
            idx = len(self.nodes)
            self.nodes.append(replace(node, parent_idx=parent_m))
            prefix = f"{self.paths[parent_m]} / " if parent_m is not None else ""
            self.paths.append(prefix + node.name)
            self.sources.append({fi})
            self._register(idx, node, parent_m, fi)
            return idx
        # Узел уже есть — склейка полей. Имя оставляем первое встреченное
        # (различие лишь в регистре/пробелах — в отчёт не шумим).
        if fi not in self.sources[hit] and len(self.sources[hit]) == 1:
            self.report.merged_paths.append(self.paths[hit])
        # Якорь связал узлы, названные ПО-РАЗНОМУ (в своём репозитории сервис зовётся
        # «app», вызывающие ходят на «payments») либо положенные под разных родителей.
        # Оставляем первое — перевешивать поддерево по позднему файлу опаснее, чем
        # оставить расхождение видимым в отчёте.
        if _norm(node.name) != _norm(self.nodes[hit].name):
            self._conflict(hit, "имя", self.nodes[hit].name, node.name, fi)
        kept_parent = self.nodes[hit].parent_idx
        if parent_m != kept_parent:
            top = "верхний уровень"
            self._conflict(
                hit,
                "родитель",
                self.paths[kept_parent] if kept_parent is not None else top,
                self.paths[parent_m] if parent_m is not None else top,
                fi,
            )
        # Грани источника у прогонов разные — склеенный узел наследует все, иначе
        # следующий файл не найдёт его по той грани, которой не досталось.
        self.nodes[hit].source_keys = merge_key_sets(self.nodes[hit].source_keys, node.source_keys)
        for k in self.nodes[hit].source_keys:
            self.by_source.setdefault(k, hit)
        self._merge_str(hit, "role", node.role, fi)
        self._merge_str(hit, "technology", node.technology, fi)
        self._merge_str(hit, "description", node.description, fi)
        self._merge_enum(hit, "shape", node.shape, "service", fi)
        self._merge_enum(hit, "status", node.status, "existing", fi)
        if node.is_external != self.nodes[hit].is_external:
            # external обычно ставят осознанно — расхождение решаем в пользу true.
            first = min(self.sources[hit]) + 1
            self.report.conflicts.append(
                f"{self.paths[hit]}: external: файлы {first} и {fi + 1} расходятся — оставлено true"
            )
            self.nodes[hit].is_external = True
        self.sources[hit].add(fi)
        return hit

    # ── рёбра ─────────────────────────────────────────────────────────────

    def add_edge(self, e: _ImpEdge, idx_map: list[int], fi: int) -> None:
        src, dst = idx_map[e.source_idx], idx_map[e.target_idx]
        key = (src, dst, e.label or "", e.technology or "")
        seen = self.edge_seen.get(key)
        if seen is not None:
            self.report.dropped_edges += 1
            self.edge_files[seen[0]].add(fi)
            self._merge_channel(seen, e.channel, fi)
            return
        self.edge_seen[key] = (len(self.edges), fi)
        self.edges.append(_ImpEdge(src, dst, e.label, e.technology, e.channel))
        self.edge_files.append({fi})
        self.pair_labels.setdefault((src, dst), []).append((e.label or "", fi))

    def _merge_channel(self, seen: tuple[int, int], new: str | None, fi: int) -> None:
        """Канал у дубля связи — та же политика, что у полей узла (_merge_str):
        заполненное бьёт пустое, расхождение решается в пользу первого файла и
        уезжает строкой в отчёт.

        В КЛЮЧ дедупа канал не входит осознанно: один и тот же поток, названный в
        двух репозиториях разными топиками, — это конфликт, который надо показать, а
        не две самостоятельные связи между той же парой с той же подписью."""
        idx, first = seen
        cur = self.edges[idx].channel
        if not _fill(new) or (_fill(cur) and cur.strip() == new.strip()):
            return
        if not _fill(cur):
            self.edges[idx].channel = new
            return
        a = self.paths[self.edges[idx].source_idx]
        b = self.paths[self.edges[idx].target_idx]
        self.report.conflicts.append(
            f"связь «{a} → {b}»: канал: оставлено «{cur}» (файл {first + 1}), "
            f"отброшено «{new}» (файл {fi + 1})"
        )

    # ── предупреждения ────────────────────────────────────────────────────

    def warn_similar_edges(self) -> None:
        """Одна пара концов, разные подписи из РАЗНЫХ файлов — возможно, дубль
        (в одном файле мульти-рёбра между парой считаем осознанными)."""
        for (src, dst), entries in self.pair_labels.items():
            if len({lbl for lbl, _ in entries}) < 2 or len({f for _, f in entries}) < 2:
                continue
            labels = ", ".join(f"«{lbl or '—'}»" for lbl, _ in entries[:4])
            # Замечание существует только потому, что файлов несколько, — схемное.
            self.report.warn(
                f"связи {self.paths[src]} → {self.paths[dst]}: разные подписи из разных "
                f"файлов ({labels}) — проверьте, не дубли ли это"
            )

    def warn_fuzzy_siblings(self) -> None:
        """Похожие имена сиблингов из непересекающихся наборов файлов — кандидаты
        «одно и то же, названное по-разному». Не склеиваем — только сигналим."""
        groups: dict[int | None, list[int]] = {}
        for i, n in enumerate(self.nodes):
            groups.setdefault(n.parent_idx, []).append(i)
        for parent, idxs in groups.items():
            if len(idxs) < 2 or len(idxs) > _FUZZY_GROUP_LIMIT:
                continue
            norms = [_norm(self.nodes[i].name) for i in idxs]
            for a in range(len(idxs)):
                for b in range(a + 1, len(idxs)):
                    ia, ib = idxs[a], idxs[b]
                    if self.sources[ia] & self.sources[ib]:
                        continue  # жили в одном файле — названы different осознанно
                    if not _similar(norms[a], norms[b]):
                        continue
                    where = f"внутри «{self.paths[parent]}»" if parent is not None else "на верхнем уровне"
                    # Пара заведомо из РАЗНЫХ файлов (условие выше) — схемное.
                    self.report.warn(
                        f"«{self.nodes[ia].name}» и «{self.nodes[ib].name}» ({where}) похожи — "
                        f"возможно, один объект из разных файлов; если да, приведите имена к одному"
                    )

    def warn_roots(self, parts: list[ParsedImport]) -> None:
        """Ни один корень не склеился из ≥2 файлов — скорее всего, агентам задали
        разные имена системы (внешние системы и акторы легально живут корнями,
        поэтому критерий именно «нет ОБЩИХ корней», а не «корней больше одного»)."""
        if len(parts) < 2:
            return
        roots = [i for i, n in enumerate(self.nodes) if n.parent_idx is None]
        if any(len(self.sources[i]) > 1 for i in roots):
            return
        names = ", ".join(f"«{self.nodes[i].name}»" for i in roots[:6])
        self.report.warn(
            f"файлы не имеют общих корневых узлов ({names}) — если это одна система, "
            f"задайте всем файлам одно имя корня и повторите"
        )

    def finish(self, parts: list[ParsedImport]) -> tuple[ParsedImport, MergeReport]:
        # Атрибуция — до предупреждений содержания: по ней warn_content решает,
        # чей файл виноват в замечании о конкретном узле/связи.
        self.report.node_files = [set(s) for s in self.sources]
        self.report.edge_files = self.edge_files
        self.warn_similar_edges()
        self.warn_fuzzy_siblings()
        self.warn_roots(parts)
        if len(self.report.warnings) > _MAX_WARNINGS:
            extra = len(self.report.warnings) - _MAX_WARNINGS
            del self.report.warnings[_MAX_WARNINGS:]
            del self.report.warning_files[_MAX_WARNINGS:]  # разметка идёт строка в строку
            self.report.warn(f"…и ещё {extra} предупреждений")
        # Лимиты — свойство СЛИТОЙ картины: один файл в них не виноват.
        if len(self.nodes) > MAX_NODES:
            self.report.error(f"После слияния слишком много узлов (больше {MAX_NODES})")
        if len(self.edges) > MAX_EDGES:
            self.report.error(f"После слияния слишком много связей (больше {MAX_EDGES})")
        roots = [n.name for n in self.nodes if n.parent_idx is None]
        return ParsedImport(nodes=self.nodes, edges=self.edges, roots=roots), self.report


def merge_imports(parts: list[ParsedImport]) -> tuple[ParsedImport, MergeReport]:
    """Слить N разобранных импортов в один. Всегда возвращает (результат, отчёт);
    непустой report.errors означает «результат непригоден» (суммарные лимиты).
    Один файл — passthrough без отчётных записей."""
    if len(parts) == 1:
        # Атрибуция вырожденная (всё из файла 0), но заполняем: warn_content не
        # должен знать, сколько было файлов.
        return parts[0], MergeReport(
            files=1,
            node_files=[{0} for _ in parts[0].nodes],
            edge_files=[{0} for _ in parts[0].edges],
        )
    m = _Merger(files=len(parts))
    for fi, part in enumerate(parts):
        idx_map: list[int] = []  # индекс узла в файле → индекс в merged
        for node in part.nodes:
            parent_m = idx_map[node.parent_idx] if node.parent_idx is not None else None
            idx_map.append(m.add_node(node, parent_m, fi))
        for e in part.edges:
            m.add_edge(e, idx_map, fi)
    return m.finish(parts)


def warn_content(merged: ParsedImport, report: MergeReport) -> None:
    """Проверки СОДЕРЖАНИЯ схемы, не полагающиеся на аккуратность агента.

    Находки ручной проверки 2026-08-08: агент кладёт людей внутрь системы
    (3 прогона из 4) и создаёт компоненты, не связанные ни с чем (2 объекта из
    10); третья — полевого QA (связи, упирающиеся в контейнер с компонентами,
    см. _warn_container_edges). Промпт про это говорит, но соблюдает его модель
    через раз — поэтому предупреждаем ЗДЕСЬ, до создания проекта.

    Только предупреждения: тихо перестраивать чужое дерево (поднимать актора в
    корень) хуже, чем строка в отчёте, — пользователь не поймёт, что произошло.

    Природа замечаний здесь ФАЙЛОВАЯ, пока объекты пришли из одного файла: агент
    своего репозитория и положил актора внутрь системы, ему это и чинить. Как
    только замечание собирает объекты из разных файлов, виноватого нет — оно
    уходит в схемную корзину (owner_of_* возвращает None).
    """
    actor_idxs = [
        i for i, n in enumerate(merged.nodes) if n.shape == "person" and n.parent_idx is not None
    ]
    if actor_idxs:
        actors = [merged.nodes[i].name for i in actor_idxs]
        report.warn(
            f"внутри системы оказались люди ({', '.join(f'«{a}»' for a in actors[:6])}) — "
            f"по C4 человек пользуется системой, а не входит в неё; перенесите их в корень",
            report.owner_of_nodes(actor_idxs),
        )
    # «Подвисшим» считается ТОЛЬКО атомарный узел: у контейнера прямых связей и
    # быть не должно — их несут его дети, а связь, упирающаяся в контейнер, ловится
    # отдельным алертом. Зеркалим определение из app/alerts.compute_alerts, иначе
    # превью пугало бы тем, чего схема потом не показывает.
    parents = {n.parent_idx for n in merged.nodes if n.parent_idx is not None}
    linked = {e.source_idx for e in merged.edges} | {e.target_idx for e in merged.edges}
    lonely_idxs = [
        i
        for i, n in enumerate(merged.nodes)
        if i not in linked and i not in parents and n.parent_idx is not None
    ]
    if lonely_idxs:
        lonely = [merged.nodes[i].name for i in lonely_idxs]
        names = ", ".join(f"«{x}»" for x in lonely[:6])
        tail = f" и ещё {len(lonely) - 6}" if len(lonely) > 6 else ""
        report.warn(
            f"объектов без единой связи: {len(lonely)} ({names}{tail}) — проверьте, "
            f"не потерялись ли связи; такие объекты попадут в «Незавершённость схемы»",
            report.owner_of_nodes(lonely_idxs),
        )
    _warn_container_edges(merged, report, parents)
    _warn_broker_edges(merged, report)
    _warn_channel_lists(merged, report)
    _warn_isolated_groups(merged, report)


def _warn_container_edges(
    merged: ParsedImport, report: MergeReport, parents: set[int]
) -> None:
    """Связи, упирающиеся в контейнер, У КОТОРОГО ЕСТЬ компоненты.

    После импорта это алерт AL8, но агент к тому моменту уже ушёл: в раунде 3
    полевого QA (docs/qa-zabbix-7.md) их накопилось 13 — «дополняй связями» слабая
    модель исполнила, а дубли с уровня контейнера не убрала. Поэтому предупреждаем
    ДО импорта и НАЗЫВАЕМ каждую связь: замечание лечится переносом конца на
    компонент, и агенту нужен конкретный конец, а не правило.

    Определение контейнера — зеркало app/alerts.compute_alerts (узел с детьми),
    но по СЛИТОМУ дереву: проекта на этот момент ещё не существует.

    Замечание про КОНКРЕТНУЮ связь — файловое: связь написана в одном файле, там же
    и лечится переносом конца. Связь, принесённая несколькими файлами сразу,
    адресата не имеет (owner_of_edges → None).
    """
    shown = hidden = 0
    hidden_idxs: list[int] = []
    for ei, e in enumerate(merged.edges):
        # dict.fromkeys — на случай петли «узел сам на себя»: конец один, не два.
        ends = [i for i in dict.fromkeys((e.source_idx, e.target_idx)) if i in parents]
        if not ends:
            continue
        if shown >= _MAX_CONTAINER_EDGES:
            hidden += 1
            hidden_idxs.append(ei)
            continue
        shown += 1
        a, b = merged.nodes[e.source_idx].name, merged.nodes[e.target_idx].name
        names = [merged.nodes[i].name for i in ends]
        if len(names) == 1:
            report.warn(
                f"связь «{a} → {b}»: конец в контейнере «{names[0]}», у которого есть "
                f"компоненты, — уточните её до конкретного компонента («{names[0]} / …»)",
                report.owner_of_edges([ei]),
            )
        else:
            report.warn(
                f"связь «{a} → {b}»: оба конца в контейнерах «{names[0]}» и «{names[1]}», "
                f"у которых есть компоненты, — уточните её до конкретных компонентов "
                f"(«{names[0]} / …», «{names[1]} / …»)",
                report.owner_of_edges([ei]),
            )
    if hidden:
        # Хвост-счётчик адресуем, только если все скрытые связи из одного файла.
        report.warn(f"…ещё {hidden} таких связей", report.owner_of_edges(hidden_idxs))


def _warn_broker_edges(merged: ParsedImport, report: MergeReport) -> None:
    """Связи, упирающиеся в БРОКЕР, но не называющие канал.

    Решение пользователя №4 (docs/plan-broker-docs.md §4): стрелка в брокер обязана
    назвать топик/очередь — иначе схема не отвечает на «откуда взялось событие».
    После импорта это алерт AL31, но урок Х5 тот же, что у связей в контейнер: агент
    к моменту алертов уже ушёл, поэтому предупреждаем ДО импорта и НАЗЫВАЕМ каждую
    связь — замечание лечится дописыванием одного поля, и агенту нужен конкретный
    конец, а не правило.

    Брокер узнаём по shape СЛИТОГО дерева: проекта на этот момент ещё нет.
    """
    shown = hidden = 0
    hidden_idxs: list[int] = []
    for ei, e in enumerate(merged.edges):
        if _fill(e.channel):
            continue
        # dict.fromkeys — на случай петли: конец один, не два. Оба конца брокеры —
        # называем первый (искать канал придётся у обоих, починка начинается с любого).
        ends = [
            i
            for i in dict.fromkeys((e.source_idx, e.target_idx))
            if merged.nodes[i].shape == "broker"
        ]
        if not ends:
            continue
        if shown >= _MAX_BROKER_EDGES:
            hidden += 1
            hidden_idxs.append(ei)
            continue
        shown += 1
        a, b = merged.nodes[e.source_idx].name, merged.nodes[e.target_idx].name
        report.warn(
            f"связь «{a} → {b}»: конец — брокер «{merged.nodes[ends[0]].name}», а канал "
            f"не указан — добавьте channel: имя топика/очереди",
            report.owner_of_edges([ei]),
        )
    if hidden:
        report.warn(
            f"…ещё {hidden} таких связей с брокером", report.owner_of_edges(hidden_idxs)
        )


def _warn_channel_lists(merged: ParsedImport, report: MergeReport) -> None:
    """Связи, у которых в channel не имя канала, а ПЕРЕЧЕНЬ имён.

    Находка №2 полевого QA (docs/qa-zulip-brokers.md): агент кладёт в поле
    «email, notify_orders, digest_emails». Правило промпта («одна пара ходит по
    нескольким топикам — это несколько рёбер, по ребру на канал») есть и прямое, но
    исполняется через раз, а машинной проверки формы не было ни в превью, ни в
    валидаторе — промах всплывал уже после импорта нечитаемым AL31. Тот же урок Х5,
    что у соседей: правило дисперсно, цель называет машина.

    Разделителем считаем запятую и точку с запятой. Точки, дефисы и версии в имени
    канала — норма («orders.created», «notify-orders»), и подозрений не вызывают.
    """
    shown = hidden = 0
    hidden_idxs: list[int] = []
    for ei, e in enumerate(merged.edges):
        if not _fill(e.channel) or not any(sep in e.channel for sep in (",", ";")):
            continue
        if shown >= _MAX_CHANNEL_LIST_EDGES:
            hidden += 1
            hidden_idxs.append(ei)
            continue
        shown += 1
        a, b = merged.nodes[e.source_idx].name, merged.nodes[e.target_idx].name
        report.warn(
            f"связь «{a} → {b}»: в channel перечень «{e.channel.strip()}» — разделите "
            f"на отдельные связи, по одной на канал",
            report.owner_of_edges([ei]),
        )
    if hidden:
        report.warn(
            f"…ещё {hidden} таких связей с перечнем в channel",
            report.owner_of_edges(hidden_idxs),
        )


def _warn_isolated_groups(merged: ParsedImport, report: MergeReport) -> None:
    """Группы объектов, связанные между собой, но оторванные от остальной схемы.

    Полевая валидация Ф8: превью говорило про ОДИНОЧЕК, а компонента из двух узлов
    («актор → его интерфейс», связанные друг с другом и больше ни с чем) проходила
    молча и всплывала алертом «Незавершённость схемы» уже после создания проекта —
    когда агент ушёл и дорисовать связь некому. Тот же урок Х5, что у связей в
    контейнер: предупреждаем ДО импорта и НАЗЫВАЕМ группу поимённо.

    Ядро связности — общее с алертом (connected_components), поэтому вердикты сходятся.
    Крупнейшую компоненту не называем: она и есть схема, а замечание должно указывать,
    ЧТО прицепить, а не пересказывать проект.

    Природа СХЕМНАЯ, даже когда вся группа пришла из одного файла: лечится замечание
    связью С ЯДРОМ, а ядро живёт в чужих репозиториях — агент своего файла дорисовать
    её не может, ему видна только его половина (решение пользователя, Ф6).
    """
    comps = connected_components([(e.source_idx, e.target_idx) for e in merged.edges])
    if len(comps) < 2:
        return  # один кластер (плюс, возможно, одиночки) — фрагментации нет
    # Ядро — самая крупная; при равных размерах порядок задаёт первое имя, иначе
    # «ядром» становилось бы то одно, то другое от прогона к прогону.
    comps.sort(key=lambda c: (-len(c), sorted(merged.nodes[i].name for i in c)))
    for comp in comps[1 : _MAX_ISOLATED_GROUPS + 1]:
        names = [merged.nodes[i].name for i in sorted(comp)]
        shown = ", ".join(f"«{n}»" for n in names[:_MAX_GROUP_NAMES])
        tail = f" и ещё {len(names) - _MAX_GROUP_NAMES}" if len(names) > _MAX_GROUP_NAMES else ""
        report.warn(
            f"группа из {len(names)} объектов не связана с остальной схемой: {shown}{tail} — "
            f"дорисуйте связь с ядром или проверьте, не потерялась ли она"
        )
    hidden = len(comps) - 1 - _MAX_ISOLATED_GROUPS
    if hidden > 0:
        report.warn(f"…ещё {hidden} таких групп")


def parse_and_merge(texts: list[str]) -> tuple[ParsedImport | None, MergeReport, list[str]]:
    """Общий путь превью и создания: разобрать N текстов и слить. Возвращает
    (результат, отчёт, ошибки); при любых ошибках результат None. Ошибки
    парсинга при N>1 префиксуются «файл N: …» (нумерация с 1, как в UI); в отчёт
    те же ошибки уходят БЕЗ префикса, разложенные по файлам (split_remarks)."""
    parts: list[ParsedImport] = []
    errors: list[str] = []
    file_errors: dict[int, list[str]] = {}
    for i, text in enumerate(texts):
        parsed, errs = parse_import(text)
        if parsed is None:
            prefix = f"файл {i + 1}: " if len(texts) > 1 else ""
            errors.extend(prefix + e for e in errs)
            file_errors[i] = list(errs)
        else:
            parts.append(parsed)
    if errors:
        return None, MergeReport(files=len(texts), file_errors=file_errors), errors
    merged, report = merge_imports(parts)
    if report.errors:
        return None, report, list(report.errors)
    warn_content(merged, report)
    return merged, report, []
