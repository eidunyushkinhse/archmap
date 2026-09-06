"""Применение единого плана ввоза: план + выбор пользователя → НОВЫЙ проект (Ф2а).

Ф1 построила план (build_unified_plan): слитый C4, вклады семей фактов на узлах
СЛИТОГО дерева и споры о телах с кандидатами. Здесь план становится проектом.

Порядок применения — строго по зависимостям, как у одноархивного импорта:
C4 (узлы и связи) → схемы логики → семьи фактов → спеки → процессы. Процессы
последними не случайно: их шаги привязываются к УЖЕ СОЗДАННЫМ схемам логики.

ТРИ РЕШЕНИЯ, определяющие модуль::

  1. Узел вклада ищется ПО ИНДЕКСУ плана, а не по пути: seed_import отдаёт id
     узлов в порядке parsed.nodes, и карта «индекс → Node» точна даже там, где
     пути неоднозначны (якорь source_ref законно разводит тёзок в одном родителе).
  2. Таблицы, каналы и параметры пишутся РОДНЫМИ приёмниками (build_*_plan /
     apply_*_plan), а не моделями напрямую: у них доменная логика, дублировать
     которую нельзя (гейт «каналы только у брокера», резолюция ссылок
     «таблица.колонка» → references_column_id, did-you-mean в замечаниях).
     Значит вклады-победители надо СОБРАТЬ ОБРАТНО в файлы ввозного формата —
     круговой прогон «вклад → yaml → parse_*_file → вклад» обязан быть точным.
  3. Привязки шагов процессов ПЕРЕПИСЫВАЮТСЯ. Адрес «%% archmap-doc: путь / имя»
     в тексте процесса входа K написан в системе координат АРХИВА K: и путь узла
     (слияние переклеивает и переименовывает), и имя схемы (тёзке при выборе
     «взять все» достаётся суффикс) в новом проекте другие. Схема, ПРОИГРАВШАЯ
     спор, не переписывается вовсе — её тела в проекте нет, и шаг честно остаётся
     без привязки (видимая деградация, как везде).
"""

import uuid
from dataclasses import dataclass

from sqlalchemy.orm import Session

from app.channels_import import (
    ChannelIn,
    apply_channels_plan,
    build_channels_plan,
    seed_edge_channel_stubs,
)
from app.config_import import ParamIn, apply_config_plan, build_config_plan
from app.data_import import TableIn, apply_data_plan, build_data_plan
from app.import_yaml import seed_import
from app.models.node import Node
from app.models.node_doc import NodeDoc
from app.models.project import Project

# Приватное из соседей — осознанно: регулярка привязки и норма адреса должны быть
# ОДНИМИ И ТЕМИ ЖЕ, что у разбора процессов, иначе переписанный адрес не совпадёт
# с тем, который импорт потом ищет. Тот же приём, что у unified_import с _read_zip.
from app.process_import import _DOC_RE, _norm_address
from app.process_import import apply_import as apply_process_import
from app.process_import import build_preview as build_process_preview
from app.processes import node_path
from app.schemas.archive import ArchiveImportResult
from app.schemas.channels_import import ChannelsImportReport
from app.schemas.config_import import ConfigImportReport
from app.schemas.data_import import DataImportReport
from app.unified_import import (
    SEP,
    DocIn,
    Family,
    FamilyValue,
    UnifiedImportError,
    UnifiedPlan,
    _channel_doc,
    _param_doc,
    _table_doc,
    _yaml,
)


@dataclass
class _Winner:
    """Вклад, который поедет в проект: бесспорный либо выбранный резолюцией."""

    family: Family
    node_idx: int
    key: str
    origin: int
    fname: str
    value: FamilyValue
    # Пришёл из спора. Для схем логики это значит «имя может получить суффикс», а
    # адрес привязки переписывается только своему входу (у проигравшего тела нет).
    from_conflict: bool


# ── Резолюции ────────────────────────────────────────────────────────────────


def _choice_index(conflict_id: str, choice: str, total: int, allow_all: bool) -> int | None:
    """Разбор выбора: None — «взять все». Кривой выбор — 400, а не тихий дефолт:
    молча применённое «не то» пользователь обнаружит уже в проекте."""
    if choice == "all":
        if not allow_all:
            raise UnifiedImportError(
                f"Спор «{conflict_id}»: «взять все» тут не применимо — "
                "значение может быть только одно"
            )
        return None
    idx_text = choice[len("cand:"):] if choice.startswith("cand:") else ""
    if not idx_text.isdigit():
        raise UnifiedImportError(f"Спор «{conflict_id}»: непонятный выбор «{choice}»")
    idx = int(idx_text)
    if idx >= total:
        raise UnifiedImportError(
            f"Спор «{conflict_id}»: выбран вариант {idx}, а их всего {total}"
        )
    return idx


def _winners(plan: UnifiedPlan, resolutions: dict[str, str]) -> list[_Winner]:
    """Победители всех споров + бесспорные вклады. Валидация — ДО любой записи.

    Порядок: сначала бесспорные, потом спорные. Он значим для схем логики: имя
    бесспорной схемы неприкосновенно, а суффикс « (2)» ищет первое свободное — так
    спорная тёзка не отберёт имя у соседки."""
    by_id = {c.id: c for c in plan.conflicts}
    for cid, choice in resolutions.items():
        conflict = by_id.get(cid)
        if conflict is None:
            raise UnifiedImportError(
                f"Резолюция к несуществующему спору «{cid}» — превью устарело, "
                "пересоберите его"
            )
        _choice_index(cid, choice, len(conflict.candidates), conflict.allow_all)

    out = [
        _Winner(family=i.family, node_idx=i.node_idx, key=i.key, origin=i.origin,
                fname=i.fname, value=i.value, from_conflict=False)
        for i in plan.items
    ]
    for c in plan.conflicts:
        idx = _choice_index(
            c.id, resolutions.get(c.id, c.default), len(c.candidates), c.allow_all
        )
        chosen = c.candidates if idx is None else [c.candidates[idx]]
        out.extend(
            _Winner(family=c.family, node_idx=c.node_idx, key=c.key, origin=k.origin,
                    fname=k.fname, value=k.value, from_conflict=True)
            for k in chosen
        )
    return out


# ── Имена и адреса ───────────────────────────────────────────────────────────


def _free_name(base: str, taken: set[str]) -> str:
    """Первое свободное имя вида «Имя», «Имя (2)», «Имя (3)»… — имя схемы уникально
    в пределах узла (uq_node_doc_name), и тёзок надо развести до записи, а не ловить
    500-кой на flush."""
    if base not in taken:
        return base
    n = 2
    while f"{base} ({n})" in taken:
        n += 1
    return f"{base} ({n})"


def _rewrite_doc_addresses(text: str, addresses: dict[str, str]) -> str:
    """Переписать адреса привязок шагов; остальной текст — байт-в-байт.

    Трогаем ТОЛЬКО строки «%% archmap-doc: …» (регистронезависимо, как разбор):
    процесс — авторский документ пользователя, и любое другое изменение его текста
    было бы самоуправством."""
    if not addresses:
        return text
    out: list[str] = []
    for line in text.splitlines(keepends=True):
        m = _DOC_RE.match(line.strip())
        new = addresses.get(_norm_address(m.group(1))) if m else None
        if new is None:
            out.append(line)
            continue
        body = line.rstrip("\r\n")
        eol = line[len(body):]
        indent = body[: len(body) - len(body.lstrip())]
        out.append(f"{indent}%% archmap-doc: {new}{eol}")
    return "".join(out)


# ── Применение ───────────────────────────────────────────────────────────────


def apply_unified_plan(
    db: Session,
    plan: UnifiedPlan,
    resolutions: dict[str, str],
    name: str | None,
    description: str | None,
    user_id: uuid.UUID,
) -> tuple[Project, ArchiveImportResult]:
    """Создать проект по плану с учётом выбора пользователя. Коммит — на вызывающей
    стороне (норма всех приёмников: транзакцией владеет роут).

    UnifiedImportError — применение невозможно целиком (план непригоден, резолюция
    не из плана, нет имени): проект не создаётся. Частичные промахи (адрес семьи не
    разрешился, канал не у брокера) едут замечаниями в отчёте, как у всех приёмников.
    """
    merged = plan.merged
    if not plan.ok or merged is None:
        raise UnifiedImportError(
            "План непригоден к применению: " + ("; ".join(plan.errors[:5]) or "неизвестно почему")
        )
    winners = _winners(plan, resolutions)

    # ── Имя и описание: поля пользователя либо манифест единственного архива (П3).
    project_name = (name or "").strip()
    if not project_name:
        if plan.name_source != "manifest":
            raise UnifiedImportError("Не задано имя проекта")
        project_name = (plan.manifest_name or "").strip() or "Из архива"
    project_description = (description or "").strip() or None
    if project_description is None and plan.name_source == "manifest":
        project_description = plan.manifest_description

    project = Project(
        id=uuid.uuid4(),
        name=project_name,
        description=project_description,
        created_by_id=user_id,
        updated_by_id=user_id,
    )
    db.add(project)
    db.flush()

    # ── C4. Карта «индекс плана → узел» — ТОЛЬКО по возврату seed_import: пути
    #    неоднозначны (тёзки в одном родителе), а индекс точен всегда.
    ids = seed_import(db, project.id, merged)
    db.flush()
    nodes = db.query(Node).filter(Node.project_id == project.id).all()
    by_id = {n.id: n for n in nodes}
    node_of = [by_id[i] for i in ids]  # индекс плана → узел проекта
    path_of = [node_path(by_id, n.id) for n in node_of]

    warnings: list[str] = list(plan.warnings)
    for i, remarks in enumerate(plan.input_remarks):
        label = plan.labels[i] if i < len(plan.labels) else f"вход {i + 1}"
        warnings.extend(f"{label}: {r}" for r in remarks)

    # ── Схемы логики: напрямую, тело БЕЗ шапки (заглушка остаётся заглушкой, Д4).
    docs_created = 0
    taken: dict[uuid.UUID, set[str]] = {}
    # (вход, узел, исходное имя) → фактическое имя. Карта переименований нужна
    # процессам: их привязки написаны исходными именами своего архива.
    renamed: dict[tuple[int, int, str], str] = {}
    # (узел, исходное имя) → фактическое, для БЕССПОРНЫХ схем: такую схему могли
    # прислать несколько входов с одинаковым телом (дедуп молча), и адрес любого из
    # них ведёт к ней же.
    shared: dict[tuple[int, str], str] = {}
    for w in winners:
        if not isinstance(w.value, DocIn):
            continue
        node = node_of[w.node_idx]
        names = taken.setdefault(node.id, set())
        actual = _free_name(w.value.name, names)
        names.add(actual)
        db.add(NodeDoc(
            node_id=node.id,
            name=actual,
            kind=w.value.kind,
            operation=w.value.operation,
            content=w.value.body,
        ))
        docs_created += 1
        renamed[(w.origin, w.node_idx, w.value.name)] = actual
        if not w.from_conflict:
            shared[(w.node_idx, w.value.name)] = actual
    db.flush()

    # ── Семьи фактов: синтетические файлы ввозного формата → родные приёмники.
    def run_family(family: Family, build, apply):
        files = _synthetic_files(family, winners, path_of)
        if not files:
            return None
        family_plan = build(db, nodes, files, None, False)
        apply(db, family_plan, False)
        return family_plan.report

    db_report: DataImportReport | None = run_family("table", build_data_plan, apply_data_plan)
    channels_report: ChannelsImportReport | None = run_family(
        "channel", build_channels_plan, apply_channels_plan
    )
    # Каналы, названные связями, но не описанные пакетом, — заглушками: схема знает,
    # что канал у брокера ЕСТЬ, и без записи панель алертов после ввоза врала бы.
    channel_stubs = seed_edge_channel_stubs(db, project.id)
    config_report: ConfigImportReport | None = run_family(
        "config", build_config_plan, apply_config_plan
    )

    # ── Спеки: одна на узел (Node.openapi_spec), текст уже без адресной строки.
    specs_applied = 0
    for w in winners:
        if w.family == "spec" and isinstance(w.value, str):
            node_of[w.node_idx].openapi_spec = w.value
            specs_applied += 1
    db.flush()

    # ── Процессы: не сливаются никогда, тёзкам — суффикс; привязки переписываются.
    addresses = _address_map(plan, renamed, shared, path_of)
    used_names: dict[str, int] = {}
    process_results = []
    for item in plan.processes:
        seen = used_names.get(item.name, 0) + 1
        used_names[item.name] = seen
        proc_name = item.name if seen == 1 else f"{item.name} ({seen})"
        if seen > 1:
            warnings.append(
                f"процесс «{item.name}» из входа «{item.origin_label}» приехал под именем "
                f"«{proc_name}»: процессы не сливаются"
            )
        text = _rewrite_doc_addresses(item.text, addresses.get(item.origin, {}))
        preview = build_process_preview(db, project.id, text, proc_name)
        mapping = {p.alias: p.node_id for p in preview.participants}
        _, result = apply_process_import(db, project.id, text, proc_name, mapping)
        process_results.append(result)

    return project, ArchiveImportResult(
        project_id=project.id,
        project_name=project.name,
        nodes=len(merged.nodes),
        edges=len(merged.edges),
        docs_created=docs_created,
        specs_applied=specs_applied,
        db=db_report,
        channels=channels_report,
        config=config_report,
        processes=process_results,
        warnings=warnings,
        resolved_conflicts=len(plan.conflicts),
        channel_stubs=channel_stubs,
    )


def _synthetic_files(
    family: Family, winners: list[_Winner], path_of: list[str]
) -> list[tuple[str, str]]:
    """Вклады-победители семьи → файлы ввозного формата, как их прислал бы агент.

    Файл — один на «вход + исходный файл + узел» (внутри одного файла адресат
    всегда один). Имя файла ОСТАЁТСЯ исходным: его человек увидит в замечаниях
    родного приёмника, и указывать ему на выдуманное «synthetic-3.yaml» бесполезно.
    """
    buckets: dict[tuple[int, str, int], list[FamilyValue]] = {}
    for w in winners:
        if w.family == family:
            buckets.setdefault((w.origin, w.fname, w.node_idx), []).append(w.value)

    out: list[tuple[str, str]] = []
    for (_origin, fname, node_idx), values in buckets.items():
        if family == "table":
            body = {"tables": [_table_doc(v) for v in values if isinstance(v, TableIn)]}
        elif family == "channel":
            body = {"channels": [_channel_doc(v) for v in values if isinstance(v, ChannelIn)]}
        else:
            body = {"config": [_param_doc(v) for v in values if isinstance(v, ParamIn)]}
        # Адрес — ведущим комментарием с решёткой: YAML-ключ адресом не считается
        # (родные парсеры ищут именно комментарий, и об ошибке предупреждают).
        out.append((fname, f"# archmap-node: {path_of[node_idx]}\n" + _yaml(body)))
    return out


def _address_map(
    plan: UnifiedPlan,
    renamed: dict[tuple[int, int, str], str],
    shared: dict[tuple[int, str], str],
    path_of: list[str],
) -> dict[int, dict[str, str]]:
    """Карта «вход → (старый адрес привязки → новый)».

    Старый адрес — «путь узла в архиве этого входа / имя схемы»; новый — «путь узла
    в новом проекте / фактическое имя». Пути входа берём из плана (origin_paths) и
    переводим происхождением вкладов (report.node_contribs, Ф0): один merged-узел
    мог собраться из нескольких узлов одного входа, поэтому адресов-ключей бывает
    несколько, и все они ведут в одну точку.
    """
    # (вход, merged-узел) → пути этого узла в системе координат входа.
    origin_paths: dict[tuple[int, int], list[str]] = {}
    for merged_idx, contribs in enumerate(plan.report.node_contribs):
        for file_idx, node_idx in contribs:
            paths = plan.origin_paths[file_idx] if file_idx < len(plan.origin_paths) else []
            if node_idx < len(paths) and merged_idx < len(path_of):
                origin_paths.setdefault((file_idx, merged_idx), []).append(paths[node_idx])

    out: dict[int, dict[str, str]] = {}

    def bind(origin: int, node_idx: int, old_name: str, actual: str) -> None:
        new = f"{path_of[node_idx]}{SEP}{actual}"
        for p in origin_paths.get((origin, node_idx), []):
            out.setdefault(origin, {}).setdefault(_norm_address(f"{p}{SEP}{old_name}"), new)

    # Сначала пооригинные (спорные тёзки с суффиксом — самый точный случай)…
    for (origin, node_idx, old_name), actual in renamed.items():
        bind(origin, node_idx, old_name, actual)
    # …потом бесспорные: их адрес одинаково верен для ЛЮБОГО входа — схема в проекте
    # одна, кто бы её ни прислал (в том числе для входа, чью копию съел дедуп).
    for (node_idx, old_name), actual in shared.items():
        for origin in range(len(plan.labels)):
            bind(origin, node_idx, old_name, actual)
    return out


__all__ = ["apply_unified_plan"]
