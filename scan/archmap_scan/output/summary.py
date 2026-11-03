"""summary.txt (ТЗ §8): сводка словами для человека и агента."""

from __future__ import annotations

from archmap_scan import __version__, texts
from archmap_scan.output.coverage import Coverage

# Сколько строк исключённого показывать в сводке; полный перечень лежит в coverage.yaml.
EXCLUDED_SHOWN = 12


def render(cov: Coverage) -> str:
    lines = [texts.summary_head(__version__, cov.repo, cov.commit), ""]
    lines.append(texts.NOTHING_FOUND)
    if cov.excluded:
        lines += ["", texts.EXCLUDED_TITLE]
        top = sorted(cov.excluded, key=lambda e: (-e.files, e.path))[:EXCLUDED_SHOWN]
        for e in top:
            lines.append(
                f"  {e.path} · {texts.files_count(e.files)} · {texts.EXCLUDE_REASON[e.reason]}"
            )
    return "\n".join(lines) + "\n"
