"""Поиск по знанию проекта — для ИИ-агента, разбирающего инцидент.

Зачем. Полевой прогон 2026-09-29: агент отвечал через MCP на вопросы вида «в логе
`failed to send SMS: SMSDevices not configured for /dev/ttyUSB0`, почему?» и, чтобы
найти ОДНУ фразу ошибки, открывал все карточки объектов подряд. На десятке
объектов это терпимо, на монолите в двести схем — нет.

Как матчим. Запрос — сырая строка лога с переменными частями (`/dev/ttyUSB0`, id,
пути), а в схеме написано `SMSDevices not configured for <устройство>`. Поэтому
подстрока целиком не годится, и поиск идёт по токенам:
  • токены — `\\w+` в нижнем регистре; короткие (меньше 3 символов), чистые числа
    и служебные слова отбрасываются;
  • русские окончания — лёгкая нормализация: длинные токены сравниваются по
    префиксу без двух последних символов («оповещения» ~ «оповещение»);
  • вес токена — IDF по единицам проекта, log(1 + N/df): частое слово почти
    ничего не весит, редкое (`smsdevices`) решает;
  • счёт единицы — сумма весов РАЗНЫХ совпавших токенов запроса, плюс бонус, если
    вся нормализованная фраза запроса встретилась в строке подряд;
  • порог — два совпавших токена (либо один, если он в запросе единственный):
    одно общее слово со строкой лога — ещё не находка.

Где ищем — единицы поиска: объект, заголовок схемы логики и каждая строка её тела,
каждая строка OpenAPI-спеки, таблица и колонка, канал и поле, параметр
конфигурации, процесс и подпись шага. Считаем в Python по загруженному знанию:
проекты — сотни схем, этого хватает, а Postgres FTS не дал бы ни тестов на SQLite,
ни нормализации под строки логов.
"""

from __future__ import annotations

import math
import re
import uuid
from collections import defaultdict
from dataclasses import dataclass

from sqlalchemy.orm import Session

from app.models.broker_channel import BrokerChannel
from app.models.business_process import BusinessProcess
from app.models.channel_field import ChannelField
from app.models.config_param import ConfigParam
from app.models.db_column import DbColumn
from app.models.db_table import DbTable
from app.models.node import Node
from app.models.node_doc import NodeDoc
from app.models.process_message import ProcessMessage
from app.schemas.search import SearchHit, SearchKind, SearchResponse

# Токен — всё, кроме разделителей: буквы, цифры и `_` (Unicode-\w, кириллица тоже).
_WORD = re.compile(r"\w+")
_SPACES = re.compile(r"\s+")

# Короче трёх символов — предлоги, «to», «is», «br» из <br> в mermaid.
MIN_TOKEN = 3
# Нормализация окончаний: токен ДЛИННЕЕ пяти символов сравнивается без двух
# последних, и длины сравниваемых токенов расходятся не больше чем на два.
STEM_FROM = 6
STEM_CUT = 2

# Служебные слова, которые не несут смысла ни в логе, ни в вопросе. Список
# намеренно маленький: IDF и так гасит частые слова, а лишнее слово в стоп-листе
# невосстановимо. `not` здесь НЕТ осознанно: в русских схемах он встречается почти
# только внутри английских фраз ошибок («SMSDevices not configured», «not in
# allowed path»), и как раз отличает ветку отказа от ветки успеха. Проверено
# тестом: с `not` в стоп-листе строка шума «failed to send for script, SMS» обходит
# ветку «SMSDevices not configured» (tests/test_search.py, главный сценарий и
# test_not_отличает_ветку_отказа). `cannot` — по той же причине.
STOP_WORDS = frozenset(
    {
        # английские
        "the", "for", "and", "with", "from", "into", "onto", "that", "this", "these",
        "those", "are", "was", "were", "has", "have", "had", "been", "being", "will",
        "would", "can", "could", "should", "you", "your", "its", "our", "their",
        "there", "then", "than", "but", "all", "any", "via",
        # русские союзы, предлоги, местоимения и вопросительные слова
        "для", "при", "или", "что", "как", "это", "эта", "этот", "эти", "если", "над",
        "под", "про", "без", "его", "ему", "её", "она", "они", "оно", "так", "также",
        "тоже", "чтобы", "когда", "где", "почему", "зачем", "какой", "какая", "какое",
        "какие", "каким", "какую", "там", "тут", "уже", "ещё", "еще", "был",
        "была", "было", "были", "есть", "быть", "все", "всё", "всех", "чем", "кто",
        "чего", "через", "либо", "лишь", "только", "можно", "нужно", "надо", "будет",
    }
)

# Бонус за всю фразу запроса подряд — доля суммарного веса запроса. Строка,
# содержащая фразу целиком, и так набирает максимум по токенам; бонус отличает
# её от строки, где те же слова разбросаны.
PHRASE_BONUS = 0.5
# Из одной схемы или спеки — не больше трёх лучших строк: иначе одна длинная
# схема с повторяющимся словом вытесняет из выдачи всё остальное.
GROUP_CAP = 3
SNIPPET_LEN = 200
# Совпадение ставим ближе к началу окна: читается то, что после него.
SNIPPET_LEAD = 60

# Порядок видов при равном счёте: конкретное знание (строка схемы) раньше общего.
KIND_ORDER: dict[str, int] = {
    kind: i
    for i, kind in enumerate(
        ["doc", "spec", "param", "column", "field", "table", "channel", "step", "process", "node"]
    )
}


class SearchQueryError(ValueError):
    """Запрос, по которому искать нечего: пустой или без значимых слов (→ 422)."""


def words(text: str) -> list[str]:
    """Все токены строки в нижнем регистре (без фильтров)."""
    return [w.lower() for w in _WORD.findall(text)]


def query_tokens(query: str) -> list[str]:
    """Значимые токены запроса в порядке появления, без повторов."""
    out: list[str] = []
    for w in words(query):
        if len(w) < MIN_TOKEN or w.isdigit() or w in STOP_WORDS or w in out:
            continue
        out.append(w)
    return out


def tokens_match(q: str, t: str) -> bool:
    """Совпадение токена запроса q с токеном текста t с поправкой на окончания.

    Длинный токен (от шести символов) сравнивается по префиксу без двух последних
    символов, в обе стороны: «оповещения» ~ «оповещение», «failed» ~ «fail».
    Длины расходятся не больше чем на два — иначе «status» тянул бы «statistics».
    """
    if q == t:
        return True
    if abs(len(q) - len(t)) > STEM_CUT:
        return False
    if len(q) >= STEM_FROM and t.startswith(q[:-STEM_CUT]):
        return True
    return len(t) >= STEM_FROM and q.startswith(t[:-STEM_CUT])


@dataclass
class Unit:
    """Единица поиска: одна строка знания с адресом."""

    kind: SearchKind
    title: str
    text: str
    node_id: uuid.UUID | None = None
    doc_id: uuid.UUID | None = None
    process_id: uuid.UUID | None = None
    message_id: uuid.UUID | None = None
    line_no: int | None = None
    # Группа капа «не больше трёх строк»: схема (заголовок и строки тела) или
    # спека объекта. None — единица сама по себе.
    group: tuple[str, uuid.UUID] | None = None


def _flat(text: str) -> str:
    """Строка в одну линию: описания бывают многострочными, а находка — строка."""
    return _SPACES.sub(" ", text).strip()


def _joined(*parts: str | None) -> str:
    return " · ".join(_flat(p) for p in parts if p and p.strip())


def collect_units(db: Session, project_id: uuid.UUID) -> tuple[list[Unit], dict[uuid.UUID, str]]:
    """Всё знание проекта единицами поиска + пути объектов («A / B / C»).

    Грузим КОЛОНКАМИ, а не сущностями: сущности узлов тянули бы selectin-ом мету
    схем, а тела схем отложены (NodeDoc.content deferred) — здесь они нужны все, и
    явная выборка колонки берёт их одним запросом.
    """
    nodes = (
        db.query(
            Node.id, Node.parent_id, Node.name, Node.description, Node.role,
            Node.technology, Node.openapi_spec,
        )
        .filter(Node.project_id == project_id)
        .all()
    )
    parent = {n.id: n.parent_id for n in nodes}
    name = {n.id: n.name for n in nodes}
    paths: dict[uuid.UUID, str] = {}

    def path_of(node_id: uuid.UUID) -> str:
        if node_id not in paths:
            chain: list[str] = []
            cur: uuid.UUID | None = node_id
            seen: set[uuid.UUID] = set()
            while cur is not None and cur in name and cur not in seen:
                seen.add(cur)
                chain.append(name[cur])
                cur = parent[cur]
            paths[node_id] = " / ".join(reversed(chain))
        return paths[node_id]

    units: list[Unit] = []
    for n in nodes:
        path_of(n.id)
        units.append(
            Unit(
                kind="node", title=n.name, node_id=n.id,
                text=_joined(n.name, n.role, n.technology, n.description),
            )
        )
        if n.openapi_spec:
            for i, line in enumerate(n.openapi_spec.splitlines(), 1):
                if line.strip():
                    units.append(
                        Unit(
                            kind="spec", title="OpenAPI", node_id=n.id, line_no=i,
                            text=line.strip(), group=("spec", n.id),
                        )
                    )

    docs = (
        db.query(NodeDoc.id, NodeDoc.node_id, NodeDoc.name, NodeDoc.operation, NodeDoc.content)
        .join(Node, Node.id == NodeDoc.node_id)
        .filter(Node.project_id == project_id)
        .all()
    )
    for d in docs:
        group = ("doc", d.id)
        units.append(
            Unit(
                kind="doc", title=d.name, node_id=d.node_id, doc_id=d.id,
                text=_joined(d.name, d.operation), group=group,
            )
        )
        for i, line in enumerate((d.content or "").splitlines(), 1):
            if line.strip():
                units.append(
                    Unit(
                        kind="doc", title=d.name, node_id=d.node_id, doc_id=d.id,
                        line_no=i, text=line.strip(), group=group,
                    )
                )

    tables = (
        db.query(DbTable.id, DbTable.node_id, DbTable.schema_name, DbTable.name, DbTable.description)
        .join(Node, Node.id == DbTable.node_id)
        .filter(Node.project_id == project_id)
        .all()
    )
    table_title: dict[uuid.UUID, str] = {}
    table_node: dict[uuid.UUID, uuid.UUID] = {}
    for t in tables:
        title = f"{t.schema_name}.{t.name}" if t.schema_name else t.name
        table_title[t.id], table_node[t.id] = title, t.node_id
        units.append(
            Unit(kind="table", title=title, node_id=t.node_id, text=_joined(title, t.description))
        )
    columns = (
        db.query(DbColumn.table_id, DbColumn.name, DbColumn.type, DbColumn.description)
        .join(DbTable, DbTable.id == DbColumn.table_id)
        .join(Node, Node.id == DbTable.node_id)
        .filter(Node.project_id == project_id)
        .all()
    )
    for c in columns:
        units.append(
            Unit(
                kind="column", title=f"{table_title[c.table_id]}.{c.name}",
                node_id=table_node[c.table_id],
                text=_joined(f"{c.name} {c.type}".strip(), c.description),
            )
        )

    channels = (
        db.query(
            BrokerChannel.id, BrokerChannel.node_id, BrokerChannel.group_name,
            BrokerChannel.name, BrokerChannel.description,
        )
        .join(Node, Node.id == BrokerChannel.node_id)
        .filter(Node.project_id == project_id)
        .all()
    )
    channel_title: dict[uuid.UUID, str] = {}
    channel_node: dict[uuid.UUID, uuid.UUID] = {}
    for ch in channels:
        title = f"{ch.group_name} / {ch.name}" if ch.group_name else ch.name
        channel_title[ch.id], channel_node[ch.id] = title, ch.node_id
        units.append(
            Unit(kind="channel", title=title, node_id=ch.node_id, text=_joined(title, ch.description))
        )
    fields = (
        db.query(ChannelField.channel_id, ChannelField.name, ChannelField.type, ChannelField.description)
        .join(BrokerChannel, BrokerChannel.id == ChannelField.channel_id)
        .join(Node, Node.id == BrokerChannel.node_id)
        .filter(Node.project_id == project_id)
        .all()
    )
    for f in fields:
        units.append(
            Unit(
                kind="field", title=f"{channel_title[f.channel_id]}.{f.name}",
                node_id=channel_node[f.channel_id],
                text=_joined(f"{f.name} {f.type}".strip(), f.description),
            )
        )

    params = (
        db.query(ConfigParam.node_id, ConfigParam.name, ConfigParam.default_value, ConfigParam.description)
        .join(Node, Node.id == ConfigParam.node_id)
        .filter(Node.project_id == project_id)
        .all()
    )
    for p in params:
        head = f"{p.name} = {p.default_value}" if p.default_value else p.name
        units.append(
            Unit(kind="param", title=p.name, node_id=p.node_id, text=_joined(head, p.description))
        )

    processes = (
        db.query(BusinessProcess.id, BusinessProcess.name)
        .filter(BusinessProcess.project_id == project_id)
        .all()
    )
    process_name = {pr.id: pr.name for pr in processes}
    for pr in processes:
        units.append(Unit(kind="process", title=pr.name, process_id=pr.id, text=_flat(pr.name)))
    steps = (
        db.query(ProcessMessage.id, ProcessMessage.process_id, ProcessMessage.caption, ProcessMessage.doc_id)
        .join(BusinessProcess, BusinessProcess.id == ProcessMessage.process_id)
        .filter(BusinessProcess.project_id == project_id, ProcessMessage.caption.isnot(None))
        .all()
    )
    for s in steps:
        if s.caption and s.caption.strip():
            units.append(
                Unit(
                    kind="step", title=process_name[s.process_id], process_id=s.process_id,
                    message_id=s.id, doc_id=s.doc_id, text=_flat(s.caption),
                )
            )
    return units, paths


def snippet(text: str, anchor_word: str) -> str:
    """Строка, обрезанная до ~200 символов вокруг первого вхождения anchor_word.

    Ищем по токенам исходной строки, а не по text.lower(): нижний регистр
    некоторых символов меняет длину строки, и позиции разъехались бы.
    """
    if len(text) <= SNIPPET_LEN:
        return text
    pos = next((m.start() for m in _WORD.finditer(text) if m.group().lower() == anchor_word), 0)
    start = max(0, pos - SNIPPET_LEAD)
    end = min(len(text), start + SNIPPET_LEN)
    start = max(0, end - SNIPPET_LEN)
    return ("…" if start > 0 else "") + text[start:end] + ("…" if end < len(text) else "")


def search(
    db: Session,
    project_id: uuid.UUID,
    query: str,
    *,
    limit: int = 20,
    kinds: set[str] | None = None,
) -> SearchResponse:
    if not query.strip():
        raise SearchQueryError(
            "Пустой запрос: передайте строку лога, текст ошибки или слова для поиска"
        )
    tokens = query_tokens(query)
    if not tokens:
        raise SearchQueryError(
            "В запросе нет значимых слов: короткие (меньше 3 символов), числа и "
            "служебные слова не ищутся"
        )

    units, paths = collect_units(db, project_id)
    unit_words = [set(words(u.text)) for u in units]
    postings: dict[str, set[int]] = defaultdict(set)
    for i, ws in enumerate(unit_words):
        for w in ws:
            postings[w].add(i)

    # Для каждого токена запроса — какие слова словаря проекта ему равны с
    # поправкой на окончания, в каких единицах они есть и сколько он весит.
    total_units = len(units)
    weight: dict[str, float] = {}
    hits_of: dict[int, dict[str, str]] = defaultdict(dict)  # единица → {токен: слово текста}
    for q in tokens:
        variants = [w for w in postings if tokens_match(q, w)]
        found: set[int] = set()
        for w in variants:
            found |= postings[w]
        if not found:
            continue
        weight[q] = math.log(1 + total_units / len(found))
        # Точное слово — первым: оно и станет якорем сниппета, если есть в строке.
        for w in [v for v in variants if v == q] + [v for v in variants if v != q]:
            for i in postings[w]:
                hits_of[i].setdefault(q, w)

    need = 1 if len(tokens) == 1 else 2
    phrase = f" {' '.join(words(query))} "
    bonus = PHRASE_BONUS * sum(weight.values())
    scored: list[tuple[float, Unit, list[str], str]] = []
    for i, matched in hits_of.items():
        unit = units[i]
        if len(matched) < need or (kinds is not None and unit.kind not in kinds):
            continue
        score = sum(weight[q] for q in matched)
        if phrase in f" {' '.join(words(unit.text))} ":
            score += bonus
        ordered = sorted(matched, key=lambda q: (-weight[q], tokens.index(q)))
        scored.append((score, unit, ordered, matched[ordered[0]]))

    scored.sort(
        key=lambda s: (
            -s[0],
            KIND_ORDER[s[1].kind],
            paths.get(s[1].node_id, "") if s[1].node_id else "",
            s[1].title,
            s[1].line_no or 0,
        )
    )

    # Кап на группу (схема, спека): показываем три лучших строки, остальные
    # называем числом. Счёт группы — по всем прошедшим порог строкам.
    group_total: dict[tuple[str, uuid.UUID], int] = defaultdict(int)
    kept: list[tuple[float, Unit, list[str], str]] = []
    for item in scored:
        g = item[1].group
        if g is not None:
            group_total[g] += 1
            if group_total[g] > GROUP_CAP:
                continue
        kept.append(item)
    kept = kept[:limit]
    group_shown: dict[tuple[str, uuid.UUID], int] = defaultdict(int)
    for _, unit, _, _ in kept:
        if unit.group is not None:
            group_shown[unit.group] += 1

    hits = [
        SearchHit(
            kind=unit.kind,
            node_id=unit.node_id,
            node_path=paths.get(unit.node_id) if unit.node_id else None,
            title=unit.title,
            doc_id=unit.doc_id,
            process_id=unit.process_id,
            message_id=unit.message_id,
            line_no=unit.line_no,
            snippet=snippet(unit.text, anchor),
            score=round(score, 3),
            matched=matched,
            more_in_group=(
                group_total[unit.group] - group_shown[unit.group] if unit.group else 0
            ),
        )
        for score, unit, matched, anchor in kept
    ]
    return SearchResponse(query=query, tokens=tokens, total=len(scored), hits=hits)
