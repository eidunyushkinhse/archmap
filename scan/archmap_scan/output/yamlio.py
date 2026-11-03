"""Запись YAML вывода: порядок ключей как задан, кириллица как есть, шапка с версией.

Значение с «: » внутри пишется в двойных кавычках, как требуют промпты ArchMap: такой файл
читается и человеком, и агентом без сюрпризов.
"""

from __future__ import annotations

from typing import Any

import yaml

from archmap_scan import __version__

WIDTH = 4096


class _Dumper(yaml.SafeDumper):  # type: ignore[misc]
    pass


def _str(dumper: yaml.SafeDumper, data: str) -> Any:
    style = '"' if ": " in data or " #" in data else None
    return dumper.represent_scalar("tag:yaml.org,2002:str", data, style=style)


_Dumper.add_representer(str, _str)


def dump(doc: Any) -> str:
    """Блочный YAML с заданным порядком ключей."""
    out: str = yaml.dump(
        doc,
        Dumper=_Dumper,
        allow_unicode=True,
        sort_keys=False,
        width=WIDTH,
        default_flow_style=False,
    )
    return out


class Flow(dict[str, Any]):
    """Отображение, которое пишется одной строкой: {status: covered, found: 7}."""


class FlowSeq(list[Any]):
    """Список, который пишется одной строкой: [compose, dockerfile]."""


def _flow_map(dumper: yaml.SafeDumper, data: Flow) -> Any:
    return dumper.represent_mapping("tag:yaml.org,2002:map", data.items(), flow_style=True)


def _flow_seq(dumper: yaml.SafeDumper, data: FlowSeq) -> Any:
    return dumper.represent_sequence("tag:yaml.org,2002:seq", list(data), flow_style=True)


_Dumper.add_representer(Flow, _flow_map)
_Dumper.add_representer(FlowSeq, _flow_seq)


def header(repo: str, commit: str) -> str:
    """Шапка каждого файла вывода: версия сборщика, repo и commit (без git пусто)."""
    lines = [f"# archmap-scan {__version__}", f"# repo: {repo}", f"# commit: {commit}"]
    return "\n".join(line.rstrip() for line in lines) + "\n"
