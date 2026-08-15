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
"""

from collections.abc import Hashable, Iterable
from dataclasses import dataclass, field, replace
from difflib import SequenceMatcher
from typing import TypeGuard, TypeVar

from app.identity import KEY_ORDER, compare_identity, key_type, merge_key_sets
from app.import_yaml import (
    MAX_EDGES,
    MAX_NODES,
    ParsedImport,
    _ImpEdge,
    _ImpNode,
    parse_import,
)

# Порог похожести имён сиблингов для предупреждения «возможно, одно и то же».
_FUZZY_RATIO = 0.78
# Группы сиблингов крупнее этого попарно не сравниваем (квадратичная стоимость;
# реальные уровни на порядки меньше — защита от патологического входа).
_FUZZY_GROUP_LIMIT = 250
_MAX_WARNINGS = 30
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
# Поля узла, которые СЛИВАЮТСЯ вкладами разных файлов (и, значит, могут спорить).
# Имени и родителя здесь нет намеренно: их решает создатель узла — перевешивать
# поддерево поздним файлом опаснее, чем оставить расхождение видимым в отчёте.
_MERGED_FIELDS = ("role", "technology", "description", "shape", "status", "is_external")
# Сколько раз повторяем проход ради стабилизации склейки (_regroup). Каждый повтор
# строго уменьшает число узлов, так что цикл сходится сам; кап — защита от
# патологического входа, а не рабочий предел (на практике хватает одного повтора).
_MAX_STABILIZE_PASSES = 5

T = TypeVar("T", bound=Hashable)


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


def _least(files: set[int]) -> int | None:
    """Адресат из множества кандидатов — файл с наименьшим номером; пусто → None.

    Наименьший не произволен: при слиянии выигрывает первый по порядку файл (имя,
    родитель, канал — всё решается в его пользу; поля — при равной содержательности
    вкладов, П2), значит именно его правка доедет до слитой схемы и погасит
    замечание."""
    return min(files) if files else None


def connected_components(edges: Iterable[tuple[T, T]]) -> list[list[T]]:
    """Связные компоненты графа РЁБЕР; компоненты из одного узла не возвращаются.

    Ядро, общее с алертом «изолированные группы» (app/alerts.compute_alerts, п.3), и
    трактовка обязана совпадать с ним до буквы — иначе превью и алерты разойдутся в
    вердиктах на одной и той же схеме:
    - иерархия parent СВЯЗЬЮ НЕ СЧИТАЕТСЯ: через дерево связано вообще всё, и такой
      критерий не отличал бы фрагментированную схему от целой;
    - узлы без единой связи в компоненты не входят: о них говорит отдельная проверка
      (в превью — «объектов без единой связи», в алертах — «подвисшие»), и дублировать
      её замечанием про «группу из одного объекта» нельзя.

    Порядок компонент и узлов внутри — от порядка рёбер: детерминирован при том же
    входе, а показываем мы их всё равно отсортированными.
    """
    adjacency: dict[T, set[T]] = {}
    for a, b in edges:
        adjacency.setdefault(a, set()).add(b)
        adjacency.setdefault(b, set()).add(a)
    visited: set[T] = set()
    out: list[list[T]] = []
    for start in adjacency:
        if start in visited:
            continue
        visited.add(start)
        stack = [start]
        comp: list[T] = []
        while stack:
            cur = stack.pop()
            comp.append(cur)
            for nxt in adjacency[cur]:
                if nxt not in visited:
                    visited.add(nxt)
                    stack.append(nxt)
        if len(comp) >= 2:
            out.append(comp)
    return out


@dataclass
class MergeReport:
    """Человеческий отчёт слияния для превью модалки. errors — только нарушение
    суммарных лимитов (per-file лимиты держит parse_import).

    Плоские списки (conflicts/warnings/errors) — исторический контракт превью, их
    наполнение не меняется. Поверх них живёт РАЗМЕТКА ПРИРОДЫ замечания (Ф6): пакет
    собирают N агентов, каждый видит только свой репозиторий и переписывает только
    свой файл, поэтому замечание, порождённое содержимым одного файла, адресуемо
    его агенту, а свойство слитой картины — только человеку (split_remarks).

    Адресат считается по ПРОИСХОЖДЕНИЮ виновных сущностей, а не по классу замечания
    (Ф7, находка пользователя): класс давал разный ответ на один и тот же файл в
    зависимости от того, сколько документов лежит рядом в панели. Правило одно на все
    классы: собери виновные сущности замечания; есть файл, внёсший вклад в каждую из
    них, — ему замечание и адресуется (при нескольких кандидатах — наименьший номер,
    _least), нет — схемная корзина."""

    files: int
    merged_paths: list[str] = field(default_factory=list)  # узлы, склеенные из ≥2 файлов
    conflicts: list[str] = field(default_factory=list)  # расхождения полей (кто победил — в тексте)
    warnings: list[str] = field(default_factory=list)  # fuzzy-пары, разные корни, похожие рёбра
    dropped_edges: int = 0  # выброшенные точные дубли рёбер
    errors: list[str] = field(default_factory=list)
    # ── разметка природы замечаний (Ф6, docs/plan-skeptic-audit.md) ────────────
    # Для каждой строки warnings/errors — индекс файла-виновника (с 0) либо None
    # («виноватого» файла нет: свойство слитой картины или отношений между файлами).
    # Длины держатся равными len(warnings)/len(errors) методами warn()/error().
    warning_files: list[int | None] = field(default_factory=list)
    error_files: list[int | None] = field(default_factory=list)
    # Ошибки РАЗБОРА отдельных файлов, БЕЗ префикса «файл N: » (адресация уже в
    # структуре). Плоский список ошибок собирает parse_and_merge — с префиксом, как раньше.
    file_errors: dict[int, list[str]] = field(default_factory=dict)
    # Служебная атрибуция слитого дерева (не для показа): какие файлы внесли вклад
    # в каждый узел / каждую связь. По ней проверки содержания решают, кому
    # адресовать замечание о конкретном объекте.
    node_files: list[set[int]] = field(default_factory=list)
    edge_files: list[set[int]] = field(default_factory=list)

    def warn(self, text: str, file: int | None = None) -> None:
        """Предупреждение: в плоский список (как раньше) и в разметку природы."""
        self.warnings.append(text)
        self.warning_files.append(file)

    def error(self, text: str, file: int | None = None) -> None:
        self.errors.append(text)
        self.error_files.append(file)

    def _common(self, attribution: list[set[int]], idxs: Iterable[int]) -> set[int]:
        """Файлы, внёсшие вклад в КАЖДЫЙ из названных объектов (пересечение
        атрибуций). Пусто — общего файла нет: замечание не адресуемо ни одному
        агенту и уедет пользователю. Ложная адресация вреднее пропущенной.

        Пересечение, а не «ровно один файл на все объекты» (Ф7): узел, склеенный из
        двух прогонов, принадлежит обоим — и не должен лишать адресата замечание,
        где остальные виновники из одного файла."""
        common: set[int] | None = None
        for i in idxs:
            if i >= len(attribution):
                return set()
            common = set(attribution[i]) if common is None else common & attribution[i]
            if not common:
                return set()
        return common or set()

    def files_of_nodes(self, idxs: Iterable[int]) -> set[int]:
        return self._common(self.node_files, idxs)

    def files_of_edges(self, idxs: Iterable[int]) -> set[int]:
        """Для связи «внёс вклад» = принёс ровно её (первоисточник или принесший
        тот же дубль); ссылки внутри файла резолвит parse_import, поэтому файл
        связи заведомо объявил и оба её конца."""
        return self._common(self.edge_files, idxs)

    def owner_of_nodes(self, idxs: Iterable[int]) -> int | None:
        return _least(self.files_of_nodes(idxs))

    def owner_of_edges(self, idxs: Iterable[int]) -> int | None:
        return _least(self.files_of_edges(idxs))


@dataclass
class FileRemarks:
    """Замечания к ОДНОМУ входному файлу — то, что чинит агент его репозитория:
    он видит только свой код и переписывает только свой YAML-документ."""

    file: int  # номер файла с 1 — та же нумерация, что в текстах «(файл 2)» и в чипах UI
    errors: list[str] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)


def split_remarks(report: MergeReport) -> tuple[list[FileRemarks], list[str], list[str]]:
    """Разложить замечания превью по ПРИРОДЕ: (пофайловые, ошибки слитой схемы,
    предупреждения слитой схемы). Записей пофайловых замечаний ровно столько,
    сколько входных файлов, — включая файлы без единого замечания (фронт адресует
    их по индексу активного чипа).

    Конфликты слияния всегда в схемной корзине: конфликт — это и есть расхождение
    ДВУХ файлов, рассудить его может только тот, кто видит оба репозитория.

    Одно-файловый режим НЕ особый (Ф7): у единственного файла все сущности его, и
    общее правило само уводит каждое замечание — включая изоляцию и прочую «слитую
    картину» — в file_remarks[0], оставляя схемные корзины пустыми. Отдельной ветки
    «при files==1 клади всё в первый файл» здесь быть не должно: она и означала бы,
    что адресат зависит от состава панели, а не от происхождения виновных."""
    per_errors: list[list[str]] = [[] for _ in range(report.files)]
    per_warnings: list[list[str]] = [[] for _ in range(report.files)]
    schema_errors: list[str] = []
    schema_warnings: list[str] = []

    def put(bucket: list[list[str]], schema: list[str], text: str, file: int | None) -> None:
        if file is None:
            schema.append(text)
        else:
            bucket[file].append(text)

    for i, errs in report.file_errors.items():
        per_errors[i].extend(errs)
    for text, owner in zip(report.errors, report.error_files, strict=True):
        put(per_errors, schema_errors, text, owner)
    for text in report.conflicts:
        put(per_warnings, schema_warnings, text, None)
    for text, owner in zip(report.warnings, report.warning_files, strict=True):
        put(per_warnings, schema_warnings, text, owner)
    files = [
        FileRemarks(file=i + 1, errors=per_errors[i], warnings=per_warnings[i])
        for i in range(report.files)
    ]
    return files, schema_errors, schema_warnings


def _norm(name: str) -> str:
    """Нормализация имени для сравнения идентичности: регистр + схлоп пробелов."""
    return " ".join(name.split()).casefold()


def _fill(val: str | None) -> TypeGuard[str]:
    # TypeGuard: после проверки val сужается до str (используется в _merge_str
    # для безопасного .strip() и передачи в _conflict без повторных null-чеков).
    return val is not None and val.strip() != ""


def _similar(a: str, b: str) -> bool:
    """Похожи ли нормализованные имена: вложение подстроки (payments ⊂
    payments-service) либо высокий difflib-ratio (опечатки, суффиксы)."""
    if a == b:
        return False  # равные склеились бы раньше — сюда не попадают
    short, long_ = (a, b) if len(a) <= len(b) else (b, a)
    if len(short) >= 4 and short in long_:
        return True
    return SequenceMatcher(None, a, b).ratio() >= _FUZZY_RATIO


class _Merger:
    """Состояние одного прогона слияния (класс вместо замыканий — читаемость)."""

    def __init__(self, files: int, force: dict[tuple[int, int], int] | None = None):
        self.report = MergeReport(files=files)
        self.nodes: list[_ImpNode] = []  # копии узлов, порядок «родители раньше детей»
        self.paths: list[str] = []  # полный путь merged-узла (для отчёта)
        self.sources: list[set[int]] = []  # какие файлы внесли вклад в узел
        # Вклады узла ПО ОТДЕЛЬНОСТИ: (файл, индекс узла в файле, его якорные ключи).
        # Слитый набор ключей (_ImpNode.source_keys) для сравнения идентичности не
        # годится — он растёт по ходу прохода и делает исход зависимым от порядка
        # файлов; стабилизация (_regroup) сравнивает именно вклады.
        self.contribs: list[list[tuple[int, int, list[str]]]] = []
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
        # (merged-родитель, норм-имя) → кандидаты. Список, а не один idx: якорь
        # может РАЗВЕСТИ двух тёзок в одном родителе (разные репозитории), и оба
        # обязаны остаться адресуемыми для следующих файлов.
        self.by_key: dict[tuple[int | None, str], list[int]] = {}
        # канонический ключ источника → idx узла. Индекс ГЛОБАЛЬНЫЙ (не в пределах
        # родителя): якорь сильнее иерархии — им ловится сервис, которого разные
        # прогоны положили под разных родителей или назвали по-разному.
        self.by_source: dict[str, int] = {}
        self.edges: list[_ImpEdge] = []
        # какие файлы принесли связь (первоисточник + принесшие тот же дубль) —
        # атрибуция замечаний о конкретной связи (Ф6).
        self.edge_files: list[set[int]] = []
        # ключ дубля → (индекс в self.edges, файл-первоисточник). Индекс нужен,
        # чтобы дубль мог ДОЛИТЬ каналом уже принятую связь, а не пропасть целиком.
        self.edge_seen: dict[tuple[int, int, str, str], tuple[int, int]] = {}
        # (src, dst) → [(label, файл)] — для предупреждения о похожих рёбрах.
        self.pair_labels: dict[tuple[int, int], list[tuple[str, int]]] = {}

    # ── узлы ──────────────────────────────────────────────────────────────

    def _conflict(
        self, idx: int, fld: str, kept: str, dropped: str, keep_fi: int, drop_fi: int
    ) -> None:
        """Строка расхождения: номера файлов — источники ОСТАВЛЕННОГО и ОТБРОШЕННОГО
        значений (а не «первый вкладчик узла»: значение могло прийти не с созданием,
        а доливкой третьего файла, и победить тоже мог не первый — см. _decide)."""
        self.report.conflicts.append(
            f"{self.paths[idx]}: {fld}: оставлено «{kept}» (файл {keep_fi + 1}), "
            f"отброшено «{dropped}» (файл {drop_fi + 1})"
        )

    def _decide(self, idx: int, fld: str, cur: str, new: str, fi: int, sub: bool) -> None:
        """Спор двух ЗАПОЛНЕННЫХ значений одного поля (П2): побеждает СОДЕРЖАТЕЛЬНЫЙ
        вклад независимо от порядка файлов, при равной содержательности — прежнее
        «первый побеждает». Строка отчёта остаётся в обоих случаях: молча слияние
        не решает, кто прав."""
        keep_fi, keep_sub = self.value_src[idx][fld]
        if sub and not keep_sub:
            setattr(self.nodes[idx], fld, new)
            self.value_src[idx][fld] = (fi, sub)
            self._conflict(idx, fld, new, cur, fi, keep_fi)
            return
        self._conflict(idx, fld, cur, new, keep_fi, fi)

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
        if new == default or new == cur:
            return
        if cur == default:
            setattr(self.nodes[idx], fld, new)
            self.value_src[idx][fld] = (fi, sub)
            return
        self._decide(idx, fld, cur, new, fi, sub)

    def _match_by_source(self, node: _ImpNode, fi: int) -> int | None:
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
            return hit
        return None

    def _match_by_name(self, node: _ImpNode, parent_m: int | None) -> int | None:
        """Матч по имени в пределах слитого родителя — прежнее поведение, но с
        предохранителем: тёзка с ПРОТИВОРЕЧАЩИМ якорем не склеивается. Противоречие
        решает сильнейший общий тип ключа (_compare_anchors, К3): тёзки с разными
        репозиториями раздельны, даже когда сетевое имя у них общее, а тёзка, у
        которой репозитория НЕТ вовсе, склеивается как раньше."""
        for idx in self.by_key.get((parent_m, _norm(node.name)), []):
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
        self.by_key.setdefault((parent_m, _norm(node.name)), []).append(idx)
        for k in self.nodes[idx].source_keys:
            taken = self.by_source.get(k)
            if taken is not None and fi in self.sources[taken]:
                # Один якорь на два узла ОДНОГО файла: агент повесил общий
                # git-remote на все сервисы монорепо, не различив их путями.
                # Склеивать нельзя (см. _match_by_source), но следующие файлы
                # найдут по этому ключу только первого — предупреждаем.
                # Природа — схемная: имена пары приходят из разных прогонов, а
                # последствие («следующие файлы свяжутся только с первым») — про
                # весь пакет, а не про один документ.
                self.report.warn(
                    f"«{self.nodes[taken].name}» и «{node.name}» указывают один источник "
                    f"({k}) — уточните source.path у каждого, иначе следующие файлы "
                    f"свяжутся только с первым"
                )
                continue
            self.by_source.setdefault(k, idx)

    def _remember_group(self, idx: int, fi: int, ni: int) -> None:
        """Узел, в который лёг атом группы, — адресат для остальных её атомов."""
        gid = self.force.get((fi, ni))
        if gid is not None:
            self.by_group.setdefault(gid, idx)

    def _match_by_group(self, fi: int, ni: int) -> int | None:
        """Склейка, УЖЕ установленная стабилизацией предыдущего прохода (v3): решение
        принято на полном результате, где виден каждый вклад, поэтому оно сильнее
        инкрементальных матчеров и проверяется первым. Узлы одного файла не
        склеиваются и здесь — правило общее для всех матчеров."""
        gid = self.force.get((fi, ni))
        if gid is None:
            return None
        hit = self.by_group.get(gid)
        return None if hit is None or fi in self.sources[hit] else hit

    def add_node(self, node: _ImpNode, parent_m: int | None, fi: int, ni: int, sub: bool) -> int:
        hit = self._match_by_group(fi, ni)
        if hit is None:
            hit = self._match_by_source(node, fi)
        if hit is None:
            hit = self._match_by_name(node, parent_m)
        if hit is None:
            idx = len(self.nodes)
            self.nodes.append(replace(node, parent_idx=parent_m))
            prefix = f"{self.paths[parent_m]} / " if parent_m is not None else ""
            self.paths.append(prefix + node.name)
            self.sources.append({fi})
            self.substantial.append(sub)
            self.contribs.append([(fi, ni, list(node.source_keys))])
            # Все поля нового узла пришли из этого файла — спорить с ними следующие
            # будут против его содержательности.
            self.value_src.append(dict.fromkeys(_MERGED_FIELDS, (fi, sub)))
            self._remember_group(idx, fi, ni)
            self._register(idx, node, parent_m, fi)
            return idx
        self.contribs[hit].append((fi, ni, list(node.source_keys)))
        self._remember_group(hit, fi, ni)
        # Узел уже есть — склейка полей. Имя оставляем первое встреченное
        # (различие лишь в регистре/пробелах — в отчёт не шумим).
        if fi not in self.sources[hit] and len(self.sources[hit]) == 1:
            self.report.merged_paths.append(self.paths[hit])
        # Якорь связал узлы, названные ПО-РАЗНОМУ (в своём репозитории сервис зовётся
        # «app», вызывающие ходят на «payments») либо положенные под разных родителей.
        # Оставляем первое — перевешивать поддерево по позднему файлу опаснее, чем
        # оставить расхождение видимым в отчёте.
        creator = min(self.sources[hit])  # имя и место узла всегда от создателя
        if _norm(node.name) != _norm(self.nodes[hit].name):
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
        self._merge_str(hit, "role", node.role, fi, sub)
        self._merge_str(hit, "technology", node.technology, fi, sub)
        self._merge_str(hit, "description", node.description, fi, sub)
        self._merge_enum(hit, "shape", node.shape, "service", fi, sub)
        self._merge_enum(hit, "status", node.status, "existing", fi, sub)
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
            self.report.conflicts.append(
                f"{self.paths[hit]}: external: файлы {keep_fi + 1} и {fi + 1} расходятся — "
                f"оставлено {'true' if winner else 'false'}"
            )
            if winner != self.nodes[hit].is_external:
                self.nodes[hit].is_external = winner
                self.value_src[hit]["is_external"] = (fi, sub)
        self.sources[hit].add(fi)
        self.substantial[hit] = self.substantial[hit] or sub
        return hit

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
        self.edges.append(_ImpEdge(src, dst, e.label, e.technology, e.channel))
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
        a = self.paths[self.edges[idx].source_idx]
        b = self.paths[self.edges[idx].target_idx]
        self.report.conflicts.append(
            f"связь «{a} → {b}»: канал: оставлено «{cur}» (файл {first + 1}), "
            f"отброшено «{new}» (файл {fi + 1})"
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
            norms = [_norm(self.nodes[i].name) for i in idxs]
            for a in range(len(idxs)):
                for b in range(a + 1, len(idxs)):
                    ia, ib = idxs[a], idxs[b]
                    if self.sources[ia] & self.sources[ib]:
                        continue  # жили в одном файле — названы different осознанно
                    if not _similar(norms[a], norms[b]):
                        continue
                    where = f"внутри «{self.paths[parent]}»" if parent is not None else "на верхнем уровне"
                    # Пара заведомо из РАЗНЫХ файлов (условие выше) — схемное.
                    self.report.warn(
                        f"«{self.nodes[ia].name}» и «{self.nodes[ib].name}» ({where}) похожи — "
                        f"возможно, один объект из разных файлов; если да, приведите имена к одному"
                    )

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

    def finish(self, parts: list[ParsedImport]) -> tuple[ParsedImport, MergeReport]:
        # Атрибуция — до предупреждений содержания: по ней warn_content решает,
        # чей файл виноват в замечании о конкретном узле/связи.
        self.report.node_files = [set(s) for s in self.sources]
        self.report.edge_files = self.edge_files
        self.warn_similar_edges()
        self.warn_fuzzy_siblings()
        self.warn_roots(parts)
        if len(self.report.warnings) > _MAX_WARNINGS:
            extra = len(self.report.warnings) - _MAX_WARNINGS
            del self.report.warnings[_MAX_WARNINGS:]
            del self.report.warning_files[_MAX_WARNINGS:]  # разметка идёт строка в строку
            self.report.warn(f"…и ещё {extra} предупреждений")
        # Лимиты — свойство СЛИТОЙ картины: один файл в них не виноват.
        if len(self.nodes) > MAX_NODES:
            self.report.error(f"После слияния слишком много узлов (больше {MAX_NODES})")
        if len(self.edges) > MAX_EDGES:
            self.report.error(f"После слияния слишком много связей (больше {MAX_EDGES})")
        roots = [n.name for n in self.nodes if n.parent_idx is None]
        return ParsedImport(nodes=self.nodes, edges=self.edges, roots=roots), self.report


def merge_imports(parts: list[ParsedImport]) -> tuple[ParsedImport, MergeReport]:
    """Слить N разобранных импортов в один. Всегда возвращает (результат, отчёт);
    непустой report.errors означает «результат непригоден» (суммарные лимиты).
    Один файл — passthrough без отчётных записей."""
    if len(parts) == 1:
        # Атрибуция вырожденная (всё из файла 0), но заполняем: warn_content не
        # должен знать, сколько было файлов.
        return parts[0], MergeReport(
            files=1,
            node_files=[{0} for _ in parts[0].nodes],
            edge_files=[{0} for _ in parts[0].edges],
        )
    # Проход инкрементальный (файл за файлом), поэтому чувствителен к порядку: узел
    # копит ключи, и поздний кандидат сравнивается уже с накопленным. Стабилизация
    # (_regroup) смотрит на ГОТОВЫЙ результат, где каждый вклад виден по отдельности,
    # и повторяет проход с найденными склейками — пока новых не находится. Так исход
    # перестаёт зависеть от порядка панели (тот же инвариант, что у П2).
    m = _run_merge(parts, {})
    for _ in range(_MAX_STABILIZE_PASSES):
        force = _regroup(m)
        if force is None:
            break
        m = _run_merge(parts, force)
    return m.finish(parts)


def _run_merge(parts: list[ParsedImport], force: dict[tuple[int, int], int]) -> _Merger:
    """Один проход слияния: файлы по порядку, узлы «родители раньше детей»."""
    m = _Merger(files=len(parts), force=force)
    for fi, part in enumerate(parts):
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
        namesakes.setdefault((n.parent_idx, _norm(n.name)), []).append(i)
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
    # Связь узла с собственным потомком разбирается ПЕРВОЙ и снимается с
    # контейнерного класса: у неё свой диагноз и свой ответ (см. _warn_descendant_edges).
    внутренние = _warn_descendant_edges(merged, report)
    _warn_container_edges(merged, report, parents, внутренние)
    _warn_broker_edges(merged, report)
    _warn_channel_lists(merged, report)
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
    """Связи, упирающиеся в контейнер, У КОТОРОГО ЕСТЬ компоненты.

    После импорта это алерт AL8, но агент к тому моменту уже ушёл: в раунде 3
    полевого QA (docs/qa-zabbix-7.md) их накопилось 13 — «дополняй связями» слабая
    модель исполнила, а дубли с уровня контейнера не убрала. Поэтому предупреждаем
    ДО импорта и НАЗЫВАЕМ каждую связь: замечание лечится переносом конца на
    компонент, и агенту нужен конкретный конец, а не правило.

    Определение контейнера — зеркало app/alerts.compute_alerts (узел с детьми),
    но по СЛИТОМУ дереву: проекта на этот момент ещё не существует.

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
    shown = hidden = 0
    hidden_idxs: list[int] = []
    for ei, e in enumerate(merged.edges):
        if ei in skip:
            continue
        # dict.fromkeys — на случай петли «узел сам на себя»: конец один, не два.
        ends = [i for i in dict.fromkeys((e.source_idx, e.target_idx)) if i in parents]
        if not ends:
            continue
        if shown >= _MAX_CONTAINER_EDGES:
            hidden += 1
            hidden_idxs.append(ei)
            continue
        shown += 1
        a, b = merged.nodes[e.source_idx].name, merged.nodes[e.target_idx].name
        names = [merged.nodes[i].name for i in ends]
        one = len(names) == 1
        cap = _MAX_CONTAINER_KIDS if one else _MAX_CONTAINER_KIDS_BOTH
        targets = "; ".join(_kids_phrase(merged.nodes[i].name, kids[i], cap) for i in ends)
        head = (
            f"конец в контейнере «{names[0]}», у которого есть компоненты, — "
            f"уточните её до конкретного компонента: {targets}"
            if one
            else f"оба конца в контейнерах «{names[0]}» и «{names[1]}», у которых есть "
            f"компоненты, — уточните её до конкретных компонентов: {targets}"
        )
        report.warn(f"связь «{a} → {b}»: {head}", report.owner_of_edges([ei]))
    if hidden:
        # Хвост-счётчик — тому, чьи все скрытые связи (как у соседних классов).
        report.warn(f"…ещё {hidden} таких связей", report.owner_of_edges(hidden_idxs))


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


def _warn_broker_edges(merged: ParsedImport, report: MergeReport) -> None:
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
    """
    shown = hidden = 0
    hidden_idxs: list[int] = []
    for ei, e in enumerate(merged.edges):
        if _fill(e.channel):
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


def _warn_channel_lists(merged: ParsedImport, report: MergeReport) -> None:
    """Связи, у которых в channel не имя канала, а ПЕРЕЧЕНЬ имён.

    Находка №2 полевого QA (docs/qa-zulip-brokers.md): агент кладёт в поле
    «email, notify_orders, digest_emails». Правило промпта («одна пара ходит по
    нескольким топикам — это несколько рёбер, по ребру на канал») есть и прямое, но
    исполняется через раз, а машинной проверки формы не было ни в превью, ни в
    валидаторе — промах всплывал уже после импорта нечитаемым AL31. Тот же урок Х5,
    что у соседей: правило дисперсно, цель называет машина.

    Разделителем считаем запятую и точку с запятой. Точки, дефисы и версии в имени
    канала — норма («orders.created», «notify-orders»), и подозрений не вызывают.
    """
    shown = hidden = 0
    hidden_idxs: list[int] = []
    for ei, e in enumerate(merged.edges):
        if not _fill(e.channel) or not any(sep in e.channel for sep in (",", ";")):
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

    Ядро связности — общее с алертом (connected_components), поэтому вердикты сходятся.
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
    comps = connected_components([(e.source_idx, e.target_idx) for e in merged.edges])
    if len(comps) < 2:
        return  # один кластер (плюс, возможно, одиночки) — фрагментации нет
    # Ядро — самая крупная; при равных размерах порядок задаёт первое имя, иначе
    # «ядром» становилось бы то одно, то другое от прогона к прогону.
    comps.sort(key=lambda c: (-len(c), sorted(merged.nodes[i].name for i in c)))
    for comp in comps[1 : _MAX_ISOLATED_GROUPS + 1]:
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
        # Хвост-счётчик — только тому, чьи все скрытые группы (как у соседних классов).
        report.warn(
            f"…ещё {len(hidden_comps)} таких групп",
            report.owner_of_nodes([i for comp in hidden_comps for i in comp]),
        )


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
    warn_content(merged, report)
    return merged, report, []
