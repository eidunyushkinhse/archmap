"""Превью единого импорта: N входов любого типа (Ф1, docs/plan-unified-import.md).

Схема ЕДИНОЙ панели ввоза: чипы .yaml и .zip вперемешку, живая сводка, споры
семей фактов с выбором пользователя. C4-часть переиспользует ImportPreviewOut —
модель сводки слияния (пофайловые замечания и корзины схемного уровня); прежний
второй сценарий, /import/preview текстами, снесён 2026-09-05, второго формата
отчёта не заводим (норма эпика архива).

КОНФЛИКТ СЕМЬИ ≠ ImportPreviewOut.conflicts: там расхождения C4-ПОЛЕЙ узла
(строки отчёта, решённые правилом мерджа), здесь — спор о ТЕЛЕ факта, который
рассудить может только человек. Смешивать нельзя: у них разная природа и разная
судьба (первое читают, второе выбирают).
"""

import uuid
from typing import Literal

from pydantic import BaseModel

from app.schemas.channels_import import ChannelsImportReport
from app.schemas.config_import import ConfigImportReport
from app.schemas.data_import import DataImportReport
from app.schemas.demo import DemoExcess
from app.schemas.node import NodeSource
from app.schemas.process_import import ProcessImportResult
from app.schemas.project import ImportPreviewOut, MergedNodeOut


class FamilyCandidateOut(BaseModel):
    """Один вариант тела в споре: чей он и что в нём.

    body обрезан капом превью (truncated=true) — выбор делается по сводке и
    началу текста, целиком тело приедет применением."""

    origin: int  # индекс входа (с 0) — порядок чипов панели
    origin_label: str  # имя файла/чипа, как его назвал пользователь
    # ИСТОЧНИК ЗНАНИЯ словами (Ф-E, §4.7 ТЗ, правка Ф2г): «Из архива plugin-a.zip»,
    # «Из файла shop.yaml», «Из файла 2» (вставлен текстом), «Из проекта».
    # Кандидат подписывается им, а не метаданными тела: пользователь выбирает между
    # источниками, а не между «41 строкой, 6 вершинами».
    source_label: str = ""
    summary: str  # человеческая сводка: «12 строк», «5 колонок», «тип int, дефолт «5000»»
    body: str
    truncated: bool
    # Кандидат ТЕКУЩЕГО проекта (только догрузка, Ф3): на нём стоит дефолт спора,
    # и подписан он «Оставить моё». При создании проекта таких кандидатов нет.
    current: bool = False


class FamilyConflictOut(BaseModel):
    """Спор о теле одного ключа у одного узла слитого дерева.

    id стабилен между превью и применением (мердж детерминирован), поэтому
    резолюции передаются словарём id → выбор, а план пересчитывается на сервере."""

    id: str  # «family|путь узла|ключ»
    family: Literal["doc", "spec", "table", "channel", "config"]
    node_path: str
    key: str  # имя схемы / «схема.таблица» / «группа/канал» / имя параметра / «openapi»
    candidates: list[FamilyCandidateOut]
    # Выбор: «cand:<i>» — тело кандидата i; «all» — взять все (только доки: тёзкам
    # достанется суффикс « (2)»). Здесь — ДЕФОЛТ, который применится без вмешательства.
    default: str
    allow_all: bool


# ── Структурный остаток слияния (Ф-E, docs/plan-byoa-quality.md) ────────────
#
# То, что мердж решить не может, приезжает в превью СТРУКТУРОЙ, а не только
# строками: фронт задаёт по ней вопросы, ответы уезжают применению словарём
# decisions и меняют слитое дерево ДО записи в БД. Строки conflicts/warnings/
# schema_warnings при этом ОСТАЮТСЯ на месте — их читает MCP пользователя, и
# контракты превью только дополняются (Р1 задания Ф1).
#
# Все id ДЕТЕРМИНИРОВАНЫ (мердж детерминирован, план считается заново на
# применении) — как у FamilyConflictOut.


class RemainderCandidateOut(BaseModel):
    """Один вариант ответа, пришедший из конкретного входа."""

    origin: int  # индекс входа (с 0)
    origin_label: str  # чип панели: «2 · grafana.yaml»
    source_label: str  # источник знания словами: «Из файла grafana.yaml»
    value: str
    current: bool = False  # вклад ЖИВОГО проекта (вход №0 догрузки)


class FieldDisputeOut(BaseModel):
    """Спор о поле узла между РАВНО содержательными вкладами (§4.2 ТЗ).

    Спора нет там, где один из вкладов видел узел изнутри: правило мерджа (П2)
    знает ответ, и вопрос был бы вопросом о том, что уже решено."""

    id: str  # «field|путь узла|поле»
    node_path: str
    field: Literal["description", "technology", "role", "shape", "status"]
    candidates: list[RemainderCandidateOut]  # в порядке входов
    default: int  # индекс кандидата, который применится без ответа


class ComponentOut(BaseModel):
    """Компонент контейнера — возможная цель конца связи."""

    path: str  # полный путь: «Grafana / Сервер Grafana / Рантайм плагинов»
    has_children: bool


class ContainerEdgeOut(BaseModel):
    """Конец связи, легший на контейнер целиком (§4.3 ТЗ). Оба конца в
    контейнерах — ДВА элемента: у каждого свой ответ."""

    id: str  # «edge|откуда|куда|подпись|конец»
    from_path: str
    to_path: str
    label: str | None = None
    technology: str | None = None
    end: Literal["source", "target"]
    container_path: str
    components: list[ComponentOut]  # всё поддерево контейнера, без капа


class IsolatedGroupOut(BaseModel):
    """Группа объектов, не связанная с остальной схемой (§4.4 ТЗ): факт
    совместного развёртывания не виден ни из одного репозитория по отдельности."""

    id: str  # «group|путь первого узла группы»
    node_paths: list[str]  # все узлы группы; кап перечня — дело фронта


class FuzzyPairOut(BaseModel):
    """Похожие имена из разных входов (§4.5 ТЗ). Мердж не склеивает их никогда —
    ложная склейка хуже дубля, — поэтому решает человек."""

    id: str  # «pair|путь A|путь B»
    a_path: str
    b_path: str
    a_source: str  # источник знания словами (§4.7)
    b_source: str
    a_edges: int  # связей у A в слитом дереве
    b_edges: int
    where: str  # «на верхнем уровне» | «внутри «X»»
    a_current: bool = False  # A — живой узел (догрузка)
    b_current: bool = False


class UnfixableOut(BaseModel):
    """Пункт свёртки «Придется подправить вручную» (§6 ТЗ, правка Ф2г): замечание,
    которое выбором не закрыть. Структурой, а не строкой, — чтобы фронту не парсить
    тексты. Пути починки «для агента» здесь нет: панель ввоза не знает, откуда
    файлы, и советовать «прогоните агента» ей не с чего."""

    id: str
    # Готовый пункт человеку («У связи «A → B» с брокером «Br» не указан канал. …»);
    # хвост «…ещё N» приклеен предложением «И ещё N таких же.». Незнакомое
    # замечание — сырой строкой как есть.
    text: str
    file: int | None = None  # индекс входа-владельца; None — замечание о слитой схеме


class RemainderOut(BaseModel):
    """Остаток слияния целиком. Пустой — разбирать нечего (и это нормальный
    результат: спрашивать не о чем)."""

    field_conflicts: list[FieldDisputeOut] = []
    container_edges: list[ContainerEdgeOut] = []
    isolated_groups: list[IsolatedGroupOut] = []
    fuzzy_pairs: list[FuzzyPairOut] = []
    unfixable: list[UnfixableOut] = []
    # Строки замечаний, СТАВШИЕ вопросами выше, — теми же текстами, что в
    # c4.warnings / c4.schema_warnings / file_remarks[*].warnings. Фронт прячет их
    # из списков замечаний: иначе пользователь прочитает одно и то же дважды —
    # вопросом и строкой. Хвосты-счётчики («…ещё N таких связей») попадают сюда
    # вместе со своими скрытыми записями. Бэк сами списки НЕ режет (Р1): их читает
    # MCP, и объединение корзин обязано оставаться плоскими списками отчёта.
    converted_warnings: list[str] = []
    # Слитое дерево для пикера концов новой связи (§5.3/5.4): полные пути всех
    # узлов и признак «контейнер» строка в строку.
    node_paths: list[str] = []
    node_has_children: list[bool] = []


class UnifiedFamilyCountsOut(BaseModel):
    """Что приедет при ДЕФОЛТНЫХ резолюциях: доки спора едут все, скаляры — первый."""

    docs: int = 0
    specs: int = 0
    tables: int = 0
    channels: int = 0
    params: int = 0
    processes: int = 0


class UnifiedPreviewOut(BaseModel):
    """Сводка dry-run единого ввоза. БД не тронута — применение отдельным вызовом (Ф2)."""

    ok: bool
    errors: list[str] = []  # пусто при ok=true; адресация — «вход N: …» и c4.file_remarks
    # C4-часть: модель сводки слияния ImportPreviewOut. Пофайловые замечания в ней
    # нумеруются ВХОДАМИ (архив — такой же вход, как YAML), и замечания семей
    # (промах адреса, внутриархивный дубль) доложены туда же по индексу входа.
    c4: ImportPreviewOut | None = None
    families: UnifiedFamilyCountsOut = UnifiedFamilyCountsOut()
    family_conflicts: list[FamilyConflictOut] = []
    # Остаток слияния структурой (Ф-E). Строки c4.conflicts / c4.warnings /
    # c4.schema_warnings остаются на месте: структура их дополняет, не заменяет.
    remainder: RemainderOut = RemainderOut()
    warnings: list[str] = []  # верхнеуровневое, не адресуемое входу (тёзки процессов)
    # Откуда брать имя и описание проекта (П3): ровно один вход и он архив —
    # «копия одного архива», поля прячутся и берутся из манифеста; иначе поля
    # заполняет пользователь.
    name_source: Literal["manifest", "fields"] = "fields"
    manifest_name: str | None = None
    manifest_description: str | None = None
    # Демо-стенд: новый проект не поместится в пределы (docs/tasks/demo-mode.md).
    # Только в демо-режиме и только при превышении; «Создать» на фронте гаснет.
    demo_excess: DemoExcess | None = None


class NewNodeOut(BaseModel):
    """Новый узел догрузки с его ЯКОРЕМ (Ф2 docs/plan-anchor-ux.md).

    source пусто — якоря у узла не будет, и следующая догрузка найдёт его только по
    имени внутри контейнера. Пользователь вправе знать это ДО применения: с якорем
    объект переживает переименование, без якоря — превращается в дубль."""

    path: str
    source: NodeSource | None = None


class IntoPreviewOut(BaseModel):
    """Сводка dry-run ДОГРУЗКИ архивов к живому проекту (Ф3). БД не тронута.

    Числа тут — про ДИФФ, а не про содержимое архивов: сколько узлов и связей
    появится, сколько записей семей приедет ПРИ ДЕФОЛТНЫХ решениях (а дефолт спора
    с живым — «оставить моё», поэтому в счётчике только бесспорное новое).
    Перетирание живого случается ровно там, где пользователь выбрал архивного
    кандидата, — и видно это в family_conflicts, а не в счётчиках.
    """

    ok: bool
    errors: list[str] = []  # адресованы чипу именем файла: «a.zip: …»
    nodes_new: int = 0
    nodes_new_paths: list[str] = []  # первые несколько путей — «что именно приедет»
    # Те же новые узлы С ЯКОРЯМИ (Ф2 якорей). nodes_new_paths выше не заменяется:
    # контракты превью только дополняются.
    new_nodes: list[NewNodeOut] = []
    # Живые узлы, к которым ПРИЕДЕТ знание из архивов (найдены мерджем). Числа выше
    # про новое, эти — про сопоставление: не назвав его, догрузка молчит о самой
    # спорной своей части — что именно она сочла тем же объектом и почему.
    nodes_matched: int = 0
    matched_nodes: list[MergedNodeOut] = []  # первые несколько — путь + основание
    edges_new: int = 0
    families: UnifiedFamilyCountsOut = UnifiedFamilyCountsOut()
    family_conflicts: list[FamilyConflictOut] = []
    # Остаток слияния структурой (Ф-E). В догрузке — только с участием архива:
    # остаток, все сущности которого из живого проекта, это дело панели
    # незавершённости, а не догрузки (Р3 задания Ф1).
    remainder: RemainderOut = RemainderOut()
    # Одним списком: замечания слияния, тёзки процессов и промахи адресов семей —
    # для человека это одна категория «посмотри глазами» (норма синка).
    warnings: list[str] = []
    # Fence: применение вернёт их обратно, и разошедшийся проект получит 409
    # «обновите превью». Курсоров ДВА — догрузка меняет и схему, и мету.
    base_graph_rev: int = 0
    base_meta_rev: int = 0
    # Демо-стенд: после догрузки проект выйдет за предел (docs/tasks/demo-mode.md).
    demo_excess: DemoExcess | None = None


class IntoApplyOut(BaseModel):
    """Отчёт применения догрузки: что именно изменилось в живом проекте.

    Форма СВОЯ, а не ArchiveImportResult: у создания числа значат «сколько знания
    в проекте», у догрузки — «сколько записей тронуто», и путать их нельзя.
    Отчёты семей при этом РОДНЫЕ (вторых форматов не заводим, норма эпика архива).
    """

    project_id: uuid.UUID
    nodes_created: int = 0
    nodes_filled: int = 0  # живые узлы, которым долили пустые поля (fill-only)
    edges_created: int = 0
    docs_created: int = 0
    docs_replaced: int = 0  # тело живой схемы заменено выбором «взять из архива»
    specs_applied: int = 0
    params_replaced: int = 0
    db: DataImportReport | None = None
    channels: ChannelsImportReport | None = None
    config: ConfigImportReport | None = None
    processes: list[ProcessImportResult] = []
    warnings: list[str] = []  # сырые строки: их читают MCP и журналы
    # Те же замечания человеку (правка Ф2г-2): свёртка «Придется подправить вручную»
    # экрана «Архивы догружены» — остаток плана, не ставший вопросом, и строки
    # применения, требующие внимания. Информация о сделанном («пустовало — залито»,
    # «Ваши решения: …») сюда не едет: её и так видно по счётчикам.
    unfixable: list[UnfixableOut] = []
    resolved_conflicts: int = 0
    channel_stubs: int = 0  # заглушки каналов по НОВЫМ связям догрузки (см. archive.py)
    # Свежие курсоры: фронт кладёт их в поллинг, не дожидаясь следующего опроса.
    graph_rev: int = 0
    meta_rev: int = 0
