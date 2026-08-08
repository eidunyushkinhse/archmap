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

from dataclasses import dataclass, field, replace
from difflib import SequenceMatcher
from typing import TypeGuard

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


@dataclass
class MergeReport:
    """Человеческий отчёт слияния для превью модалки. errors — только нарушение
    суммарных лимитов (per-file лимиты держит parse_import)."""

    files: int
    merged_paths: list[str] = field(default_factory=list)  # узлы, склеенные из ≥2 файлов
    conflicts: list[str] = field(default_factory=list)  # расхождения полей (оставлено первое)
    warnings: list[str] = field(default_factory=list)  # fuzzy-пары, разные корни, похожие рёбра
    dropped_edges: int = 0  # выброшенные точные дубли рёбер
    errors: list[str] = field(default_factory=list)


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
        self.edge_seen: set[tuple[int, int, str, str]] = set()
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
                self.report.warnings.append(
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
                self.report.warnings.append(
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
        if key in self.edge_seen:
            self.report.dropped_edges += 1
            return
        self.edge_seen.add(key)
        self.edges.append(_ImpEdge(src, dst, e.label, e.technology))
        self.pair_labels.setdefault((src, dst), []).append((e.label or "", fi))

    # ── предупреждения ────────────────────────────────────────────────────

    def warn_similar_edges(self) -> None:
        """Одна пара концов, разные подписи из РАЗНЫХ файлов — возможно, дубль
        (в одном файле мульти-рёбра между парой считаем осознанными)."""
        for (src, dst), entries in self.pair_labels.items():
            if len({lbl for lbl, _ in entries}) < 2 or len({f for _, f in entries}) < 2:
                continue
            labels = ", ".join(f"«{lbl or '—'}»" for lbl, _ in entries[:4])
            self.report.warnings.append(
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
                    self.report.warnings.append(
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
        self.report.warnings.append(
            f"файлы не имеют общих корневых узлов ({names}) — если это одна система, "
            f"задайте всем файлам одно имя корня и повторите"
        )

    def finish(self, parts: list[ParsedImport]) -> tuple[ParsedImport, MergeReport]:
        self.warn_similar_edges()
        self.warn_fuzzy_siblings()
        self.warn_roots(parts)
        if len(self.report.warnings) > _MAX_WARNINGS:
            extra = len(self.report.warnings) - _MAX_WARNINGS
            del self.report.warnings[_MAX_WARNINGS:]
            self.report.warnings.append(f"…и ещё {extra} предупреждений")
        if len(self.nodes) > MAX_NODES:
            self.report.errors.append(f"После слияния слишком много узлов (больше {MAX_NODES})")
        if len(self.edges) > MAX_EDGES:
            self.report.errors.append(f"После слияния слишком много связей (больше {MAX_EDGES})")
        roots = [n.name for n in self.nodes if n.parent_idx is None]
        return ParsedImport(nodes=self.nodes, edges=self.edges, roots=roots), self.report


def merge_imports(parts: list[ParsedImport]) -> tuple[ParsedImport, MergeReport]:
    """Слить N разобранных импортов в один. Всегда возвращает (результат, отчёт);
    непустой report.errors означает «результат непригоден» (суммарные лимиты).
    Один файл — passthrough без отчётных записей."""
    if len(parts) == 1:
        return parts[0], MergeReport(files=1)
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

    Обе находки ручной проверки 2026-08-08: агент кладёт людей внутрь системы
    (3 прогона из 4) и создаёт компоненты, не связанные ни с чем (2 объекта из
    10). Промпт про это говорит, но соблюдает его модель через раз — поэтому
    предупреждаем ЗДЕСЬ, до создания проекта.

    Только предупреждения: тихо перестраивать чужое дерево (поднимать актора в
    корень) хуже, чем строка в отчёте, — пользователь не поймёт, что произошло.
    """
    actors = [n.name for n in merged.nodes if n.shape == "person" and n.parent_idx is not None]
    if actors:
        report.warnings.append(
            f"внутри системы оказались люди ({', '.join(f'«{a}»' for a in actors[:6])}) — "
            f"по C4 человек пользуется системой, а не входит в неё; перенесите их в корень"
        )
    # Корень связей и не имеет — они у его детей; сравниваем только остальных.
    linked = {e.source_idx for e in merged.edges} | {e.target_idx for e in merged.edges}
    lonely = [
        n.name for i, n in enumerate(merged.nodes) if i not in linked and n.parent_idx is not None
    ]
    if lonely:
        names = ", ".join(f"«{x}»" for x in lonely[:6])
        tail = f" и ещё {len(lonely) - 6}" if len(lonely) > 6 else ""
        report.warnings.append(
            f"объектов без единой связи: {len(lonely)} ({names}{tail}) — проверьте, "
            f"не потерялись ли связи; такие объекты попадут в «Незавершённость схемы»"
        )


def parse_and_merge(texts: list[str]) -> tuple[ParsedImport | None, MergeReport, list[str]]:
    """Общий путь превью и создания: разобрать N текстов и слить. Возвращает
    (результат, отчёт, ошибки); при любых ошибках результат None. Ошибки
    парсинга при N>1 префиксуются «файл N: …» (нумерация с 1, как в UI)."""
    parts: list[ParsedImport] = []
    errors: list[str] = []
    for i, text in enumerate(texts):
        parsed, errs = parse_import(text)
        if parsed is None:
            prefix = f"файл {i + 1}: " if len(texts) > 1 else ""
            errors.extend(prefix + e for e in errs)
        else:
            parts.append(parsed)
    if errors:
        return None, MergeReport(files=len(texts)), errors
    merged, report = merge_imports(parts)
    if report.errors:
        return None, report, list(report.errors)
    warn_content(merged, report)
    return merged, report, []
