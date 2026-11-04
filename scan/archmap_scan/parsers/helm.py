"""Helm (ТЗ §6.1): Chart.yaml (имя чарта, зависимости) и values.yaml рядом с ним (образы).

Объект — по каждому образу в values: «image: {repository: x}» или «image: строка»; имя —
ключ, внутри которого лежит образ, а у образа в корне values — имя чарта. Зависимости
чарта с именем из словаря образов (postgresql, redis, kafka) — тоже объекты. Каталог
templates не разбирается (Go-шаблоны): семья контейнеров получает пометку «partial».
"""

from __future__ import annotations

from typing import Any

from archmap_scan import paths, texts, vocab
from archmap_scan.context import Context
from archmap_scan.model import Findings, Hint, Loc, Unit, unparsed_hint
from archmap_scan.walk import Files
from archmap_scan.yamlload import BadYaml, LineDict, LineList, YamlTooLarge, load

NAME = "helm"
_MAX_DEPTH = 12


def _load(files: Files, rel: str, found: Findings) -> Any:
    text = files.read(rel)
    if text is None:
        return None
    try:
        return load(text)
    except YamlTooLarge:
        files.refuse(rel)
    except BadYaml:
        found.hints.append(unparsed_hint(rel, texts.REASON_BAD_YAML))
    return None


def _image_of(value: Any) -> str | None:
    if isinstance(value, str) and value.strip():
        return value.strip()
    if isinstance(value, LineDict):
        repo = value.get("repository")
        if isinstance(repo, str) and repo.strip():
            registry = value.get("registry")
            if isinstance(registry, str) and registry.strip():
                return f"{registry.strip()}/{repo.strip()}"
            return repo.strip()
    return None


def _walk(
    node: LineDict, owner: str, rel: str, found: Findings, seen: set[int], depth: int
) -> None:
    """Обход values: id() в seen — защита от псевдонимов, ссылающихся на одно и то же."""
    if depth > _MAX_DEPTH or id(node) in seen:
        return
    seen.add(id(node))
    if node.get("enabled") is False:
        found.hints.append(Hint("profiles", {
            "kind": "container", "name": owner, "reason": texts.REASON_HELM_DISABLED,
            "source": str(Loc(rel, node.line)), "profiles": [],
        }))
        return
    image = _image_of(node.get("image"))
    if image is not None:
        found.units.append(Unit(
            name=owner, parser=NAME, loc=Loc(rel, node.line_of("image")), image=image,
        ))
    for key, value in node.items():
        if key == "image":
            continue
        if isinstance(value, LineDict):
            _walk(value, str(key), rel, found, seen, depth + 1)
        elif isinstance(value, LineList):
            for item in value:
                if isinstance(item, LineDict) and isinstance(item.get("name"), str):
                    _walk(item, item["name"], rel, found, seen, depth + 1)


def parse(files: Files, ctx: Context) -> Findings:
    found = Findings()
    present = set(files.paths)
    for rel in files.select(lambda p: paths.name(p) == "Chart.yaml"):
        chart = _load(files, rel, found)
        if not isinstance(chart, LineDict) or not isinstance(chart.get("name"), str):
            continue
        name = chart["name"]
        folder = paths.parent(rel)
        deps = chart.get("dependencies")
        if isinstance(deps, LineList):
            for i, dep in enumerate(deps):
                dep_name = dep.get("name") if isinstance(dep, LineDict) else None
                if isinstance(dep_name, str) and vocab.image_kind(dep_name) is not None:
                    found.units.append(Unit(
                        name=dep_name, parser=NAME, loc=Loc(rel, deps.line_at(i)),
                        image=dep_name,
                    ))
        values_rel = f"{folder}/values.yaml" if folder else "values.yaml"
        if values_rel in present:
            values = _load(files, values_rel, found)
            if isinstance(values, LineDict):
                _walk(values, name, values_rel, found, set(), 0)
        prefix = f"{folder}/templates/" if folder else "templates/"
        if any(p.startswith(prefix) for p in files.paths):
            found.notes.setdefault("containers", []).append(texts.NOTE_HELM_TEMPLATES)
            found.unsupported.setdefault("containers", []).append(texts.STACK_HELM_TEMPLATES)
    return found
