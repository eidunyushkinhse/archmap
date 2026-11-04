"""coverage.yaml (ТЗ §8): покрытие по семьям для машины.

Молчание не двусмысленно (инвариант 3): у каждой семьи один статус. covered — разборщики
работали и нашли; partial — нашли, но часть стека без разборщика (названа в unsupported);
empty — разборщики работали и ничего не нашли; unsupported — стек опознан, разборщика нет;
unknown — стек не опознан; error — разборщик упал.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass, field

from archmap_scan import __version__
from archmap_scan.output import yamlio
from archmap_scan.output.yamlio import Flow, FlowSeq
from archmap_scan.walk import Excluded


@dataclass
class FamilyStat:
    found: int = 0
    # Разных имён среди found (семья config): одинаковый параметр у двух контейнеров —
    # две записи (правило продукта), а «Найдено» в сводке считает имена (ТЗ §7). В
    # coverage.yaml пишется, только когда расходится с found.
    distinct: int = 0
    # Параметры общего кода для строки пояснений сводки: сколько контейнеров получили
    # параметр, общий с другим контейнером, и сколько таких записей (свои параметры
    # контейнера сюда не входят). В coverage.yaml не пишется.
    holders: int = 0
    shared_records: int = 0
    ran: list[str] = field(default_factory=list)  # разборщики семьи, которые отработали
    contributed: list[str] = field(default_factory=list)  # разборщики, давшие записи
    unsupported: list[str] = field(default_factory=list)
    notes: list[str] = field(default_factory=list)
    skipped: dict[str, int] = field(default_factory=dict)
    dropped: int = 0
    dynamic_names: int = 0
    # Найдено, но не записано в файлы: владелец не определён, записи в hints.unassigned.
    # В found они не входят: сводка считает найденным только записанное (ТЗ §7).
    unassigned: int = 0
    # Записи кода из служебных каталогов и конфигов инструментов и переменные ОС, ушедшие
    # в подсказки (ТЗ §13.1): число записей для строки пояснений сводки. В coverage.yaml
    # не пишется: там skipped.tooling — число файлов.
    tooling: int = 0
    os_variables: int = 0
    # Найденное пришло и из кода (ярус 2), а не только из манифестов: так сводка говорит
    # «найдено не всё», а не «найдено в манифестах». В coverage.yaml не пишется.
    from_code: bool = False
    error: str | None = None

    @property
    def status(self) -> str:
        if self.error:
            return "error"
        if self.found > 0 or self.unassigned > 0:
            return "partial" if self.unsupported else "covered"
        if self.unsupported:
            return "unsupported"
        if self.ran:
            return "empty"
        return "unknown"

    def entry(self) -> Flow:
        out = Flow(status=self.status)
        if self.found:
            out["found"] = self.found
        if self.distinct and self.distinct != self.found:
            out["distinct"] = self.distinct
        out["parsers"] = FlowSeq(self.contributed if self.found or self.unassigned else self.ran)
        if self.unsupported:
            out["unsupported"] = FlowSeq(self.unsupported)
        if self.skipped:
            out["skipped"] = Flow(self.skipped)
        if self.dropped:
            out["dropped"] = self.dropped
        if self.unassigned:
            out["unassigned"] = self.unassigned
        if self.dynamic_names:
            out["dynamic_names"] = self.dynamic_names
        if self.notes:
            out["notes"] = FlowSeq(self.notes)
        if self.error:
            out["error"] = self.error
        return out


@dataclass
class Coverage:
    repo: str
    commit: str
    stacks: list[str]
    families: dict[str, FamilyStat]
    excluded: Sequence[Excluded]
    too_large: int
    binary: int

    def doc(self) -> dict[str, object]:
        return {
            "scanner": __version__,
            "repo": self.repo,
            "commit": self.commit,
            "stacks": FlowSeq(self.stacks),
            "families": {name: stat.entry() for name, stat in self.families.items()},
            "excluded": [
                Flow(path=e.path, files=e.files, reason=e.reason) for e in self.excluded
            ],
            "unread": Flow(too_large=self.too_large, binary=self.binary),
        }

    def render(self) -> str:
        return yamlio.header(self.repo, self.commit) + yamlio.dump(self.doc())

    def as_json(self) -> dict[str, object]:
        """То же для --json: обычные словари и списки."""
        return _plain(self.doc())


def _plain(value: object) -> dict[str, object]:
    out = _unflow(value)
    assert isinstance(out, dict)
    return out


def _unflow(value: object) -> object:
    if isinstance(value, dict):
        return {str(k): _unflow(v) for k, v in value.items()}
    if isinstance(value, list):
        return [_unflow(v) for v in value]
    return value
