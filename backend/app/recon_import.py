"""Приём ПЕРЕЧНЯ точек входа от разведчика (Ф1 docs/plan-recon.md).

Разведка возвращает не документацию, а оглавление: ОДИН YAML-файл со списком
операций и фоновых процессов одного объекта (промпт — app/recon_prompt.py).
Применение делает из каждой строки ЗАГЛУШКУ — схему логики с пустым телом, то есть
модель хранения не меняется (§5 плана), меняется только транспорт.

Здесь — разбор файла и превращение его строк в заглушки. Сопоставление с живыми
схемами узла и запись — ниже по модулю (план и применение).

Разбор намеренно ТОЛЕРАНТНЫЙ (Р7): файл приезжает через пользователя, бывает обёрнут
в markdown-ограждение, а невалидный YAML рождается тут не из ничего — его делает имя
объекта с двоеточием в строке `node:`, при том что остальные двести строк целы.
Терять их из-за одной кривой нельзя, поэтому за yaml.safe_load стоит построчный
фолбэк.
"""

import re
import uuid
from dataclasses import dataclass, field
from typing import cast

import yaml
from sqlalchemy.orm import Session

from app.docs_import import _node_paths, spec_check
from app.import_yaml import _FENCE_RE, _closest_node
from app.models.node import Node
from app.models.node_doc import NodeDoc
from app.schemas.node_doc import NodeDocKind
from app.schemas.recon import ReconImportReport, ReconItem

# «Файл ПОХОЖ на перечень» — по разделам верхнего уровня (Р8). Строка-корень
# «# archmap-recon» для YAML комментарий, разбору не мешает и обязательной НЕ
# является: агент её потеряет — перечень от этого не перестанет быть перечнем.
LOOKS_LIKE_RECON = re.compile(r"^(operations|workers)[ \t]*:", re.MULTILINE)

# Потолок строк перечня. Ориентир — Zulip: 201 операция + 11 очередей = 212 строк
# (docs/qa-recon-completeness.md), запас впятеро. Больше — почти наверняка не перечень
# одного объекта, а склеенные несколько или зациклившийся вывод модели.
MAX_RECON_LINES = 1000
# Имя схемы и её operation в БД — String(256) (models/node_doc.py). Строку длиннее НЕ
# создаём и НЕ обрезаем: обрезанный адрес не сойдётся с операцией никогда.
MAX_ENTRY_LEN = 256
# Капы однотипных замечаний: список уезжает агенту целиком, и один класс не должен
# вытеснить остальные (приём семьи — data_import/docs_import).
MAX_LONG_WARNINGS = 8
MAX_DOUBT_WARNINGS = 8
# Сколько адресов называем в ответе «объект не найден». Слабая модель адрес ВЫДУМЫВАЕТ,
# и перечень допустимых экономит раунд переписки (урок дозаливки данных); но у крупного
# проекта узлов десятки, и весь список вытеснил бы остальные замечания.
MAX_NODE_HINTS = 12

# Разделы построчного разбора. `sources` в перечень заглушек не входит (это сверка
# самого агента), но знать о нём надо: иначе его строки уехали бы в предыдущий раздел.
_SECTION_RE = re.compile(r"^(node|operations|workers|sources|doubts)[ \t]*:[ \t]*(.*)$")
_ITEM_RE = re.compile(r"^[ \t]*-[ \t]*(.*)$")
# Хвостовой комментарий в построчном режиме — по правилу самого YAML: решётка
# считается комментарием, только если отделена пробелом.
_COMMENT_TAIL = re.compile(r"[ \t]+#.*$")


@dataclass
class ParsedRecon:
    """Разобранный перечень: адрес объекта и строки разделов в порядке файла."""

    node_ref: str | None = None
    operations: list[str] = field(default_factory=list)
    workers: list[str] = field(default_factory=list)
    # Сомнения разведчика («похоже на точку входа, но не уверен»). Заглушками не
    # становятся, но и молчать о них нельзя: агент написал их именно человеку.
    doubts: list[str] = field(default_factory=list)
    # Разбор ушёл в построчный фолбэк — YAML не читается (Р7). Факт нужен превью:
    # спасённый файл стоит просмотреть глазами перед применением.
    salvaged: bool = False


@dataclass
class ReconStub:
    """Строка перечня, ставшая заглушкой: имя схемы, её вид и адрес операции."""

    name: str
    kind: NodeDocKind
    operation: str | None


def _candidates(content: str) -> list[str]:
    """Текст файла и содержимое markdown-ограждения ```yaml … ``` (Р7).

    Ограждение — не экзотика: пользователь приносит ответ агента как есть, и это уже
    ловил импорт схемы. Регулярка взята оттуда (app/import_yaml.py), второй своей не
    заводим.
    """
    out = [content]
    m = _FENCE_RE.search(content)
    if m is not None:
        out.append(m.group(1))
    return out


def _load(text: str) -> object:
    try:
        return yaml.safe_load(text)
    except yaml.YAMLError:
        return None


def _as_ref(raw: object) -> str | None:
    if raw is None:
        return None
    ref = str(raw).strip()
    return ref or None


def _as_lines(raw: object) -> list[str]:
    """Раздел перечня → строки в порядке файла.

    Элемент-словарь — не мусор, а съеденное YAML двоеточие: «GET /x: latest» приезжает
    как {"GET /x": "latest"}. Собираем строку обратно, а не выбрасываем: молча
    потерянная точка входа не даст о себе знать никак — её просто не задокументируют.
    """
    if not isinstance(raw, list):
        return []
    out: list[str] = []
    for item in raw:
        if isinstance(item, str):
            out.append(item.strip())
        elif isinstance(item, dict) and len(item) == 1:
            key, value = next(iter(item.items()))
            tail = "" if value is None else f" {value}"
            out.append(f"{key}:{tail}".strip())
        elif item is not None and not isinstance(item, (list, dict)):
            # Число или булево: YAML прочитал строку по-своему («- 200»). Строкой
            # перечня она от этого быть не перестала.
            out.append(str(item).strip())
    return out


def _clean(value: str) -> str:
    """Значение построчного режима — так, как его снял бы YAML: хвостовой комментарий
    отрезан, парные кавычки сняты."""
    text = _COMMENT_TAIL.sub("", value).strip()
    if len(text) >= 2 and text[0] == text[-1] and text[0] in "\"'":
        text = text[1:-1].strip()
    return text


def _salvage(content: str) -> ParsedRecon:
    """Построчный разбор перечня — фолбэк на невалидный YAML (Р7).

    Читаем ровно то, что читал бы YAML: заголовки разделов и строки «- …» под ними.
    Всё прочее (в том числе строка `node:` с двоеточием внутри имени, которая и роняет
    разбор) берётся как есть до конца строки.
    """
    out = ParsedRecon(salvaged=True)
    bucket: dict[str, list[str]] = {
        "operations": out.operations,
        "workers": out.workers,
        "doubts": out.doubts,
    }
    section: list[str] | None = None
    for raw in content.splitlines():
        line = raw.rstrip()
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            continue
        item = _ITEM_RE.match(line)
        if item is not None:
            if section is not None:
                value = _clean(item.group(1))
                if value:
                    section.append(value)
            continue
        head = _SECTION_RE.match(line)
        if head is None:
            continue
        key, tail = head.group(1), head.group(2).strip()
        if key == "node":
            out.node_ref = _clean(tail) or None
            section = None
        else:
            # sources → None: строки-источники заглушками не становятся, но раздел
            # обязан закрыть предыдущий, иначе его строки уехали бы в перечень.
            section = bucket.get(key)
    return out


def looks_like_spec(content: str) -> bool:
    """Файл — OpenAPI-спека, а не перечень (Р8).

    Нужен, чтобы принесённая вместо перечня спека получила внятный ответ, а не
    молчаливый пропуск: «перечня нет» без объяснения отправляет пользователя гадать.
    """
    return any(spec_check(text)[1] for text in _candidates(content))


def parse_recon_file(content: str) -> ParsedRecon | None:
    """Разобрать файл-перечень. None — файл не про разведку.

    None значит «пусть его смотрит другой разборщик»: пользователь вправе перетащить
    папку целиком, и рядом лежат схемы логики, спеки и структура данных.
    """
    for text in _candidates(content):
        if spec_check(text)[1]:
            return None  # следы спеки: openapi:/paths: — это не перечень (Р8)
        doc = _load(text)
        if isinstance(doc, dict) and ({"operations", "workers"} & doc.keys()):
            return ParsedRecon(
                node_ref=_as_ref(doc.get("node")),
                operations=_as_lines(doc.get("operations")),
                workers=_as_lines(doc.get("workers")),
                doubts=_as_lines(doc.get("doubts")),
            )
    # YAML не поддался. Прежде чем спасать построчно, убеждаемся, что спасать есть что:
    # разделы перечня в тексте видны и без разбора.
    if not LOOKS_LIKE_RECON.search(content):
        return None
    return _salvage(content)


def recon_stubs(parsed: ParsedRecon) -> tuple[list[ReconStub], list[str], list[str]]:
    """Строки перечня → заглушки (Р11). Возвращает (заглушки, предупреждения, ошибки).

    Правила разложены здесь, а не в плане, потому что они свойство ПЕРЕЧНЯ, а не
    живого состояния узла: у операции имя и адрес — сама строка, у воркера адреса нет
    вовсе (имя очереди в operation не кладём — поле означает операцию спеки).
    """
    warnings: list[str] = []
    errors: list[str] = []

    lines: list[tuple[NodeDocKind, str]] = []
    for raw in parsed.operations:
        lines.append(("operation", raw))
    for raw in parsed.workers:
        lines.append(("worker", raw))

    if len(lines) > MAX_RECON_LINES:
        errors.append(
            f"в перечне {len(lines)} строк — больше потолка {MAX_RECON_LINES}: перечень "
            "принадлежит одному объекту, проверьте, не склеены ли в файле несколько"
        )
        return [], warnings, errors

    stubs: list[ReconStub] = []
    seen: set[str] = set()
    empty = dupes = 0
    long_lines: list[str] = []
    for kind, raw in lines:
        name = raw.strip()
        if not name:
            empty += 1
            continue
        # Дедуп ОБЩИЙ на оба раздела: имя схемы уникально в пределах узла
        # (uq_node_doc_name), и строка, попавшая и в операции, и в воркеры, уронила бы
        # запись целиком.
        if name in seen:
            dupes += 1
            continue
        seen.add(name)
        if len(name) > MAX_ENTRY_LEN:
            long_lines.append(name)
            continue
        stubs.append(
            ReconStub(name=name, kind=kind, operation=name if kind == "operation" else None)
        )

    if parsed.salvaged:
        warnings.append(
            "файл разобран построчно: YAML не читается — частая причина двоеточие или "
            "решётка в имени объекта (строка node); просмотрите строки перечня глазами"
        )
    if empty:
        warnings.append(f"пустых строк перечня пропущено: {empty}")
    if dupes:
        warnings.append(f"повторов строк перечня схлопнуто: {dupes}")
    for name in long_lines[:MAX_LONG_WARNINGS]:
        warnings.append(
            f"строка длиннее {MAX_ENTRY_LEN} символов — заглушка не создана: «{name[:60]}…»"
        )
    if len(long_lines) > MAX_LONG_WARNINGS:
        warnings.append(
            f"…ещё {len(long_lines) - MAX_LONG_WARNINGS} строк длиннее {MAX_ENTRY_LEN} символов"
        )
    # Сомнения агента — в замечания: другого места у них нет, а потерять их значит
    # выбросить единственное, что разведчик сказал о границах своей уверенности.
    for doubt in parsed.doubts[:MAX_DOUBT_WARNINGS]:
        warnings.append(f"сомнение разведчика: {doubt}")
    if len(parsed.doubts) > MAX_DOUBT_WARNINGS:
        warnings.append(f"…ещё {len(parsed.doubts) - MAX_DOUBT_WARNINGS} сомнений разведчика")

    return stubs, warnings, errors


# --- План: перечень против живых схем узла ------------------------------------
@dataclass
class ReconPlan:
    """План приёма: чей это перечень, что создастся и что показать человеку."""

    report: ReconImportReport = field(default_factory=ReconImportReport)
    node: Node | None = None
    # Только СОЗДАНИЕ: перезаписи и удаления у этого потока нет ни при какой политике.
    creates: list[ReconStub] = field(default_factory=list)


def _node_hint(fulls: list[str]) -> str:
    """Перечень адресов проекта для текста ошибки — с капом и счётчиком хвоста."""
    if not fulls:
        return "в проекте их нет"
    head = ", ".join(fulls[:MAX_NODE_HINTS])
    if len(fulls) > MAX_NODE_HINTS:
        return f"{head} …и ещё {len(fulls) - MAX_NODE_HINTS}"
    return head


def _resolve_node(
    ref: str | None,
    fname: str,
    flat: list[Node],
    fulls: list[str],
    by_bare: dict[str, list[int]],
    by_path: dict[str, list[int]],
    window: uuid.UUID | None,
    plan: ReconPlan,
) -> Node | None:
    """Объект по адресу перечня: полный путь, голое имя или однозначный хвост пути.
    Без адреса — объект окна (Р9).

    Порядок попыток и форма ошибок — как у дозаливки данных (data_import._resolve_node),
    did-you-mean — тот же, что у импорта схемы (_closest_node). ВЫЗВАТЬ тот резолвер
    нельзя: его текст перечисляет узлы-БД проекта («структура принадлежит только
    базе»), а перечень адресуется любому объекту — и перечень кандидатов, и обещание
    были бы неверными; общий параметр туда — правка чужого модуля, на которую эта
    фаза не уполномочена.
    """
    if ref is None:
        if window is None:
            plan.report.errors.append(
                f"{fname}: не указан объект, а окно не сказало, к какому применять"
            )
            return None
        found = next((n for n in flat if n.id == window), None)
        if found is None:
            plan.report.errors.append(f"{fname}: объект окна не найден")
        return found
    hits = by_path.get(ref) or by_bare.get(ref) or []
    if not hits:
        # ЧАСТИЧНЫЙ путь: агент видит только свой репозиторий и корневого контейнера
        # не знает. Совпадение по хвосту — по границе « / », чтобы «…/ Заказы» не
        # цеплялось к «…/ Мои Заказы».
        hits = [i for i, full in enumerate(fulls) if full.endswith(f" / {ref}")]
    if not hits:
        hint = _closest_node(ref, fulls, by_bare, by_path)
        tail = f" — похоже на «{hint}»" if hint else ""
        plan.report.errors.append(
            f"{fname}: объект «{ref}» не найден{tail}; объекты проекта: {_node_hint(fulls)}"
        )
        return None
    if len(hits) > 1:
        plan.report.errors.append(
            f'{fname}: имя «{ref}» неоднозначно ({", ".join(fulls[i] for i in hits)}) — '
            "укажите полный путь"
        )
        return None
    return flat[hits[0]]


def _pick_file(files: list[tuple[str, str]], plan: ReconPlan) -> tuple[str, ParsedRecon] | None:
    """Единственный перечень среди принесённых файлов (Р10).

    Пользователь вправе перетащить папку целиком, поэтому среди файлов ищем похожие на
    перечень, а не требуем ровно один файл на входе. Несколько перечней — вопрос, а не
    угадывание: перечень принадлежит ОДНОМУ объекту (образец — выбор файла спеки в
    дозаливке доков).
    """
    picked: list[tuple[str, ParsedRecon]] = []
    specs: list[str] = []
    for fname, content in files:
        parsed = parse_recon_file(content)
        if parsed is not None:
            picked.append((fname, parsed))
        elif looks_like_spec(content):
            specs.append(fname)
    if len(picked) == 1:
        return picked[0]
    if not picked:
        # Спека вместо перечня — самая вероятная подмена (оба YAML, оба «про API»), и
        # молчаливое «перечня нет» отправило бы человека гадать.
        tail = (
            f'; «{", ".join(sorted(specs))}» — OpenAPI-спека, а не перечень' if specs else ""
        )
        plan.report.errors.append(
            f"среди файлов нет перечня разведки: нужен YAML с разделом operations "
            f"или workers{tail}"
        )
        return None
    plan.report.errors.append(
        "в пакете несколько перечней ("
        + ", ".join(sorted(n for n, _ in picked))
        + ") — перечень принадлежит одному объекту, оставьте один файл"
    )
    return None


def build_recon_plan(
    db: Session,
    nodes: list[Node],
    files: list[tuple[str, str]],
    window: uuid.UUID | None,
) -> ReconPlan:
    """Перечень против живых схем объекта → четыре действия превью (Р12) + отчёт.

    Ключ сопоставления — главное место фазы. Сопоставлять только по имени нельзя:
    схемы, написанные до разведки, называются по-человечески («Отправка сообщения»),
    а операция у них лежит в поле operation — и разведка создала бы заглушку-ДУБЛЬ
    поверх уже описанной операции. Поэтому операция считается описанной, если у узла
    есть схема с таким ИМЕНЕМ ИЛИ с такой ОПЕРАЦИЕЙ, а воркер — только по имени
    (поле operation воркерам не положено).

    БД только читается: превью и применение зовут одно и то же.
    """
    plan = ReconPlan()
    flat, fulls, by_bare, by_path = _node_paths(nodes)

    выбран = _pick_file(files, plan)
    if выбран is None:
        return plan
    fname, parsed = выбран

    node = _resolve_node(parsed.node_ref, fname, flat, fulls, by_bare, by_path, window, plan)
    if node is None:
        return plan
    plan.node = node
    plan.report.node_path = next(
        (fulls[i] for i, n in enumerate(flat) if n.id == node.id), node.name
    )

    # Р15: заглушки у контейнера дадут штатный алерт AL24 «контейнер со своей
    # документацией» — алерт правильный, но узнать о нём человек должен здесь, а не
    # потом. Предупреждение, а не ошибка: бывают и законные случаи.
    if any(n.parent_id == node.id for n in nodes):
        plan.report.warnings.append(
            f"«{plan.report.node_path}» — контейнер; собственные схемы контейнеров "
            "попадают в алерт «Контейнеры со своей документацией» — перечень лучше "
            "адресовать листовому объекту"
        )

    stubs, warnings, errors = recon_stubs(parsed)
    plan.report.warnings.extend(warnings)
    plan.report.errors.extend(errors)
    if errors:
        return plan

    docs = db.query(NodeDoc).filter(NodeDoc.node_id == node.id).all()
    by_doc_name = {d.name: d for d in docs}
    by_doc_operation: dict[str, NodeDoc] = {}
    for d in docs:
        if d.operation:
            by_doc_operation.setdefault(d.operation, d)

    matched: set[uuid.UUID] = set()
    for stub in stubs:
        cur = by_doc_name.get(stub.name)
        if cur is None and stub.kind == "operation":
            cur = by_doc_operation.get(stub.name)
        if cur is None:
            plan.creates.append(stub)
            plan.report.items.append(
                ReconItem(
                    name=stub.name, kind=stub.kind, operation=stub.operation, action="create"
                )
            )
            continue
        matched.add(cur.id)
        plan.report.items.append(
            ReconItem(
                name=stub.name,
                kind=stub.kind,
                operation=stub.operation,
                # Пустое тело — та же заглушка (её мог поставить прошлый заход);
                # непустое — работа человека или агента, и её мы не трогаем.
                action="described" if cur.content.strip() else "unchanged",
                # Строка перечня и имя схемы совпадают не всегда: «POST /messages»
                # бывает описан схемой «Отправка сообщения» — человек должен видеть,
                # ЧТО именно закрыло операцию.
                doc_name=cur.name if cur.name != stub.name else None,
            )
        )

    # Исчезнувшие — ТОЛЬКО операции и воркеры: схема-обзор в перечень не входит по
    # природе, и объявлять её исчезнувшей значит каждый раз пугать ложной тревогой.
    # Порядок по имени: порядок строк из БД произволен, а превью читает человек.
    for d in sorted(docs, key=lambda d: d.name):
        if d.id in matched or d.kind not in ("operation", "worker"):
            continue
        plan.report.items.append(
            ReconItem(
                name=d.name,
                kind=cast(NodeDocKind, d.kind),
                operation=d.operation,
                action="vanished",
            )
        )
    return plan


def apply_recon_plan(db: Session, plan: ReconPlan) -> None:
    """Записать заглушки. НИЧЕГО не удаляет и не перезаписывает (Р13).

    Исчезнувшая из кода схема остаётся жить: расхождение должно быть ВИДНО, а удаление
    — ручное. Описанная схема тем более неприкосновенна: разведка не вправе затирать
    работу человека, и повторный прогон перечня обязан быть пустым (Р14).
    """
    node = plan.node
    if node is None:
        return
    for stub in plan.creates:
        db.add(
            NodeDoc(
                node_id=node.id,
                name=stub.name,
                kind=stub.kind,
                operation=stub.operation,
                content="",  # пустое тело и есть заглушка (§5 плана)
            )
        )
        plan.report.created += 1
    db.flush()
    plan.report.applied = True
