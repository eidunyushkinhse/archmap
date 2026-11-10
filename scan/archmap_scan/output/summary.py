"""summary.txt (ТЗ §8): сводка словами для человека и агента.

Начало — версия и оговорка, что полнота не обещается (ТЗ §15 п. 10 А14), затем одной
фразой, что найдено (числа по семьям), семьи, где искали и не нашли, «Не разобрано» с
именами стеков, пояснения, «Исключено» с каталогами, непрочитанное и «Как
импортировать» с настоящими названиями окон ArchMap (способ «Импорт»). Части строки
разделяет «·».
"""

from __future__ import annotations

from archmap_scan import __version__, texts
from archmap_scan.output.coverage import Coverage

# Сколько строк исключённого показывать в сводке; полный перечень лежит в coverage.yaml.
EXCLUDED_SHOWN = 12
# Семьи, непрочитанное в которых — код на языке или фреймворке (ТЗ §6.2).
CODE_FAMILIES = frozenset({"config", "channels", "http_routes", "schedules"})
# Семьи объектов схемы: без них schema.yaml пуста и советовать её импорт нечего.
OBJECT_FAMILIES = ("containers", "databases", "brokers")


def _dynamic_shown(fam: str, dynamic_names: int) -> bool:
    """Строка «заданным выражением в коде» семьи есть в «Пояснениях»."""
    return bool(dynamic_names) and fam in CODE_FAMILIES


def _found(cov: Coverage) -> list[str]:
    lines = []
    parts = []
    empty = []
    for fam, stat in cov.families.items():
        if stat.found:
            one, few, many = texts.FAMILY_WORDS[fam]
            # Параметры считаются по именам: запись общего кода у каждого контейнера —
            # не новый параметр (ТЗ §7); записи названы строкой в «Пояснениях».
            parts.append(texts.plural(stat.distinct or stat.found, one, few, many))
        elif stat.status == "empty" and not _dynamic_shown(fam, stat.dynamic_names):
            # Семья, где нашлись только записи с выражением, в «Искали и не нашли» не
            # входит: о ней говорит строка «заданным выражением» (ТЗ §15 п. 16 П3). Статус
            # empty в coverage.yaml остаётся.
            empty.append(texts.FAMILY_LABEL[fam].lower())
    lines.append(texts.found_phrase(parts))
    if empty:
        lines.append(texts.empty_phrase(empty))
    return lines


def _not_covered(cov: Coverage) -> list[str]:
    lines = []
    for fam, stat in cov.families.items():
        label = texts.FAMILY_LABEL[fam]
        status = stat.status
        if status == "unsupported":
            lines.append("  " + texts.family_unsupported(label, stat.unsupported))
        elif status == "partial":
            lines.append("  " + texts.family_partial(
                label, stat.unsupported, fam in CODE_FAMILIES, stat.from_code,
            ))
        elif status == "unknown":
            lines.append("  " + texts.family_unknown(label))
        elif status == "error":
            lines.append("  " + texts.family_error(label, stat.error or ""))
    return [texts.NOT_COVERED_TITLE, *lines] if lines else []


def _notes(cov: Coverage) -> list[str]:
    lines = [
        f"  {texts.FAMILY_LABEL[fam]}: {note}."
        for fam, stat in cov.families.items()
        for note in stat.notes
    ]
    # Боевых манифестов нет: объекты собраны из манифестов разработки (ТЗ §15 п. 10 Б3).
    dev_objects = sum(cov.families[fam].from_dev_manifests for fam in OBJECT_FAMILIES)
    if dev_objects:
        lines.append("  " + texts.dev_objects_line(dev_objects))
    config = cov.families["config"]
    if config.shared_records:
        lines.append("  " + texts.shared_params_line(config.holders, config.shared_records))
    # Найденное без владельца в «Найдено» не входит: оно названо здесь отдельной строкой.
    lines += [
        "  " + texts.unassigned_line(fam, stat.unassigned)
        for fam, stat in cov.families.items()
        if stat.unassigned
    ]
    # Записи служебных каталогов и переменные ОС не факты, но и не пропадают (ТЗ §13.1).
    tooling = sum(stat.tooling for stat in cov.families.values())
    if tooling:
        lines.append("  " + texts.tooling_line(tooling))
    if config.os_variables:
        lines.append("  " + texts.os_variables_line(config.os_variables))
    # Имена из кода, заданные выражением, ничего не дали, но молча не пропадают (инвариант 5).
    lines += [
        "  " + texts.dynamic_line(fam, stat.dynamic_names)
        for fam, stat in cov.families.items()
        if _dynamic_shown(fam, stat.dynamic_names)
    ]
    return [texts.NOTES_TITLE, *lines] if lines else []


def _excluded(cov: Coverage) -> list[str]:
    if not cov.excluded:
        return []
    lines = [texts.EXCLUDED_TITLE]
    top = sorted(cov.excluded, key=lambda e: (-e.files, e.path, e.reason))
    for e in top[:EXCLUDED_SHOWN]:
        lines.append(
            f"  {e.path} · {texts.files_count(e.files)} · {texts.EXCLUDE_REASON[e.reason]}"
        )
    if len(top) > EXCLUDED_SHOWN:
        lines.append(texts.excluded_more(len(top) - EXCLUDED_SHOWN))
    return lines


def has_objects(cov: Coverage) -> bool:
    """В schema.yaml записан хотя бы один объект: контейнер, база или брокер."""
    return any(cov.families[fam].found for fam in OBJECT_FAMILIES)


def _how_to(cov: Coverage) -> list[str]:
    """«Как импортировать» только по записанным файлам (ТЗ §8): пункт про schema.yaml, когда
    в схеме есть объект, файлы фактов по семьям, каталог agent — вместе с разделом. Ничего
    не записано — раздела нет: импорт пустой схемы не советуем."""
    lines = list(texts.HOW_TO_IMPORT) if has_objects(cov) else []
    facts = False
    for fam, block in (
        ("tables", texts.HOW_TO_IMPORT_TABLES),
        ("config", texts.HOW_TO_IMPORT_CONFIG),
        ("channels", texts.HOW_TO_IMPORT_CHANNELS),
    ):
        if cov.families[fam].found:
            lines += block
            facts = True
    if facts:
        lines += texts.HOW_TO_IMPORT_FACTS
    if not lines:
        return []
    return [texts.HOW_TO_IMPORT_TITLE, *lines, *texts.HOW_TO_IMPORT_AGENT]


def render(cov: Coverage) -> str:
    gaps = _not_covered(cov)
    blocks = [
        [
            texts.summary_head(__version__, cov.repo, cov.commit),
            *(texts.PROMISE_WITH_GAPS if gaps else texts.PROMISE_NO_GAPS),
        ],
        _found(cov),
        gaps,
        _notes(cov),
        _excluded(cov),
        [texts.unread_phrase(cov.too_large, cov.binary)] if cov.too_large or cov.binary else [],
        _how_to(cov),
        [*(texts.TAIL_EDGES if has_objects(cov) else []), texts.TAIL_GITIGNORE],
    ]
    return "\n\n".join("\n".join(b) for b in blocks if b) + "\n"
