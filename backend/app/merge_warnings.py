"""Анализаторы содержимого слитого импорта: одиночные узлы, связи в контейнер и в
собственного потомка, связи с брокером без канала, перечни каналов, изолированные
группы. Вынесены из app/import_merge.py (аудит Q-18); пишут в MergeReport
(app/merge_report.py)."""


from app.connectivity import connected_components
from app.import_element import effective_elements
from app.import_yaml import (
    ParsedImport,
    _ImpNode,
)
from app.merge_report import ContainerEdgeRec, IsolatedGroupRec, MergeReport, _fill

# Связи в контейнер называем поимённо, но не все: замечания уезжают агенту одним
# списком, и полсотни строк одного класса вытеснят остальное.
_MAX_CONTAINER_EDGES = 10
# Тот же кап у связей узла с собственным потомком — свой счётчик на класс.
_MAX_DESCENDANT_EDGES = 10
# Сколько компонентов контейнера перечисляем в таком замечании («цель с ответом»,
# П5) и сколько — когда перечней в строке два (оба конца контейнеры): два длинных
# перечисления в одной строке нечитаемы, поэтому там кап строже.
_MAX_CONTAINER_KIDS = 6
_MAX_CONTAINER_KIDS_BOTH = 4
# Тот же кап у связей в брокер без канала — свой счётчик, чтобы один класс не
# съедал квоту другого.
_MAX_BROKER_EDGES = 10
# И у связей, чей channel несёт ПЕРЕЧЕНЬ каналов вместо одного имени.
_MAX_CHANNEL_LIST_EDGES = 10
# Изолированные группы: сколько групп называем и сколько имён показываем в каждой.
_MAX_ISOLATED_GROUPS = 10
_MAX_GROUP_NAMES = 6


def warn_content(merged: ParsedImport, report: MergeReport) -> None:
    """Проверки СОДЕРЖАНИЯ схемы, не полагающиеся на аккуратность агента.

    Находки ручной проверки 2026-08-08: агент кладёт людей внутрь системы
    (3 прогона из 4) и создаёт компоненты, не связанные ни с чем (2 объекта из
    10); третья — полевого QA (связи, упирающиеся в контейнер с компонентами,
    см. _warn_container_edges); четвёртая — матрицы федерации (связи узла с его
    собственным потомком, см. _warn_descendant_edges). Промпт про это говорит, но
    соблюдает его модель через раз — поэтому предупреждаем ЗДЕСЬ, до создания проекта.

    Только предупреждения: тихо перестраивать чужое дерево (поднимать актора в
    корень) хуже, чем строка в отчёте, — пользователь не поймёт, что произошло.

    Адресат каждого замечания — по происхождению виновных сущностей (Ф7): агент
    своего репозитория положил актора внутрь системы, ему это и чинить. Как только
    замечание собирает объекты, у которых нет общего файла, виноватого нет — оно
    уходит в схемную корзину (owner_of_* возвращает None).
    """
    actor_idxs = [
        i for i, n in enumerate(merged.nodes) if n.shape == "person" and n.parent_idx is not None
    ]
    if actor_idxs:
        actors = [merged.nodes[i].name for i in actor_idxs]
        report.warn(
            f"внутри системы оказались люди ({', '.join(f'«{a}»' for a in actors[:6])}) — "
            f"по C4 человек пользуется системой, а не входит в неё; перенесите их в корень",
            report.owner_of_nodes(actor_idxs),
        )
    # «Подвисшим» считается ТОЛЬКО атомарный узел: у контейнера прямых связей и
    # быть не должно — их несут его дети, а связь, упирающаяся в контейнер, ловится
    # отдельным алертом. Зеркалим определение из app/alerts.compute_alerts, иначе
    # превью пугало бы тем, чего схема потом не показывает.
    parents = {n.parent_idx for n in merged.nodes if n.parent_idx is not None}
    linked = {e.source_idx for e in merged.edges} | {e.target_idx for e in merged.edges}
    lonely_idxs = [
        i
        for i, n in enumerate(merged.nodes)
        if i not in linked and i not in parents and n.parent_idx is not None
    ]
    _warn_lonely(merged, report, lonely_idxs)
    # Связь узла с собственным потомком разбирается ПЕРВОЙ и снимается со ВСЕХ
    # остальных классов о связях: её ответ — «удалите или перевесьте», и совет
    # «уточните конец» / «допишите канал» / «разделите перечень» рядом с ним
    # противоречив (см. _warn_descendant_edges).
    внутренние = _warn_descendant_edges(merged, report)
    _warn_container_edges(merged, report, parents, внутренние)
    _warn_broker_edges(merged, report, внутренние)
    _warn_channel_lists(merged, report, внутренние)
    _warn_isolated_groups(merged, report)


def _warn_lonely(merged: ParsedImport, report: MergeReport, lonely_idxs: list[int]) -> None:
    """«Объектов без единой связи» — СТРОКОЙ НА ФАЙЛ-ВЛАДЕЛЕЦ (П4).

    Сборный список сирот всей слитой схемы уходил в схемную корзину, стоило сиротам
    прийти из разных файлов: файла, внёсшего вклад в КАЖДОГО из них, нет, и по общему
    правилу Ф7 адресата у строки не находилось. А чинит каждого сироту его агент —
    поэтому список режется по владельцу: сироты, весь вклад в которые сделал один
    файл, собираются в его строку (формулировка, счёт и кап имён — прежние, только
    про его объекты), а сироты-склейки нескольких файлов идут одной общей строкой,
    адресат которой считается всё тем же правилом Ф7 (наименьший общий файл; общего
    нет — схемная корзина, свести таких может только видящий весь ландшафт).

    При единственном файле группа ровно одна, и текст совпадает с прежним байт-в-байт."""
    groups: dict[int | None, list[int]] = {}
    for i in lonely_idxs:
        files = report.node_files[i] if i < len(report.node_files) else set()
        groups.setdefault(next(iter(files)) if len(files) == 1 else None, []).append(i)
    # Детерминированный порядок строк: владельцы по номеру файла, общая — последней.
    for owner in sorted(groups, key=lambda f: (f is None, f or 0)):
        idxs = groups[owner]
        lonely = [merged.nodes[i].name for i in idxs]
        names = ", ".join(f"«{x}»" for x in lonely[:6])
        tail = f" и ещё {len(lonely) - 6}" if len(lonely) > 6 else ""
        report.warn(
            f"объектов без единой связи: {len(lonely)} ({names}{tail}) — проверьте, "
            f"не потерялись ли связи; такие объекты попадут в «Незавершённость схемы»",
            report.owner_of_nodes(idxs),
        )


def _descends(nodes: list[_ImpNode], child: int, ancestor: int) -> bool:
    """Потомок ли child для ancestor (ребёнок, внук, любая глубина).

    Подъём по parent_idx конечен: родитель узла всегда создан раньше него самого
    (add_node кладёт parent_m, уже существующий), поэтому индекс родителя строго
    меньше индекса ребёнка и цикла в дереве быть не может."""
    parent = nodes[child].parent_idx
    while parent is not None:
        if parent == ancestor:
            return True
        parent = nodes[parent].parent_idx
    return False


def _warn_descendant_edges(merged: ParsedImport, report: MergeReport) -> set[int]:
    """Связи между узлом и его СОБСТВЕННЫМ потомком (в любую сторону, любой глубины).
    Возвращает индексы таких связей — контейнерный класс их уже не разбирает.

    Полевая находка матрицы федерации (docs/qa-federation-matrix.md, находка 4):
    у Zulip таких связей пять («background-workers → email-senders», где цель —
    компонент источника), у федерации они же сидят в intermediate_edges. Агент
    рисует их сам под интро «дописывай недостающие связи»: вложенность ему кажется
    отношением, которое надо провести стрелкой.

    Почему отдельный класс, а не прежний контейнерный: связь между контейнером и его
    компонентом СЕМАНТИЧЕСКИ ПУСТА — иерархия уже сказала всё, что стрелка пыталась
    сказать, — а контейнерное замечание отвечало на неё бессмыслицей («уточните её до
    конкретного компонента», хотя конец УЖЕ компонент, притом этого же контейнера).
    Проверено полем: круги её не лечили. Ответ здесь другой — удалить или перевесить,
    поэтому и класс свой (урок Х5 «цель с ответом» тот же).

    Связь в ЧУЖОЙ контейнер («A → C / компонент», C ≠ A) под правило не подпадает и
    остаётся прежним контейнерным классом с перечнем компонентов.

    Адресат — файл-первоисточник связи: виновная сущность ровно одна (сама связь), а
    её концы объявлены тем же файлом (ссылки резолвятся внутри файла).
    """
    shown = hidden = 0
    hidden_idxs: list[int] = []
    свои: set[int] = set()
    for ei, e in enumerate(merged.edges):
        if _descends(merged.nodes, e.target_idx, e.source_idx):
            часть, целое = e.target_idx, e.source_idx
        elif _descends(merged.nodes, e.source_idx, e.target_idx):
            часть, целое = e.source_idx, e.target_idx
        else:
            continue
        свои.add(ei)
        if shown >= _MAX_DESCENDANT_EDGES:
            hidden += 1
            hidden_idxs.append(ei)
            continue
        shown += 1
        a, b = merged.nodes[e.source_idx].name, merged.nodes[e.target_idx].name
        report.warn(
            f"связь «{a} → {b}»: «{merged.nodes[часть].name}» — часть "
            f"«{merged.nodes[целое].name}», иерархия уже выражает вложенность — "
            f"удалите связь или перевесьте её на другой узел",
            report.owner_of_edges([ei]),
        )
    if hidden:
        report.warn(
            f"…ещё {hidden} таких связей с собственным потомком",
            report.owner_of_edges(hidden_idxs),
        )
    return свои


def _warn_container_edges(
    merged: ParsedImport, report: MergeReport, parents: set[int], skip: set[int]
) -> None:
    """Связи, упирающиеся в объект, У КОТОРОГО ЕСТЬ вложенные объекты.

    После импорта это алерт AL8, но агент к тому моменту уже ушёл: в раунде 3
    полевого QA (docs/qa-zabbix-7.md) их накопилось 13 — «дополняй связями» слабая
    модель исполнила, а дубли с уровня контейнера не убрала. Поэтому предупреждаем
    ДО импорта и НАЗЫВАЕМ каждую связь: замечание лечится переносом конца на
    компонент, и агенту нужен конкретный конец, а не правило.

    Определение такого конца — зеркало app/alerts.compute_alerts (узел с детьми),
    но по СЛИТОМУ дереву: проекта на этот момент ещё не существует. Правило одно для
    любого объекта с вложенными (Р22 эпика элементов архитектуры), а слова — по его
    действующему элементу в слитом (уже санитизированном) дереве: у системы —
    «вложенные объекты», у контейнера — «компоненты». Составной компонент в роли конца
    (редкость) зовётся, как контейнер: у него тоже есть части одной программы.

    Замечание несёт ОТВЕТ — перечень реальных компонентов конца в форме
    «Контейнер / компонент» (П5; урок Ф8 брокерного эпика, подтверждён трижды:
    замечание с готовой целью чинится за один круг, а «уточните до конкретного
    компонента» слабая модель исполняла лениво и частично — это был главный
    поглотитель кругов). Форма квалификатора дословно та, которую понимает
    parse_import в ссылках связей: строку из замечания можно вписать в YAML как есть.

    Адресат — ВСЕГДА файл-первоисточник связи. Виновная сущность здесь ровно одна —
    сама связь (правило Ф7 не меняется, сужается круг виновных): знание о чужих
    компонентах больше не требуется от агента, оно вложено в текст. До П5 у
    контейнера, раскрытого ЧУЖИМ файлом, замечание уходило человеку («агент их не
    видит») — в мульти-режиме туда оседал самый частый и самый механический класс
    правок.

    skip — связи, уже разобранные классом «узел и его собственный потомок»
    (_warn_descendant_edges): у них другой диагноз и другой ответ, и два замечания на
    одну связь противоречили бы друг другу.
    """
    kids = _children_names(merged)
    elements = effective_elements(merged.nodes)
    shown = hidden = 0
    hidden_idxs: list[int] = []
    hidden_recs: list[ContainerEdgeRec] = []
    for ei, e in enumerate(merged.edges):
        if ei in skip:
            continue
        # dict.fromkeys — на случай петли «узел сам на себя»: конец один, не два.
        ends = [i for i in dict.fromkeys((e.source_idx, e.target_idx)) if i in parents]
        if not ends:
            continue
        # Структура (Ф-E) собирается ДО капа: кап — свойство текста, уезжающего
        # агенту одним списком, а вопрос пользователю положен каждому концу.
        recs = [
            ContainerEdgeRec(
                edge_idx=ei,
                end="source" if i == e.source_idx else "target",
                container_idx=i,
            )
            for i in ends
        ]
        report.container_edges.extend(recs)
        if shown >= _MAX_CONTAINER_EDGES:
            hidden += 1
            hidden_idxs.append(ei)
            hidden_recs.extend(recs)  # их строка — общий хвост-счётчик ниже
            continue
        shown += 1
        for rec in recs:
            rec.warning_idx = len(report.warnings)
        a, b = merged.nodes[e.source_idx].name, merged.nodes[e.target_idx].name
        names = [merged.nodes[i].name for i in ends]
        systems = [elements[i] == "system" for i in ends]
        cap = _MAX_CONTAINER_KIDS if len(names) == 1 else _MAX_CONTAINER_KIDS_BOTH
        targets = "; ".join(_kids_phrase(merged.nodes[i].name, kids[i], cap) for i in ends)
        head = _container_edge_head(names, systems, targets)
        report.warn(f"связь «{a} → {b}»: {head}", report.owner_of_edges([ei]))
    if hidden:
        for rec in hidden_recs:
            rec.warning_idx = len(report.warnings)
        # Хвост-счётчик — тому, чьи все скрытые связи (как у соседних классов).
        report.warn(f"…ещё {hidden} таких связей", report.owner_of_edges(hidden_idxs))


def _container_edge_head(names: list[str], systems: list[bool], targets: str) -> str:
    """Суть замечания о связи в объект с вложенными — словами элемента конца. names и
    systems — концы (один или оба) и «конец — система»; targets — готовые цели (П5)."""
    if len(names) == 1:
        if systems[0]:
            return (
                f"конец в системе «{names[0]}», у которой есть вложенные объекты, — "
                f"уточните её до одного из них: {targets}"
            )
        return (
            f"конец в контейнере «{names[0]}», у которого есть компоненты, — "
            f"уточните её до конкретного компонента: {targets}"
        )
    if not any(systems):
        return (
            f"оба конца в контейнерах «{names[0]}» и «{names[1]}», у которых есть "
            f"компоненты, — уточните её до конкретных компонентов: {targets}"
        )
    where = (
        f"системах «{names[0]}» и «{names[1]}»"
        if all(systems)
        else " и ".join(
            f"{'системе' if system else 'контейнере'} «{name}»"
            for name, system in zip(names, systems, strict=True)
        )
    )
    return (
        f"оба конца в {where}, у которых есть вложенные объекты, — уточните её до "
        f"вложенных объектов: {targets}"
    )


def _children_names(merged: ParsedImport) -> dict[int, list[str]]:
    """Индекс контейнера → имена его компонентов в порядке СЛИТОГО дерева.

    Ключи — ровно те же индексы, что в `parents` у warn_content (оба множества
    считаются по parent_idx одних и тех же узлов), поэтому перечень у контейнера
    заведомо непустой. Порядок детерминирован обходом nodes: один и тот же пакет
    даёт один и тот же перечень в замечании от прогона к прогону."""
    out: dict[int, list[str]] = {}
    for n in merged.nodes:
        if n.parent_idx is not None:
            out.setdefault(n.parent_idx, []).append(n.name)
    return out


def _kids_phrase(container: str, names: list[str], cap: int) -> str:
    """Перечень готовых целей для конца связи: «Y / poller», «Y / trapper» и ещё 6.

    Кап нужен по той же причине, что и у соседних классов: замечания уезжают агенту
    одним списком, и контейнер на полсотни компонентов вытеснил бы всё остальное.
    Хвост считаем, а не молчим о нём: агент должен знать, что выбор шире показанного."""
    shown = ", ".join(f"«{container} / {n}»" for n in names[:cap])
    tail = f" и ещё {len(names) - cap}" if len(names) > cap else ""
    return shown + tail


def _warn_broker_edges(merged: ParsedImport, report: MergeReport, skip: set[int]) -> None:
    """Связи, упирающиеся в БРОКЕР, но не называющие канал.

    Решение пользователя №4 (docs/plan-broker-docs.md §4): стрелка в брокер обязана
    назвать топик/очередь — иначе схема не отвечает на «откуда взялось событие».
    После импорта это алерт AL31, но урок Х5 тот же, что у связей в контейнер: агент
    к моменту алертов уже ушёл, поэтому предупреждаем ДО импорта и НАЗЫВАЕМ каждую
    связь — замечание лечится дописыванием одного поля, и агенту нужен конкретный
    конец, а не правило.

    Брокер узнаём по shape СЛИТОГО дерева: проекта на этот момент ещё нет.

    Виновные (Ф7) — связь и её конец-брокер, но пересекать их атрибуции не с чем:
    файл, написавший связь, объявил и оба её конца (ссылки резолвятся внутри файла),
    так что общий файл есть всегда и адресат — первоисточник связи. Даже когда
    «брокером» конец сделал ЧУЖОЙ файл своим shape, замечание остаётся выполнимым:
    от агента требуется дописать одно поле — имя топика, в который пишет его код.

    skip — связи класса «узел и его собственный потомок» (_warn_descendant_edges):
    им велено исчезнуть, а не обзавестись каналом.
    """
    shown = hidden = 0
    hidden_idxs: list[int] = []
    for ei, e in enumerate(merged.edges):
        if ei in skip or _fill(e.channel):
            continue
        # dict.fromkeys — на случай петли: конец один, не два. Оба конца брокеры —
        # называем первый (искать канал придётся у обоих, починка начинается с любого).
        ends = [
            i
            for i in dict.fromkeys((e.source_idx, e.target_idx))
            if merged.nodes[i].shape == "broker"
        ]
        if not ends:
            continue
        if shown >= _MAX_BROKER_EDGES:
            hidden += 1
            hidden_idxs.append(ei)
            continue
        shown += 1
        a, b = merged.nodes[e.source_idx].name, merged.nodes[e.target_idx].name
        report.warn(
            f"связь «{a} → {b}»: конец — брокер «{merged.nodes[ends[0]].name}», а канал "
            f"не указан — добавьте channel: имя топика/очереди",
            report.owner_of_edges([ei]),
        )
    if hidden:
        report.warn(
            f"…ещё {hidden} таких связей с брокером", report.owner_of_edges(hidden_idxs)
        )


def _warn_channel_lists(merged: ParsedImport, report: MergeReport, skip: set[int]) -> None:
    """Связи, у которых в channel не имя канала, а ПЕРЕЧЕНЬ имён.

    Находка №2 полевого QA (docs/qa-zulip-brokers.md): агент кладёт в поле
    «email, notify_orders, digest_emails». Правило промпта («одна пара ходит по
    нескольким топикам — это несколько рёбер, по ребру на канал») есть и прямое, но
    исполняется через раз, а машинной проверки формы не было ни в превью, ни в
    валидаторе — промах всплывал уже после импорта нечитаемым AL31. Тот же урок Х5,
    что у соседей: правило дисперсно, цель называет машина.

    Разделителем считаем запятую и точку с запятой. Точки, дефисы и версии в имени
    канала — норма («orders.created», «notify-orders»), и подозрений не вызывают.

    skip — связи класса «узел и его собственный потомок» (та же причина, что у
    брокерного класса: разделять на несколько связей нечего, связь лишняя целиком).
    """
    shown = hidden = 0
    hidden_idxs: list[int] = []
    for ei, e in enumerate(merged.edges):
        if ei in skip or not _fill(e.channel) or not any(sep in e.channel for sep in (",", ";")):
            continue
        if shown >= _MAX_CHANNEL_LIST_EDGES:
            hidden += 1
            hidden_idxs.append(ei)
            continue
        shown += 1
        a, b = merged.nodes[e.source_idx].name, merged.nodes[e.target_idx].name
        report.warn(
            f"связь «{a} → {b}»: в channel перечень «{e.channel.strip()}» — разделите "
            f"на отдельные связи, по одной на канал",
            report.owner_of_edges([ei]),
        )
    if hidden:
        report.warn(
            f"…ещё {hidden} таких связей с перечнем в channel",
            report.owner_of_edges(hidden_idxs),
        )


def _warn_isolated_groups(merged: ParsedImport, report: MergeReport) -> None:
    """Группы объектов, связанные между собой, но оторванные от остальной схемы.

    Полевая валидация Ф8: превью говорило про ОДИНОЧЕК, а компонента из двух узлов
    («актор → его интерфейс», связанные друг с другом и больше ни с чем) проходила
    молча и всплывала алертом «Незавершённость схемы» уже после создания проекта —
    когда агент ушёл и дорисовать связь некому. Тот же урок Х5, что у связей в
    контейнер: предупреждаем ДО импорта и НАЗЫВАЕМ группу поимённо.

    Ядро связности — общее с алертом (app.connectivity), поэтому вердикты сходятся; там же
    исключение «связь в коробку касается её поддерева» (AL7, 2026-09-06) — связь плагина в
    контейнер продукта не делает внутренности продукта «отдельной группой».
    Крупнейшую компоненту не называем: она и есть схема, а замечание должно указывать,
    ЧТО прицепить, а не пересказывать проект.

    Виновные (Ф7) — узлы самой группы: у одного файла остров получился, ему и
    дорисовывать связь (в Ф6 класс был жёстко схемным, и один и тот же файл получал
    разный ответ в зависимости от того, сколько документов лежит рядом, — находка
    пользователя). Остров из узлов РАЗНЫХ файлов адресата не имеет: свести его с
    ядром может только тот, кто видит оба репозитория. Остров, ПОГАШЕННЫЙ слиянием,
    в слитом графе не существует — замечания нет вовсе, и это правильно: подсистема
    вправе держаться за мир через чужой репозиторий.
    """
    comps = connected_components(
        [(e.source_idx, e.target_idx) for e in merged.edges],
        {i: n.parent_idx for i, n in enumerate(merged.nodes)},
    )
    if len(comps) < 2:
        return  # один кластер (плюс, возможно, одиночки) — фрагментации нет
    # Ядро — самая крупная; при равных размерах порядок задаёт первое имя, иначе
    # «ядром» становилось бы то одно, то другое от прогона к прогону.
    comps.sort(key=lambda c: (-len(c), sorted(merged.nodes[i].name for i in c)))
    for comp in comps[1 : _MAX_ISOLATED_GROUPS + 1]:
        report.isolated_groups.append(
            IsolatedGroupRec(node_idxs=sorted(comp), warning_idx=len(report.warnings))
        )
        names = [merged.nodes[i].name for i in sorted(comp)]
        shown = ", ".join(f"«{n}»" for n in names[:_MAX_GROUP_NAMES])
        tail = f" и ещё {len(names) - _MAX_GROUP_NAMES}" if len(names) > _MAX_GROUP_NAMES else ""
        report.warn(
            f"группа из {len(names)} объектов не связана с остальной схемой: {shown}{tail} — "
            f"дорисуйте связь с ядром или проверьте, не потерялась ли она",
            report.owner_of_nodes(comp),
        )
    hidden_comps = comps[_MAX_ISOLATED_GROUPS + 1 :]
    if hidden_comps:
        # Скрытые за счётчиком группы — тоже вопросы (кап у текста, не у структуры).
        for comp in hidden_comps:
            report.isolated_groups.append(
                IsolatedGroupRec(node_idxs=sorted(comp), warning_idx=len(report.warnings))
            )
        # Хвост-счётчик — только тому, чьи все скрытые группы (как у соседних классов).
        report.warn(
            f"…ещё {len(hidden_comps)} таких групп",
            report.owner_of_nodes([i for comp in hidden_comps for i in comp]),
        )
