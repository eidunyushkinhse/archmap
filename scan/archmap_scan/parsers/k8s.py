"""Манифесты Kubernetes без шаблонов (ТЗ §6.1).

Файлы *.y*ml с apiVersion и kind (несколько документов в файле). Нагрузки Deployment,
StatefulSet, DaemonSet, Job, CronJob — кандидаты в объекты: образ первого контейнера пода,
команда, переменные env (литералы значений — ради адресов), envFrom из ConfigMap того же
набора манифестов, расписание CronJob. Service даёт объекту host: по selector к меткам пода,
иначе по совпадению имени. Файлы с разметкой Helm (_HELM) — шаблоны чарта, их разбирает
только helm.py; «{{ИМЯ}}» в данных ConfigMap (подстановка при старте) шаблоном не считается.
Отрендеренный шаблон Helm (RELEASE-NAME в именах или образах, rendered) не разбирается.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any

from archmap_scan import paths, texts, vocab
from archmap_scan.context import Context
from archmap_scan.model import EnvVar, Findings, Loc, Unit, unparsed_hint
from archmap_scan.parsers.compose import is_dynamic
from archmap_scan.walk import Files, is_compose_name
from archmap_scan.yamlload import BadYaml, LineDict, LineList, YamlTooLarge, load_all

NAME = "k8s"
WORKLOADS = frozenset({"Deployment", "StatefulSet", "DaemonSet", "Job", "CronJob"})
# Дешёвая проверка до разбора: в файле есть строка «kind:» нужного вида. Большие файлы с
# CRD и прочими видами разбирать незачем: чистый Python-разборщик YAML небыстр.
_KIND_LINE = re.compile(
    r"^[ \t-]*kind:[ \t]*[\"']?(Deployment|StatefulSet|DaemonSet|Job|CronJob|Service|ConfigMap)"
    r"[\"']?(?!\w)",
    re.MULTILINE,
)
# Признак шаблона Helm: «{{-» или «{{» перед объектом или функцией шаблона. Подстановка
# вида «{{PROJECT_ID}}», которую заменяет sed при старте, шаблоном не считается (ТЗ §15
# п. 10 А2). Без оглядки назад: просмотр вперёд от «{{» на фиксированную длину.
_HELM = re.compile(
    r"\{\{-|\{\{[ \t]*(?:\.Values|\.Release|\.Chart|\.Capabilities|\.Files|/\*|include|template"
    r"|define|tpl|if|else|range|with|end|toYaml)(?![\w])"
)


# Вывод helm template (ТЗ §15 п. 12 С10): имя релиза по умолчанию «RELEASE-NAME» в
# metadata.name или образе. Это не манифест выкладки, а отрендеренный шаблон чарта
# (chart/kustomize-overlays/kerberos/ Airflow: объекты «RELEASE-NAME-kerberos-kdc»).
_RELEASE_NAME = "release-name"
_MAX_DEPTH = 32


def _images(node: Any, depth: int = 0) -> list[str]:
    """Строки под ключом image в документе (поды любых видов)."""
    if depth > _MAX_DEPTH:
        return []
    out: list[str] = []
    if isinstance(node, dict):
        for key, value in node.items():
            if key == "image" and isinstance(value, str):
                out.append(value)
            else:
                out += _images(value, depth + 1)
    elif isinstance(node, list):
        for item in node:
            out += _images(item, depth + 1)
    return out


def rendered(docs: list[LineDict]) -> bool:
    """Файл — вывод helm template: RELEASE-NAME в metadata.name или образе документа."""
    for doc in docs:
        name = _get(doc, "metadata", "name")
        if isinstance(name, str) and _RELEASE_NAME in name.lower():
            return True
        if any(_RELEASE_NAME in image.lower() for image in _images(doc)):
            return True
    return False


@dataclass
class _Workload:
    unit: Unit
    labels: dict[str, str]
    config_refs: list[str] = field(default_factory=list)


@dataclass
class _Service:
    name: str
    selector: dict[str, str]
    loc: Loc


def is_candidate(rel: str) -> bool:
    name = paths.name(rel)
    return name.lower().endswith((".yaml", ".yml")) and not is_compose_name(name)


def _get(doc: Any, *keys: str) -> Any:
    for key in keys:
        if not isinstance(doc, dict):
            return None
        doc = doc.get(key)
    return doc


def _str_map(value: Any) -> dict[str, str]:
    if not isinstance(value, dict):
        return {}
    return {str(k): str(v) for k, v in value.items() if v is not None}


def _command(container: LineDict) -> tuple[str | None, int | None]:
    parts: list[str] = []
    line: int | None = None
    for key in ("command", "args"):
        value = container.get(key)
        if isinstance(value, list) and value:
            parts += [str(v) for v in value]
            line = line or container.line_of(key)
    return (" ".join(" ".join(parts).split()) or None), line


def _env(container: LineDict, rel: str, out: list[EnvVar]) -> list[str]:
    """Переменные контейнера; возвращает имена ConfigMap из envFrom."""
    env = container.get("env")
    if isinstance(env, LineList):
        for i, item in enumerate(env):
            if not isinstance(item, LineDict) or not item.get("name"):
                continue
            raw = item.get("value")
            value = None if raw is None else str(raw)
            dynamic = value is not None and ("$(" in value or is_dynamic(value))
            out.append(EnvVar(str(item["name"]), Loc(rel, env.line_at(i)), value, dynamic))
    refs: list[str] = []
    env_from = container.get("envFrom")
    if isinstance(env_from, list):
        for item in env_from:
            ref = _get(item, "configMapRef", "name")
            if isinstance(ref, str):
                refs.append(ref)
    return refs


def _workload(doc: LineDict, kind: str, rel: str) -> _Workload | None:
    meta = doc.get("metadata")
    name = _get(meta, "name")
    if not isinstance(name, str) or not name or not isinstance(meta, LineDict):
        return None
    template = _get(doc, "spec", "jobTemplate", "spec", "template") if kind == "CronJob" \
        else _get(doc, "spec", "template")
    containers = _get(template, "spec", "containers")
    unit = Unit(name=name, parser=NAME, loc=Loc(rel, meta.line_of("name")))
    work = _Workload(unit=unit, labels=_str_map(_get(template, "metadata", "labels")))
    if isinstance(containers, list) and containers and isinstance(containers[0], LineDict):
        main = containers[0]
        image = main.get("image")
        unit.image = image if isinstance(image, str) else None
        unit.command, line = _command(main)
        unit.command_loc = Loc(rel, line) if line else None
        for container in containers:
            if isinstance(container, LineDict):
                work.config_refs += _env(container, rel, unit.env)
    if kind == "CronJob":
        schedule = _get(doc, "spec", "schedule")
        unit.schedule = str(schedule) if schedule is not None else None
        unit.role = vocab.ROLE_SCHEDULER
    else:
        unit.role = vocab.role_by_command(unit.command)
    return work


def _docs(files: Files, rel: str, found: Findings) -> list[LineDict]:
    text = files.read(rel)
    if text is None or "apiVersion" not in text or _HELM.search(text) is not None:
        return []
    if _KIND_LINE.search(text) is None:
        return []
    try:
        docs = load_all(text)
    except YamlTooLarge:
        files.refuse(rel)
        return []
    except BadYaml:
        found.hints.append(unparsed_hint(rel, texts.REASON_BAD_YAML))
        return []
    return [d for d in docs if isinstance(d, LineDict) and "apiVersion" in d and "kind" in d]


def parse(files: Files, ctx: Context) -> Findings:
    found = Findings()
    workloads: list[_Workload] = []
    services: list[_Service] = []
    configs: dict[str, list[EnvVar]] = {}
    for rel in files.select(is_candidate):
        docs = _docs(files, rel, found)
        if rendered(docs):
            found.hints.append(unparsed_hint(rel, texts.REASON_HELM_RENDERED))
            notes = found.notes.setdefault("containers", [])
            if texts.NOTE_HELM_RENDERED not in notes:
                notes.append(texts.NOTE_HELM_RENDERED)
            continue
        for doc in docs:
            kind = str(doc.get("kind"))
            if kind in WORKLOADS:
                work = _workload(doc, kind, rel)
                if work is not None:
                    workloads.append(work)
            elif kind == "Service":
                meta = doc.get("metadata")
                name = _get(meta, "name")
                if isinstance(name, str) and isinstance(meta, LineDict):
                    services.append(_Service(
                        name, _str_map(_get(doc, "spec", "selector")),
                        Loc(rel, meta.line_of("name")),
                    ))
            elif kind == "ConfigMap":
                name = _get(doc, "metadata", "name")
                data = doc.get("data")
                if isinstance(name, str) and isinstance(data, LineDict):
                    configs[name] = [
                        EnvVar(str(k), Loc(rel, data.line_of(k)), None if v is None else str(v))
                        for k, v in data.items()
                    ]
    for work in workloads:
        for ref in work.config_refs:
            work.unit.env += configs.get(ref, [])
    for svc in sorted(services, key=lambda s: s.name):
        for work in workloads:
            if svc.selector:
                labels = work.labels
                matched = all(labels.get(k) == v for k, v in svc.selector.items())
            else:
                matched = svc.name == work.unit.name
            if matched and work.unit.host is None:
                work.unit.host = svc.name
                work.unit.extra_locs.append(svc.loc)
    for work in workloads:
        if work.unit.host is None:
            same = next((s for s in services if s.name == work.unit.name), None)
            if same is not None:
                work.unit.host = same.name
                work.unit.extra_locs.append(same.loc)
        found.units.append(work.unit)
    return found
