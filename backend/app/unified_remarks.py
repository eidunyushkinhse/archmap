"""Остаток единого импорта для человека: подписи входов, вопросы разбора остатка,
пункты свёртки «Придется подправить вручную» и строки отчёта применения. Вынесено из
app/unified_import.py (аудит Q-19): план строит unified_import, здесь — его прочтение."""

import re
from collections.abc import Callable
from dataclasses import dataclass, field

from app.import_yaml import ParsedImport
from app.schemas.unified_import import (
    ComponentOut,
    ContainerEdgeOut,
    FieldDisputeOut,
    FuzzyPairOut,
    IsolatedGroupOut,
    RemainderCandidateOut,
    RemainderOut,
    UnfixableOut,
)
from app.text import identity_name
from app.unified_import import UnifiedPlan

# ── Остаток слияния структурой (Ф-E, docs/plan-byoa-quality.md) ─────────────
#
# Мердж докладывает СТРОКАМИ всё, чего не решил сам, и до Ф-E пользователь правил
# это руками уже на холсте. Теперь тот же остаток приезжает в превью структурой:
# фронт задаёт по нему вопросы, ответы уезжают применению (decisions). Строки
# остаются нетронутыми (Р1): их читает MCP, и на них стоит инвариант корзин.


# Подпись входа без имени файла: роутер зовёт так вход, пришедший без filename
# (вставленный текстом YAML фронт отправляет с пустым именем).
def _nameless(label: str, origin: int) -> bool:
    return not label.strip() or label == f"вход {origin + 1}"


def source_label(plan: UnifiedPlan, origin: int, current: int | None = None) -> str:
    """ИСТОЧНИК ЗНАНИЯ словами (§4.7 ТЗ Ф-E, правка Ф2г): «Из архива plugin-a.zip»,
    «Из файла shop.yaml», «Из файла 2», «Из проекта».

    Панель ввоза НЕ ЗНАЕТ, откуда пользователь взял файл: это может быть сессия
    агента, давно закрытая, или перенос между проектами. Поэтому ни «агента», ни
    имени корня (раньше им звали «агента файла») в подписи нет — только то, что
    пользователь сам положил в панель: имя архива или файла. У входа без имени
    (YAML, вставленный текстом) — номер его чипа."""
    if current is not None and origin == current:
        return "Из проекта"
    label = plan.labels[origin] if origin < len(plan.labels) else ""
    kind = plan.kinds[origin] if origin < len(plan.kinds) else "yaml"
    слово = "Из архива" if kind == "archive" else "Из файла"
    return f"{слово} {origin + 1}" if _nameless(label, origin) else f"{слово} {label}"


# Класс замечания узнаётся по устойчивой подстроке текста. Порядок значим: сначала
# самые узкие формулировки (тексты соседних классов делят общие слова).
_REMARK_CLASSES: tuple[tuple[str, str], ...] = (
    ("слиты в ОДИН объект", "absorbed"),
    ("указывают один источник", "shared_source"),
    ("встречается в файлах как РАЗНЫЕ объекты", "namesakes"),
    ("разные подписи из разных файлов", "edge_labels"),
    ("не имеют общих корневых узлов", "roots"),
    ("внутри системы оказались люди", "actors"),
    ("объектов без единой связи", "lonely"),
    ("иерархия уже выражает вложенность", "descendant"),
    ("в channel перечень", "channel_list"),
    ("канал не указан", "broker"),
)
# Хвосты-счётчики («…ещё N таких …») своего пункта не образуют: они приклеиваются
# к последнему замечанию СВОЕГО класса. Порядок значим по той же причине —
# «таких связей» есть подстрока «таких связей с брокером».
_REMARK_TAILS: tuple[tuple[str, str], ...] = (
    ("таких склеек по общему источнику", "absorbed"),
    ("таких источников", "shared_source"),
    ("таких связей с собственным потомком", "descendant"),
    ("таких связей с брокером", "broker"),
    ("таких связей с перечнем в channel", "channel_list"),
    ("таких групп", "isolated"),
    ("таких связей", "container"),
)

# ── Пункты свёртки «Придется подправить вручную» (Ф2г, тексты финальные) ─────
#
# Сырые строки мерджа адресованы агенту («задайте source.path», «выдайте файл
# заново»), а панель ввоза не знает, был ли агент вообще. Поэтому пункт свёртки —
# тот же факт другими словами: ЧТО не так и что с этим придётся сделать руками.
# Объекты берутся из сырой строки её же разметкой (маркеры классов выше не
# меняются); не разобралась строка — пункт сырой строкой как есть: правда общими
# словами лучше молчания. Сами строки мерджа НЕ меняются: их читают MCP и отчёты.


def _objects_word(n: int) -> str:
    """«У 1 объекта» / «У 5 объектов»: родительный падеж после «У»."""
    return "объекта" if n % 10 == 1 and n % 100 != 11 else "объектов"


_FRIENDLY: dict[str, tuple[re.Pattern[str], Callable[[re.Match[str]], str]]] = {
    "namesakes": (
        re.compile(r"^(?P<head>.+?) встречается в файлах как РАЗНЫЕ объекты"),
        lambda m: f"{m['head']} в разных файлах имеет разные метаданные. ArchMap не "
        "знает, это один и тот же объект или нет. Если это дубль, его нужно будет "
        "удалить вручную.",
    ),
    "absorbed": (
        re.compile(r"^(?P<names>.+?) слиты в ОДИН объект"),
        lambda m: f"{m['names']} указывают на один и тот же источник, поэтому ArchMap "
        "объединил их в один объект. Если это разные объекты, их нужно будет "
        "разделить вручную.",
    ),
    "shared_source": (
        re.compile(r"^(?P<names>.+?) указывают один источник"),
        lambda m: f"{m['names']} указывают на один и тот же источник. При следующем "
        "обновлении из кода ArchMap узнает только один из них, а второй станет "
        "дублем. Чтобы этого не случилось, поправьте якорь в карточке одного из "
        "объектов.",
    ),
    "edge_labels": (
        re.compile(
            r"^связи (?P<a>.+?) → (?P<b>.+?): разные подписи из разных файлов "
            r"\((?P<labels>.*)\) — "
        ),
        lambda m: f"У связи «{m['a']} → {m['b']}» в разных файлах разные подписи "
        f"({m['labels']}). Если это одна и та же связь, лишнюю нужно будет удалить "
        "вручную.",
    ),
    "roots": (
        re.compile(r"не имеют общих корневых узлов \((?P<names>.*)\) — "),
        lambda m: f"У файлов разные корневые объекты ({m['names']}), поэтому в проекте "
        "будет несколько корней. Если это одна система, их содержимое нужно будет "
        "перенести в один корень вручную.",
    ),
    "actors": (
        re.compile(r"внутри системы оказались люди \((?P<names>.*)\) — по C4"),
        lambda m: f"Внутри системы оказались люди ({m['names']}). Человек пользуется "
        "системой, а не входит в неё, поэтому их нужно будет перенести в корень схемы "
        "вручную.",
    ),
    "lonely": (
        re.compile(r"^объектов без единой связи: (?P<n>\d+) \((?P<names>.*)\) — "),
        lambda m: f"У {m['n']} {_objects_word(int(m['n']))} ({m['names']}) нет ни одной "
        "связи. Проверьте, не потерялись ли связи, и при необходимости проведите их "
        "вручную.",
    ),
    "descendant": (
        re.compile(r"^связь «(?P<edge>.+?)»: «.*иерархия уже выражает вложенность"),
        lambda m: f"Связь «{m['edge']}» ведёт от объекта к его собственной части. Её "
        "нужно будет удалить или перевесить вручную.",
    ),
    "channel_list": (
        re.compile(r"^связь «(?P<edge>.+?)»: в channel перечень «(?P<list>.*)» — "),
        lambda m: f"У связи «{m['edge']}» указано сразу несколько каналов "
        f"(«{m['list']}»). Её нужно будет разделить на отдельные связи вручную.",
    ),
    "broker": (
        re.compile(r"^связь «(?P<edge>.+?)»: конец — брокер «(?P<broker>.+?)», а канал не указан"),
        lambda m: f"У связи «{m['edge']}» с брокером «{m['broker']}» не указан канал. "
        "Его нужно будет вписать в карточке связи вручную.",
    ),
}
_TAIL_RE = re.compile(r"^…ещё (?P<n>\d+) таких")


_PROCESS_MANY = re.compile(r"^процесс «(?P<name>.+?)» есть в нескольких входах \((?P<labels>.+?)\) — ")
# Строка ПРИМЕНЕНИЯ (создание и догрузка): тёзка уже приехал, имя известно точно.
_PROCESS_RENAMED = re.compile(
    r"^процесс «(?P<name>.+?)» из входа «(?P<label>.+?)» приехал под именем «(?P<new>.+)»: "
    r"процессы не сливаются"
)
_PROCESS_LIVE = re.compile(r"^процесс «(?P<name>.+?)» из входа «(?P<label>.+?)» — тёзка уже имеющегося")
_LIVE_NAMESAKES = re.compile(r"^узлы-тёзки «(?P<path>.+?)» слились в один")


def friendly_process_note(text: str) -> str:
    """Пункт свёртки из замечаний о тёзках процессов (создание и догрузка) и о
    тёзках среди живых узлов (догрузка). Незнакомая строка — как есть."""
    if (m := _PROCESS_MANY.search(text)) is not None:
        return (
            f"Процесс «{m['name']}» есть в нескольких файлах ({m['labels']}). Процессы не "
            f"объединяются, поэтому второй приедет под именем «{m['name']} (2)». Если это "
            "один и тот же процесс, лишний нужно будет удалить вручную."
        )
    if (m := _PROCESS_LIVE.search(text)) is not None:
        return (
            f"Процесс «{m['name']}» из «{m['label']}» совпадает по имени с уже имеющимся в "
            f"проекте и приедет под именем «{m['name']} (2)». Если это один и тот же "
            "процесс, лишний нужно будет удалить вручную."
        )
    if (m := _LIVE_NAMESAKES.search(text)) is not None:
        return (
            f"В проекте несколько объектов «{m['path']}», и знание из архива приедет "
            "только к первому из них. Остальные останутся как были."
        )
    if (m := _PROCESS_RENAMED.search(text)) is not None:
        return (
            f"Процесс «{m['name']}» из «{m['label']}» совпал по имени с другим процессом и "
            f"приехал под именем «{m['new']}». Если это один и тот же процесс, лишний нужно "
            "будет удалить вручную."
        )
    return text


# ── Строки отчёта ПРИМЕНЕНИЯ (правка Ф2г-2) ──────────────────────────────────
#
# Отчёт применения («Проект создан» / «Архивы догружены») показывает не сырой
# список warnings (его читает MCP), а ту же свёртку «Придется подправить вручную».
# Строка применения — одно из двух:
#   (а) ИНФОРМАЦИЯ о сделанном, уже видном по счётчикам или по выбору человека
#       («пустовало — залито», «заменено по вашему решению», «Ваши решения: …»,
#       легенда нумерации файлов) — в свёртку не едет;
#   (б) ТРЕБУЕТ ВНИМАНИЯ (в архиве другое значение, а живое оставлено; параметр не
#       догружен; части записи не слились; процесс приехал с суффиксом) — пункт
#       свёртки дружелюбным текстом. Незнакомая строка — сырой как есть.

_APPLY_INFO: tuple[re.Pattern[str], ...] = (
    re.compile(r"^узел «.+?»: поле «[^»]+» пустовало — залито из "),
    re.compile(r"^узел «.+?»: поле «[^»]+» заменено по вашему решению"),
    re.compile(r"^нумерация файлов в замечаниях слияния: "),
    re.compile(r"^Ваши решения: "),
)
_FIELD_KEPT = re.compile(
    r"^узел «(?P<path>.+?)»: поле «(?P<field>[^»]+)» в архиве другое \(«(?P<new>.*)»\) — "
    r"оставлено живое \(«(?P<cur>.*)»\)$"
)
_PARAM_GONE = re.compile(r"^параметр «(?P<name>.+?)»: живой записи уже нет — пропущен")
_EXTRA_PARTS = re.compile(
    r"^(?P<kind>таблица|канал) «(?P<key>.+?)» узла «(?P<path>.+?)»: (?P<part>колонок|полей) "
    r"(?P<names>.+) в архиве нет — оставлены"
)
# Форма и статус едут в строку кодами контракта — человеку их называем словами.
# Зеркало SHAPE_LABEL (questionText.ts) и STATUS_META (graph/colors.ts) фронта.
_CODE_RU: dict[str, dict[str, str]] = {
    "форма": {"service": "Сервис", "database": "База данных", "broker": "Брокер",
              "person": "Пользователь"},
    "статус": {"existing": "Существует", "planned": "Проектируется", "deprecated": "Выводится"},
}


def _human(field_ru: str, value: str) -> str:
    return _CODE_RU.get(field_ru, {}).get(value, value)


def _extra_parts_text(m: re.Match[str]) -> str:
    """«Остались колонки …» с согласованием по числу: одна часть — «осталась
    колонка … которой», несколько — «остались колонки … которых»."""
    one = m["names"].count("«") == 1
    where = (f"В таблице «{m['key']}»" if m["kind"] == "таблица" else f"В канале «{m['key']}»")
    if m["part"] == "колонок":
        what = "осталась колонка" if one else "остались колонки"
        rel, it = ("которой", "она больше не нужна, её") if one else ("которых", "они больше не нужны, их")
    else:
        what = "осталось поле" if one else "остались поля"
        rel, it = ("которого", "оно больше не нужно, его") if one else ("которых", "они больше не нужны, их")
    return (
        f"{where} объекта «{m['path']}» {what} {m['names']}, {rel} нет в архиве: догрузка "
        f"ничего не удаляет. Если {it} нужно будет удалить вручную."
    )


def friendly_apply_note(text: str) -> str | None:
    """Строка отчёта применения → пункт свёртки; None — информация (не показывать).

    Строки процессов и живых тёзок разбирает friendly_process_note; незнакомая
    строка — как есть (правда общими словами лучше молчания)."""
    if any(p.search(text) for p in _APPLY_INFO):
        return None
    if (m := _FIELD_KEPT.search(text)) is not None:
        return (
            f"У объекта «{m['path']}» в архиве другое значение поля «{m['field']}» "
            f"(«{_human(m['field'], m['new'])}»), а в проекте осталось прежнее "
            f"(«{_human(m['field'], m['cur'])}»). Если верно значение из архива, поле нужно "
            "будет поправить в карточке объекта вручную."
        )
    if (m := _PARAM_GONE.search(text)) is not None:
        return (
            f"Параметр «{m['name']}» не догружен: в проекте его уже нет. Если он нужен, его "
            "нужно будет добавить вручную."
        )
    if (m := _EXTRA_PARTS.search(text)) is not None:
        return _extra_parts_text(m)
    return friendly_process_note(text)


def apply_unfixable(lines: list[str]) -> list[UnfixableOut]:
    """Строки, добавленные ПРИМЕНЕНИЕМ, — пунктами свёртки отчёта (без информации)."""
    return [
        UnfixableOut(id=f"apply|{j}", text=t)
        for j, raw in enumerate(lines)
        if (t := friendly_apply_note(raw)) is not None
    ]


def friendly_remark(text: str) -> str:
    """Пункт свёртки из сырой строки замечания (не хвоста); незнакомый класс или
    неразобранная строка — сама строка как есть."""
    cls, _tail = _remark_class(text)
    rule = _FRIENDLY.get(cls)
    m = rule[0].search(text) if rule is not None else None
    return rule[1](m) if rule is not None and m is not None else text


def _tail_sentence(text: str) -> str:
    """Хвост-счётчик «…ещё N таких …» — отдельным предложением к своему пункту."""
    m = _TAIL_RE.search(text)
    return f"И ещё {m['n']} таких же." if m is not None else text


def _remark_class(text: str) -> tuple[str, bool]:
    """(класс замечания, хвост ли это). Пустой класс — незнакомое замечание."""
    if text.startswith("…ещё"):
        for marker, cls in _REMARK_TAILS:
            if marker in text:
                return cls, True
        return "", True
    for marker, cls in _REMARK_CLASSES:
        if marker in text:
            return cls, False
    return "", False


class _Tree:
    """Слитое дерево под вопросы: потомки контейнера, признак «контейнер», связи узла."""

    def __init__(self, plan: UnifiedPlan) -> None:
        merged = plan.merged
        nodes = merged.nodes if merged else []
        self.paths = plan.node_paths
        self.parent = [n.parent_idx for n in nodes]
        self.has_children = [False] * len(nodes)
        for pi in self.parent:
            if pi is not None:
                self.has_children[pi] = True
        self.edges = [0] * len(nodes)
        for e in merged.edges if merged else []:
            self.edges[e.source_idx] += 1
            if e.target_idx != e.source_idx:
                self.edges[e.target_idx] += 1

    def descends(self, child: int, ancestor: int) -> bool:
        pi = self.parent[child]
        while pi is not None:
            if pi == ancestor:
                return True
            pi = self.parent[pi]
        return False

    def components(self, container: int) -> list[int]:
        """ВСЁ поддерево контейнера в порядке обхода дерева (индексы слитого
        дерева идут «родители раньше детей»), без капа: кап — дело фронта."""
        return [i for i in range(len(self.paths)) if self.descends(i, container)]

    def where(self, parent: int | None) -> str:
        return f"внутри «{self.paths[parent]}»" if parent is not None else "на верхнем уровне"


@dataclass
class RemainderIndex:
    """АДРЕСА элементов остатка в слитом дереве: id вопроса → индексы, которыми
    применение правит дерево.

    Строится ТЕМ ЖЕ проходом, что и RemainderOut (remainder_with_index): разойдись
    они — и ответ пользователя применился бы не к тому, о чём его спросили."""

    fields: dict[str, tuple[int, str, list[str]]] = field(default_factory=dict)
    # id → (индекс связи, конец, «путь компонента → его индекс»)
    edges: dict[str, tuple[int, str, dict[str, int]]] = field(default_factory=dict)
    groups: dict[str, list[int]] = field(default_factory=dict)
    pairs: dict[str, tuple[int, int]] = field(default_factory=dict)
    # Путь узла → индекс: концы новой связи пользователь называет путями. Тёзки
    # (якорь разводит их законно) адресуются первым — как и везде в превью.
    nodes: dict[str, int] = field(default_factory=dict)


def remainder_from_plan(plan: UnifiedPlan, current: int | None = None) -> RemainderOut:
    """Остаток слияния структурой (без адресов — они нужны только применению)."""
    return remainder_with_index(plan, current)[0]


def remainder_with_index(
    plan: UnifiedPlan, current: int | None = None
) -> tuple[RemainderOut, RemainderIndex]:
    """Остаток слияния структурой и его адреса. current — индекс входа ЖИВОГО
    проекта (0 у догрузки, None при создании).

    Р3 догрузки: элемент, в котором не участвует ничего нового, в остаток НЕ
    попадает — это дело панели незавершённости, а не догрузки. Догрузка отвечает
    за то, что привезли архивы."""
    if not plan.ok or plan.merged is None:
        return RemainderOut(), RemainderIndex()
    b = _RemainderBuilder(plan, plan.merged, current)
    fields = b.field_conflicts()
    container = b.container_edges()
    groups = b.isolated_groups()
    pairs = b.fuzzy_pairs()
    return RemainderOut(
        field_conflicts=fields,
        container_edges=container,
        isolated_groups=groups,
        fuzzy_pairs=pairs,
        unfixable=_unfixable(plan, b.converted, current),
        converted_warnings=_converted_texts(plan.report.warnings, b.converted),
        node_paths=list(b.paths),
        node_has_children=list(b.tree.has_children),
    ), b.index


class _RemainderBuilder:
    """Сборщик остатка: общие адреса, дедуп id и строки отчёта, ставшие вопросами,
    на все четыре вида вопросов. Порядок вызова видов — порядок вопросов в окне."""

    def __init__(self, plan: UnifiedPlan, merged: ParsedImport, current: int | None) -> None:
        self.plan = plan
        self.current = current
        self.merged = merged
        self.report = plan.report
        self.tree = _Tree(plan)
        self.paths = plan.node_paths
        # id вопроса — по адресу узла: у тёзок путь один на двоих, и вопрос второго
        # тёзки иначе терялся бы как «столкнувшийся». Человеку — голый путь (paths).
        self.addr = plan.node_addresses or self.paths
        self.index = RemainderIndex()
        for i, p in enumerate(self.paths):
            self.index.nodes.setdefault(p, i)
        self.seen: set[str] = set()
        # Строки отчёта, ставшие вопросами: в свёртку они больше не попадают.
        self.converted: set[int] = set()

    def свой(self, node_idx: int) -> bool:
        """Узел УЖЕ ЕСТЬ в живом проекте (догрузка). Именно «есть», а не «пришёл
        только оттуда»: архив, повторяющий живой узел, нового объекта не привозит,
        и остаток вокруг таких узлов — дело панели незавершённости, а не догрузки
        (иначе свой же архив, догруженный к себе, задал бы вопросы обо всём)."""
        return self.current is not None and self.current in self.report.node_files[node_idx]

    def кандидат(self, origin: int, value: str) -> RemainderCandidateOut:
        plan = self.plan
        return RemainderCandidateOut(
            origin=origin,
            origin_label=plan.labels[origin] if origin < len(plan.labels) else "",
            source_label=source_label(plan, origin, self.current),
            value=value,
            current=origin == self.current,
        )

    def свежий(self, eid: str) -> bool:
        """Id адресует ОДИН элемент: столкнувшиеся вопросом не становятся —
        применить ответ было бы некуда. Тёзки не сталкиваются: их id строится по
        адресу с уточнителем (node_addresses)."""
        if eid in self.seen:
            return False
        self.seen.add(eid)
        return True

    def field_conflicts(self) -> list[FieldDisputeOut]:
        """Споры полей: вопрос только там, где вклады равно содержательны (П2)."""
        out: list[FieldDisputeOut] = []
        for d in self.report.field_disputes:
            if all(fi == self.current for fi, _v in d.contributions):
                continue  # Р3 (по построению недостижимо: спор — это всегда два входа)
            eid = f"field|{self.addr[d.node_idx]}|{d.field}"
            if not self.свежий(eid):
                continue
            cands = [self.кандидат(fi, v) for fi, v in d.contributions]
            # Дефолт — то, что применится без ответа: живой кандидат у догрузки
            # («оставить моё»), первый по порядку файлов при создании.
            default = next((i for i, c in enumerate(cands) if c.current), 0)
            out.append(FieldDisputeOut(
                id=eid,
                node_path=self.paths[d.node_idx],
                field=d.field,
                candidates=cands,
                default=default,
            ))
            self.index.fields[eid] = (d.node_idx, d.field, [c.value for c in cands])
        return out

    def container_edges(self) -> list[ContainerEdgeOut]:
        """Связи в контейнер. В догрузке — только НОВЫЕ связи: перевесить живую
        значило бы тронуть то, о чём не спрашивали (Р3)."""
        out: list[ContainerEdgeOut] = []
        paths, addr = self.paths, self.addr
        for rec in self.report.container_edges:
            if self.current is not None and self.current in self.report.edge_files[rec.edge_idx]:
                continue
            e = self.merged.edges[rec.edge_idx]
            eid = (
                f"edge|{addr[e.source_idx]}|{addr[e.target_idx]}|{e.label or ''}|{rec.end}"
            )
            if not self.свежий(eid):
                continue
            comps = self.tree.components(rec.container_idx)
            out.append(ContainerEdgeOut(
                id=eid,
                from_path=paths[e.source_idx],
                to_path=paths[e.target_idx],
                label=e.label,
                technology=e.technology,
                end=rec.end,
                container_path=paths[rec.container_idx],
                components=[
                    ComponentOut(path=paths[i], has_children=self.tree.has_children[i])
                    for i in comps
                ],
            ))
            self.index.edges[eid] = (rec.edge_idx, rec.end, {paths[i]: i for i in comps})
            if rec.warning_idx is not None:
                self.converted.add(rec.warning_idx)
        return out

    def isolated_groups(self) -> list[IsolatedGroupOut]:
        out: list[IsolatedGroupOut] = []
        for g in self.report.isolated_groups:
            if all(self.свой(i) for i in g.node_idxs):
                continue  # Р3: группа целиком живая — не дело догрузки
            eid = f"group|{self.addr[g.node_idxs[0]]}"
            if not self.свежий(eid):
                continue
            out.append(IsolatedGroupOut(id=eid, node_paths=[self.paths[i] for i in g.node_idxs]))
            self.index.groups[eid] = list(g.node_idxs)
            if g.warning_idx is not None:
                self.converted.add(g.warning_idx)
        return out

    def fuzzy_pairs(self) -> list[FuzzyPairOut]:
        """Похожие имена. Пара заведомо из РАЗНЫХ входов (мердж не сравнивает узлы
        одного файла), поэтому «обе стороны живые» тут невозможно."""
        out: list[FuzzyPairOut] = []
        plan, report, tree = self.plan, self.report, self.tree
        for f in report.fuzzy_pairs:
            if self.свой(f.a_idx) and self.свой(f.b_idx):
                continue
            eid = f"pair|{self.addr[f.a_idx]}|{self.addr[f.b_idx]}"
            if not self.свежий(eid):
                continue
            out.append(FuzzyPairOut(
                id=eid,
                a_path=self.paths[f.a_idx],
                b_path=self.paths[f.b_idx],
                a_source=source_label(plan, min(report.node_files[f.a_idx]), self.current),
                b_source=source_label(plan, min(report.node_files[f.b_idx]), self.current),
                a_edges=tree.edges[f.a_idx],
                b_edges=tree.edges[f.b_idx],
                where=tree.where(f.parent_idx),
                a_current=self.свой(f.a_idx),
                b_current=self.свой(f.b_idx),
            ))
            self.index.pairs[eid] = (f.a_idx, f.b_idx)
            if f.warning_idx is not None:
                self.converted.add(f.warning_idx)
        return out


def _converted_texts(warnings: list[str], converted: set[int]) -> list[str]:
    """Тексты строк, ставших вопросами, — в порядке строк и без повторов.

    Текстом, а не индексом: строка живёт в трёх местах отчёта (общий список,
    схемная корзина, корзина своего файла) с разной нумерацией, а текст там один и
    тот же. Повторы гасим: два класса могут сойтись в одной формулировке, а фронту
    нужен набор «что прятать»."""
    out: list[str] = []
    seen: set[str] = set()
    for i in sorted(converted):
        text = warnings[i]
        if text not in seen:
            seen.add(text)
            out.append(text)
    return out


# Сырая строка мерджа о законных тёзках («оставлены раздельно»): имя и родитель.
# Родитель — путь слитого дерева, «на верхнем уровне» — без родителя.
_NAMESAKES = re.compile(
    r"^«(?P<name>.+?)» \((?:внутри «(?P<parent>.+)»|на верхнем уровне)\) "
    r"встречается в файлах как РАЗНЫЕ объекты"
)


def _live_namesakes(plan: UnifiedPlan, text: str, current: int) -> bool:
    """Замечание о тёзках, которые ВСЕ уже живут в проекте (догрузка): Р3 — элемент
    без участия нового в остаток не попадает.

    Строку мердж пишет без владельца (это «отношение файлов»), поэтому общий фильтр
    по владельцу её не гасит, а догрузка своего архива давала бы пункт «разные
    метаданные» о живой паре законных тёзок — той самой, что уже стоит в проекте.
    Узлов строка не несёт — группа восстанавливается по имени и родителю тем же
    сравнением, каким мердж их сопоставлял. Хоть один тёзка новый (архив привёз
    третьего) или строка не разобралась — пункт остаётся: вопрос «дубль ли это»
    тогда законен."""
    m = _NAMESAKES.search(text)
    merged = plan.merged
    if m is None or merged is None:
        return False
    name, parent, paths = identity_name(m["name"]), m["parent"], plan.node_paths
    group = [
        i
        for i, n in enumerate(merged.nodes)
        if identity_name(n.name) == name
        and (paths[n.parent_idx] if n.parent_idx is not None else None) == parent
    ]
    return bool(group) and all(current in plan.report.node_files[i] for i in group)


def _unfixable(
    plan: UnifiedPlan, converted: set[int], current: int | None = None
) -> list[UnfixableOut]:
    """Свёртка «Придется подправить вручную» (§6 ТЗ, правка Ф2г): ВСЕ замечания
    принятых входов, не ставшие вопросами, — пунктом на замечание.

    Входят и схемные строки (без владельца), и пофайловые: карточки «Замечания к
    файлу N» в панели больше нет, и знать об этом пользователь может только отсюда.
    Туда же — замечания семей архивов (промах адреса, внутриархивный дубль): они
    живут не в строках мерджа, а в input_remarks, и адресованы своему архиву.
    Конфликты полей сюда не едут: расхождение, решённое правилом мерджа, — это
    чтение, а не действие.

    current — вход ЖИВОГО проекта у догрузки: его собственные замечания (одинокие
    объекты, люди внутри системы…) — дело панели незавершённости, а не догрузки (Р3).
    Хвост-счётчик «…ещё N таких …» своего пункта не образует: он приклеен
    предложением к последнему пункту своего класса."""
    report = plan.report
    out: list[UnfixableOut] = []
    last: dict[str, UnfixableOut] = {}
    for i, (text, owner) in enumerate(
        zip(report.warnings, report.warning_files, strict=True)
    ):
        if i in converted or (current is not None and owner == current):
            continue
        cls, tail = _remark_class(text)
        if cls == "namesakes" and current is not None and _live_namesakes(plan, text, current):
            continue
        if tail:
            # Хвост о тех же объектах, что строки перед ним. Класс весь ушёл в
            # вопросы — хвост уходит с ним.
            цель = last.get(cls) or (out[-1] if cls == "" and out else None)
            if цель is not None:
                цель.text = f"{цель.text} {_tail_sentence(text)}"
            continue
        item = UnfixableOut(id=f"remark|{i}", text=friendly_remark(text), file=owner)
        out.append(item)
        last[cls] = item
    # Верхнеуровневые замечания плана (тёзки процессов разных входов) адресовать
    # входу нельзя, и раньше при создании они не показывались нигде. В догрузке
    # тёзок считает она сама (unified_into._process_notes: знает копии живых) —
    # там этот пункт не нужен.
    if current is None:
        out.extend(
            UnfixableOut(id=f"plan|{j}", text=friendly_process_note(w))
            for j, w in enumerate(plan.warnings)
        )
    for k, remarks in enumerate(plan.input_remarks):
        if k == current:
            continue
        # Путь файла внутри архива без имени архива неоднозначен (у двух архивов
        # бывают одинаковые docs/…), поэтому пункт начинается с имени входа.
        label = plan.labels[k] if k < len(plan.labels) else f"вход {k + 1}"
        out.extend(
            UnfixableOut(id=f"input|{k}|{j}", text=f"{label}: {r}", file=k)
            for j, r in enumerate(remarks)
            # Р3: дубль, равный записи живого проекта, знания не теряет.
            if current is None or current not in plan.dup_echoes.get((k, j), ())
        )
    return out
