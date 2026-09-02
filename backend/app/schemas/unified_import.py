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

from typing import Literal

from pydantic import BaseModel

from app.schemas.project import ImportPreviewOut


class FamilyCandidateOut(BaseModel):
    """Один вариант тела в споре: чей он и что в нём.

    body обрезан капом превью (truncated=true) — выбор делается по сводке и
    началу текста, целиком тело приедет применением."""

    origin: int  # индекс входа (с 0) — порядок чипов панели
    origin_label: str  # имя файла/чипа, как его назвал пользователь
    summary: str  # человеческая сводка: «12 строк», «5 колонок», «тип int, дефолт «5000»»
    body: str
    truncated: bool


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
