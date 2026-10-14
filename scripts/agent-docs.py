#!/usr/bin/env python3
"""QWEN.md собирается из CLAUDE.md — правила для двух агентов не расходятся.

Раньше файлы правили руками «оба одновременно», и к аудиту 2026-10 (P-7) они
разошлись на 173 строки, а оба — с кодом. Теперь источник один: CLAUDE.md, а
QWEN.md отличается только строками про самого агента (ниже — весь список).

    python3 scripts/agent-docs.py          # пересобрать QWEN.md
    python3 scripts/agent-docs.py --check  # 1, если QWEN.md отстал (хук и CI)
"""

from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

# (что в CLAUDE.md, чем заменить в QWEN.md). Каждая строка обязана найтись ровно
# один раз: переформулировали её в CLAUDE.md — правится и эта таблица, а не
# молча уезжает в QWEN.md чужая для агента строка.
AGENT_LINES: list[tuple[str, str]] = [
    ("# ArchMap — CLAUDE.md\n", "# ArchMap — QWEN.md\n"),
    (
        "└── QWEN.md                # тот же файл для Qwen Code — собирается из этого (scripts/agent-docs.py)\n",
        "└── CLAUDE.md              # исходник этого файла для Claude Code: QWEN.md собирается из него\n"
        "                           # (python3 scripts/agent-docs.py), руками не правится\n",
    ),
    (
        "- Claude запускает его как фоновую задачу (run_in_background) — так процесс\n"
        "  переживает teardown харнесса.\n",
        "- Запускать как фоновую задачу (is_background: true) — так процесс\n"
        "  переживает teardown сессии.\n",
    ),
    (
        "- ПОСТОЯННОЕ РАЗРЕШЕНИЕ коммитить самому: после каждого логически\n"
        "  завершённого и проверенного изменения сразу делать коммит, НЕ дожидаясь\n"
        "  отдельной просьбы. Это переопределяет дефолт «коммитить только по запросу».\n",
        "",
    ),
    (
        "  формат: \"feat: …\" / \"fix: …\" / \"chore: …\" / \"docs: …\". Последней строкой —\n"
        "  Co-Authored-By с моделью, которая писала коммит, например:\n"
        "  Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>\n"
        "- После коммита называть в ответе хэш и сообщение. Состояние видно в\n"
        "  statusline: «⎇ main ✓» — всё закоммичено, «⎇ main ±N» — N несохранённых.\n",
        "  формат: \"feat: …\" / \"fix: …\" / \"chore: …\" / \"docs: …\".\n"
        "- После коммита называть в ответе хэш и сообщение.\n",
    ),
    (
        "- Работа с git — см. секцию «Git» выше (коммитить самому на чекпойнтах)\n",
        "- Работа с git — см. секцию «Git» выше\n",
    ),
    (
        "- QWEN.md — тот же файл для Qwen Code, собирается из CLAUDE.md: правишь CLAUDE.md →\n"
        "  python3 scripts/agent-docs.py и коммитишь оба (хук и CI сверяют их через --check);\n"
        "  строки про самого агента — в таблице AGENT_LINES скрипта.\n",
        "- QWEN.md собирается из CLAUDE.md (python3 scripts/agent-docs.py): правила меняются\n"
        "  в CLAUDE.md и попадают сюда пересборкой; сам QWEN.md руками не правится.\n",
    ),
]


def build(claude: str) -> str:
    out = claude
    for old, new in AGENT_LINES:
        count = out.count(old)
        if count != 1:
            raise SystemExit(
                f"agent-docs: в CLAUDE.md {count} вхождений вместо одного:\n{old}"
                "Поправьте таблицу AGENT_LINES в scripts/agent-docs.py."
            )
        out = out.replace(old, new)
    return out


def main() -> int:
    claude = (ROOT / "CLAUDE.md").read_text(encoding="utf-8")
    qwen_path = ROOT / "QWEN.md"
    expected = build(claude)
    if "--check" in sys.argv[1:]:
        if qwen_path.read_text(encoding="utf-8") != expected:
            print(
                "QWEN.md отстал от CLAUDE.md: python3 scripts/agent-docs.py и закоммитьте оба.",
                file=sys.stderr,
            )
            return 1
        return 0
    qwen_path.write_text(expected, encoding="utf-8")
    return 0


if __name__ == "__main__":
    sys.exit(main())
