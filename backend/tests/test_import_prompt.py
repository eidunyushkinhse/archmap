"""Тесты промпта «Из репозитория» (app/import_prompt.py + GET /projects/import/prompt).

Главная гарантия: встроенный в промпт пример — ВАЛИДНЫЙ документ импорта
(кормим его в parse_import на обеих глубинах); промпт не может протухнуть
относительно формата. Плюс параметры: имя системы вшито в требования к корню,
depth=2 вырезает слой компонентов и из инструкции, и из примера, язык и
подсказки попадают в текст.
"""

import re

import pytest
import yaml
from conftest import ensure_architect

from app.import_prompt import build_import_prompt, example_yaml
from app.import_yaml import parse_import
from app.routers.projects import import_prompt


def test_example_is_valid_import_both_depths():
    for depth in (2, 3):
        parsed, errors = parse_import(example_yaml(depth))
        assert errors == [], (depth, errors)
        assert parsed is not None and len(parsed.nodes) > 5 and len(parsed.edges) >= 5


def test_example_depth2_has_no_components():
    parsed, _ = parse_import(example_yaml(2))
    assert parsed is not None
    # максимум два уровня: у детей корня своих детей нет
    depth_of: dict[int, int] = {}
    for i, n in enumerate(parsed.nodes):
        depth_of[i] = 1 if n.parent_idx is None else depth_of[n.parent_idx] + 1
    assert max(depth_of.values()) == 2
    # а на глубине 3 компоненты есть
    parsed3, _ = parse_import(example_yaml(3))
    assert parsed3 is not None
    assert any(
        n.parent_idx is not None and parsed3.nodes[n.parent_idx].parent_idx is not None
        for n in parsed3.nodes
    )


def test_prompt_carries_system_name_and_conventions():
    p = build_import_prompt("Платёжная  платформа")  # двойной пробел схлопывается
    assert "«Платёжная платформа»" in p
    # опорные конвенции на месте
    for marker in (
        "docker-compose",
        "заглушкой",
        "<сервис>-db",
        "external: true",
        "Родитель / Имя",
        "выведи весь YAML-документ целиком",
        "двойные кавычки",  # правило кавычек — класс ошибок №1 стресс-теста
        "их БД и кэши не создаю",  # анти-фантом чужой инфраструктуры (чек-лист)
    ):
        assert marker in p, marker
    # пример демонстрирует кавычки: description с двоеточием закавычен дампером
    assert "'Хранилище сервиса orders: заказы и статусы.'" in p
    # пример встроен и начинается с nodes:
    assert "```yaml\nnodes:" in p


def test_варианты_одного_слота_это_один_узел():
    """Находка №9 полевого QA: поддержка mysql|postgresql|elasticsearch приехала
    ТРЕМЯ параллельными базами одной инсталляции. Промпт обязан различать выбор
    инсталляции и хранилища, живущие бок о бок."""
    p = build_import_prompt("Zabbix 7")
    assert "Взаимозаменяемые ВАРИАНТЫ одного слота" in p
    assert "«MySQL | PostgreSQL»" in p
    assert "ОДНОВРЕМЕННО в одной инсталляции" in p


def test_связь_с_брокером_называет_канал():
    """Стрелка «в шину» без имени топика не отвечает ни на один вопрос сопровождения
    (§4 plan-broker-docs.md). Правило стоит и в формате, и в чек-листе — последнее,
    что модель читает перед выводом, — а пример показывает поле в деле: он же
    прогоняется через parse_import, поэтому промпт не разойдётся с форматом."""
    p = build_import_prompt("Ярмарка")
    assert "СВЯЗЬ С БРОКЕРОМ НАЗЫВАЕТ КАНАЛ" in p
    assert "channel: orders.created" in p
    assert "по ребру на канал" in p
    assert "У связей с брокерами указан channel" in p

    for depth in (2, 3):
        parsed, errors = parse_import(example_yaml(depth))
        assert errors == [] and parsed is not None
        каналы = {
            (parsed.nodes[e.source_idx].name, parsed.nodes[e.target_idx].name): e.channel
            for e in parsed.edges
            if e.channel
        }
        assert каналы == {("orders", "events"): "orders.created"}


def test_висячие_лечатся_связями_а_не_удалением():
    """Открытое направление QA-раунда 2 (docs/qa-zabbix-7.md): на замечание «объекты
    без связей» слабая модель отвечает ампутацией (31→27, затем 30→14 узлов). Промпт
    обязан звучать одинаково во всех трёх местах, где заходит речь о висячем узле:
    правило слоя компонентов, чек-лист и протокол замечаний. Чек-лист — последнее,
    что модель читает перед выводом, и старое «либо нашёл связь, либо убрал узел»
    переигрывало остальные два места."""
    p3 = build_import_prompt("Zabbix 7")
    assert "УЖЕ созданный компонент не удаляй в ответ на замечания валидатора" in p3
    for p in (p3, build_import_prompt("Zabbix 7", depth=2)):
        # удаление — не равноправный выход, а крайний случай «нет основания в коде»
        assert "либо нашёл связь, либо убрал узел" not in p
        assert "вернись в код и найди его связи" in p
        assert "удалить узел можно только если у него нет основания в файлах репозитория" in p
        assert "Предупреждения о „висячих“ объектах лечи связями, а не удалением объектов." in p


def test_связь_требуется_только_от_узлов_без_детей():
    """Добивка К1: под федерацией пункт 5 чек-листа («у каждого узла, кроме корня-
    системы, есть хотя бы одна связь») требовал связать контейнер-продукт, а связь В
    контейнер с детьми запрещена соседним правилом («уточни конец до компонента») —
    слабая модель на таком противоречии делает хуже, чем при молчании. Требование сужено
    до бездетных узлов; это верно и БЕЗ федерации: контейнер, чьи связи перенесены на
    компоненты, законно остаётся без собственных, и алерт «висячий узел» его тоже не
    трогает (alerts.py исключает узлы-родители). Правило безусловное — звучит одинаково
    в разделе связей и в чек-листе."""
    for p in (
        build_import_prompt("Zabbix 7"),
        build_import_prompt("Zabbix 7", depth=2),
        build_import_prompt("Zabbix 7", multi_product=True),
    ):
        # Раздел «Связи» и чек-лист говорят одно и то же, одними словами.
        assert "У КАЖДОГО УЗЛА БЕЗ ДЕТЕЙ ХОТЯ БЫ ОДНА СВЯЗЬ" in p
        assert "5. У каждого узла БЕЗ ДЕТЕЙ есть хотя бы одна связь." in p
        assert (
            p.count(
                "Узел с children — коробка: связи несут лежащие в ней узлы, и своих связей "
                "у корня-системы и у контейнеров может не быть."
            )
            == 2
        )
        # Прежнее требование ко ВСЕМ узлам не осталось ни в одном из двух мест.
        assert "У каждого узла, кроме корня-системы, есть хотя бы одна связь" not in p
        assert "Исключение одно: корень-система" not in p


def test_замечание_про_связь_в_контейнер_лечится_переносом_а_не_удалением():
    """Раунд 3 QA (docs/qa-zabbix-7.md): 13 связей, упирающихся в контейнер с
    компонентами. Валидатор их теперь называет поимённо, но ремарк-протокол промпта
    молчал о том, ЧТО с таким замечанием делать, — а дефолт слабой модели на любое
    замечание один: удалить."""
    for p in (build_import_prompt("Zabbix 7"), build_import_prompt("Zabbix 7", depth=2)):
        assert (
            "Замечание «уточни связь до компонента» лечится переносом конца связи "
            "с контейнера на его компонент, а не удалением связи." in p
        )


def test_правило_кавычек_безусловно_и_повторено_в_чек_листе():
    """Находка №5: петля замечаний не лечит квотинг на слабой модели (правку «строка
    29» она перепечатала с той же ошибкой) — правило должно быть безусловным и стоять
    ещё раз в чек-листе, последнем, что модель читает перед выводом."""
    p = build_import_prompt("X")
    assert "двоеточие с пробелом" in p
    assert p.count("самая частая причина битого YAML") == 2  # правило формата + чек-лист


def test_prompt_depth_and_lang_and_hints():
    p2 = build_import_prompt("X", depth=2)
    assert "НЕ строй" in p2 and "компонентов ≤ 10" not in p2
    assert "billing-worker" not in p2  # компоненты вырезаны и из примера
    p3 = build_import_prompt("X", depth=3)
    assert "3–5 ключевых" in p3 and "billing-worker" in p3
    pen = build_import_prompt("X", lang="en")
    assert "английский" in pen and "в своём выводе используй выбранный язык" in pen
    ph = build_import_prompt("X", hints="монорепо: смотри только services/*")
    assert "Дополнительные указания" in ph and "services/*" in ph
    assert "Дополнительные указания" not in p3  # без hints секции нет


def test_профилактика_конфабуляций_в_разделе_честности():
    """П13 тюнинга федерации (docs/qa-semantic-review.md): три полевых класса лжи
    строителя — слитые шины, выдуманные хранилища, угаданные technology. Правила
    БЕЗУСЛОВНЫЕ (стоят в промпте всегда) и короткие: раздел честности читают все
    прогоны, а регрессию сторожит только полевая матрица."""
    for p in (build_import_prompt("Zabbix 7"), build_import_prompt("Zabbix 7", depth=2)):
        assert (
            "Каждая технологическая шина — ОТДЕЛЬНЫЙ узел-брокер: Kafka и очередь задач "
            "(Celery, RQ) — разные узлы, не сливай их в один." in p
        )
        assert (
            "Узел-хранилище или поисковый движок добавляй ТОЛЬКО с основанием в коде или "
            "конфиге деплоя — не по типовой аналогии („раз поиск, то Elasticsearch“ — "
            "не основание)." in p
        )
        assert (
            "technology бери из манифестов (package.json, Cargo.toml, requirements*.txt, "
            "go.mod), а не угадывай по роли узла: называй ПАКЕТ дословно, как он записан "
            "в манифесте." in p
        )
        # Чек-лист — последнее, что модель читает перед выводом: правило про манифесты
        # продублировано и там (как правило кавычек).
        assert "technology каждого узла взята из манифеста сборки" in p


def test_technology_не_путает_библиотеку_с_фреймворком():
    """К6 второй итерации (находка 6 матрицы): у Zabbix осталось «PHP + Symfony», хотя
    в composer.json есть только symfony/yaml — библиотека разбора YAML. Правило П13
    формально соблюдено, врёт трактовка, поэтому в нём назван ОБРАЗЕЦ: пакет дословно,
    фреймворк — только если в манифесте есть он сам. Правило безусловное: стоит на
    обеих глубинах и в прогонах без федерации."""
    for p in (
        build_import_prompt("Zabbix 7"),
        build_import_prompt("Zabbix 7", depth=2),
        build_import_prompt("Zabbix 7", multi_product=True),
    ):
        assert "называй ПАКЕТ дословно, как он записан в манифесте" in p
        assert (
            "Фреймворк указывай, только если в манифесте есть он сам, а не отдельный его "
            "компонент: «symfony/yaml» — это библиотека разбора YAML, а не фреймворк "
            "Symfony." in p
        )


# ── Федерация продуктов (П1) ──────────────────────────────────────────────────


МУЛЬТИ_ЗАГОЛОВОК = "## Проект объединяет НЕСКОЛЬКО продуктов"


def test_мультипродукт_учит_оборачивать_свой_продукт_контейнером():
    """Инсайт 1 мультирепо-QA: конвенция «имя системы = название проекта» растворяет
    продукт в корне — заглушки соседей не находят пары, продукт существует дважды."""
    p = build_import_prompt("Zabbix+Grafana", multi_product=True)
    assert МУЛЬТИ_ЗАГОЛОВОК in p
    assert "Система «Zabbix+Grafana» состоит из нескольких самостоятельных продуктов" in p
    assert "ВСЁ содержимое ЭТОГО репозитория оформи ОДНИМ контейнером под корнем системы" in p
    assert "Контейнеры и компоненты клади ВНУТРЬ него, а не в корень" in p
    assert "заглушками-контейнерами НА ТОМ ЖЕ уровне" in p
    assert "external им НЕ ставь" in p
    # ⚠ Полевой урок: плагин вписал в узел Grafana СВОЙ repo, и продукт едва не
    # расщепился надвое — заглушке соседа положено только сетевое имя.
    assert "В source заглушке соседа пиши ТОЛЬКО сетевое имя (host)" in p
    assert "Свой repo ей НЕ приписывай" in p
    # Раздел стоит рядом с конвенциями склейки — между именованием и полем source.
    assert p.index("## Правила именования") < p.index(МУЛЬТИ_ЗАГОЛОВОК) < p.index("## Поле source")


def test_мультипродукт_требует_host_у_заглушки_соседа():
    """Бэклог матрицы федерации (2026-08-16): у одного агента заглушки СОСЕДНИХ
    продуктов вышли с пустым source — прогону в репозитории соседа не за что
    зацепиться, и продукт оказывается в проекте дважды (то же раздвоение, что и от
    чужого repo, только с другой стороны). Прежняя формулировка была ЗАПРЕТОМ («пиши
    только host, свой repo не приписывай»), а не требованием заполнить.

    Пример говорит то же самое (заглушка соседа с source.host — тест
    test_федеративный_пример_показывает_продукт_и_заглушку_соседа): для слабой модели
    образец сильнее правила, и расходиться им нельзя."""
    p = build_import_prompt("Zabbix+Grafana", multi_product=True)
    assert "пиши его ВСЕГДА, когда оно видно из конфигов или URL" in p
    assert "выдуманный host хуже пустого" in p
    # Свой продукт — как обычно, но repo носит ОДИН узел: repo у нескольких узлов
    # потребовал бы path каждому (пункт 12 чек-листа), и пример уложен ровно так.
    assert "repo этого репозитория ставь ОДНОМУ узлу — контейнеру-продукту" in p

    # ⚠ Усиление живёт ТОЛЬКО в федеративной ветке: одно-репо промпт этих слов не знает
    # (байт-в-байт его сторожит test_без_мультипродукта_промпт_байт_в_байт).
    без = build_import_prompt("Zabbix+Grafana")
    assert "выдуманный host хуже пустого" not in без
    assert "контейнеру-продукту" not in без



def _пример(depth: int, multi_product: bool) -> dict:
    """Пример промпта, разобранный обратно в структуру: тест проверяет УКЛАДКУ, а не
    буквы дампа (иначе он ломался бы от любой правки _EXAMPLE_DOC)."""
    doc = yaml.safe_load(example_yaml(depth, multi_product=multi_product))
    assert isinstance(doc, dict)
    return doc


@pytest.mark.parametrize("depth", [2, 3])
def test_федеративный_пример_показывает_продукт_и_заглушку_соседа(depth):
    """К1 второй итерации (находка 1 матрицы docs/qa-federation-matrix.md): раздел П1
    стоит ВЫШЕ примера, и Zabbix-агент, сохранивший раздел дословно, всё равно уложил
    семь узлов прямо в корень — для слабой модели ОБРАЗЕЦ перевешивает правило.
    Значит при multi_product образец обязан показывать федеративную укладку."""
    doc = _пример(depth, True)
    корень = doc["nodes"][0]
    assert корень["name"] == "Ярмарка" and корень["role"] == "система"

    # Под корнем ровно двое: свой контейнер-продукт и заглушка соседнего продукта.
    продукт, сосед = корень["children"]
    assert len(корень["children"]) == 2
    assert продукт["name"] == "shop-backend"
    # Всё прежнее содержимое примера уехало ВНУТРЬ продукта, а не осталось в корне.
    assert [c["name"] for c in продукт["children"]] == [
        "storefront",
        "orders",
        "orders-db",
        "payments",
        "events",
    ]
    # Заглушка соседа — ровно как учит раздел П1: только имя продукта и сетевое имя,
    # без children, без description и без external.
    assert сосед == {"name": "delivery", "source": {"host": "delivery"}}
    # Образец межпродуктовой связи: хотя бы одна связь уходит в заглушку соседа.
    assert any(e["to"] == "delivery" for e in doc["edges"])

    # Люди и внешние SaaS остаются корневыми — федерация их уровня не касается.
    assert [n["name"] for n in doc["nodes"]] == ["Ярмарка", "Покупатель", "Stripe"]


@pytest.mark.parametrize("depth", [2, 3])
def test_федеративный_пример_валиден_и_несёт_якоря(depth):
    """Пример-данные не может протухнуть относительно формата: федеративный вариант
    тоже кормится в parse_import. Якоря — по правилам source: repo носит контейнер-
    продукт (он и есть этот репозиторий), внутренние узлы и заглушка — сетевые имена;
    иначе пример нарушил бы собственный пункт 12 чек-листа (repo у нескольких узлов
    требует path у каждого)."""
    parsed, errors = parse_import(example_yaml(depth, multi_product=True))
    assert errors == [], (depth, errors)
    assert parsed is not None
    keys = {n.name: n.source_keys for n in parsed.nodes if n.source_keys}
    assert keys["shop-backend"] == ["git:github.com/org/shop-backend"]
    assert keys["orders"] == ["host:orders"]
    assert keys["delivery"] == ["host:delivery"]
    assert "Ярмарка" not in keys


def test_федеративный_пример_согласован_со_слоями_на_глубине_2():
    """⚠ П1 велит отсчитывать слои ОТ контейнера-продукта, поэтому depth=2 под флагом —
    это «система → продукт → контейнеры» и ни одного компонента. Инструкция слоёв под
    флагом говорит ровно это: буквальное «children допустимы только у корня-системы»
    запретило бы сам контейнер-продукт и разошлось бы с примером."""
    продукт2 = _пример(2, True)["nodes"][0]["children"][0]
    assert all("children" not in c for c in продукт2["children"])
    продукт3 = _пример(3, True)["nodes"][0]["children"][0]
    assert any(c.get("children") for c in продукт3["children"])

    p2 = build_import_prompt("Zabbix+Grafana", depth=2, multi_product=True)
    assert "контейнер-продукт и его контейнеры" in p2
    assert "и у контейнера-продукта" in p2
    # Без флага строка слоёв прежняя — про корень-систему.
    assert "система и её контейнеры. children допустимы только у корня-системы." in (
        build_import_prompt("Zabbix+Grafana", depth=2)
    )


def test_иллюстрация_пути_углубляется_на_слой_продукта():
    """Путь из раздела формата обязан существовать В ПРИМЕРЕ: при федерации между
    системой и контейнером стоит продукт, и «Ярмарка / orders / api» — уже не путь."""
    assert "«Ярмарка / shop-backend / orders / api»" in build_import_prompt(
        "Zabbix+Grafana", multi_product=True
    )
    assert "«Ярмарка / orders / api»" in build_import_prompt("Zabbix+Grafana")


# ── Иллюстрации пути согласованы с глубиной ──────────────────────────────────

_ИЛЛЮСТРАЦИИ = re.compile("например «([^»]+)»; достаточно однозначного хвоста пути: «([^»]+)»")


def _иллюстрации_пути(текст: str) -> tuple[list[str], list[str]]:
    """Обе иллюстрации пути из раздела формата, разобранные на звенья."""
    m = _ИЛЛЮСТРАЦИИ.search(текст)
    assert m is not None, "в промпте не нашлась иллюстрация пути"
    полный, хвост = m.groups()
    return полный.split(" / "), хвост.split(" / ")


def _пример_из_промпта(текст: str) -> dict:
    """Встроенный пример, вынутый из самого промпта (а не собранный заново): проверяем
    согласие текста с ТЕМ образцом, который увидит агент."""
    блок = re.search(r"```yaml\n(.*?)```", текст, re.S)
    assert блок is not None, "в промпте нет примера документа"
    doc = yaml.safe_load(блок.group(1))
    assert isinstance(doc, dict)
    return doc


def _есть_путь(nodes: list[dict], путь: list[str]) -> bool:
    """Есть ли в примере цепочка узлов с такими именами, начиная от корня документа."""
    if not путь:
        return True
    return any(
        n["name"] == путь[0] and _есть_путь(n.get("children", []), путь[1:]) for n in nodes
    )


@pytest.mark.parametrize("multi_product", [False, True])
@pytest.mark.parametrize("depth", [2, 3])
def test_иллюстрация_пути_есть_в_примере_на_обеих_глубинах(depth, multi_product):
    """Инструкция про путь иллюстрировалась компонентом («Ярмарка / orders / api»),
    которого на глубине 2 в образце нет вовсе — слой компонентов там не строится.
    В проекте четырежды доказано «пример сильнее правила»: модель исполняет образец,
    поэтому ОБЕ иллюстрации обязаны быть путями в примере этого же промпта."""
    p = build_import_prompt("Ярмарка", depth=depth, multi_product=multi_product)
    путь, хвост = _иллюстрации_пути(p)
    assert _есть_путь(_пример_из_промпта(p)["nodes"], путь), путь
    # Хвост — суффикс полного пути и короче него: иначе он не показывает, что писать
    # путь от самого корня необязательно.
    assert хвост == путь[len(путь) - len(хвост) :]
    assert 0 < len(хвост) < len(путь)


def test_на_глубине_3_иллюстрация_пути_прежняя():
    """Обратная сторона правки: трёхслойный режим остаётся публичным контрактом ручки
    (дефолт depth=3, на нём сидят MCP-агенты) — согласование с глубиной 2 не смеет
    утечь в него."""
    строка = "например «{}»; достаточно однозначного хвоста пути: «orders / api»"
    assert строка.format("Ярмарка / orders / api") in build_import_prompt("Ярмарка")
    assert строка.format("Ярмарка / shop-backend / orders / api") in build_import_prompt(
        "Ярмарка", multi_product=True
    )


# Иллюстрации пути с федерацией и без неё, буквами: на глубине 2 компонентов в примере
# нет, и путь указывает на контейнер. Перечислены явно, чтобы сентинел ниже ловил и
# молчаливую правку генератора иллюстраций.
_ПУТИ_ФЕДЕРАЦИИ = {
    3: [("Ярмарка / shop-backend / orders / api", "Ярмарка / orders / api")],
    2: [
        ("Ярмарка / shop-backend / storefront", "Ярмарка / storefront"),
        ("shop-backend / storefront", "storefront"),
    ],
}


def _снять_федерацию(текст: str, depth: int) -> str:
    """Снять с мультипродуктового промпта РОВНО то, что добавляет флаг: раздел П1,
    федеративный пример, углублённые иллюстрации пути и (на depth=2) переанкоренную
    строку слоёв. Остаток обязан совпасть с текстом без флага байт-в-байт."""
    голова, хвост = текст.split(МУЛЬТИ_ЗАГОЛОВОК)
    без_раздела = голова + "## Поле source" + хвост.split("## Поле source", 1)[1]
    без_примера = без_раздела.replace(
        example_yaml(depth, multi_product=True), example_yaml(depth)
    )
    for было, стало in _ПУТИ_ФЕДЕРАЦИИ[depth]:
        без_примера = без_примера.replace(f"«{было}»", f"«{стало}»")
    return без_примера.replace(
        "контейнер-продукт и его контейнеры. children допустимы только у корня-системы\n"
        "  и у контейнера-продукта.",
        "система и её контейнеры. children допустимы только у корня-системы.",
    )


@pytest.mark.parametrize("depth", [2, 3])
def test_без_мультипродукта_промпт_байт_в_байт(depth):
    """⚠ Сентинел (ловушка №1 плана): одно-репо прогоны НЕ регрессируют. Флаг обязан
    менять РОВНО три вещи (на depth=2 — четыре): раздел П1, пример, иллюстрацию пути и
    строку слоёв. Сняли их с мультипродуктового текста — получили прежний байт-в-байт.
    Тест падает и если генератор флаг игнорирует (снимать нечего), и если флаг заодно
    правит что-то ещё."""
    парам = {"depth": depth, "lang": "ru", "hints": "монорепо"}
    без = build_import_prompt("Zabbix+Grafana", **парам)
    assert без == build_import_prompt("Zabbix+Grafana", **парам, multi_product=False)
    assert МУЛЬТИ_ЗАГОЛОВОК not in без
    # Пример без флага — прежний: ни продукта, ни заглушки соседа в нём нет.
    assert example_yaml(depth) in без
    assert "shop-backend" not in без and "delivery" not in без

    с_флагом = build_import_prompt("Zabbix+Grafana", **парам, multi_product=True)
    assert _снять_федерацию(с_флагом, depth) == без


def test_prompt_endpoint(db):
    user = ensure_architect(db)
    out = import_prompt(system_name="Ярмарка", depth=3, lang="ru", hints=None, _user=user)
    assert "«Ярмарка»" in out.prompt and "```yaml\nnodes:" in out.prompt


def test_ручка_пробрасывает_мультипродукт_в_строительный_и_в_обёртку(db):
    """Флаг живёт в строительном промпте, поэтому доезжает и до блока А обёртки —
    отдельного пути у оркестраторного варианта нет и быть не должно."""
    user = ensure_architect(db)
    парам = {"system_name": "Zabbix+Grafana", "depth": 3, "lang": "ru", "hints": None}

    выкл = import_prompt(**парам, _user=user)
    вкл = import_prompt(**парам, multi_product=True, _user=user)
    assert МУЛЬТИ_ЗАГОЛОВОК not in выкл.prompt
    assert вкл.prompt == build_import_prompt("Zabbix+Grafana", multi_product=True)

    обёртка = import_prompt(**парам, variant="orchestrated", multi_product=True, _user=user)
    assert МУЛЬТИ_ЗАГОЛОВОК in обёртка.prompt
    assert МУЛЬТИ_ЗАГОЛОВОК not in import_prompt(
        **парам, variant="orchestrated", _user=user
    ).prompt


def test_example_carries_source_anchors():
    """Пример учит конвенции якорей (Фаза 0 синка): свой сервис — repo + path
    (+ host), чужой — только host. Тест держит пример и парсер синхронными:
    правило из промпта обязано разбираться в ключи identity.

    ⚠ Ф3 BYOA, правка №2: path стоит у КАЖДОГО своего узла — у обоих контейнеров
    и (на depth=3) у компонентов. До правки пример нёс source у одного контейнера
    и ни одного path, и Haiku оставлял компоненты без якоря."""
    for depth in (2, 3):
        parsed, errors = parse_import(example_yaml(depth))
        assert errors == [] and parsed is not None
        keys = {n.name: n.source_keys for n in parsed.nodes if n.source_keys}
        assert keys["orders"] == ["git:github.com/org/yarmarka#services/orders", "host:orders"]
        assert keys["storefront"] == ["git:github.com/org/yarmarka#frontend"]
        if depth == 3:
            assert keys["api"] == ["git:github.com/org/yarmarka#services/orders/api"]
            assert keys["billing-worker"] == ["git:github.com/org/yarmarka#services/orders/worker"]
        else:
            assert "api" not in keys and "billing-worker" not in keys
        # Сервис из чужого репозитория — только сетевое имя, ничего выдуманного.
        assert keys["payments"] == ["host:payments"]
        # Корню-системе и людям-акторам якорь не нужен.
        assert "Ярмарка" not in keys and "Покупатель" not in keys


def test_prompt_explains_source_field():
    """Видов якоря два (docs/plan-anchor-ux.md): код (repo + path) и имя
    зависимости (host). Образ и объект k8s из идентичности убраны — промпт не
    должен их просить, иначе агент тратит проход на приметы контура развёртывания."""
    text = build_import_prompt("Ярмарка")
    assert "## Поле source" in text
    for field in ("repo", "path", "host"):
        assert field in text
    источник = text.split("## Поле source", 1)[1].split("## Формат YAML", 1)[0]
    assert "image" not in источник and "deployment" not in источник


def test_состав_из_авторитативного_перечня_без_капов():
    """Ф3 BYOA, правка №3 (2026-09-05): капы «≤ 12 контейнеров» и «≤ 10 компонентов»
    сняты, состав слоёв задаёт авторитативный перечень в коде (шаг 3 обследования),
    сверка «посчитай записи — сравни с узлами» — приём эпика разведки."""
    for depth in (2, 3):
        p = build_import_prompt("X", depth=depth)
        assert "Не больше 12" not in p and "не больше 10" not in p and "≤ 12" not in p
        assert "АВТОРИТАТИВНЫЙ ПЕРЕЧЕНЬ процессов" in p
        assert "не срезай состав ради компактности" in p
    p3 = build_import_prompt("X", depth=3)
    assert "сворачивать их в один узел «workers»" in p3
    assert "число узлов сверено с числом записей" in p3
    p2 = build_import_prompt("X", depth=2)
    assert "сворачивать их в один узел «workers»" not in p2
    assert "ни одна деплой-единица не срезана" in p2


def test_path_каждому_своему_узлу_включая_компоненты():
    """Ф3 BYOA, правка №2 (2026-09-05): класс «компоненты без якоря». Раздел source
    и чек-лист требуют path у КАЖДОГО своего узла, компонентам тоже; текст обязан
    держаться, пока держится пример (test_example_carries_source_anchors)."""
    text = build_import_prompt("Ярмарка")
    источник = text.split("## Поле source", 1)[1].split("## Формат YAML", 1)[0]
    assert "Ставь КАЖДОМУ своему узлу — и контейнеру, и компоненту внутри него" in источник
    assert "КАЖДОМУ своему узлу (описанному по этому репозиторию) — repo и path, компонентам внутри контейнеров тоже" in источник
    assert "и у каждого такого узла (у компонентов тоже) свой path" in text


def test_правило_path_называет_последствие_правдиво():
    """Промпт врал в деталях: обещал, что второй узел «потеряется вместе со своими
    детьми». Проверено кодом и живым прогоном при закрытии склейки (6de50f5): дети
    НЕ теряются — они переезжают внутрь узла-победителя. Мотив правила прежний (узлы
    должны быть различимы), но последствие названо тем, что происходит на самом деле:
    враньё в промпте — это враньё модели, которая по нему работает."""
    text = build_import_prompt("Ярмарка")

    assert (
        "два узла с одинаковым repo и без path неразличимы, и при слиянии они склеятся "
        "в ОДИН: описания и связи сольются, дети обоих окажутся внутри узла-победителя, "
        "а модель будет утверждать, что это один сервис" in text
    )
    # Сторож на возвращение прежней (неправдивой) формулировки.
    assert "потеряется вместе со своими детьми" not in text
