"""Шапка .mmd-файла: метаданные схемы логики внутри самой диаграммы.

Пакет «Доки от агента» переезжает с YAML-манифеста на набор самодостаточных
.mmd-файлов (docs/plan-docs-mmd.md). Всё, что раньше несла запись манифеста —
имя схемы, вид, привязка к операции, адрес узла, — теперь едет ВНУТРИ файла
ведущими строками-комментариями::

    %% archmap-name: Приём заказа
    %% archmap-kind: operation
    %% archmap-operation: POST /orders
    graph TD
      A["Приём запроса"] --> B["Валидация корзины"]

Почему внутри, а не в имени файла: так метаданные едут вместе с содержимым, и
вставка текста из буфера работает наравне с перетаскиванием файла. Mermaid
строки на «%%» игнорирует, поэтому файл остаётся валидной диаграммой и
рендерится где угодно.

Все поля НЕОБЯЗАТЕЛЬНЫ: слабая модель шапку забудет, и это не должно ломать
импорт. Чем заменять пропуски (имя файла, вид «операция», узел окна) — решает
вызывающий, здесь только разбор.
"""

import re
from collections.abc import Iterator, Mapping
from dataclasses import dataclass, field

# Порядок полей в примере для промпта; он же — порядок вывода render_header.
KEYS = ("name", "kind", "operation", "node")
# Виды схем логики (NodeDoc.kind). Латиницей — как в остальном контракте агента.
KINDS = ("operation", "worker")

_PREFIX = "archmap-"


@dataclass
class MmdHeader:
    """Разобранная шапка. Ничего не подставляет: пропуск — это None."""

    name: str | None = None
    kind: str | None = None
    operation: str | None = None
    node: str | None = None
    # Строки «%% archmap-…», которые понять не удалось: опечатка в ключе, пустое
    # значение, неизвестный вид. Вызывающий показывает их пользователем — иначе
    # схема тихо приедет не с тем именем, и виноватой будет выглядеть ArchMap.
    problems: list[str] = field(default_factory=list)

    @property
    def is_empty(self) -> bool:
        """Шапки не было вовсе (не путать с шапкой, которую не разобрали)."""
        return not any((self.name, self.kind, self.operation, self.node)) and not self.problems


def _preamble(text: str) -> tuple[list[str], str | None]:
    """(комментарии до диаграммы без «%%», первая строка самой диаграммы).

    Читаем только начало файла: комментарий посреди диаграммы — часть схемы, а не
    её паспорт. Пустые строки и чужие комментарии пропускаем, но сканирование не
    прерываем: «%%{init: …}%%» — это ДИРЕКТИВА mermaid, она законно стоит перед
    диаграммой и не должна прятать шапку, идущую следом. Frontmatter mermaid
    («--- title: … ---») тоже пропускаем — он допустим в начале файла.
    """
    lines = text.lstrip("﻿").splitlines()
    i = 0
    if i < len(lines) and lines[i].strip() == "---":
        i += 1
        while i < len(lines) and lines[i].strip() != "---":
            i += 1
        i += 1
    comments: list[str] = []
    for line in lines[i:]:
        stripped = line.strip()
        if not stripped:
            continue
        if not stripped.startswith("%%"):
            return comments, stripped
        comments.append(stripped[2:].strip())
    return comments, None


def _leading_comments(text: str) -> Iterator[str]:
    """Комментарии ДО первой строки диаграммы, без ведущих «%%»."""
    return iter(_preamble(text)[0])


# Слова, с которых начинается диаграмма mermaid. Нужны, чтобы отличить схему
# логики от прочих файлов пакета (спека OpenAPI, манифест) КОГДА ИМЕНИ НЕТ или
# оно ни о чём не говорит — например, при вставке текста из буфера.
_DIAGRAMS = (
    "graph", "flowchart", "sequencediagram", "classdiagram", "statediagram",
    "erdiagram", "journey", "gantt", "pie", "mindmap", "timeline", "gitgraph",
    "quadrantchart", "sankey", "xychart", "block", "packet", "architecture",
    "c4context", "c4container", "c4component", "c4dynamic", "requirementdiagram",
)


def looks_like_mermaid(name: str, text: str) -> bool:
    """Это схема логики? Имя .mmd, наша шапка или узнаваемое начало диаграммы.

    Определять по СОДЕРЖИМОМУ обязательно: при вставке текста из буфера имени
    файла попросту нет (окно называет такую вставку само)."""
    if name.lower().endswith((".mmd", ".mermaid")):
        return True
    comments, first = _preamble(text)
    if any(c.lower().startswith(_PREFIX) for c in comments):
        return True
    if first is None:
        return False
    head = first.split(maxsplit=1)[0].rstrip(":").lower()
    return head in _DIAGRAMS


def parse_mmd_header(text: str) -> MmdHeader:
    """Разобрать ведущие «%% archmap-*» строки. Чистая функция, ошибок не кидает."""
    header = MmdHeader()
    for comment in _leading_comments(text):
        if not comment.lower().startswith(_PREFIX):
            continue  # чужой комментарий или директива — не наше дело
        body = comment[len(_PREFIX) :]
        key, sep, value = body.partition(":")
        key = key.strip().lower()
        # Значение режем по ПЕРВОМУ двоеточию: и в имени схемы («Крон: выставление
        # счетов»), и в операции («POST /orders») двоеточия законны.
        value = value.strip()
        if not sep or not value:
            header.problems.append(f"строка «%% {comment}» — не понял, что после «{key or '?'}»")
            continue
        if key not in KEYS:
            header.problems.append(f"неизвестное поле «{key}» в строке «%% {comment}»")
            continue
        if key == "kind" and value.lower() not in KINDS:
            header.problems.append(
                f"неизвестный вид схемы «{value}» — бывают: {', '.join(KINDS)}"
            )
            continue
        setattr(header, key, value.lower() if key == "kind" else value)
    return header


def render_header(fields: Mapping[str, str]) -> str:
    """Собрать шапку из полей (порядок KEYS). Используется примером для промпта."""
    return "".join(f"%% {_PREFIX}{k}: {fields[k]}\n" for k in KEYS if fields.get(k))


_HEADER_LINE = re.compile(r"^%%\s*archmap-", re.IGNORECASE)


def strip_header(text: str) -> str:
    """Текст схемы без ведущих строк «%% archmap-*» — для обратной выгрузки (архив).

    Тела при заливке сохраняются ВМЕСТЕ с шапкой (идемпотентность повторной
    заливки), а истина метаданных — БД: схему могли переименовать после импорта,
    и старая шапка в теле врёт. Экспорт снимает её и пишет свежую из записи.
    Чужие комментарии, директивы «%%{init: …}%%» и frontmatter не трогаем;
    «archmap-» посреди диаграммы — часть схемы, а не паспорт (как в _preamble)."""
    bom = "﻿" if text.startswith("﻿") else ""
    lines = text.lstrip("﻿").splitlines(keepends=True)
    out: list[str] = []
    i = 0
    # Frontmatter («--- … ---») пропускаем нетронутым, как _preamble.
    if i < len(lines) and lines[i].strip() == "---":
        out.append(lines[i])
        i += 1
        while i < len(lines) and lines[i].strip() != "---":
            out.append(lines[i])
            i += 1
        if i < len(lines):
            out.append(lines[i])
            i += 1
    body_started = False
    for ln in lines[i:]:
        if not body_started:
            s = ln.strip()
            if s == "" or s.startswith("%%"):
                if _HEADER_LINE.match(s):
                    continue
                out.append(ln)
                continue
            body_started = True
        out.append(ln)
    return bom + "".join(out)


# Ромб, открытый «{"» и закрытый «"]»: частая опечатка слабой модели, от которой
# mermaid не рендерит схему ЦЕЛИКОМ (5 из 8 синтаксических ошибок замеров
# docs-quality; правило развилок умножило ромбы — docs/plan-docs-quality.md,
# «Правка №3»). Намерение однозначно — ромб: открывающая скобка задаёт форму.
# Строго кавычечная форма: внутри кавычек нет ни скобок, ни переводов строки,
# поэтому валидный текст шаблон не задевает.
_BROKEN_DIAMOND = re.compile(r'(\b[\w-]+)\{("[^"\n]*")\]')


def fix_broken_diamonds(text: str) -> tuple[str, int]:
    """Починить ромбы «ID{"…"]» → «ID{"…"}». (текст, сколько починено)."""
    return _BROKEN_DIAMOND.subn(r"\1{\2}", text)


# ── Встроенный пример (данные, не текст) ─────────────────────────────────────
# Тот же приём, что держал пример манифеста в docs_prompt: пример хранится
# данными, дампается в текст и ПАРСИТСЯ ОБРАТНО тестом. Поэтому промпт физически
# не может разойтись с парсером — а разъезд здесь означал бы, что агент пишет
# шапку, которую мы молча не читаем.
_EXAMPLE_FIELDS = {
    "name": "Приём заказа",
    "kind": "operation",
    "operation": "POST /orders",
}
_EXAMPLE_BODY = (
    "graph TD\n"
    '  A["Приём запроса"] --> B["Валидация корзины"]\n'
    '  B --> C{"Товары в наличии?"}\n'
    '  C -- да --> D["Создать заказ<br>читает: accounts.balance<br>пишет: orders, order_items"]\n'
    '  C -- нет --> E["409: конфликт наличия"]\n'
    # Событие в брокер — вторая семья пометок (§3 plan-broker-docs.md). Стоит в том же
    # образце: агент, увидевший только «читает:/пишет:», помечает публикацию словом
    # «пишет:», и обращение уходит искать таблицу «orders.created».
    '  D --> F["Отправить событие<br>публикует: orders.created"]\n'
)


def example_mmd() -> str:
    """Образец файла для промпта: шапка + диаграмма."""
    return render_header(_EXAMPLE_FIELDS) + _EXAMPLE_BODY
