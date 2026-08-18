"""Экспорт процесса в Mermaid sequenceDiagram (Ф2 архива, решение Р2).

ПЕРЕНОС фронтового конвертера toMermaid.ts, а не его близнец: фронт свой
конвертер удаляет и зовёт ручку — реализация ровно одна, иначе они разошлись бы
(принцип проекта, тот же, что у directions и каталога шага). Гарантия переноса —
построчное совпадение с выдачей фронтового конвертера на живых процессах,
снятой ДО удаления (полевой прогон Ф2).

Устройство повторяет оригинал: участники нумеруются по порядку (P1, P2… — в
идентификаторах Mermaid лучше избегать дефисов UUID), сообщения и фрагменты
раскладываются по индексам строк (индекс = число сообщений с меньшим order).
Привязка шага к схеме логики едет строкой «%% archmap-doc: путь узла / имя»
ПЕРЕД шагом (Ф7 эпика «процессы → доки шага»): в строку шага её не вписать —
всё после первого двоеточия mermaid читает как подпись.
"""

import re
from dataclasses import dataclass

from app.schemas.process import MessageOut, ProcessDetail

# Чистка текста реплики/условия: Mermaid обрывает оператор на переводе строки и
# плохо реагирует на «;». Схлопываем пробелы/переводы строк, «;» → «,».
_WS = re.compile(r"\s+")


def _clean(text: str | None) -> str:
    if not text:
        return ""
    return _WS.sub(" ", text).replace(";", ",").strip()


# Стрелка Mermaid по виду сообщения: return — пунктир с возвратом, async —
# открытая стрелка «-)», forward/self — сплошная синхронная «->>».
def _arrow(kind: str) -> str:
    if kind == "return":
        return "-->>"
    if kind == "async":
        return "-)"
    return "->>"


def _indent(depth: int) -> str:
    return "    " * depth


@dataclass
class _Branch:
    row: int
    guard: str


@dataclass
class _Frag:
    kind: str
    from_row: int
    to_row: int
    guard: str
    branches: list[_Branch]


def detail_to_mermaid(detail: ProcessDetail) -> str:
    lines: list[str] = ["sequenceDiagram"]

    # Участники в порядке order → алиасы P1, P2…
    parts = sorted(detail.participants, key=lambda p: p.order)
    alias: dict[object, str] = {}  # id участника → Pn (не узла: у
    # непривязанного участника узла нет, а имя он несёт в себе)
    for i, p in enumerate(parts):
        pid = f"P{i + 1}"
        alias[p.id] = pid
        lines.append(f"{_indent(1)}participant {pid} as {_clean(p.name) or pid}")

    # Сообщения по order → строки 0..N-1.
    msgs: list[MessageOut] = sorted(detail.messages, key=lambda m: m.order)

    # Фрагменты: order → индекс строки (число сообщений с меньшим order).
    orders = [m.order for m in msgs]

    def row_of(order: int) -> int:
        return sum(1 for o in orders if o < order)

    frags = [
        _Frag(
            kind=f.kind,
            from_row=row_of(f.from_order),
            to_row=row_of(f.to_order),
            guard=_clean(f.guard),
            # Ветви [иначе] со второй и дальше: у alt их сколько угодно (mermaid
            # принимает цепочку else любой длины — проверено парсером 11.15.0).
            branches=[
                _Branch(row=row_of(b.start_order), guard=_clean(b.guard)) for b in f.branches
            ],
        )
        for f in detail.fragments
    ]

    # depth — текущая глубина вложенности (1 = верхний уровень тела диаграммы).
    depth = 1

    for i, m in enumerate(msgs):
        # 1) Ветви [else] для alt, начинающиеся на строке i, — на отступ родителя.
        for f in frags:
            if f.kind != "alt":
                continue
            for b in f.branches:
                if b.row == i:
                    guard = f" {b.guard}" if b.guard else ""
                    lines.append(f"{_indent(depth - 1)}else{guard}")

        # 2) Открываем фрагменты, начинающиеся на строке i (внешние/широкие — раньше).
        opening = sorted((f for f in frags if f.from_row == i), key=lambda f: -f.to_row)
        for f in opening:
            guard = f" {f.guard}" if f.guard else ""
            lines.append(f"{_indent(depth)}{f.kind}{guard}")
            depth += 1

        # 3) Само сообщение. Привязка к схеме логики — отдельной строкой перед
        #    шагом (Ф7): адрес «путь узла / имя схемы», импорт сверяет его целиком.
        frm = alias.get(m.from_participant_id)
        to = alias.get(m.to_participant_id)
        if frm and to:
            if m.doc_id and m.doc_node_path and m.doc_name:
                addr = _clean(f"{m.doc_node_path} / {m.doc_name}")
                lines.append(f"{_indent(depth)}%% archmap-doc: {addr}")
            lines.append(f"{_indent(depth)}{frm}{_arrow(m.kind)}{to}: {_clean(m.caption) or '—'}")

        # 4) Закрываем фрагменты, заканчивающиеся на строке i (внутренние/узкие — раньше).
        closing = sorted((f for f in frags if f.to_row == i), key=lambda f: -f.from_row)
        for _f in closing:
            depth -= 1
            lines.append(f"{_indent(depth)}end")

    return "\n".join(lines)
