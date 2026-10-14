"""YAML через libyaml, когда PyYAML собран с ним.

Замер аудита 2026-10 (фаза 6): разбор и выгрузка YAML — основная цена архива знания и
плана догрузки, чистый Python-разборщик PyYAML медленнее C-шного в ~6 раз (273 файла
архивов dev-базы: 8,9 → 1,4 с). Результат проверен на том же наборе: объекты разбора и
байты выгрузки архива совпадают.

Ошибку разбора повторяет чистый разборщик: тексты и позиции замечаний пользователю не
должны зависеть от того, с libyaml ли собран PyYAML на сервере.
"""

from typing import Any

import yaml

_LOADER: type = getattr(yaml, "CSafeLoader", yaml.SafeLoader)
_DUMPER: type = getattr(yaml, "CSafeDumper", yaml.SafeDumper)


def safe_load(text: str) -> Any:
    """Как yaml.safe_load. YAMLError — с текстом чистого разборщика."""
    try:
        return yaml.load(text, Loader=_LOADER)  # noqa: S506 — загрузчик безопасный (Safe)
    except yaml.YAMLError:
        return yaml.safe_load(text)


def safe_dump(doc: Any, **kwargs: Any) -> str:
    """Как yaml.safe_dump."""
    out: str = yaml.dump(doc, Dumper=_DUMPER, **kwargs)
    return out
