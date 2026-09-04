#!/usr/bin/env python3
"""Измеритель сверки C4-схем ArchMap: экспорт-кандидат против экспорта-эталона.

Зачем. BYOA-промпт строит схему кодовой базы руками ИИ-агента. Чтобы правка
промпта была отличима от дисперсии модели, нужен воспроизводимый замер: не
«похоже/не похоже», а набор чисел по классам расхождений.

Принципы измерения (см. docs/plan-byoa-quality.md, Ф2):
- узлы матчатся СТУПЕНЯМИ с убывающей уверенностью (якорь → точное имя+форма →
  синонимичное имя → форма+технология у БД/брокеров); ступень фиксируется;
- путь в дереве в матч НЕ входит: контейнеры у разных моделей расходятся
  законно, расхождение уровня — флаг, а не промах;
- рёбра судятся по парам СМАТЧЕННЫХ концов, направление значимо; ребро, у
  которого конец не сматчен, относится на вину узла (отдельный класс);
- подписи автоматически не судим (актив/пассив — семантика): выдаём список
  «проверить», в метрики он не входит;
- сводного скаляра нет — только вектор чисел.

Запуск (venv бэкенда, из корня репозитория):
    backend/venv/bin/python scripts/c4-compare/compare.py run ЭТАЛОН.yaml КАНДИДАТ.yaml \
        --md отчёт.md --json итог.json --title "Zabbix Haiku base"
    backend/venv/bin/python scripts/c4-compare/compare.py table a.json b.json --md сводка.md
"""

from __future__ import annotations

import argparse
import difflib
import json
import re
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import yaml

# --------------------------------------------------------------------------
# Пороги мер похожести. Меняются осознанно: сдвиг порога меняет ВСЕ прошлые
# замеры, поэтому базлайн и контрольную матрицу считать одними и теми же.
# --------------------------------------------------------------------------
JACCARD_MIN = 0.6  # доля общих токенов имени, при которой считаем имена синонимичными
RATIO_MIN = 0.85  # difflib-похожесть строк (опечатки, транслит, порядок слов)
LABEL_CHECK_MAX = 0.25  # ниже этой похожести подпись ребра попадает в список «проверить»

# Формы, у которых технология сама по себе — сильный признак (ступень 4).
TECH_SHAPES = frozenset({"database", "broker"})

# --------------------------------------------------------------------------
# Двуязычный словарь синонимов. ДОПОЛНЯЕТСЯ ПО НАХОДКАМ: когда очередной прогон
# показал промах на паре «одно и то же разными словами» — слово сюда, замер
# перегнать. Слева — нормализованный токен, справа — канонический.
# Многословные обороты (SYNONYM_PHRASES) применяются к строке ДО токенизации.
# --------------------------------------------------------------------------
SYNONYM_PHRASES: dict[str, str] = {
    "база данных": "db",
    "базы данных": "db",
    "базa данных": "db",
    "веб интерфейс": "frontend",
    "веб приложение": "frontend",
    "web app": "frontend",
    "web application": "frontend",
    "single page application": "frontend",
    "шина сообщений": "bus",
    "очередь сообщений": "queue",
    "очередь задач": "queue",
    "message broker": "broker",
    "message queue": "queue",
    "объектное хранилище": "storage",
    "object storage": "storage",
}

SYNONYMS: dict[str, str] = {
    # инфраструктурные роли
    "сервер": "server",
    "серверы": "server",
    "сервера": "server",
    "server": "server",
    "servers": "server",
    "бд": "db",
    "db": "db",
    "database": "db",
    "databases": "db",
    "база": "db",
    "базы": "db",
    "воркер": "worker",
    "воркеры": "worker",
    "воркера": "worker",
    "worker": "worker",
    "workers": "worker",
    "очередь": "queue",
    "очереди": "queue",
    "queue": "queue",
    "queues": "queue",
    "веб": "web",
    "web": "web",
    "фронтенд": "frontend",
    "frontend": "frontend",
    "ui": "frontend",
    "spa": "frontend",
    "интерфейс": "frontend",
    "прокси": "proxy",
    "proxy": "proxy",
    "агент": "agent",
    "агенты": "agent",
    "agent": "agent",
    "agents": "agent",
    "шлюз": "gateway",
    "gateway": "gateway",
    "клиент": "client",
    "клиенты": "client",
    "client": "client",
    "clients": "client",
    "приложение": "app",
    "app": "app",
    "application": "app",
    "хранилище": "storage",
    "storage": "storage",
    "store": "storage",
    "кэш": "cache",
    "кеш": "cache",
    "cache": "cache",
    "планировщик": "scheduler",
    "scheduler": "scheduler",
    "cron": "scheduler",
    "брокер": "broker",
    "broker": "broker",
    "шина": "bus",
    "bus": "bus",
    "сервис": "service",
    "сервисы": "service",
    "service": "service",
    "services": "service",
    "обработчик": "handler",
    "обработчики": "handler",
    "handler": "handler",
    "handlers": "handler",
    "processor": "handler",
    "процессор": "handler",
    "уведомления": "notifications",
    "уведомление": "notifications",
    "оповещения": "notifications",
    "notifications": "notifications",
    "notification": "notifications",
    "задачи": "tasks",
    "задача": "tasks",
    "задач": "tasks",
    "tasks": "tasks",
    "task": "tasks",
    "jobs": "tasks",
    "job": "tasks",
    "консьюмер": "consumer",
    "консьюмеры": "consumer",
    "потребитель": "consumer",
    "consumer": "consumer",
    "consumers": "consumer",
    "продюсер": "producer",
    "producer": "producer",
    "поллер": "poller",
    "опрашиватель": "poller",
    "poller": "poller",
    "pollers": "poller",
    "менеджер": "manager",
    "manager": "manager",
    "коллектор": "collector",
    "сборщик": "collector",
    "collector": "collector",
    "синхронизатор": "syncer",
    "syncer": "syncer",
    "sync": "syncer",
    "рендерер": "renderer",
    "renderer": "renderer",
    "балансировщик": "balancer",
    "balancer": "balancer",
    # доменные слова (частые в именах узлов)
    "платёж": "payment",
    "платеж": "payment",
    "платежи": "payment",
    "платежей": "payment",
    "платёжный": "payment",
    "платежный": "payment",
    "payment": "payment",
    "payments": "payment",
    "пользователь": "user",
    "пользователи": "user",
    "пользователей": "user",
    "user": "user",
    "users": "user",
    "заказ": "order",
    "заказы": "order",
    "заказов": "order",
    "order": "order",
    "orders": "order",
    "почта": "mail",
    "почты": "mail",
    "mail": "mail",
    "email": "mail",
    "smtp": "smtp",
    "поиск": "search",
    "поиска": "search",
    "search": "search",
    "отчёт": "report",
    "отчет": "report",
    "отчёты": "report",
    "отчеты": "report",
    "report": "report",
    "reports": "report",
    "файл": "file",
    "файлы": "file",
    "файлов": "file",
    "file": "file",
    "files": "file",
    "лог": "log",
    "логи": "log",
    "логов": "log",
    "log": "log",
    "logs": "log",
    "метрика": "metric",
    "метрики": "metric",
    "metric": "metric",
    "metrics": "metric",
    "событие": "event",
    "события": "event",
    "событий": "event",
    "event": "event",
    "events": "event",
    "мониторинг": "monitoring",
    "monitoring": "monitoring",
}

# Стоп-слова: связки и «пустые» родовые слова, не несущие различающего смысла.
STOPWORDS: frozenset[str] = frozenset(
    {
        "и",
        "или",
        "для",
        "в",
        "на",
        "с",
        "по",
        "из",
        "к",
        "of",
        "the",
        "a",
        "an",
        "for",
        "and",
        "or",
        "to",
        "in",
        "on",
        "служба",
        "службы",
        "компонент",
        "компоненты",
        "модуль",
        "модули",
        "подсистема",
        "система",
        "часть",
    }
)


class CompareError(Exception):
    """Ошибка разбора или сверки: сообщение адресовано человеку."""


# --------------------------------------------------------------------------
# Нормализация
# --------------------------------------------------------------------------

_PUNCT_RE = re.compile(r"[^0-9a-zа-я]+")


def norm_text(value: str | None) -> str:
    """Нижний регистр, ё→е, пунктуация → пробел, схлопнутые пробелы."""
    if not value:
        return ""
    text = value.lower().replace("ё", "е")
    text = _PUNCT_RE.sub(" ", text)
    return " ".join(text.split())


def norm_anchor_repo(value: str | None) -> str:
    """Нормализация репозитория якоря: регистр, схема, префикс git:, .git, слэши."""
    if not value:
        return ""
    text = value.strip().lower()
    for prefix in ("git:", "git+", "https://", "http://", "ssh://", "git@"):
        if text.startswith(prefix):
            text = text[len(prefix) :]
    if text.endswith(".git"):
        text = text[: -len(".git")]
    return text.strip("/")


def norm_anchor_path(value: str | None) -> str:
    """Нормализация пути якоря: регистр, ведущие ./ и слэши, хвостовые слэши."""
    if not value:
        return ""
    text = value.strip().lower().replace("\\", "/")
    while text.startswith("./"):
        text = text[2:]
    return text.strip("/")


def tokens(value: str | None) -> set[str]:
    """Токены имени после словаря синонимов и стоп-слов."""
    text = norm_text(value)
    if not text:
        return set()
    for phrase, canon in SYNONYM_PHRASES.items():
        if phrase in text:
            text = text.replace(phrase, canon)
    result: set[str] = set()
    for raw in text.split():
        token = SYNONYMS.get(raw, raw)
        if token in STOPWORDS:
            continue
        result.add(token)
    return result


def jaccard(left: set[str], right: set[str]) -> float:
    """Мера Жаккара по множествам токенов (пустые множества — не похожи)."""
    if not left or not right:
        return 0.0
    return len(left & right) / len(left | right)


def ratio(left: str, right: str) -> float:
    """Похожесть нормализованных строк (опечатки, перестановки букв)."""
    if not left or not right:
        return 0.0
    return difflib.SequenceMatcher(None, left, right).ratio()


def name_measure(left: NodeRec, right: NodeRec) -> float:
    """Мера похожести имён: максимум из токенной и строковой."""
    return max(jaccard(left.tokens, right.tokens), ratio(left.norm_name, right.norm_name))


def names_similar(left: NodeRec, right: NodeRec) -> bool:
    """Порог синонимичности имён (ступень 3)."""
    return (
        jaccard(left.tokens, right.tokens) >= JACCARD_MIN
        or ratio(left.norm_name, right.norm_name) >= RATIO_MIN
    )


# --------------------------------------------------------------------------
# Модель разобранного экспорта
# --------------------------------------------------------------------------


@dataclass
class NodeRec:
    """Узел плоским списком: дерево уже развёрнуто, путь сохранён отдельно."""

    idx: int
    name: str
    path: str
    parent_path: str
    depth: int
    shape: str
    role: str
    technology: str
    external: bool
    status: str
    repo: str
    src_path: str
    host: str
    is_container: bool

    @property
    def norm_name(self) -> str:
        return norm_text(self.name)

    @property
    def tokens(self) -> set[str]:
        return tokens(self.name)

    @property
    def anchor(self) -> tuple[str, str] | None:
        """Ключ якоря: (repo, path). Без repo якоря нет — host не якорь."""
        if not self.repo:
            return None
        return (self.repo, self.src_path)


@dataclass
class EdgeRec:
    """Ребро с уже разрешёнными концами (индексы узлов своей модели)."""

    idx: int
    source: int
    target: int
    label: str
    technology: str
    channel: str
    sync: bool  # null в экспорте = синхронный по умолчанию

    @property
    def norm_channel(self) -> str:
        return norm_text(self.channel)


@dataclass
class Model:
    """Разобранный экспорт: узлы плоско, рёбра с индексами концов."""

    title: str
    nodes: list[NodeRec] = field(default_factory=list)
    edges: list[EdgeRec] = field(default_factory=list)

    def node(self, idx: int) -> NodeRec:
        return self.nodes[idx]


def _as_str(value: Any) -> str:
    """Терпимое приведение необязательного поля к строке."""
    if value is None:
        return ""
    if isinstance(value, str):
        return value.strip()
    return str(value).strip()


def parse_model(data: Any, title: str) -> Model:
    """Разбирает документ экспорта ArchMap {nodes: дерево, edges: список}.

    Терпим к отсутствию необязательных полей (кандидат может их не отдать), но
    строг к неразрешимым ссылкам рёбер: молчаливая потеря ребра исказила бы замер.
    """
    if not isinstance(data, dict):
        raise CompareError(f"{title}: документ не словарь — ожидались ключи nodes/edges")
    model = Model(title=title)

    def walk(items: Any, parent_path: str, depth: int) -> None:
        if items is None:
            return
        if not isinstance(items, list):
            raise CompareError(f"{title}: nodes/children должны быть списком, получено {type(items).__name__}")
        for raw in items:
            if not isinstance(raw, dict):
                raise CompareError(f"{title}: узел должен быть словарём, получено {type(raw).__name__}")
            name = _as_str(raw.get("name"))
            if not name:
                raise CompareError(f"{title}: узел без имени (родитель «{parent_path or '—'}»)")
            path = f"{parent_path} / {name}" if parent_path else name
            source = raw.get("source") or {}
            if not isinstance(source, dict):
                source = {}
            children = raw.get("children")
            model.nodes.append(
                NodeRec(
                    idx=len(model.nodes),
                    name=name,
                    path=path,
                    parent_path=parent_path,
                    depth=depth,
                    shape=_as_str(raw.get("shape")) or "service",
                    role=_as_str(raw.get("role")),
                    technology=_as_str(raw.get("technology")),
                    external=bool(raw.get("external")),
                    status=_as_str(raw.get("status")) or "existing",
                    repo=norm_anchor_repo(_as_str(source.get("repo"))),
                    src_path=norm_anchor_path(_as_str(source.get("path"))),
                    host=norm_text(_as_str(source.get("host"))),
                    is_container=bool(children),
                )
            )
            walk(children, path, depth + 1)

    walk(data.get("nodes") or [], "", 0)

    # Индексы для разрешения ссылок рёбер: экспорт пишет ПУТЬ, если имя в наборе
    # не уникально, иначе голое имя — резолвим оба варианта.
    by_path: dict[str, list[int]] = {}
    by_name: dict[str, list[int]] = {}
    by_norm_name: dict[str, list[int]] = {}
    for node in model.nodes:
        by_path.setdefault(node.path, []).append(node.idx)
        by_name.setdefault(node.name, []).append(node.idx)
        by_norm_name.setdefault(node.norm_name, []).append(node.idx)

    def resolve(ref: str, where: str) -> int:
        candidates = by_path.get(ref)
        if candidates is None:
            candidates = by_name.get(ref)
        if candidates is None and " / " in ref:
            # Кандидат мог указать путь с иным разделителем/огрызком — берём хвост.
            candidates = by_name.get(ref.rsplit(" / ", 1)[-1])
        if candidates is None:
            candidates = by_norm_name.get(norm_text(ref))
        if not candidates:
            raise CompareError(f"{title}: ребро {where}: узел «{ref}» не найден")
        if len(candidates) > 1:
            variants = ", ".join(f"«{model.nodes[i].path}»" for i in candidates[:5])
            raise CompareError(
                f"{title}: ребро {where}: ссылка «{ref}» неоднозначна — "
                f"подходят {len(candidates)} узла: {variants}"
            )
        return candidates[0]

    raw_edges = data.get("edges") or []
    if not isinstance(raw_edges, list):
        raise CompareError(f"{title}: edges должен быть списком")
    for raw in raw_edges:
        if not isinstance(raw, dict):
            raise CompareError(f"{title}: ребро должно быть словарём")
        src_ref = _as_str(raw.get("from"))
        dst_ref = _as_str(raw.get("to"))
        if not src_ref or not dst_ref:
            raise CompareError(f"{title}: у ребра нет from/to: {raw!r}")
        where = f"«{src_ref}» → «{dst_ref}»"
        sync = raw.get("sync")
        model.edges.append(
            EdgeRec(
                idx=len(model.edges),
                source=resolve(src_ref, where),
                target=resolve(dst_ref, where),
                label=_as_str(raw.get("label")),
                technology=_as_str(raw.get("technology")),
                channel=_as_str(raw.get("channel")),
                sync=True if sync is None else bool(sync),
            )
        )
    return model


def load_model(path: Path) -> Model:
    """Читает YAML-экспорт с диска."""
    try:
        data = yaml.safe_load(path.read_text(encoding="utf-8"))
    except yaml.YAMLError as exc:
        raise CompareError(f"{path}: YAML не разобран: {exc}") from exc
    return parse_model(data, path.name)


# --------------------------------------------------------------------------
# Матчинг узлов
# --------------------------------------------------------------------------

STAGE_NAMES: dict[str, str] = {
    "якорь": "1. якорь source (repo+path)",
    "имя+форма": "2. точное имя + форма",
    "синоним": "3. синонимичное имя",
    "форма+технология": "4. форма + технология (БД/брокер)",
}


@dataclass
class NodePair:
    """Сматченная пара узлов и флаги расхождений (не промахи, но сигналы)."""

    etalon: int
    candidate: int
    stage: str
    measure: float
    flags: list[str] = field(default_factory=list)


@dataclass
class DupNode:
    """Лишний узел кандидата, претендующий на уже занятый узел эталона."""

    candidate: int
    claims: int
    measure: float


@dataclass
class NodeMatch:
    """Итог матчинга узлов."""

    pairs: list[NodePair] = field(default_factory=list)
    missing: list[int] = field(default_factory=list)  # индексы узлов эталона
    invented: list[int] = field(default_factory=list)  # индексы узлов кандидата
    dups: list[DupNode] = field(default_factory=list)
    e_to_c: dict[int, int] = field(default_factory=dict)
    c_to_e: dict[int, int] = field(default_factory=dict)


def _pair_flags(etalon: NodeRec, candidate: NodeRec) -> list[str]:
    """Флаги сматченной пары: уровень, форма, external, потерянный якорь."""
    flags: list[str] = []
    if norm_text(etalon.parent_path) != norm_text(candidate.parent_path):
        flags.append("уровень")
    if etalon.shape != candidate.shape:
        flags.append("форма")
    if etalon.external != candidate.external:
        flags.append("external")
    if etalon.repo and not candidate.repo:
        flags.append("нет якоря")
    return flags


def _greedy_pairs(
    options: list[tuple[float, int, int]],
    used_e: set[int],
    used_c: set[int],
) -> list[tuple[int, int, float]]:
    """Жадное паросочетание по убыванию меры; каждый узел берётся один раз."""
    result: list[tuple[int, int, float]] = []
    for measure, e_idx, c_idx in options:
        if e_idx in used_e or c_idx in used_c:
            continue
        used_e.add(e_idx)
        used_c.add(c_idx)
        result.append((e_idx, c_idx, measure))
    return result


def match_nodes(etalon: Model, candidate: Model) -> NodeMatch:
    """Ступенчатый матч узлов: якорь → имя+форма → синоним → форма+технология."""
    match = NodeMatch()
    used_e: set[int] = set()
    used_c: set[int] = set()

    def take(e_idx: int, c_idx: int, stage: str, measure: float) -> None:
        pair = NodePair(
            etalon=e_idx,
            candidate=c_idx,
            stage=stage,
            measure=measure,
            flags=_pair_flags(etalon.nodes[e_idx], candidate.nodes[c_idx]),
        )
        match.pairs.append(pair)
        match.e_to_c[e_idx] = c_idx
        match.c_to_e[c_idx] = e_idx

    # Ступень 1 — якорь. Берём только однозначные ключи с обеих сторон: два узла
    # с одним якорем — это уже находка (дубль), а не основание для матча.
    anchors_e: dict[tuple[str, str], list[int]] = {}
    anchors_c: dict[tuple[str, str], list[int]] = {}
    for node in etalon.nodes:
        if node.anchor:
            anchors_e.setdefault(node.anchor, []).append(node.idx)
    for node in candidate.nodes:
        if node.anchor:
            anchors_c.setdefault(node.anchor, []).append(node.idx)
    for key, e_list in sorted(anchors_e.items()):
        c_list = anchors_c.get(key)
        if not c_list or len(e_list) != 1 or len(c_list) != 1:
            continue
        used_e.add(e_list[0])
        used_c.add(c_list[0])
        take(e_list[0], c_list[0], "якорь", 1.0)

    # Ступень 2 — точное нормализованное имя + форма. Тёзок (легальны в разных
    # контейнерах) разводим по похожести путей, чтобы не переставлять их местами.
    keys_e: dict[tuple[str, str], list[int]] = {}
    keys_c: dict[tuple[str, str], list[int]] = {}
    for node in etalon.nodes:
        if node.idx not in used_e:
            keys_e.setdefault((node.norm_name, node.shape), []).append(node.idx)
    for node in candidate.nodes:
        if node.idx not in used_c:
            keys_c.setdefault((node.norm_name, node.shape), []).append(node.idx)
    for key, e_list in sorted(keys_e.items()):
        c_list = keys_c.get(key)
        if not c_list:
            continue
        options = sorted(
            (
                (
                    ratio(norm_text(etalon.nodes[e].path), norm_text(candidate.nodes[c].path)),
                    e,
                    c,
                )
                for e in e_list
                for c in c_list
            ),
            key=lambda item: (-item[0], item[1], item[2]),
        )
        for e_idx, c_idx, _measure in _greedy_pairs(options, used_e, used_c):
            take(e_idx, c_idx, "имя+форма", 1.0)

    # Ступень 3 — синонимичное имя (словарь + difflib). Предпочтение той же
    # форме; матч через форму допустим, но помечается флагом.
    ranked: list[tuple[float, int, float, int, int]] = []
    for e_node in etalon.nodes:
        if e_node.idx in used_e:
            continue
        for c_node in candidate.nodes:
            if c_node.idx in used_c:
                continue
            if not names_similar(e_node, c_node):
                continue
            measure = name_measure(e_node, c_node)
            same_shape = 1 if e_node.shape == c_node.shape else 0
            path_sim = ratio(norm_text(e_node.path), norm_text(c_node.path))
            ranked.append((measure, same_shape, path_sim, e_node.idx, c_node.idx))
    ranked.sort(key=lambda item: (-item[0], -item[1], -item[2], item[3], item[4]))
    options3 = [(m, e, c) for m, _s, _p, e, c in ranked]
    for e_idx, c_idx, measure in _greedy_pairs(options3, used_e, used_c):
        take(e_idx, c_idx, "синоним", measure)

    # Ступень 4 — форма + технология у БД/брокеров (имена таких узлов часто
    # расходятся: «БД Grafana» против «PostgreSQL»).
    tech_e: dict[tuple[str, str], list[int]] = {}
    tech_c: dict[tuple[str, str], list[int]] = {}
    for node in etalon.nodes:
        if node.idx not in used_e and node.shape in TECH_SHAPES and node.technology:
            tech_e.setdefault((node.shape, norm_text(node.technology)), []).append(node.idx)
    for node in candidate.nodes:
        if node.idx not in used_c and node.shape in TECH_SHAPES and node.technology:
            tech_c.setdefault((node.shape, norm_text(node.technology)), []).append(node.idx)
    for key, e_list in sorted(tech_e.items()):
        c_list = tech_c.get(key)
        if not c_list or len(e_list) != 1 or len(c_list) != 1:
            continue
        used_e.add(e_list[0])
        used_c.add(c_list[0])
        take(e_list[0], c_list[0], "форма+технология", 1.0)

    # Остатки. Узел эталона без пары — ПРОПУСК. Узел кандидата без пары — ДУБЛЬ,
    # если он претендует на уже занятый узел эталона (по ступеням 2-4), иначе
    # ВЫДУМКА.
    match.missing = sorted(n.idx for n in etalon.nodes if n.idx not in used_e)
    for c_node in candidate.nodes:
        if c_node.idx in used_c:
            continue
        claim: tuple[float, int] | None = None
        for e_idx in sorted(match.e_to_c):
            e_node = etalon.nodes[e_idx]
            if c_node.anchor and c_node.anchor == e_node.anchor:
                claim = (1.0, e_idx)
                break
            if e_node.norm_name == c_node.norm_name and e_node.shape == c_node.shape:
                claim = (1.0, e_idx)
                break
            if names_similar(e_node, c_node):
                measure = name_measure(e_node, c_node)
                if claim is None or measure > claim[0]:
                    claim = (measure, e_idx)
        if claim is not None:
            match.dups.append(DupNode(candidate=c_node.idx, claims=claim[1], measure=claim[0]))
        else:
            match.invented.append(c_node.idx)
    match.pairs.sort(key=lambda p: p.etalon)
    return match


# --------------------------------------------------------------------------
# Матчинг рёбер
# --------------------------------------------------------------------------

EDGE_MATCHED = "совпало"
EDGE_DIRECTION = "направление"
EDGE_CHANNEL = "канал"
EDGE_SYNC = "синхронность"
EDGE_MISSING = "пропуск"
EDGE_MISSING_NODE = "пропуск-по-узлу"
EDGE_INVENTED = "выдумка"
EDGE_INVENTED_NODE = "выдумка-по-узлу"
EDGE_DUP = "дубль"


@dataclass
class EdgeVerdict:
    """Вердикт по одному ребру эталона (или лишнему ребру кандидата)."""

    cls: str
    edge: int  # индекс ребра в своей модели
    other: int | None = None  # найденное ребро другой модели
    note: str = ""


@dataclass
class EdgeMatch:
    """Итог сверки рёбер."""

    verdicts: list[EdgeVerdict] = field(default_factory=list)  # по рёбрам эталона
    extra: list[EdgeVerdict] = field(default_factory=list)  # по рёбрам кандидата
    labels_to_check: list[tuple[int, int, float]] = field(default_factory=list)
    structural_total: int = 0  # рёбра эталона, у которых оба конца сматчены
    found_directed: int = 0  # найдено в нужном направлении (совпало + канал + синхронность)


def match_edges(etalon: Model, candidate: Model, nodes: NodeMatch) -> EdgeMatch:
    """Сверка рёбер по парам сматченных концов; направление значимо."""
    result = EdgeMatch()

    # Ключ ребра кандидата — пара канонических (эталонных) индексов концов.
    def canon(edge: EdgeRec) -> tuple[int, int] | None:
        src = nodes.c_to_e.get(edge.source)
        dst = nodes.c_to_e.get(edge.target)
        if src is None or dst is None:
            return None
        return (src, dst)

    by_pair: dict[tuple[int, int], list[int]] = {}
    for edge in candidate.edges:
        key = canon(edge)
        if key is None:
            continue  # конец не сматчен — учтётся как выдумка-по-узлу
        by_pair.setdefault(key, []).append(edge.idx)

    # Дубли кандидата: ≥2 ребра на одной паре с одним каналом. Второе и далее —
    # ДУБЛЬ, в матч не идут.
    consumed: set[int] = set()
    for key, idx_list in by_pair.items():
        groups: dict[str, list[int]] = {}
        for idx in idx_list:
            groups.setdefault(candidate.edges[idx].norm_channel, []).append(idx)
        for _channel, group in groups.items():
            for idx in group[1:]:
                consumed.add(idx)
                result.extra.append(
                    EdgeVerdict(
                        cls=EDGE_DUP,
                        edge=idx,
                        note=f"повтор пары {etalon.nodes[key[0]].path} → {etalon.nodes[key[1]].path}",
                    )
                )

    for e_edge in etalon.edges:
        e_src = nodes.e_to_c.get(e_edge.source)
        e_dst = nodes.e_to_c.get(e_edge.target)
        if e_src is None or e_dst is None:
            result.verdicts.append(EdgeVerdict(cls=EDGE_MISSING_NODE, edge=e_edge.idx))
            continue
        result.structural_total += 1
        key = (e_edge.source, e_edge.target)
        pool = [i for i in by_pair.get(key, []) if i not in consumed]
        # Сперва ребро с тем же каналом (одна пара может нести несколько каналов).
        same_channel = [i for i in pool if candidate.edges[i].norm_channel == e_edge.norm_channel]
        chosen: int | None = None
        cls = EDGE_MATCHED
        if same_channel:
            chosen = same_channel[0]
        elif pool:
            chosen = pool[0]
            cls = EDGE_CHANNEL
        if chosen is None:
            back_key = (e_edge.target, e_edge.source)
            back_pool = [i for i in by_pair.get(back_key, []) if i not in consumed]
            if back_pool:
                chosen = back_pool[0]
                consumed.add(chosen)
                result.verdicts.append(
                    EdgeVerdict(cls=EDGE_DIRECTION, edge=e_edge.idx, other=chosen)
                )
                continue
            result.verdicts.append(EdgeVerdict(cls=EDGE_MISSING, edge=e_edge.idx))
            continue
        consumed.add(chosen)
        c_edge = candidate.edges[chosen]
        result.found_directed += 1
        note = ""
        if cls == EDGE_CHANNEL:
            note = f"эталон «{e_edge.channel or '—'}», кандидат «{c_edge.channel or '—'}»"
        elif e_edge.sync != c_edge.sync:
            cls = EDGE_SYNC
            note = f"эталон sync={e_edge.sync}, кандидат sync={c_edge.sync}"
        result.verdicts.append(EdgeVerdict(cls=cls, edge=e_edge.idx, other=chosen, note=note))
        # Подписи не судим: считаем похожесть и складываем спорные в список.
        similarity = jaccard(tokens(e_edge.label), tokens(c_edge.label))
        if e_edge.label and c_edge.label and similarity < LABEL_CHECK_MAX:
            result.labels_to_check.append((e_edge.idx, chosen, similarity))

    # Остатки кандидата: выдумки (оба конца сматчены) и выдумки-по-узлу.
    for edge in candidate.edges:
        if edge.idx in consumed:
            continue
        if canon(edge) is None:
            result.extra.append(EdgeVerdict(cls=EDGE_INVENTED_NODE, edge=edge.idx))
        else:
            result.extra.append(EdgeVerdict(cls=EDGE_INVENTED, edge=edge.idx))
    return result


# --------------------------------------------------------------------------
# Метрики и отчёты
# --------------------------------------------------------------------------


def _pct(part: int, whole: int) -> float:
    """Доля в процентах с одним знаком; пустой знаменатель — 0.0."""
    if whole <= 0:
        return 0.0
    return round(100.0 * part / whole, 1)


def build_report(
    etalon: Model, candidate: Model, nodes: NodeMatch, edges: EdgeMatch, title: str
) -> dict[str, Any]:
    """Собирает JSON-итог: метрики + поимённые списки расхождений."""
    matched = len(nodes.pairs)
    missing_containers = sum(1 for i in nodes.missing if etalon.nodes[i].is_container)
    stages: dict[str, int] = {}
    for pair in nodes.pairs:
        stages[pair.stage] = stages.get(pair.stage, 0) + 1
    flags: dict[str, int] = {}
    for pair in nodes.pairs:
        for flag in pair.flags:
            flags[flag] = flags.get(flag, 0) + 1

    anchors_e = sum(1 for n in etalon.nodes if n.repo)
    anchors_c = sum(1 for n in candidate.nodes if n.repo)
    anchors_lost = sum(1 for p in nodes.pairs if "нет якоря" in p.flags)

    edge_classes: dict[str, int] = {}
    for verdict in edges.verdicts:
        edge_classes[verdict.cls] = edge_classes.get(verdict.cls, 0) + 1
    for verdict in edges.extra:
        edge_classes[verdict.cls] = edge_classes.get(verdict.cls, 0) + 1
    matched_edges = edge_classes.get(EDGE_MATCHED, 0)

    metrics: dict[str, Any] = {
        "узлы": {
            "эталон": len(etalon.nodes),
            "кандидат": len(candidate.nodes),
            "сматчено": matched,
            "полнота_%": _pct(matched, len(etalon.nodes)),
            "точность_%": _pct(matched, len(candidate.nodes)),
            "пропуски": len(nodes.missing),
            "пропуски_контейнеры": missing_containers,
            "выдумки": len(nodes.invented),
            "дубли": len(nodes.dups),
            "по_ступеням": stages,
            "флаги": flags,
            "якоря_эталон": anchors_e,
            "якоря_кандидат": anchors_c,
            "якоря_покрытие_эталон_%": _pct(anchors_e, len(etalon.nodes)),
            "якоря_покрытие_кандидат_%": _pct(anchors_c, len(candidate.nodes)),
            "якоря_потеряно": anchors_lost,
        },
        "рёбра": {
            "эталон": len(etalon.edges),
            "кандидат": len(candidate.edges),
            "совпало": matched_edges,
            "структурных_в_эталоне": edges.structural_total,
            "найдено_в_направлении": edges.found_directed,
            "полнота_структурная_%": _pct(matched_edges, edges.structural_total),
            "полнота_общая_%": _pct(matched_edges, len(etalon.edges)),
            "точность_%": _pct(matched_edges, len(candidate.edges)),
            "направление": edge_classes.get(EDGE_DIRECTION, 0),
            "канал": edge_classes.get(EDGE_CHANNEL, 0),
            "синхронность": edge_classes.get(EDGE_SYNC, 0),
            "пропуски": edge_classes.get(EDGE_MISSING, 0),
            "пропуски_по_узлу": edge_classes.get(EDGE_MISSING_NODE, 0),
            "выдумки": edge_classes.get(EDGE_INVENTED, 0),
            "выдумки_по_узлу": edge_classes.get(EDGE_INVENTED_NODE, 0),
            "дубли": edge_classes.get(EDGE_DUP, 0),
            "подписей_проверить": len(edges.labels_to_check),
        },
    }

    def edge_text(model: Model, idx: int) -> str:
        edge = model.edges[idx]
        channel = f" [{edge.channel}]" if edge.channel else ""
        return (
            f"{model.nodes[edge.source].path} → {model.nodes[edge.target].path}"
            f"{channel} — {edge.label or '—'}"
        )

    lists: dict[str, list[Any]] = {
        "узлы_пропуски": [
            {
                "путь": etalon.nodes[i].path,
                "форма": etalon.nodes[i].shape,
                "контейнер": etalon.nodes[i].is_container,
            }
            for i in nodes.missing
        ],
        "узлы_выдумки": [
            {"путь": candidate.nodes[i].path, "форма": candidate.nodes[i].shape}
            for i in nodes.invented
        ],
        "узлы_дубли": [
            {
                "путь": candidate.nodes[d.candidate].path,
                "претендует_на": etalon.nodes[d.claims].path,
                "мера": round(d.measure, 2),
            }
            for d in nodes.dups
        ],
        "узлы_флаги": [
            {
                "эталон": etalon.nodes[p.etalon].path,
                "кандидат": candidate.nodes[p.candidate].path,
                "ступень": p.stage,
                "флаги": p.flags,
            }
            for p in nodes.pairs
            if p.flags
        ],
        "узлы_ступень_синоним": [
            {
                "эталон": etalon.nodes[p.etalon].path,
                "кандидат": candidate.nodes[p.candidate].path,
                "мера": round(p.measure, 2),
            }
            for p in nodes.pairs
            if p.stage == "синоним"
        ],
        "рёбра_пропуски": [
            edge_text(etalon, v.edge) for v in edges.verdicts if v.cls == EDGE_MISSING
        ],
        "рёбра_пропуски_по_узлу": [
            edge_text(etalon, v.edge) for v in edges.verdicts if v.cls == EDGE_MISSING_NODE
        ],
        "рёбра_направление": [
            edge_text(etalon, v.edge) for v in edges.verdicts if v.cls == EDGE_DIRECTION
        ],
        "рёбра_канал": [
            f"{edge_text(etalon, v.edge)} :: {v.note}"
            for v in edges.verdicts
            if v.cls == EDGE_CHANNEL
        ],
        "рёбра_синхронность": [
            f"{edge_text(etalon, v.edge)} :: {v.note}"
            for v in edges.verdicts
            if v.cls == EDGE_SYNC
        ],
        "рёбра_выдумки": [
            edge_text(candidate, v.edge) for v in edges.extra if v.cls == EDGE_INVENTED
        ],
        "рёбра_выдумки_по_узлу": [
            edge_text(candidate, v.edge) for v in edges.extra if v.cls == EDGE_INVENTED_NODE
        ],
        "рёбра_дубли": [
            f"{edge_text(candidate, v.edge)} :: {v.note}" for v in edges.extra if v.cls == EDGE_DUP
        ],
        "подписи_проверить": [
            f"{edge_text(etalon, e_idx)}  ||  кандидат: {candidate.edges[c_idx].label or '—'}"
            f"  (похожесть {sim:.2f})"
            for e_idx, c_idx, sim in edges.labels_to_check
        ],
    }
    return {
        "title": title,
        "эталон_файл": etalon.title,
        "кандидат_файл": candidate.title,
        "метрики": metrics,
        "списки": lists,
    }


SECTION_CAP = 60


def _md_section(title: str, items: list[str]) -> list[str]:
    """Секция отчёта со срезом до SECTION_CAP строк."""
    lines = [f"### {title} — {len(items)}", ""]
    if not items:
        lines += ["_пусто_", ""]
        return lines
    for item in items[:SECTION_CAP]:
        lines.append(f"- {item}")
    if len(items) > SECTION_CAP:
        lines.append(f"- … и ещё {len(items) - SECTION_CAP}")
    lines.append("")
    return lines


def render_markdown(report: dict[str, Any]) -> str:
    """Markdown-отчёт: таблицы метрик, затем секции по классам расхождений."""
    metrics = report["метрики"]
    nodes = metrics["узлы"]
    edges = metrics["рёбра"]
    lists = report["списки"]
    out: list[str] = [
        f"# Сверка C4: {report['title']}",
        "",
        f"Эталон: `{report['эталон_файл']}` · кандидат: `{report['кандидат_файл']}`",
        "",
        "## Узлы",
        "",
        "| метрика | значение |",
        "| --- | --- |",
        f"| всего в эталоне | {nodes['эталон']} |",
        f"| всего у кандидата | {nodes['кандидат']} |",
        f"| сматчено | {nodes['сматчено']} |",
        f"| полнота (сматчено/эталон) | {nodes['полнота_%']}% |",
        f"| точность (сматчено/кандидат) | {nodes['точность_%']}% |",
        f"| пропуски (из них контейнеров) | {nodes['пропуски']} ({nodes['пропуски_контейнеры']}) |",
        f"| выдумки | {nodes['выдумки']} |",
        f"| дубли | {nodes['дубли']} |",
        f"| покрытие якорями эталон / кандидат | {nodes['якоря_покрытие_эталон_%']}% / {nodes['якоря_покрытие_кандидат_%']}% |",
        f"| потеряно якорей (у пар) | {nodes['якоря_потеряно']} |",
        "",
        "Ступени матча: "
        + (
            ", ".join(f"{STAGE_NAMES.get(k, k)} — {v}" for k, v in sorted(nodes["по_ступеням"].items()))
            or "—"
        ),
        "",
        "Флаги пар: "
        + (", ".join(f"{k} — {v}" for k, v in sorted(nodes["флаги"].items())) or "—"),
        "",
        "## Рёбра",
        "",
        "| метрика | значение |",
        "| --- | --- |",
        f"| всего в эталоне | {edges['эталон']} |",
        f"| всего у кандидата | {edges['кандидат']} |",
        f"| совпало | {edges['совпало']} |",
        f"| найдено в нужном направлении | {edges['найдено_в_направлении']} |",
        f"| полнота структурная (по сматченным концам, знаменатель {edges['структурных_в_эталоне']}) | {edges['полнота_структурная_%']}% |",
        f"| полнота общая | {edges['полнота_общая_%']}% |",
        f"| точность | {edges['точность_%']}% |",
        f"| направление | {edges['направление']} |",
        f"| канал | {edges['канал']} |",
        f"| синхронность | {edges['синхронность']} |",
        f"| пропуски / пропуски-по-узлу | {edges['пропуски']} / {edges['пропуски_по_узлу']} |",
        f"| выдумки / выдумки-по-узлу | {edges['выдумки']} / {edges['выдумки_по_узлу']} |",
        f"| дубли | {edges['дубли']} |",
        f"| подписей проверить (в метрику не входит) | {edges['подписей_проверить']} |",
        "",
        "## Расхождения",
        "",
    ]
    out += _md_section("Узлы: пропуски", [
        f"{item['путь']} ({item['форма']}){' [контейнер]' if item['контейнер'] else ''}"
        for item in lists["узлы_пропуски"]
    ])
    out += _md_section("Узлы: выдумки", [
        f"{item['путь']} ({item['форма']})" for item in lists["узлы_выдумки"]
    ])
    out += _md_section("Узлы: дубли", [
        f"{item['путь']} → претендует на «{item['претендует_на']}» (мера {item['мера']})"
        for item in lists["узлы_дубли"]
    ])
    out += _md_section("Узлы: сматчено с флагами", [
        f"{item['эталон']} ↔ {item['кандидат']} [{item['ступень']}] — {', '.join(item['флаги'])}"
        for item in lists["узлы_флаги"]
    ])
    out += _md_section("Узлы: матч по синонимам (проверить глазами)", [
        f"{item['эталон']} ↔ {item['кандидат']} (мера {item['мера']})"
        for item in lists["узлы_ступень_синоним"]
    ])
    out += _md_section("Рёбра: пропуски", lists["рёбра_пропуски"])
    out += _md_section("Рёбра: пропуски по узлу", lists["рёбра_пропуски_по_узлу"])
    out += _md_section("Рёбра: направление", lists["рёбра_направление"])
    out += _md_section("Рёбра: канал", lists["рёбра_канал"])
    out += _md_section("Рёбра: синхронность", lists["рёбра_синхронность"])
    out += _md_section("Рёбра: выдумки", lists["рёбра_выдумки"])
    out += _md_section("Рёбра: выдумки по узлу", lists["рёбра_выдумки_по_узлу"])
    out += _md_section("Рёбра: дубли", lists["рёбра_дубли"])
    out += _md_section("Подписи: проверить глазами", lists["подписи_проверить"])
    return "\n".join(out).rstrip() + "\n"


TABLE_COLUMNS: list[tuple[str, str, str]] = [
    # (заголовок, раздел метрик, ключ)
    ("узлы эт.", "узлы", "эталон"),
    ("узлы канд.", "узлы", "кандидат"),
    ("полнота уз.", "узлы", "полнота_%"),
    ("точность уз.", "узлы", "точность_%"),
    ("проп.", "узлы", "пропуски"),
    ("проп.-конт.", "узлы", "пропуски_контейнеры"),
    ("выдум.", "узлы", "выдумки"),
    ("дубли уз.", "узлы", "дубли"),
    ("якоря канд.", "узлы", "якоря_покрытие_кандидат_%"),
    ("рёбра эт.", "рёбра", "эталон"),
    ("рёбра канд.", "рёбра", "кандидат"),
    ("совпало", "рёбра", "совпало"),
    ("полн. структ.", "рёбра", "полнота_структурная_%"),
    ("полн. общ.", "рёбра", "полнота_общая_%"),
    ("точн. рёб.", "рёбра", "точность_%"),
    ("направл.", "рёбра", "направление"),
    ("канал", "рёбра", "канал"),
    ("синхр.", "рёбра", "синхронность"),
    ("дубли рёб.", "рёбра", "дубли"),
]


def render_table(reports: list[dict[str, Any]]) -> str:
    """Сводная таблица метрик по нескольким прогонам (строка — прогон)."""
    header = "| прогон | " + " | ".join(name for name, _s, _k in TABLE_COLUMNS) + " |"
    sep = "| --- | " + " | ".join("---" for _ in TABLE_COLUMNS) + " |"
    lines = ["# Сводка сверок C4", "", header, sep]
    for report in reports:
        metrics = report.get("метрики", {})
        cells = []
        for _name, section, key in TABLE_COLUMNS:
            cells.append(str(metrics.get(section, {}).get(key, "—")))
        lines.append(f"| {report.get('title', '?')} | " + " | ".join(cells) + " |")
    lines.append("")
    return "\n".join(lines)


# --------------------------------------------------------------------------
# CLI
# --------------------------------------------------------------------------


def compare_files(etalon_path: Path, candidate_path: Path, title: str | None) -> dict[str, Any]:
    """Полный цикл сверки двух файлов экспорта."""
    etalon = load_model(etalon_path)
    candidate = load_model(candidate_path)
    node_match = match_nodes(etalon, candidate)
    edge_match = match_edges(etalon, candidate, node_match)
    return build_report(
        etalon, candidate, node_match, edge_match, title or candidate_path.stem
    )


def cmd_run(args: argparse.Namespace) -> int:
    report = compare_files(Path(args.etalon), Path(args.candidate), args.title)
    if args.json:
        Path(args.json).write_text(
            json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
        )
    markdown = render_markdown(report)
    if args.md:
        Path(args.md).write_text(markdown, encoding="utf-8")
    else:
        sys.stdout.write(markdown)
    nodes = report["метрики"]["узлы"]
    edges = report["метрики"]["рёбра"]
    sys.stderr.write(
        f"узлы: полнота {nodes['полнота_%']}% точность {nodes['точность_%']}%; "
        f"рёбра: структурная {edges['полнота_структурная_%']}% точность {edges['точность_%']}%\n"
    )
    return 0


def cmd_table(args: argparse.Namespace) -> int:
    reports = [json.loads(Path(p).read_text(encoding="utf-8")) for p in args.jsons]
    table = render_table(reports)
    if args.md:
        Path(args.md).write_text(table, encoding="utf-8")
    else:
        sys.stdout.write(table)
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Сверка C4-экспортов ArchMap: кандидат против эталона")
    sub = parser.add_subparsers(dest="command", required=True)

    run = sub.add_parser("run", help="сверить два экспорта")
    run.add_argument("etalon", help="YAML-экспорт эталона")
    run.add_argument("candidate", help="YAML-экспорт кандидата")
    run.add_argument("--md", help="файл markdown-отчёта (по умолчанию — stdout)")
    run.add_argument("--json", help="файл JSON-итога")
    run.add_argument("--title", help="имя прогона в отчёте и сводке")
    run.set_defaults(func=cmd_run)

    table = sub.add_parser("table", help="сводная таблица по JSON-итогам")
    table.add_argument("jsons", nargs="+", help="JSON-итоги подкоманды run")
    table.add_argument("--md", help="файл markdown-сводки (по умолчанию — stdout)")
    table.set_defaults(func=cmd_table)
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        result: int = args.func(args)
        return result
    except CompareError as exc:
        sys.stderr.write(f"ОШИБКА: {exc}\n")
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
