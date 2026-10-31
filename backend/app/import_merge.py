"""Слияние нескольких разобранных импортов в один (сценарий «Из репозитория»:
один промпт × N репозиториев системы → N YAML → один проект).

Мерджим РАЗОБРАННЫЕ структуры (ParsedImport), а не YAML-тексты: ссылки рёбер уже
разрезолвлены parse_import'ом внутри своего файла, поэтому кросс-файловой
неоднозначности имён в ссылках не существует. Идентичность узла — нормализованное
имя в пределах одного СМЕРДЖЕННОГО родителя (то есть фактически путь
«Система / Сервис / …»). Поля сливаются по правилу «богатое побеждает»
(заполненное бьёт пустое, не-дефолт бьёт дефолт); расхождения заполненных
значений не решаются молча — побеждает СОДЕРЖАТЕЛЬНЫЙ вклад (_substantial), а при
равной содержательности первое по порядку файлов, и факт в обоих случаях уходит
строкой в отчёт. Fuzzy-похожие имена НИКОГДА не склеиваются автоматически
(ложная склейка двух разных сервисов хуже дубля) — только предупреждение.

Результат детерминирован; порядок файлов влияет лишь на tie-break конфликтов
равной содержательности, и это видно в отчёте. Выход совместим с seed_import без
изменений (порядок «родители раньше детей» сохраняется по построению).

Элемент архитектуры (docs/plan-c4-elements.md, Р30) трёхзначен: «не сказано» (None)
уступает любому значению, «система» против «контейнера» — спор поля по тому же правилу
П2. Слитое дерево проверяется той же санитизацией, что и один файл (app/import_element):
база из одного файла внутри контейнера другого снимает контейнер с замечанием.

Площадки развёртывания склеиваются ПО ИМЕНИ (имя площадки уникально в проекте, на
него и ссылаются узлы): первая объявившая задаёт вид, технологию и описание, родитель —
первый непустой; у склеенного узла sites — объединение в порядке первого появления.
"""

from collections.abc import Callable, Iterable
from dataclasses import replace
from difflib import SequenceMatcher

from app.domain_types import NodeElement
from app.identity import (
    KEY_ORDER,
    basis_of_key,
    basis_of_type,
    compare_identity,
    key_type,
    merge_key_sets,
    strongest_common_type,
)
from app.import_element import sanitize_elements, tree_paths
from app.import_yaml import (
    MAX_EDGES,
    MAX_NODES,
    ParsedImport,
    _ImpEdge,
    _ImpNode,
    _ImpSite,
    order_sites,
    parse_import,
)
from app.merge_report import FieldDispute, FuzzyPairRec, MergeReport, _fill
from app.merge_warnings import warn_content
from app.text import identity_name

# Порог похожести имён сиблингов для предупреждения «возможно, одно и то же».
_FUZZY_RATIO = 0.78
# Группы сиблингов крупнее этого попарно не сравниваем (квадратичная стоимость;
# реальные уровни на порядки меньше — защита от патологического входа).
_FUZZY_GROUP_LIMIT = 250
_MAX_WARNINGS = 30
# Общий repo без path у нескольких узлов: сколько имён называем в одной строке и
# сколько таких источников показываем, прежде чем свернуть остаток в счётчик.
# Причина капов та же, что у соседей: замечания уезжают агенту одним списком, и
# монорепо на полсотни сервисов вытеснило бы всё остальное.
_MAX_SHARED_SOURCE_NAMES = 6
_MAX_SHARED_SOURCE_GROUPS = 10
# Поля узла, которые СЛИВАЮТСЯ вкладами разных файлов (и, значит, могут спорить).
# Имени и родителя здесь нет намеренно: их решает создатель узла — перевешивать
# поддерево поздним файлом опаснее, чем оставить расхождение видимым в отчёте.
_MERGED_FIELDS = (
    "role", "technology", "description", "shape", "status", "is_external", "element"
)
# Сколько раз повторяем проход ради стабилизации склейки (_regroup). Каждый повтор
# строго уменьшает число узлов, так что цикл сходится сам; кап — защита от
# патологического входа, а не рабочий предел (на практике хватает одного повтора).
_MAX_STABILIZE_PASSES = 5

# ОСНОВАНИЕ СКЛЕЙКИ — чем два вклада признаны одним объектом (Ф2
# docs/plan-anchor-ux.md). Словарь ЕДИНЫЙ на бэк и фронт: пользователь читает
# «по коду» / «по имени зависимости» / «по имени», а не технические «git:»/«host:».
# Порядок — убывание различающей силы (тот же, что у KEY_ORDER, плюс имя в хвосте):
# у склеенного узла показываем СИЛЬНЕЙШЕЕ основание среди его вкладов.
BASIS_ORDER = ("code", "dependency", "name")


def union_sites(a: list[str], b: list[str]) -> list[str]:
    """Имена площадок двух вкладов одного объекта — объединением в порядке первого
    появления. Новый список: исходные вклады остаются нетронутыми."""
    return [*a, *(name for name in b if name not in a)]


def _strongest_basis(bases: list[str]) -> str | None:
    """Сильнейшее основание среди вкладов узла; пусто (узел из одного файла) → None."""
    return next((b for b in BASIS_ORDER if b in bases), None)


def _substantial(node: _ImpNode, has_children: bool) -> bool:
    """Содержательность ВКЛАДА файла в узел: файл раскрыл узел компонентами либо
    назвал его репозиторий (source.repo → ключ типа git).

    Формализация полевого кейса федерации (docs/plan-federation-tuning.md, П2):
    сосед описывает чужой продукт ЗАГЛУШКОЙ — имя, сетевой хост, угаданная
    technology, external: true, — и такой вклад не должен решать спор о полях с
    файлом, который этот продукт реально разбирал. Градаций ровно две: «видел
    изнутри» (репозиторий или компоненты) против «видел снаружи»; тонких шкал не
    вводим — их пришлось бы объяснять пользователю в отчёте.

    Дети считаются по СВОЕМУ файлу, а не по слитому дереву: в слитом узел раскрыт
    чужими компонентами, и заглушка задним числом стала бы содержательной."""
    return has_children or any(key_type(k) == "git" for k in node.source_keys)


def _compare_anchors(a: list[str], b: list[str]) -> str:
    """Один ли это узел по якорям: «same» | «different» | «unknown» (матчер v3 + К3).

    Решает СИЛЬНЕЙШИЙ ОБЩИЙ тип ключа — ровно правило app.identity.compare_identity,
    к которому мердж вернулся в К3 (docs/plan-tuning-round2.md, находка 3 матрицы
    docs/qa-federation-matrix.md). Читается оно так: совпадение СЛАБОГО поля гасит
    противоречие СИЛЬНОГО только тогда, когда у одной из сторон сильного поля НЕТ
    (тогда общим оказывается слабый тип, и он же решает). Знают своё repo обе
    стороны, и оно разное — это разные сущности, никакой общий host их не спасает.

    Почему прежнее мягкое правило («совпадение ЛЮБОГО типа гасит противоречие
    остальных», П3 прошлой итерации) снято: оно чинило один полевой случай и ломало
    другой. Чинило — заглушку соседа {host: grafana}, у которой repo НЕТ вовсе: она
    обязана склеиться с продуктом (и склеивается до сих пор, потому что общего
    сильного типа у них нет). Ломало — плагин {repo плагина, host grafana}, который
    сливался с ядром продукта {repo продукта, host grafana}: совпавший host гасил
    противоречие repo, и в схеме федерации плагин выдавал себя за ядро (6 из 12
    схемных строк «имя/родитель/role/technology/description отброшено» и путаница
    ролей). Ложная склейка хуже дубля: дубль видно глазами, склейка выглядит
    корректной схемой.

    Настоящие тёзки (сильнейший общий тип расходится) раздельны, как и были. Синк
    живой схемы (app/sync_plan) держится того же compare_identity — после К3 у
    мерджа и синка ОДИН предикат идентичности, отдельного «мягкого» режима нет."""
    return compare_identity(a, b)


def _bridged(a: list[tuple[int, int, list[str]]], b: list[tuple[int, int, list[str]]]) -> bool:
    """Можно ли объединить две группы вкладов (матчер v3 + К3): есть пара вкладов с
    якорями по обе стороны, и НИ ОДНА пара вкладов друг другу не противоречит.

    Зачем сравнивать вклады, а не накопленные множества ключей: накопленное растёт
    по ходу прохода, поэтому строгая проверка против него делает результат зависимым
    от порядка файлов. Полевой контрпример — продукт федерации: если заглушка соседа
    легла РАНЬШЕ своего продукта, узел уже нёс её host, и вклад продукта сравнивался
    бы с накопленным, а не с тем, кто его туда положил.

    Почему у обоих сторон якоря обязательны: вклад БЕЗ якорей не свидетельствует ни
    о чём — он попал в узел по имени, и позволить ему связать двух чужих друг другу
    тёзок значило бы вернуть молчаливую ложную склейку, ради которой якоря и
    заводились (она хуже дубля: выглядит как корректная схема).

    Почему «ни одна пара не противоречит», а не «хоть одна не противоречит» (К3):
    свидетель гасит противоречие только там, где его нет по К3-предикату. Иначе
    заглушка {host: grafana}, совместимая и с ядром продукта, и с плагином, служила
    бы мостом между ними — и стабилизация задним числом собрала бы ровно ту ложную
    склейку, которую К3 запретил в паре. Проверка идёт по ВСЕМ вкладам обеих групп
    (не только тех двух узлов, что сравниваются), иначе мост навела бы транзитивность
    union-find: A+свидетель, свидетель+B → A и B в одной группе вопреки их спору."""
    verdicts = [
        _compare_anchors(ka, kb) for _fa, _na, ka in a for _fb, _nb, kb in b if ka and kb
    ]
    return bool(verdicts) and all(v != "different" for v in verdicts)


def _rank_keys(keys: list[str], strong: list[str]) -> list[str]:
    """Порядок якорей склеенного узла: тип по убыванию силы (как merge_key_sets), а
    внутри типа — ключи СОДЕРЖАТЕЛЬНОГО вклада раньше.

    Первый ключ уезжает в nodes.source_ref (seed_import) и служит опознанием узла
    для будущих прогонов: у продукта там обязано стоять репо продукта, а не репо
    плагина, вписавшего в его узел своё (П2 для якоря). Сортировка стабильная —
    порядок внутри равных групп остаётся от merge_key_sets."""
    order = {t: i for i, t in enumerate(KEY_ORDER)}
    return sorted(keys, key=lambda k: (order.get(key_type(k), len(order)), k not in strong))


def _similar(a: str, b: str) -> bool:
    """Похожи ли нормализованные имена: вложение подстроки (payments ⊂
    payments-service) либо высокий difflib-ratio (опечатки, суффиксы)."""
    if a == b:
        return False  # равные склеились бы раньше — сюда не попадают
    short, long_ = (a, b) if len(a) <= len(b) else (b, a)
    if len(short) >= 4 and short in long_:
        return True
    return SequenceMatcher(None, a, b).ratio() >= _FUZZY_RATIO


def _repo_no_path(key: str) -> bool:
    """Ключ-репозиторий БЕЗ пути внутри него: «git:host/org/repo», а не «…#api».

    Ровно тот случай, о котором говорит пункт 12 чек-листа промпта: repo, стоящий у
    НЕСКОЛЬКИХ узлов без path, их не различает — оба получают один якорь, и дальше
    решает не смысл, а порядок файлов. Ключ с path («git:repo#api») различает
    сервисы монорепо и под правило не подпадает.

    Остальные типы ключей (img/k8s/host) сюда не входят намеренно: у них другой
    ответ. Общий host — законное соседство (плагин и ядро продукта живут на одном
    сетевом имени, К3), и звать там «уточните path» было бы неверным советом."""
    return key.startswith("git:") and "#" not in key


def _names_phrase(names: Iterable[str]) -> str:
    """Перечень имён с честным хвостом: «A» и «B»; «A», «B», … и ещё 4.

    Порядок АЛФАВИТНЫЙ, а не документный: от перестановки файлов в панели зависит,
    какой из узлов встретится раньше, а текст замечания шевелиться от этого не
    должен (то же правило, что у перечня кандидатов в parse_import). Хвост считаем,
    а не молчим о нём: пользователь должен знать, что список шире показанного."""
    ordered = sorted(names)
    shown = [f"«{n}»" for n in ordered[:_MAX_SHARED_SOURCE_NAMES]]
    if len(ordered) > len(shown):
        return f"{', '.join(shown)} и ещё {len(ordered) - len(shown)}"
    if len(shown) == 1:
        return shown[0]
    return f"{', '.join(shown[:-1])} и {shown[-1]}"


def _files_phrase(files: list[int], one: str, many: str) -> str:
    """Номера файлов словами: «файлу 2», «файлам 1 и 3» (нумерация с 1, как в UI)."""
    nums = [str(fi + 1) for fi in files]
    if len(nums) == 1:
        return f"{one} {nums[0]}"
    return f"{many} {', '.join(nums[:-1])} и {nums[-1]}"


def _warn_shared_repo(nodes: list[_ImpNode], report: MergeReport) -> None:
    """Один repo БЕЗ path у НЕСКОЛЬКИХ узлов результата — поимённо.

    Пункт 12 чек-листа промпта требует у каждого узла свой path, если repo стоит не
    на одном; машинной проверки требования не было, и промах агента (монорепо одним
    repo на все сервисы) не показывался нигде. Последствие тихое, но тяжёлое: якорь
    у таких узлов один, и по нему находится ТОЛЬКО ОДИН из них — им свяжется
    следующий файл пакета (_match_by_source) и будущий синк живой схемы (sync_plan
    держит по source_ref первый попавшийся узел). Урок Х5 тот же, что у соседних
    классов: правило в промпте есть, соблюдается через раз — цель называет машина.

    Проверка живёт в СЛИЯНИИ, а не в warn_content: она про идентичность узлов
    (ключи источника), а не про содержание схемы. Одно-файловый passthrough зовёт
    её отдельно — иначе один и тот же документ молчал бы в одиночку и предупреждал
    в пакете, а это ровно тот перекос, который снял Ф7 (ответ не должен зависеть от
    состава панели).

    Адресат — по общему правилу Ф7 (owner_of_nodes): виновные сущности — сами
    узлы, и один файл, повесивший общий repo на свои сервисы, чинит это сам."""
    groups: dict[str, list[int]] = {}
    for i, n in enumerate(nodes):
        for k in n.source_keys:
            if _repo_no_path(k):
                groups.setdefault(k, []).append(i)
    shown = hidden = 0
    hidden_idxs: list[int] = []
    for k in sorted(groups):  # алфавит ключа: порядок строк не зависит от файлов
        idxs = groups[k]
        if len(idxs) < 2:
            continue
        if shown >= _MAX_SHARED_SOURCE_GROUPS:
            hidden += 1
            hidden_idxs.extend(idxs)
            continue
        shown += 1
        report.warn(
            f"{_names_phrase(nodes[i].name for i in idxs)} указывают один источник "
            f"({k}) — задайте каждому свой source.path, иначе следующее обновление "
            f"из кода свяжется только с одним из них",
            report.owner_of_nodes(idxs),
        )
    if hidden:
        # Хвост-счётчик — тому, чьи все скрытые источники (как у соседних классов).
        report.warn(
            f"…ещё {hidden} таких источников", report.owner_of_nodes(hidden_idxs)
        )


class _Merger:
    """Состояние одного прогона слияния (класс вместо замыканий — читаемость)."""

    def __init__(
        self,
        files: int,
        force: dict[tuple[int, int], int] | None = None,
        pinned_file: int | None = None,
    ):
        self.report = MergeReport(files=files)
        # Вход, чьи объекты санитизация элемента не переносит: снимок живого проекта у
        # догрузки (вход №0). None — переносить можно всё (создание проекта).
        self.pinned_file = pinned_file
        self.nodes: list[_ImpNode] = []  # копии узлов, порядок «родители раньше детей»
        self.paths: list[str] = []  # полный путь merged-узла (для отчёта)
        self.sources: list[set[int]] = []  # какие файлы внесли вклад в узел
        # Вклады узла ПО ОТДЕЛЬНОСТИ: (файл, индекс узла в файле, его якорные ключи).
        # Слитый набор ключей (_ImpNode.source_keys) для сравнения идентичности не
        # годится — он растёт по ходу прохода и делает исход зависимым от порядка
        # файлов; стабилизация (_regroup) сравнивает именно вклады.
        self.contribs: list[list[tuple[int, int, list[str]]]] = []
        # Основания склеек узла: по строке на КАЖДЫЙ вклад сверх создающего (Ф2
        # якорей). Пустой список = узел из одного файла. Считается ПОСЛЕ решения
        # матчера и на решение не влияет — это доклад пользователю, чем сошлось.
        self.basis: list[list[str]] = []
        # merged-индексы строк report.merged_paths (строка в строку): по ним finish
        # проставит merged_basis уже итоговыми, сильнейшими основаниями.
        self.merged_idxs: list[int] = []
        # Склейки, установленные стабилизацией предыдущего прохода: атом (файл,
        # индекс в файле) → номер группы, и группа → уже созданный узел.
        self.force = force or {}
        self.by_group: dict[int, int] = {}
        # Был ли среди вкладов хоть один СОДЕРЖАТЕЛЬНЫЙ (_substantial): им решается
        # порядок якорей склеенного узла (_rank_keys).
        self.substantial: list[bool] = []
        # Чей вклад дал ТЕКУЩЕЕ значение каждого сливаемого поля: (файл,
        # содержательность вклада). Нужно и для честных номеров файлов в строке
        # конфликта, и для правила П2: спорит не «файл с файлом», а источник
        # текущего значения с источником нового.
        self.value_src: list[dict[str, tuple[int, bool]]] = []
        # Открытые споры полей (Ф-E): (узел, поле) → запись в report.field_disputes.
        # Копим в ОДНУ запись: третий файл добавляет кандидата, а не второй спор.
        self.disputes: dict[tuple[int, str], FieldDispute] = {}
        # Рецепты строк report.conflicts (строка в строку): пересборка по путям после
        # санитизации элемента (settle_elements).
        self._conflict_lines: list[Callable[[], str]] = []
        # (merged-родитель, норм-имя) → кандидаты. Список, а не один idx: якорь
        # может РАЗВЕСТИ двух тёзок в одном родителе (разные репозитории), и оба
        # обязаны остаться адресуемыми для следующих файлов.
        self.by_key: dict[tuple[int | None, str], list[int]] = {}
        # канонический ключ источника → idx узла. Индекс ГЛОБАЛЬНЫЙ (не в пределах
        # родителя): якорь сильнее иерархии — им ловится сервис, которого разные
        # прогоны положили под разных родителей или назвали по-разному.
        self.by_source: dict[str, int] = {}
        # Склейки РАЗНОИМЁННЫХ узлов по repo без path: (узел-приёмник, ключ) → имена
        # всех слитых в него. Показать их иначе нечем — после слияния второго узла в
        # результате уже нет, и его имя видно только здесь (см. _warn_absorbed).
        self.absorbed: dict[tuple[int, str], set[str]] = {}
        self.edges: list[_ImpEdge] = []
        # какие файлы принесли связь (первоисточник + принесшие тот же дубль) —
        # атрибуция замечаний о конкретной связи (Ф6).
        self.edge_files: list[set[int]] = []
        # ключ дубля → (индекс в self.edges, файл-первоисточник). Индекс нужен,
        # чтобы дубль мог ДОЛИТЬ каналом уже принятую связь, а не пропасть целиком.
        self.edge_seen: dict[tuple[int, int, str, str], tuple[int, int]] = {}
        # (src, dst) → [(label, файл)] — для предупреждения о похожих рёбрах.
        self.pair_labels: dict[tuple[int, int], list[tuple[str, int]]] = {}
        # Площадки по имени. Родитель — ИМЕНЕМ до finish: первый непустой может
        # прийти поздним файлом, и порядок «родители раньше детей» строится в конце.
        self.sites: list[_ImpSite] = []
        self.site_index: dict[str, int] = {}
        self.site_parent: list[str | None] = []

    # ── узлы ──────────────────────────────────────────────────────────────

    def _conflict(
        self, idx: int, fld: str, kept: str, dropped: str, keep_fi: int, drop_fi: int
    ) -> None:
        """Строка расхождения: номера файлов — источники ОСТАВЛЕННОГО и ОТБРОШЕННОГО
        значений (а не «первый вкладчик узла»: значение могло прийти не с созданием,
        а доливкой третьего файла, и победить тоже мог не первый — см. _decide)."""
        self._add_conflict(
            lambda: f"{self.paths[idx]}: {fld}: оставлено «{kept}» (файл {keep_fi + 1}), "
            f"отброшено «{dropped}» (файл {drop_fi + 1})"
        )

    def _add_conflict(self, render: Callable[[], str]) -> None:
        """Строка расхождения — текстом сейчас и рецептом на потом: пути узлов меняет
        санитизация элемента (база выносится из контейнера), и settle_elements
        пересобирает строки по дереву после неё."""
        self._conflict_lines.append(render)
        self.report.conflicts.append(render())

    def _decide(self, idx: int, fld: str, cur: str, new: str, fi: int, sub: bool) -> None:
        """Спор двух ЗАПОЛНЕННЫХ значений одного поля (П2): побеждает СОДЕРЖАТЕЛЬНЫЙ
        вклад независимо от порядка файлов, при равной содержательности — прежнее
        «первый побеждает». Строка отчёта остаётся в обоих случаях: молча слияние
        не решает, кто прав.

        ВОПРОСОМ пользователю (Ф-E) становится только равная содержательность: там,
        где один вклад видел узел изнутри, спрашивать не о чем — правило П2 знает
        ответ, и спор существует лишь как строка «для чтения»."""
        keep_fi, keep_sub = self.value_src[idx][fld]
        if sub and not keep_sub:
            setattr(self.nodes[idx], fld, new)
            self.value_src[idx][fld] = (fi, sub)
            self._conflict(idx, fld, new, cur, fi, keep_fi)
            # Содержательный вклад пришёл ПОСЛЕ спора двух заглушек и победил их
            # обеих: вопрос снимается — ответ на него переиграл бы правило П2.
            self._drop_dispute(idx, fld)
            return
        self._conflict(idx, fld, cur, new, keep_fi, fi)
        if sub == keep_sub:
            self._note_dispute(idx, fld, keep_fi, cur, fi, new)

    def _note_dispute(
        self, idx: int, fld: str, keep_fi: int, cur: str, fi: int, new: str
    ) -> None:
        """Копить кандидатов спора в одну запись: первым — источник текущего
        значения (он же дефолт «первый побеждает»), дальше по порядку файлов."""
        rec = self.disputes.get((idx, fld))
        if rec is None:
            rec = FieldDispute(node_idx=idx, field=fld, contributions=[(keep_fi, cur)])
            self.disputes[(idx, fld)] = rec
            self.report.field_disputes.append(rec)
        if all(v.strip() != new.strip() for _f, v in rec.contributions):
            rec.contributions.append((fi, new))

    def _drop_dispute(self, idx: int, fld: str) -> None:
        rec = self.disputes.pop((idx, fld), None)
        if rec is not None:
            self.report.field_disputes.remove(rec)

    def _merge_str(self, idx: int, fld: str, new: str | None, fi: int, sub: bool) -> None:
        cur = getattr(self.nodes[idx], fld)
        if not _fill(new) or (_fill(cur) and cur.strip() == new.strip()):
            return
        if not _fill(cur):
            # Пустое против заполненного — не спор, а доливка (правило прежнее).
            setattr(self.nodes[idx], fld, new)
            self.value_src[idx][fld] = (fi, sub)
            return
        self._decide(idx, fld, cur, new, fi, sub)

    def _merge_enum(self, idx: int, fld: str, new: str, default: str, fi: int, sub: bool) -> None:
        # shape/status: не-дефолт бьёт дефолт (явный дефолт после парсинга
        # неотличим от отсутствия поля — считаем его самым слабым утверждением;
        # содержательность вклада этого не меняет — утверждения тут просто нет).
        cur = getattr(self.nodes[idx], fld)
        if new in (default, cur):
            return
        if cur == default:
            setattr(self.nodes[idx], fld, new)
            self.value_src[idx][fld] = (fi, sub)
            return
        self._decide(idx, fld, cur, new, fi, sub)

    def _merge_element(self, idx: int, new: NodeElement | None, fi: int, sub: bool) -> None:
        """Элемент архитектуры — трёхзначное поле (Р2, Р30): None («не сказано») уступает
        любому значению в обе стороны, равные значения не спорят, «система» против
        «контейнера» — спор П2 (_decide). _merge_enum здесь не годится: у него явный
        дефолт неотличим от отсутствия, а у элемента «не сказано» — отдельное значение,
        и «система», сказанная файлом, — такое же утверждение, как «контейнер»."""
        cur = self.nodes[idx].element
        if new is None or new == cur:
            return
        if cur is None:
            self.nodes[idx].element = new
            self.value_src[idx]["element"] = (fi, sub)
            return
        self._decide(idx, "element", cur, new, fi, sub)

    def _match_by_source(self, node: _ImpNode, fi: int) -> tuple[int | None, str | None]:
        """Матч по якорю — ГЛОБАЛЬНО, поверх имени и иерархии: ловит сервис, которого
        разные прогоны назвали по-разному или положили под разных родителей.

        Совпавшего ключа МАЛО (К3): решает тот же предикат, что и везде, —
        сильнейший общий тип (_compare_anchors). Совпал host, но обе стороны знают
        своё repo и оно разное — кандидат не подходит, ищем дальше по остальным
        ключам. Полевой случай федерации: плагин и ядро продукта живут на одном
        сетевом имени «grafana», и до К3 это склеивало их в один узел.

        Узлы ОДНОГО файла не склеиваются никогда, даже при совпавшем якоре: внутри
        файла агент развёл их осознанно (тот же принцип, что в warn_fuzzy_siblings).
        Без этого монорепо схлопывалось — агент вешает один git-remote на все свои
        сервисы, и «backend» вместе с поддеревом растворялся во «frontend»
        (найдено прогоном на реальном репозитории 2026-08-07)."""
        for k in node.source_keys:
            hit = self.by_source.get(k)
            if hit is None or fi in self.sources[hit]:
                continue
            # Ключ k общий по построению (by_source отдаёт узел, у которого он есть),
            # поэтому вердикт здесь — только «same» либо «different».
            if _compare_anchors(self.nodes[hit].source_keys, node.source_keys) == "different":
                continue
            # Основание — вид СОВПАВШЕГО ключа: по нему узлы и признаны одним.
            return hit, basis_of_key(k)
        return None, None

    def _match_by_name(self, node: _ImpNode, parent_m: int | None) -> int | None:
        """Матч по имени в пределах слитого родителя — прежнее поведение, но с
        предохранителем: тёзка с ПРОТИВОРЕЧАЩИМ якорем не склеивается. Противоречие
        решает сильнейший общий тип ключа (_compare_anchors, К3): тёзки с разными
        репозиториями раздельны, даже когда сетевое имя у них общее, а тёзка, у
        которой репозитория НЕТ вовсе, склеивается как раньше."""
        for idx in self.by_key.get((parent_m, identity_name(node.name)), []):
            if _compare_anchors(self.nodes[idx].source_keys, node.source_keys) == "different":
                # Замечание о ФАЙЛАХ (тёзки из разных прогонов) — виноватого нет.
                self.report.warn(
                    f"«{node.name}» ({self._where(parent_m)}) встречается в файлах как РАЗНЫЕ "
                    f"объекты (различаются источники) — оставлены раздельно"
                )
                continue
            return idx
        return None

    def _where(self, parent_m: int | None) -> str:
        return f"внутри «{self.paths[parent_m]}»" if parent_m is not None else "на верхнем уровне"

    def _register(self, idx: int, node: _ImpNode, parent_m: int | None, fi: int) -> None:
        """Узел адресуем и по имени в родителе, и по каждому своему якорю."""
        self.by_key.setdefault((parent_m, identity_name(node.name)), []).append(idx)
        for k in self.nodes[idx].source_keys:
            taken = self.by_source.get(k)
            if taken is not None and fi in self.sources[taken]:
                # Один якорь на два узла ОДНОГО файла: агент повесил общий
                # git-remote (или образ, или хост) на несколько своих сервисов, не
                # различив их. Склеивать нельзя (см. _match_by_source), но
                # следующие файлы найдут по этому ключу только первого.
                # Про repo без path об этом говорит _warn_shared_repo — там же
                # готовый ответ (source.path), кап на перечень и адресация Ф7, и
                # там же ловится одно-файловый пакет, до которого слияние не
                # доходит вовсе. Здесь остаются прочие типы ключей: у них ответ
                # другой, а молчать о совпадении всё равно нельзя.
                if not _repo_no_path(k):
                    self.report.warn(
                        f"«{self.nodes[taken].name}» и «{node.name}» указывают один "
                        f"источник ({k}) — разведите source у каждого, иначе следующие "
                        f"файлы свяжутся только с первым"
                    )
                continue
            self.by_source.setdefault(k, idx)

    def _remember_group(self, idx: int, fi: int, ni: int) -> None:
        """Узел, в который лёг атом группы, — адресат для остальных её атомов."""
        gid = self.force.get((fi, ni))
        if gid is not None:
            self.by_group.setdefault(gid, idx)

    def _match_by_group(self, node: _ImpNode, fi: int, ni: int) -> tuple[int | None, str | None]:
        """Склейка, УЖЕ установленная стабилизацией предыдущего прохода (v3): решение
        принято на полном результате, где виден каждый вклад, поэтому оно сильнее
        инкрементальных матчеров и проверяется первым. Узлы одного файла не
        склеиваются и здесь — правило общее для всех матчеров."""
        gid = self.force.get((fi, ni))
        if gid is None:
            return None, None
        hit = self.by_group.get(gid)
        if hit is None or fi in self.sources[hit]:
            return None, None
        # Основание группы восстанавливается, а не хранится: решение стабилизации
        # принято на ПРОШЛОМ проходе (_regroup видит все вклады сразу), и «какой
        # именно ключ свёл» там не единственный — группу мог связать свидетель с
        # якорями по обе стороны. Поэтому называем сильнейшую ОБЩУЮ грань пары
        # «уже собранный узел ↔ новый вклад»: она и есть то, чем они признаны одним.
        # Общей грани нет (у вклада якорей нет вовсе) — сошлись по имени: группы
        # строятся из ОДНОИМЁННЫХ узлов одного родителя, другого основания там нет.
        common = strongest_common_type(self.nodes[hit].source_keys, node.source_keys)
        return hit, basis_of_type(common)

    def _note_absorbed(self, hit: int, node: _ImpNode) -> None:
        """Запомнить склейку узлов с РАЗНЫМИ именами по общему repo без path.

        Одноимённые сюда не попадают: у них склейка — штатная работа матчера (один
        сервис, описанный двумя прогонами), и предъявлять пользователю нечего.
        Разные имена при общем repo без path — либо переименованный сервис, либо
        два сервиса монорепо, которых нечем различить; какой из двух случаев —
        знает только пользователь, поэтому машина называет факт и ответ.

        Вызывать ДО merge_key_sets: сравнение идёт с ключами ПРИНЯВШЕГО узла, а
        после слияния наборов общими стали бы все ключи новичка."""
        if identity_name(node.name) == identity_name(self.nodes[hit].name):
            return
        for k in node.source_keys:
            if _repo_no_path(k) and k in self.nodes[hit].source_keys:
                self.absorbed.setdefault((hit, k), {self.nodes[hit].name}).add(node.name)

    def add_node(self, node: _ImpNode, parent_m: int | None, fi: int, ni: int, sub: bool) -> int:
        hit, basis = self._match_by_group(node, fi, ni)
        if hit is None:
            hit, basis = self._match_by_source(node, fi)
        if hit is None:
            hit = self._match_by_name(node, parent_m)
            basis = "name" if hit is not None else None
        if hit is None:
            idx = len(self.nodes)
            self.nodes.append(replace(node, parent_idx=parent_m, sites=list(node.sites)))
            prefix = f"{self.paths[parent_m]} / " if parent_m is not None else ""
            self.paths.append(prefix + node.name)
            self.sources.append({fi})
            self.substantial.append(sub)
            self.contribs.append([(fi, ni, list(node.source_keys))])
            self.basis.append([])
            # Все поля нового узла пришли из этого файла — спорить с ними следующие
            # будут против его содержательности.
            self.value_src.append(dict.fromkeys(_MERGED_FIELDS, (fi, sub)))
            self._remember_group(idx, fi, ni)
            self._register(idx, node, parent_m, fi)
            return idx
        self.contribs[hit].append((fi, ni, list(node.source_keys)))
        # basis здесь заведомо не None: сюда приводит только сработавший матчер.
        self.basis[hit].append(basis or "name")
        self._remember_group(hit, fi, ni)
        # До слияния наборов ключей ниже: после него общими окажутся все ключи
        # новичка, и «по какому основанию склеились» уже не восстановить.
        self._note_absorbed(hit, node)
        # Узел уже есть — склейка полей. Имя оставляем первое встреченное
        # (различие лишь в регистре/пробелах — в отчёт не шумим).
        if fi not in self.sources[hit] and len(self.sources[hit]) == 1:
            self.report.merged_paths.append(self.paths[hit])
            self.merged_idxs.append(hit)
        # Якорь связал узлы, названные ПО-РАЗНОМУ (в своём репозитории сервис зовётся
        # «app», вызывающие ходят на «payments») либо положенные под разных родителей.
        # Оставляем первое — перевешивать поддерево по позднему файлу опаснее, чем
        # оставить расхождение видимым в отчёте.
        creator = min(self.sources[hit])  # имя и место узла всегда от создателя
        if identity_name(node.name) != identity_name(self.nodes[hit].name):
            self._conflict(hit, "имя", self.nodes[hit].name, node.name, creator, fi)
        kept_parent = self.nodes[hit].parent_idx
        if parent_m != kept_parent:
            top = "верхний уровень"
            self._conflict(
                hit,
                "родитель",
                self.paths[kept_parent] if kept_parent is not None else top,
                self.paths[parent_m] if parent_m is not None else top,
                creator,
                fi,
            )
        # Грани источника у прогонов разные — склеенный узел наследует все, иначе
        # следующий файл не найдёт его по той грани, которой не досталось. Порядок
        # внутри типа решает содержательность: канонический ключ (он же будущий
        # source_ref) должен принадлежать тому, кто видел узел изнутри.
        strong = (
            node.source_keys
            if sub and not self.substantial[hit]
            else self.nodes[hit].source_keys
        )
        self.nodes[hit].source_keys = _rank_keys(
            merge_key_sets(self.nodes[hit].source_keys, node.source_keys), strong
        )
        for k in self.nodes[hit].source_keys:
            self.by_source.setdefault(k, hit)
        # Размещение не спорит: один объект стоит везде, где его поставил любой файл.
        self.nodes[hit].sites = union_sites(self.nodes[hit].sites, node.sites)
        self._merge_str(hit, "role", node.role, fi, sub)
        self._merge_str(hit, "technology", node.technology, fi, sub)
        self._merge_str(hit, "description", node.description, fi, sub)
        self._merge_enum(hit, "shape", node.shape, "service", fi, sub)
        self._merge_enum(hit, "status", node.status, "existing", fi, sub)
        self._merge_element(hit, node.element, fi, sub)
        if node.is_external != self.nodes[hit].is_external:
            keep_fi, keep_sub = self.value_src[hit]["is_external"]
            if sub != keep_sub:
                # Заглушка соседа («чужой продукт — внешняя система») не красит узел,
                # который другой файл разбирал изнутри: там external — свойство места
                # соседа, а не самого продукта (П2, полевой кейс Grafana).
                winner = node.is_external if sub else self.nodes[hit].is_external
            else:
                # Равные вклады: external ставят осознанно — решаем в пользу true.
                winner = True
            kept_fi, флаг = keep_fi, "true" if winner else "false"
            self._add_conflict(
                lambda: f"{self.paths[hit]}: external: файлы {kept_fi + 1} и {fi + 1} "
                f"расходятся — оставлено {флаг}"
            )
            if winner != self.nodes[hit].is_external:
                self.nodes[hit].is_external = winner
                self.value_src[hit]["is_external"] = (fi, sub)
        self.sources[hit].add(fi)
        self.substantial[hit] = self.substantial[hit] or sub
        return hit

    # ── площадки развёртывания ────────────────────────────────────────────

    def add_sites(self, part: ParsedImport, fi: int) -> None:
        """Площадки файла: новое имя — новая площадка, известное — склейка полей.
        part.sites идут «родители раньше детей», поэтому родитель уже известен."""
        for s in part.sites:
            parent = part.sites[s.parent_idx].name if s.parent_idx is not None else None
            k = self.site_index.get(s.name)
            if k is None:
                self.site_index[s.name] = len(self.sites)
                self.sites.append(replace(s, parent_idx=None))
                self.site_parent.append(parent)
                continue
            cur = self.sites[k]
            if s.declared and not cur.declared:
                # Неявная площадка — догадка разбора («только названа узлом»), и её поля
                # уступают объявленной в любом следующем файле целиком.
                self.sites[k] = replace(s, parent_idx=None)
            elif s.declared:
                if s.kind != cur.kind:
                    self.report.warn(
                        f"площадка «{s.name}»: вид расходится между файлами "
                        f"({cur.kind} / {s.kind}) — взят первый"
                    )
                cur.technology = cur.technology if _fill(cur.technology) else s.technology
                cur.description = cur.description if _fill(cur.description) else s.description
            self._site_parent(k, parent, fi)

    def _site_parent(self, k: int, parent: str | None, fi: int) -> None:
        """Родитель площадки — первый непустой. Поздний родитель, который замкнул бы
        вложенность в цикл (A в B из одного файла, B в A из другого), не ставится:
        цикл отвергла бы проверка площадок, а слитая картина обязана быть годной."""
        if parent is None or self.site_parent[k] is not None:
            return
        name = self.sites[k].name
        seen: set[str] = set()
        cur: str | None = parent
        while cur is not None and cur not in seen:
            if cur == name:
                self.report.warn(
                    f"площадка «{name}»: родитель «{parent}» из файла {fi + 1} замкнул бы "
                    f"вложенность в цикл — оставлена без него"
                )
                return
            seen.add(cur)
            idx = self.site_index.get(cur)
            cur = self.site_parent[idx] if idx is not None else None
        self.site_parent[k] = parent

    def merged_sites(self) -> list[_ImpSite]:
        """Площадки результата: «родители раньше детей», parent_idx — в этом списке."""
        parents = [None if p is None else self.site_index.get(p) for p in self.site_parent]
        return order_sites(self.sites, parents)

    # ── рёбра ─────────────────────────────────────────────────────────────

    def add_edge(self, e: _ImpEdge, idx_map: list[int], fi: int) -> None:
        src, dst = idx_map[e.source_idx], idx_map[e.target_idx]
        key = (src, dst, e.label or "", e.technology or "")
        seen = self.edge_seen.get(key)
        if seen is not None:
            self.report.dropped_edges += 1
            self.edge_files[seen[0]].add(fi)
            self._merge_channel(seen, e.channel, fi)
            return
        self.edge_seen[key] = (len(self.edges), fi)
        self.edges.append(_ImpEdge(src, dst, e.label, e.technology, e.channel, e.is_synchronous))
        self.edge_files.append({fi})
        self.pair_labels.setdefault((src, dst), []).append((e.label or "", fi))

    def _merge_channel(self, seen: tuple[int, int], new: str | None, fi: int) -> None:
        """Канал у дубля связи — та же политика, что у полей узла (_merge_str):
        заполненное бьёт пустое, расхождение решается в пользу первого файла и
        уезжает строкой в отчёт.

        В КЛЮЧ дедупа канал не входит осознанно: один и тот же поток, названный в
        двух репозиториях разными топиками, — это конфликт, который надо показать, а
        не две самостоятельные связи между той же парой с той же подписью."""
        idx, first = seen
        cur = self.edges[idx].channel
        if not _fill(new) or (_fill(cur) and cur.strip() == new.strip()):
            return
        if not _fill(cur):
            self.edges[idx].channel = new
            return
        edge = self.edges[idx]
        self._add_conflict(
            lambda: f"связь «{self.paths[edge.source_idx]} → {self.paths[edge.target_idx]}»: "
            f"канал: оставлено «{cur}» (файл {first + 1}), отброшено «{new}» (файл {fi + 1})"
        )

    # ── предупреждения ────────────────────────────────────────────────────

    def warn_similar_edges(self) -> None:
        """Одна пара концов, разные подписи из РАЗНЫХ файлов — возможно, дубль
        (в одном файле мульти-рёбра между парой считаем осознанными)."""
        for (src, dst), entries in self.pair_labels.items():
            if len({lbl for lbl, _ in entries}) < 2 or len({f for _, f in entries}) < 2:
                continue
            labels = ", ".join(f"«{lbl or '—'}»" for lbl, _ in entries[:4])
            # Замечание существует только потому, что файлов несколько, — схемное.
            self.report.warn(
                f"связи {self.paths[src]} → {self.paths[dst]}: разные подписи из разных "
                f"файлов ({labels}) — проверьте, не дубли ли это"
            )

    def warn_fuzzy_siblings(self) -> None:
        """Похожие имена сиблингов из непересекающихся наборов файлов — кандидаты
        «одно и то же, названное по-разному». Не склеиваем — только сигналим."""
        groups: dict[int | None, list[int]] = {}
        for i, n in enumerate(self.nodes):
            groups.setdefault(n.parent_idx, []).append(i)
        for parent, idxs in groups.items():
            if len(idxs) < 2 or len(idxs) > _FUZZY_GROUP_LIMIT:
                continue
            norms = [identity_name(self.nodes[i].name) for i in idxs]
            for a in range(len(idxs)):
                for b in range(a + 1, len(idxs)):
                    ia, ib = idxs[a], idxs[b]
                    if self.sources[ia] & self.sources[ib]:
                        continue  # жили в одном файле — названы different осознанно
                    if not _similar(norms[a], norms[b]):
                        continue
                    where = f"внутри «{self.paths[parent]}»" if parent is not None else "на верхнем уровне"
                    self.report.fuzzy_pairs.append(
                        FuzzyPairRec(a_idx=ia, b_idx=ib, parent_idx=parent,
                                     warning_idx=len(self.report.warnings))
                    )
                    # Пара заведомо из РАЗНЫХ файлов (условие выше) — схемное.
                    self.report.warn(
                        f"«{self.nodes[ia].name}» и «{self.nodes[ib].name}» ({where}) похожи — "
                        f"возможно, один объект из разных файлов; если да, приведите имена к одному"
                    )

    def _warn_absorbed(self) -> None:
        """Узлы, СЛИТЫЕ в один по общему repo без path, — поимённо.

        Молчанием это не было только формально: в отчёте оставалась строка
        конфликта «имя: оставлено …, отброшено …», которая читается как расхождение
        подписи ОДНОГО объекта, а не как исчезновение второго. Пользователь узнавал
        о пропаже, лишь заметив её на схеме (пункт 12 чек-листа промпта про это
        предупреждает, но машинной проверки не было).

        Поведение слияния строкой не меняется: склейка остаётся, ответ — «задайте
        path и повторите». Ошибкой (отказом импорта) класс не сделан осознанно —
        как у соседей (межфайловый дубль канала, дубль таблиц данных): слитая схема
        пригодна, а решить, один это сервис или два, может только пользователь.

        Корзина СХЕМНАЯ всегда: сюда попадают только межфайловые склейки (все
        матчеры отказываются склеивать узлы одного файла, а _match_by_name сводит
        лишь тёзок, которые отсеяны выше). Замечание существует ровно потому, что
        файлов несколько, и рассудить его может только видящий оба репозитория —
        то же правило, что у похожих подписей и fuzzy-тёзок."""
        shown = hidden = 0
        # Порядок строк — по ключу, затем по узлу-приёмнику: от перестановки файлов
        # он не зависит (имена внутри строки алфавитны, см. _names_phrase).
        for (_hit, k), names in sorted(self.absorbed.items(), key=lambda it: (it[0][1], it[0][0])):
            if shown >= _MAX_SHARED_SOURCE_GROUPS:
                hidden += 1
                continue
            shown += 1
            self.report.warn(
                f"{_names_phrase(names)} слиты в ОДИН объект: у них общий источник "
                f"({k}), а path не задан — задайте каждому свой source.path и "
                f"повторите, иначе вместо {len(names)} объектов в схеме останется "
                f"один, а их компоненты окажутся внутри него"
            )
        if hidden:
            self.report.warn(f"…ещё {hidden} таких склеек по общему источнику")

    def warn_roots(self, parts: list[ParsedImport]) -> None:
        """Ни один корень не склеился из ≥2 файлов — скорее всего, агентам задали
        разные имена системы (внешние системы и акторы легально живут корнями,
        поэтому критерий именно «нет ОБЩИХ корней», а не «корней больше одного»)."""
        if len(parts) < 2:
            return
        roots = [i for i, n in enumerate(self.nodes) if n.parent_idx is None]
        if any(len(self.sources[i]) > 1 for i in roots):
            return
        names = ", ".join(f"«{self.nodes[i].name}»" for i in roots[:6])
        self.report.warn(
            f"файлы не имеют общих корневых узлов ({names}) — если это одна система, "
            f"задайте всем файлам одно имя корня и повторите"
        )

    def settle_elements(self, parts: list[ParsedImport]) -> None:
        """Элемент архитектуры слитого дерева (Р5, Р6, камень 6) — ДО остальных
        предупреждений: база и контейнер, допустимые в своих файлах, в слитом дереве
        могли оказаться друг в друге. Санитизация та же, что у одного файла.

        Замечания — схемные (без файла-адресата): каждый файл по отдельности чист (его
        разбор уже санитизирован), и нарушение существует только потому, что файлов
        несколько, — тот же принцип, что у _warn_absorbed и warn_roots.

        Спор элемента у узла, которому санитизация сменила значение, снимается: правило
        уже ответило, и вопрос был бы о решённом (выбранный «Контейнер» снялся бы снова).

        База или брокер, вынесенные из контейнера, меняют пути своего поддерева: пути
        слитого дерева и строки склеек пересчитываются, чтобы следующие замечания и
        превью называли объект там, где он окажется; строки conflicts пересобираются по
        тем же путям (Ф13а), замечания о тёзках при склейке остаются с путями документа.
        Состояние узлов до санитизации — в report.pre_settle: по нему применение
        возвращает поддерево узла, с которого ответ на спор снял «контейнер». Объекты живого
        проекта (pinned_file) не переносятся: контейнер с живой базой внутри остаётся
        системой, а если и сам контейнер живой — место не трогается вовсе."""
        before = [n.element for n in self.nodes]
        parents = [n.parent_idx for n in self.nodes]
        self.report.pre_settle = [(n.parent_idx, n.element, list(n.sites)) for n in self.nodes]
        pinned = self.pinned_file

        def is_pinned(idx: int) -> bool:
            return pinned is not None and pinned in self.sources[idx]

        def live_element(idx: int) -> bool:
            # Слитое значение совпадает с тем, что сказал живой проект.
            return pinned is not None and any(
                fi == pinned and parts[fi].nodes[ni].element == self.nodes[idx].element
                for fi, ni, _keys in self.contribs[idx]
            )

        first = len(self.report.warnings)
        for text in sanitize_elements(
            self.nodes, self.paths, pinned=is_pinned, live_element=live_element
        ):
            self.report.warn(text)
        self.report.settle_warnings = range(first, len(self.report.warnings))
        for idx, was in enumerate(before):
            if self.nodes[idx].element != was:
                self._drop_dispute(idx, "element")
        if any(n.parent_idx != p for n, p in zip(self.nodes, parents, strict=True)):
            self.paths = tree_paths(self.nodes)
            self.report.merged_paths = [self.paths[i] for i in self.merged_idxs]
            # Строки расхождений записаны до выноса — путями документа; пересобираем их
            # по дереву после санитизации, чтобы они называли объект там, где он ляжет.
            self.report.conflicts = [render() for render in self._conflict_lines]
        self._warn_adopted_children(parts)

    def _warn_adopted_children(self, parts: list[ParsedImport]) -> None:
        """Камень 6: у контейнера из одного файла появились объекты из другого, который
        не называл узел контейнером, — они молча стали компонентами (его базы и сервисы
        тоже, если бы не санитизация). Одна строка на контейнер; ребёнок, которого
        принёс и файл-«контейнер», замечанием не считается — тот положил его осознанно."""
        children: dict[int, list[int]] = {}
        for i, n in enumerate(self.nodes):
            if n.parent_idx is not None:
                children.setdefault(n.parent_idx, []).append(i)
        for idx, node in enumerate(self.nodes):
            if node.element != "container":
                continue
            said = {
                fi for fi, ni, _keys in self.contribs[idx]
                if parts[fi].nodes[ni].element == "container"
            }
            adopted = [c for c in children.get(idx, []) if not self.sources[c] & said]
            if not adopted:
                continue
            others = sorted({fi for c in adopted for fi in self.sources[c]})
            self.report.warn(
                f"{self.paths[idx]}: контейнер по {_files_phrase(sorted(said), 'файлу', 'файлам')}, "
                f"а {_files_phrase(others, 'файл', 'файлы')} "
                f"{'положил' if len(others) == 1 else 'положили'} внутрь объекты "
                f"({_names_phrase(self.nodes[c].name for c in adopted)}), не зная, что это "
                f"контейнер — они стали его компонентами; проверьте, не система ли это"
            )

    def finish(self, parts: list[ParsedImport]) -> tuple[ParsedImport, MergeReport]:
        # Атрибуция — до предупреждений содержания: по ней warn_content решает,
        # чей файл виноват в замечании о конкретном узле/связи.
        self.report.node_files = [set(s) for s in self.sources]
        # Наружу — только адрес вклада: якорные ключи — внутренняя кухня стабилизации.
        self.report.node_contribs = [[(fi, ni) for (fi, ni, _keys) in c] for c in self.contribs]
        # Основание узла — СИЛЬНЕЙШЕЕ среди его склеек: узел, найденный третьим файлом
        # по имени, всё равно был опознан по коду, когда с ним же сошёлся второй.
        self.report.node_basis = [_strongest_basis(b) for b in self.basis]
        # Строка отчёта о склейке называет то же самое основание, что и сам узел, —
        # иначе один узел говорил бы о себе в двух местах по-разному.
        self.report.merged_basis = [
            self.report.node_basis[i] or "name" for i in self.merged_idxs
        ]
        self.report.edge_files = self.edge_files
        self.settle_elements(parts)
        self.warn_similar_edges()
        self.warn_fuzzy_siblings()
        self.warn_roots(parts)
        self._warn_absorbed()
        _warn_shared_repo(self.nodes, self.report)
        if len(self.report.warnings) > _MAX_WARNINGS:
            extra = len(self.report.warnings) - _MAX_WARNINGS
            del self.report.warnings[_MAX_WARNINGS:]
            del self.report.warning_files[_MAX_WARNINGS:]  # разметка идёт строка в строку
            self.report.forget_cut_warnings(_MAX_WARNINGS)
            self.report.warn(f"…и ещё {extra} предупреждений")
        # Лимиты — свойство СЛИТОЙ картины: один файл в них не виноват.
        if len(self.nodes) > MAX_NODES:
            self.report.error(f"После слияния слишком много узлов (больше {MAX_NODES})")
        if len(self.edges) > MAX_EDGES:
            self.report.error(f"После слияния слишком много связей (больше {MAX_EDGES})")
        roots = [n.name for n in self.nodes if n.parent_idx is None]
        merged = ParsedImport(
            nodes=self.nodes, edges=self.edges, roots=roots, sites=self.merged_sites()
        )
        return merged, self.report


def merge_imports(
    parts: list[ParsedImport], *, pinned_file: int | None = None
) -> tuple[ParsedImport, MergeReport]:
    """Слить N разобранных импортов в один. Всегда возвращает (результат, отчёт);
    непустой report.errors означает «результат непригоден» (суммарные лимиты).
    Один файл — passthrough без отчётных записей. pinned_file — вход живого проекта
    (догрузка): его объекты санитизация элемента не переносит."""
    if len(parts) == 1:
        # Атрибуция вырожденная (всё из файла 0), но заполняем: warn_content не
        # должен знать, сколько было файлов.
        report = MergeReport(
            files=1,
            node_files=[{0} for _ in parts[0].nodes],
            edge_files=[{0} for _ in parts[0].edges],
            node_contribs=[[(0, i)] for i in range(len(parts[0].nodes))],
            node_basis=[None] * len(parts[0].nodes),
        )
        # Единственное замечание слияния, которое имеет смысл и без второго файла:
        # общий repo без path — промах ОДНОГО документа, и ответ на него не зависит
        # от состава панели (Ф7). Остальное слияние при одном файле — passthrough.
        _warn_shared_repo(parts[0].nodes, report)
        return parts[0], report
    # Проход инкрементальный (файл за файлом), поэтому чувствителен к порядку: узел
    # копит ключи, и поздний кандидат сравнивается уже с накопленным. Стабилизация
    # (_regroup) смотрит на ГОТОВЫЙ результат, где каждый вклад виден по отдельности,
    # и повторяет проход с найденными склейками — пока новых не находится. Так исход
    # перестаёт зависеть от порядка панели (тот же инвариант, что у П2).
    m = _run_merge(parts, {}, pinned_file)
    for _ in range(_MAX_STABILIZE_PASSES):
        force = _regroup(m)
        if force is None:
            break
        m = _run_merge(parts, force, pinned_file)
    return m.finish(parts)


def _run_merge(
    parts: list[ParsedImport],
    force: dict[tuple[int, int], int],
    pinned_file: int | None = None,
) -> _Merger:
    """Один проход слияния: файлы по порядку, узлы «родители раньше детей»."""
    m = _Merger(files=len(parts), force=force, pinned_file=pinned_file)
    for fi, part in enumerate(parts):
        m.add_sites(part, fi)
        # Кто раскрыт компонентами В ЭТОМ файле — половина признака содержательности
        # вклада (_substantial); считаем до обхода, дети идут после родителя.
        opened = {n.parent_idx for n in part.nodes if n.parent_idx is not None}
        idx_map: list[int] = []  # индекс узла в файле → индекс в merged
        for ni, node in enumerate(part.nodes):
            parent_m = idx_map[node.parent_idx] if node.parent_idx is not None else None
            idx_map.append(m.add_node(node, parent_m, fi, ni, _substantial(node, ni in opened)))
        for e in part.edges:
            m.add_edge(e, idx_map, fi)
    return m


def _regroup(m: _Merger) -> dict[tuple[int, int], int] | None:
    """Стабилизация склейки (матчер v3): какие узлы результата на самом деле один и
    тот же объект. Возвращает разметку «атом (файл, индекс в файле) → группа» для
    повторного прохода либо None, если объединять нечего.

    Правило симметрично и не зависит от порядка файлов: ОДНОИМЁННЫЕ узлы одного
    родителя объединяются, если их вклады совместимы (_bridged) — есть свидетель с
    якорями по обе стороны и ни одна пара вкладов не противоречит по К3. Противоречия
    держат узлы раздельно: настоящие тёзки двух команд остаются двумя узлами в любом
    порядке файлов, и плагин, вписавший в тёзку продукта своё repo, — тоже (К3).

    Совместимость проверяется по вкладам ГРУППЫ, а не двух сравниваемых узлов: union-
    find транзитивен, и общий свидетель иначе связал бы через себя две группы,
    спорящие друг с другом напрямую.

    Разметка описывает ВЕСЬ результат (не только новые склейки): повторный проход
    обязан воспроизвести и то, что матчеры уже нашли сами, иначе он разошёлся бы с
    предыдущим. Возвращаем группы атомами, а не индексами узлов, потому что индексы
    следующего прохода будут другими.
    """
    root = list(range(len(m.nodes)))
    # Вклады группы по её представителю: пополняются при каждом объединении.
    members: dict[int, list[tuple[int, int, list[str]]]] = {
        i: list(cs) for i, cs in enumerate(m.contribs)
    }

    def find(x: int) -> int:
        while root[x] != x:
            root[x] = root[root[x]]
            x = root[x]
        return x

    changed = False
    namesakes: dict[tuple[int | None, str], list[int]] = {}
    for i, n in enumerate(m.nodes):
        namesakes.setdefault((n.parent_idx, identity_name(n.name)), []).append(i)
    for idxs in namesakes.values():
        for a in range(len(idxs)):
            for b in range(a + 1, len(idxs)):
                ra, rb = find(idxs[a]), find(idxs[b])
                if ra == rb or not _bridged(members[ra], members[rb]):
                    continue
                # Представитель — наименьший индекс: детерминированные номера групп.
                keep, gone = min(ra, rb), max(ra, rb)
                root[gone] = keep
                members[keep].extend(members.pop(gone))
                changed = True
    if not changed:
        return None
    return {(fi, ni): find(i) for i, cs in enumerate(m.contribs) for fi, ni, _keys in cs}


def carry_parse_warnings(parts: list[ParsedImport], report: MergeReport) -> None:
    """Замечания РАЗБОРА каждого файла — в отчёт слияния, адресованные этому файлу.

    Разбор их адресовать не может (он видит один документ и не знает своего номера),
    а превью показывает только отчёт. Индекс части = индекс входа: при ошибке
    разбора любого файла общий путь возвращается раньше, поэтому parts плотный."""
    for i, part in enumerate(parts):
        for text in part.warnings:
            report.warn(text, i)


def parse_and_merge(texts: list[str]) -> tuple[ParsedImport | None, MergeReport, list[str]]:
    """Общий путь превью и создания: разобрать N текстов и слить. Возвращает
    (результат, отчёт, ошибки); при любых ошибках результат None. Ошибки
    парсинга при N>1 префиксуются «файл N: …» (нумерация с 1, как в UI); в отчёт
    те же ошибки уходят БЕЗ префикса, разложенные по файлам (split_remarks)."""
    parts: list[ParsedImport] = []
    errors: list[str] = []
    file_errors: dict[int, list[str]] = {}
    for i, text in enumerate(texts):
        parsed, errs = parse_import(text)
        if parsed is None:
            prefix = f"файл {i + 1}: " if len(texts) > 1 else ""
            errors.extend(prefix + e for e in errs)
            file_errors[i] = list(errs)
        else:
            parts.append(parsed)
    if errors:
        return None, MergeReport(files=len(texts), file_errors=file_errors), errors
    merged, report = merge_imports(parts)
    if report.errors:
        return None, report, list(report.errors)
    carry_parse_warnings(parts, report)
    warn_content(merged, report)
    return merged, report, []
