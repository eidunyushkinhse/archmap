"""Превью единого импорта: N входов любого типа (Ф1, docs/plan-unified-import.md).

Схема ЕДИНОЙ панели ввоза: чипы .yaml и .zip вперемешку, живая сводка, споры
семей фактов с выбором пользователя. C4-часть переиспользует ImportPreviewOut —
ту же модель, что отдаёт /import/preview: сводка слияния, пофайловые замечания и
корзины схемного уровня у обоих сценариев одни и те же, второго формата отчёта
не заводим (норма эпика архива).

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
from app.schemas.node import NodeSource
from app.schemas.process_import import ProcessImportResult
from app.schemas.project import ImportPreviewOut, MergedNodeOut


class FamilyCandidateOut(BaseModel):
    """Один вариант тела в споре: чей он и что в нём.

    body обрезан капом превью (truncated=true) — выбор делается по сводке и
    началу текста, целиком тело приедет применением."""

    origin: int  # индекс входа (с 0) — порядок чипов панели
    origin_label: str  # имя файла/чипа, как его назвал пользователь
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
    # C4-часть: та же модель, что у /import/preview. Пофайловые замечания в ней
    # нумеруются ВХОДАМИ (архив — такой же вход, как YAML), и замечания семей
    # (промах адреса, внутриархивный дубль) доложены туда же по индексу входа.
    c4: ImportPreviewOut | None = None
    families: UnifiedFamilyCountsOut = UnifiedFamilyCountsOut()
    family_conflicts: list[FamilyConflictOut] = []
    warnings: list[str] = []  # верхнеуровневое, не адресуемое входу (тёзки процессов)
    # Откуда брать имя и описание проекта (П3): ровно один вход и он архив —
    # «копия одного архива», поля прячутся и берутся из манифеста; иначе поля
    # заполняет пользователь.
    name_source: Literal["manifest", "fields"] = "fields"
    manifest_name: str | None = None
    manifest_description: str | None = None


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
    # Одним списком: замечания слияния, тёзки процессов и промахи адресов семей —
    # для человека это одна категория «посмотри глазами» (норма синка).
    warnings: list[str] = []
    # Fence: применение вернёт их обратно, и разошедшийся проект получит 409
    # «обновите превью». Курсоров ДВА — догрузка меняет и схему, и мету.
    base_graph_rev: int = 0
    base_meta_rev: int = 0


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
    warnings: list[str] = []
    resolved_conflicts: int = 0
    # Свежие курсоры: фронт кладёт их в поллинг, не дожидаясь следующего опроса.
    graph_rev: int = 0
    meta_rev: int = 0
