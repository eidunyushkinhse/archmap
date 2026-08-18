"""Снапшот-тесты промптов: АБСОЛЮТНЫЙ сторож текста, который уезжает агенту.

ЗАЧЕМ ЕЩЁ ОДИН СТОРОЖ. Сентинелы «байт-в-байт» у промптов уже есть, но все они
ОТНОСИТЕЛЬНЫЕ: сравнивают текст с флагом против текста без флага (федерация,
каталоги, точки входа). Правка БЕЗУСЛОВНОЙ строки проходит мимо них — едут обе
стороны сравнения сразу, и разницы нет. За неделю мимо этих сторожей прошли пять
правок промптов (данные, доки ×2, конфигурация, скептик), и каждая была замечена
только глазами. Промпт — главный продуктовый артефакт BYOA: почти все полевые
дефекты чинились именно в нём, а не в коде.

ЧТО ГАРАНТИРУЕТ ЭТОТ ФАЙЛ. Полный текст каждого промпта лежит в
tests/snapshots/prompts/<случай>.txt и сравнивается посимвольно. Любая правка любой
строки любого промпта роняет тест и требует ОСОЗНАННОГО обновления снапшота.
Смысл не в том, что текст не должен меняться, — а в том, что его изменение обязано
быть ВИДНО в диффе коммита. Правка промпта без дифф-а снапшота означает, что
тронуто не то, что собирались тронуть.

КАК ОБНОВЛЯТЬ (после осознанной правки промпта):

    UPDATE_PROMPT_SNAPSHOTS=1 ./venv/bin/python -m pytest tests/test_prompt_snapshots.py -q

и посмотреть `git diff tests/snapshots/` — это и есть ревью правки.

ЧТО СНИМАЕТСЯ. Не сборщики по отдельности, а РЕЗУЛЬТАТ РУЧКИ: prompt_for_variant
(variant, flow, …) — ровно та строка, которую отдаёт эндпоинт. Поэтому сторож видит
и правку строительного промпта, и правку скептика, и правку оркестраторной обёртки.

ПОЧЕМУ ЭТО НАДЁЖНО. Сборщики промптов — чистые функции своих аргументов: ни времени,
ни случайности, ни обхода множеств внутри них нет. Значит снапшот не «протухает сам».
"""

import difflib
import os
import pathlib
from collections.abc import Callable
from dataclasses import dataclass
from typing import get_args

import pytest

from app.channels_prompt import build_channels_prompt
from app.config_prompt import build_config_prompt
from app.data_prompt import build_data_prompt
from app.docs_prompt import build_docs_prompt
from app.import_prompt import build_import_prompt
from app.recon_prompt import build_recon_prompt
from app.skeptic_prompt import Flow, PromptVariant, prompt_for_variant

SNAP_DIR = pathlib.Path(__file__).parent / "snapshots" / "prompts"
UPDATE = os.environ.get("UPDATE_PROMPT_SNAPSHOTS") == "1"
# Сколько строк диффа показывать при расхождении: полный дифф промпта — стена в
# несколько экранов, а для «что поехало» хватает начала.
DIFF_LINES = 60

ПОДСКАЗКА = (
    "Промпт изменился. Если правка ОСОЗНАННАЯ — обнови снапшоты:\n"
    "    UPDATE_PROMPT_SNAPSHOTS=1 ./venv/bin/python -m pytest "
    "tests/test_prompt_snapshots.py -q\n"
    "и покажи `git diff tests/snapshots/` в ревью. Если правка не задумывалась — "
    "значит тронуто не то."
)

# ── Фикстуры аргументов ──────────────────────────────────────────────────────
# Фиксированные и маленькие: снапшот должен читаться человеком, а не быть дампом.
SLICE = (
    "nodes:\n"
    "- name: Ярмарка\n"
    "  shape: service\n"
    "  children:\n"
    "  - name: orders\n"
    "    shape: service\n"
    "  - name: Каталог-БД\n"
    "    shape: database\n"
    "edges: []\n"
)
DB_PATHS = ["Ярмарка / Каталог-БД", "Ярмарка / Учёт-БД"]
BROKER_PATHS = ["Ярмарка / Шина событий"]
SERVICE_PATHS = ["Ярмарка / orders", "Ярмарка / billing"]
TABLE_CATALOG = {"Ярмарка / Каталог-БД": ["orders", "order_items", "catalog.items"]}
CHANNEL_CATALOG = {"Ярмарка / Шина событий": ["orders.created", "billing.paid"]}
EDGE_CHANNELS = {"Ярмарка / Шина событий": ["orders.created"]}
DESCRIBED = {"Ярмарка / orders": ["GET /orders", "Создание заказа (POST /orders)"]}
PENDING = {"Ярмарка / orders": ["DELETE /orders/{id}", "email_senders"]}
SYSTEM = "Голосовалка"
NODE_PATH = "Ярмарка / orders"


@dataclass(frozen=True)
class Case:
    """Один снимок: имя файла, поток и вариант ручки, сборка текста."""

    name: str
    flow: Flow
    variant: PromptVariant
    build: Callable[[], str]


def _case(name: str, flow: Flow, variant: PromptVariant, build: Callable[[], str]) -> Case:
    return Case(name=name, flow=flow, variant=variant, build=build)


# ── Реестр случаев ───────────────────────────────────────────────────────────
# Разворот по вариантам ручки (builder / skeptic / orchestrated) — обязателен для
# КАЖДОГО потока: это сторожит test_каждый_поток_и_вариант_под_снапшотом. Развилки
# внутри строительного промпта (флаги, языки, каталоги) добавляются к варианту
# builder — именно там живёт продуктовый текст.
CASES: list[Case] = [
    # ── импорт схемы ─────────────────────────────────────────────────────────
    _case("import--builder", "import", "builder",
          lambda: prompt_for_variant("builder", "import", build_import_prompt(SYSTEM))),
    _case("import--builder-multi-product", "import", "builder",
          lambda: prompt_for_variant(
              "builder", "import", build_import_prompt(SYSTEM, multi_product=True))),
    _case("import--builder-en-hints-depth", "import", "builder",
          lambda: prompt_for_variant(
              "builder", "import",
              build_import_prompt(SYSTEM, depth=2, lang="en", hints="монорепа, см. services/"))),
    _case("import--skeptic", "import", "skeptic",
          lambda: prompt_for_variant(
              "skeptic", "import", build_import_prompt(SYSTEM), system_name=SYSTEM)),
    _case("import--orchestrated", "import", "orchestrated",
          lambda: prompt_for_variant(
              "orchestrated", "import", build_import_prompt(SYSTEM), system_name=SYSTEM)),
    # ── схемы логики и спеки ─────────────────────────────────────────────────
    _case("docs--builder", "docs", "builder",
          lambda: prompt_for_variant("builder", "docs", build_docs_prompt(SLICE))),
    _case("docs--builder-logic-only", "docs", "builder",
          lambda: prompt_for_variant(
              "builder", "docs", build_docs_prompt(SLICE, include="logic"))),
    _case("docs--builder-api-only", "docs", "builder",
          lambda: prompt_for_variant("builder", "docs", build_docs_prompt(SLICE, include="api"))),
    _case("docs--builder-en", "docs", "builder",
          lambda: prompt_for_variant("builder", "docs", build_docs_prompt(SLICE, lang="en"))),
    _case("docs--builder-target", "docs", "builder",
          lambda: prompt_for_variant(
              "builder", "docs", build_docs_prompt(SLICE, target="POST /orders"))),
    _case("docs--builder-hints", "docs", "builder",
          lambda: prompt_for_variant(
              "builder", "docs", build_docs_prompt(SLICE, hints="код лежит в backend/"))),
    _case("docs--builder-catalogs", "docs", "builder",
          lambda: prompt_for_variant(
              "builder", "docs",
              build_docs_prompt(
                  SLICE, table_catalog=TABLE_CATALOG, channel_catalog=CHANNEL_CATALOG))),
    _case("docs--builder-entry-points", "docs", "builder",
          lambda: prompt_for_variant(
              "builder", "docs",
              build_docs_prompt(SLICE, described_entries=DESCRIBED, pending_entries=PENDING))),
    _case("docs--skeptic", "docs", "skeptic",
          lambda: prompt_for_variant("skeptic", "docs", build_docs_prompt(SLICE))),
    _case("docs--orchestrated", "docs", "orchestrated",
          lambda: prompt_for_variant("orchestrated", "docs", build_docs_prompt(SLICE))),
    # ── структура БД ─────────────────────────────────────────────────────────
    _case("data--builder", "data", "builder",
          lambda: prompt_for_variant("builder", "data", build_data_prompt(DB_PATHS[:1]))),
    _case("data--builder-many-dbs", "data", "builder",
          lambda: prompt_for_variant("builder", "data", build_data_prompt(DB_PATHS))),
    _case("data--skeptic", "data", "skeptic",
          lambda: prompt_for_variant("skeptic", "data", build_data_prompt(DB_PATHS))),
    _case("data--orchestrated", "data", "orchestrated",
          lambda: prompt_for_variant("orchestrated", "data", build_data_prompt(DB_PATHS))),
    # ── каналы брокера ───────────────────────────────────────────────────────
    _case("channels--builder", "channels", "builder",
          lambda: prompt_for_variant(
              "builder", "channels", build_channels_prompt(BROKER_PATHS))),
    _case("channels--builder-multi-broker", "channels", "builder",
          lambda: prompt_for_variant(
              "builder", "channels",
              build_channels_prompt([*BROKER_PATHS, "Ярмарка / Очередь задач"]))),
    _case("channels--builder-edge-channels", "channels", "builder",
          lambda: prompt_for_variant(
              "builder", "channels", build_channels_prompt(BROKER_PATHS, EDGE_CHANNELS))),
    _case("channels--skeptic", "channels", "skeptic",
          lambda: prompt_for_variant(
              "skeptic", "channels", build_channels_prompt(BROKER_PATHS))),
    _case("channels--orchestrated", "channels", "orchestrated",
          lambda: prompt_for_variant(
              "orchestrated", "channels", build_channels_prompt(BROKER_PATHS))),
    # ── параметры конфигурации ───────────────────────────────────────────────
    _case("config--builder", "config", "builder",
          lambda: prompt_for_variant(
              "builder", "config", build_config_prompt(SERVICE_PATHS[:1]))),
    _case("config--builder-many-services", "config", "builder",
          lambda: prompt_for_variant("builder", "config", build_config_prompt(SERVICE_PATHS))),
    _case("config--skeptic", "config", "skeptic",
          lambda: prompt_for_variant("skeptic", "config", build_config_prompt(SERVICE_PATHS))),
    _case("config--orchestrated", "config", "orchestrated",
          lambda: prompt_for_variant(
              "orchestrated", "config", build_config_prompt(SERVICE_PATHS))),
    # ── разведка точек входа ─────────────────────────────────────────────────
    # У оркестраторной разведки текста «одним куском» нет: петля гоняет два прогона в
    # разные файлы, поэтому ей передаётся генератор по пути результата.
    _case("recon--builder", "recon", "builder",
          lambda: prompt_for_variant("builder", "recon", build_recon_prompt(NODE_PATH))),
    _case("recon--skeptic", "recon", "skeptic",
          lambda: prompt_for_variant("skeptic", "recon", build_recon_prompt(NODE_PATH))),
    _case("recon--orchestrated", "recon", "orchestrated",
          lambda: prompt_for_variant(
              "orchestrated", "recon", build_recon_prompt(NODE_PATH),
              recon_builder=lambda путь: build_recon_prompt(NODE_PATH, result_path=путь))),
]

ИМЕНА = [c.name for c in CASES]


def _diff(stored: str, current: str, name: str) -> str:
    строки = list(
        difflib.unified_diff(
            stored.splitlines(keepends=True),
            current.splitlines(keepends=True),
            fromfile=f"снапшот/{name}.txt",
            tofile=f"собрано сейчас/{name}",
            n=1,
        )
    )
    хвост = "" if len(строки) <= DIFF_LINES else f"\n… ещё {len(строки) - DIFF_LINES} строк диффа"
    return "".join(строки[:DIFF_LINES]) + хвост


@pytest.mark.parametrize("case", CASES, ids=ИМЕНА)
def test_промпт_совпадает_со_снапшотом(case: Case) -> None:
    текст = case.build()
    path = SNAP_DIR / f"{case.name}.txt"
    if UPDATE:
        SNAP_DIR.mkdir(parents=True, exist_ok=True)
        path.write_text(текст, encoding="utf-8")
        return
    assert path.exists(), f"Снапшота «{case.name}» нет вовсе.\n{ПОДСКАЗКА}"
    stored = path.read_text(encoding="utf-8")
    if stored != текст:
        pytest.fail(f"{ПОДСКАЗКА}\n\n{_diff(stored, текст, case.name)}", pytrace=False)


def test_имена_случаев_уникальны() -> None:
    """Дубль имени тихо перезаписал бы чужой снапшот — и один из промптов остался
    бы без сторожа вовсе."""
    assert len(ИМЕНА) == len(set(ИМЕНА))


def test_каждый_поток_и_вариант_под_снапшотом() -> None:
    """Сторож ПОЛНОТЫ реестра: добавили седьмой поток или четвёртый вариант ручки —
    тест валится, пока для него нет снимка. Без этого новый промпт приезжал бы в
    продукт без сторожа, а файл выглядел бы «покрывающим всё»."""
    ожидаемые = {(flow, variant) for flow in get_args(Flow) for variant in get_args(PromptVariant)}
    покрытые = {(c.flow, c.variant) for c in CASES}
    assert ожидаемые - покрытые == set(), "Не покрыты снапшотом: пары (поток, вариант)"


def test_нет_осиротевших_файлов() -> None:
    """Случай убрали, а файл остался: мёртвый снапшот выглядит как покрытие, но не
    сторожит ничего. Плюс ловит переименование случая, сделанное наполовину."""
    if UPDATE:
        pytest.skip("режим обновления: файлы переписываются, сверять нечего")
    на_диске = {p.stem for p in SNAP_DIR.glob("*.txt")}
    assert на_диске - set(ИМЕНА) == set(), "Лишние файлы снапшотов — удалить"


def test_сборка_детерминирована() -> None:
    """Промпт обязан быть чистой функцией аргументов: обход множества или словаря с
    нестабильным порядком дал бы «мигающий» снапшот, и сторож пришлось бы выключить.
    Дешевле поймать это здесь, чем ловить мигание в CI."""
    for case in CASES:
        assert case.build() == case.build(), f"«{case.name}» собирается по-разному"


def test_снапшоты_не_пусты() -> None:
    """Сборщик, вернувший пустую строку, снялся бы в пустой файл и с тех пор
    «совпадал» бы с ним вечно — сторож молчал бы о поломке."""
    for case in CASES:
        assert len(case.build()) > 500, f"«{case.name}» подозрительно короток"


def test_сравнение_ловит_подмену_одного_символа() -> None:
    """Самопроверка сторожа: важно не «тест зелёный», а «тест краснеет, когда надо».
    Меняем в готовом промпте один символ и убеждаемся, что расхождение видно и что
    дифф показывает именно испорченную строку."""
    эталон = CASES[0].build()
    испорченный = эталон.replace("ArchMap", "ArchMаp", 1)  # «а» кириллическая
    assert испорченный != эталон, "фикстура самопроверки протухла: подстроки нет в тексте"
    дифф = _diff(эталон, испорченный, CASES[0].name)
    assert "ArchMаp" in дифф and дифф.startswith("---")
