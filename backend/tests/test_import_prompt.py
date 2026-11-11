"""Тесты промпта «Из репозитория» (app/import_prompt.py + GET /projects/import/prompt).

Главная гарантия: встроенный в промпт пример — ВАЛИДНЫЙ документ импорта
(кормим его в parse_import на обеих глубинах); промпт не может протухнуть
относительно формата. Плюс параметры: имя системы вшито в требования к корню,
depth=2 вырезает слой компонентов и из инструкции, и из примера, язык и
подсказки попадают в текст.
"""

import io
import re
import zipfile

import pytest
import yaml
from conftest import ensure_architect
from fastapi.testclient import TestClient

from app.auth import get_current_user
from app.config import settings
from app.import_prompt import build_import_prompt, example_yaml
from app.import_yaml import parse_import
from app.main import app
from app.routers.projects import import_prompt
from app.skeptic_prompt import prompt_for_variant


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
        # Правка №4: на depth=3 публикует компонент outbox, на depth=2 (компоненты
        # вырезаны) конец ребра свёрнут на контейнер orders. Доставку подписчику
        # billing-worker (контейнер, Ф13а) пример показывает тем же каналом.
        ожидаемый_источник = "outbox" if depth == 3 else "orders"
        assert каналы == {
            (ожидаемый_источник, "events"): "orders.created",
            ("events", "billing-worker"): "orders.created",
        }


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
        # Ф14: протокол замечаний называет их словами настоящих замечаний ArchMap
        # (app/merge_warnings, app/unified_remarks), а не «висячими».
        assert (
            "Замечания об объектах без связей («без единой связи», «нет ни одной связи», "
            "«не связана с остальной схемой») лечи связями, а не удалением объектов." in p
        )
        assert "висяч" not in p


def test_промпт_ввоза_словами_продукта():
    """Ф14: агенту пользователя — слова продукта. Люди — просто люди (shape: person),
    без «акторов» и в примере тоже; соседние репозитории описывает тот же промпт,
    запущенный там, а не «прогон»."""
    for p in (build_import_prompt("Ярмарка"), build_import_prompt("Ярмарка", depth=2)):
        assert "актор" not in p and "прогон" not in p
        assert "внешние системы (external: true) и люди (shape: person)." in p
        assert "Тянет положить человека в children" in p
        assert "их опишет тот же промпт, запущенный в их репозитории" in p
        assert "по нему их опознает запуск в их репозитории" in p
        assert "Внешним SaaS, людям и корню-системе source не нужен вовсе." in p
        assert "- Люди связываются с той точкой входа" in p
        assert "role: покупатель" in p


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
    ):
        # Раздел «Связи» и чек-лист говорят одно и то же, одними словами.
        assert "У КАЖДОГО УЗЛА БЕЗ ДЕТЕЙ ХОТЯ БЫ ОДНА СВЯЗЬ" in p
        assert "5. У каждого узла БЕЗ ДЕТЕЙ есть хотя бы одна связь." in p
        assert (
            p.count(
                "Узел с children сам вызовов не делает: связи несут лежащие в нём узлы, и "
                "своих связей у корня-системы и у контейнеров может не быть."
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
    замечание один: удалить.

    Ф9 эпика элементов архитектуры: замечание говорит словами элемента конца
    (app/merge_warnings: «уточните её до конкретного компонента» у контейнера, «до
    одного из них» у системы) — протокол цитирует общую часть и называет ответ, который
    замечание несёт само."""
    for p in (build_import_prompt("Zabbix 7"), build_import_prompt("Zabbix 7", depth=2)):
        assert (
            "Замечание «уточните её» о связи, упирающейся в узел с children, лечится "
            "переносом конца связи на один из лежащих в нём узлов (замечание их называет), "
            "а не удалением связи." in p
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
    assert "outbox" not in p2  # компоненты вырезаны и из примера
    assert "billing-worker" in p2  # отдельный процесс — контейнер, он остаётся (Ф13а)
    p3 = build_import_prompt("X", depth=3)
    assert "3–5 ключевых" in p3 and "outbox" in p3
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
    ):
        assert "называй ПАКЕТ дословно, как он записан в манифесте" in p
        assert (
            "Фреймворк указывай, только если в манифесте есть он сам, а не отдельный его "
            "компонент: «symfony/yaml» — это библиотека разбора YAML, а не фреймворк "
            "Symfony." in p
        )


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


@pytest.mark.parametrize("depth", [2, 3])
def test_иллюстрация_пути_есть_в_примере_на_обеих_глубинах(depth):
    """Инструкция про путь иллюстрировалась компонентом («Ярмарка / orders / api»),
    которого на глубине 2 в образце нет вовсе — слой компонентов там не строится.
    В проекте четырежды доказано «пример сильнее правила»: модель исполняет образец,
    поэтому ОБЕ иллюстрации обязаны быть путями в примере этого же промпта."""
    p = build_import_prompt("Ярмарка", depth=depth)
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


def test_prompt_endpoint(db):
    user = ensure_architect(db)
    out = import_prompt(system_name="Ярмарка", depth=3, lang="ru", hints=None, _user=user)
    assert "«Ярмарка»" in out.prompt and "```yaml\nnodes:" in out.prompt


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
        assert keys["billing-worker"] == ["git:github.com/org/yarmarka#services/billing-worker"]
        if depth == 3:
            assert keys["api"] == ["git:github.com/org/yarmarka#services/orders/api"]
            assert keys["outbox"] == ["git:github.com/org/yarmarka#services/orders/outbox"]
        else:
            assert "api" not in keys and "outbox" not in keys
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


def test_рёбра_примера_от_компонентов_не_от_коробки():
    """Ф3 BYOA, правка №4 (2026-09-05): класс «ребро от коробки» — Haiku вешал до
    половины концов рёбер на контейнеры с children, потому что так делал пример.
    На depth=3 ни одно ребро примера не выходит из узла с children; на depth=2
    концы свёрнуты на контейнеры и пример остаётся валидным. Текст правила —
    именами примера, чужой иллюстрации «vote» больше нет."""
    parsed, errors = parse_import(example_yaml(3))
    assert errors == [] and parsed is not None
    пары = {(parsed.nodes[e.source_idx].name, parsed.nodes[e.target_idx].name) for e in parsed.edges}
    assert {
        ("storefront", "api"), ("api", "orders-db"), ("outbox", "events"),
        ("events", "billing-worker"), ("billing-worker", "payments"),
    } <= пары
    с_детьми: set[str] = set()

    def собрать(nodes: list[dict]) -> None:
        for n in nodes:
            if n.get("children"):
                с_детьми.add(n["name"])
                собрать(n["children"])

    собрать(yaml.safe_load(example_yaml(3))["nodes"])
    assert с_детьми == {"Ярмарка", "orders"}
    assert not any(parsed.nodes[e.source_idx].name in с_детьми for e in parsed.edges)
    parsed2, errors2 = parse_import(example_yaml(2))
    assert errors2 == [] and parsed2 is not None
    пары2 = {(parsed2.nodes[e.source_idx].name, parsed2.nodes[e.target_idx].name) for e in parsed2.edges}
    assert {
        ("storefront", "orders"), ("orders", "orders-db"), ("orders", "events"),
        ("events", "billing-worker"), ("billing-worker", "payments"),
    } <= пары2
    p3 = build_import_prompt("X", depth=3)
    assert "ОТ КОМПОНЕНТА, НЕ ОТ КОНТЕЙНЕРА С CHILDREN" in p3 and "vote" not in p3
    assert "не «orders → orders-db», а «orders / api → orders-db»" in p3
    assert "перевешено на лежащий в нём узел, который делает вызов" in p3
    p2 = build_import_prompt("X", depth=2)
    assert "ОТ КОМПОНЕНТА, НЕ ОТ КОНТЕЙНЕРА С CHILDREN" not in p2 and "vote" not in p2


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
    assert "Сворачивать их в один узел «workers» нельзя" in p3
    assert "число узлов сверено с числом записей" in p3
    p2 = build_import_prompt("X", depth=2)
    assert "Сворачивать их в один узел «workers»" not in p2
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


# ── Элемент архитектуры (Ф9 docs/plan-c4-elements.md) ────────────────────────


def test_пример_помечает_контейнер_с_компонентами():
    """Пример сильнее правила: узел с компонентами показан с element: container, и
    пример по-прежнему валидный ввоз — без единого замечания санитизации элементов."""
    parsed, errors = parse_import(example_yaml(3))
    assert errors == [] and parsed is not None
    элементы = {n.name: n.element for n in parsed.nodes}
    assert элементы["orders"] == "container"
    assert parsed.warnings == []


def test_элемент_в_примере_только_у_корня_и_контейнера_с_компонентами():
    """Тип выбран всегда (2026-11-01): корень с children без element ввоз отвергает, и
    пример несёт element: system у корня на обеих глубинах. На глубине 2 слоя компонентов
    нет, и ключ у orders вырезается вместе с children (лист с element: container спорил бы
    с правилом «element нужен только корню-системе»); на глубине 3 orders — контейнер."""
    элементы2 = {
        n["name"]: n["element"]
        for n in _все_узлы(yaml.safe_load(example_yaml(2))["nodes"])
        if "element" in n
    }
    assert example_yaml(2).count("element") == 1
    assert элементы2 == {"Ярмарка": "system"}
    элементы3 = {
        n["name"]: n["element"]
        for n in _все_узлы(yaml.safe_load(example_yaml(3))["nodes"])
        if "element" in n
    }
    assert элементы3 == {"Ярмарка": "system", "orders": "container"}


def test_в_свободной_роли_примера_нет_слов_c4():
    """Лексикон §6 п.10: C4-слово в свободной «Роли» читается как элемент и путает и
    человека, и модель."""
    роли = {n.get("role") for n in _все_узлы(yaml.safe_load(example_yaml(3))["nodes"])}
    assert not роли & {"система", "контейнер", "компонент"}


def _все_узлы(nodes: list[dict]) -> list[dict]:
    out: list[dict] = []
    for n in nodes:
        out.append(n)
        out.extend(_все_узлы(n.get("children", [])))
    return out


def test_правило_элемента_на_глубине_3():
    p = build_import_prompt("Ярмарка")
    assert (
        "Узел с children помечай element: container, если это одна запускаемая программа и "
        "children — части её кода (компоненты), и element: system, если внутри несколько "
        "отдельно запускаемых частей (API, база, воркер)" in p
    )
    # Правила, которые ввоз держит сам (app/import_element.sanitize_elements).
    assert (
        "база данных и брокер внутри контейнера недопустимы — ArchMap вынесет их на "
        "уровень выше с замечанием" in p
    )
    assert "Без element у узла с children ArchMap файл не примет." in p
    assert (
        "16. element стоит у каждого узла формы service с children и только у них; внутри "
        "узла с element: container нет ни базы данных, ни брокера; у children контейнера "
        "element не стоит.\n" in p
    )


def test_на_глубине_2_элемент_только_у_корня():
    p = build_import_prompt("Ярмарка", depth=2)
    assert (
        "Ключ element нужен только корню-системе: element: system (без него ArchMap файл не "
        "примет). У узлов внутри неё element не ставится: без слоя компонентов каждый из них "
        "— контейнер сам по себе." in p
    )
    assert "Узел с children помечай element: container" not in p
    assert (
        "16. У корня-системы стоит element: system; у узлов внутри неё element не стоит.\n" in p
    )


@pytest.mark.parametrize("depth", [2, 3])
def test_чек_лист_сходится_на_обеих_глубинах(depth):
    """Пункт об элементе — 16-й и последний на обеих глубинах: номера 1–16 подряд."""
    p = build_import_prompt("Ярмарка", depth=depth)
    вывод = p.split("## Вывод", 1)[1]
    номера = [int(m) for m in re.findall(r"^(\d+)\. ", вывод, flags=re.M)]
    assert номера == list(range(1, 17))


@pytest.mark.parametrize("depth", [2, 3])
def test_промпт_говорит_правду_о_файле_без_типа(depth):
    """Тип выбран всегда (2026-11-01): файл без element у узла с children ввоз отвергает.
    Сторож на возвращение прежних фраз «читает системой» и «без него … — система»."""
    p = build_import_prompt("Ярмарка", depth=depth)
    assert "ArchMap файл не примет" in p
    assert "читает системой" not in p
    assert "без него узел с children — система" not in p


def test_слой_контейнеров_в_смысле_c4():
    """Контейнер в смысле C4, а не Docker; «деплой-единица» осталась пояснением."""
    for depth in (2, 3):
        p = build_import_prompt("Ярмарка", depth=depth)
        assert (
            "- Слой 2 — контейнеры (в смысле C4: то, что разворачивается и запускается "
            "отдельно; с Docker не связано) — деплой-единицы внутри системы" in p
        )


def test_формат_называет_поле_element():
    for depth in (2, 3):
        p = build_import_prompt("Ярмарка", depth=depth)
        assert (
            "element (system | container; обязателен у узла формы service с children, без "
            "него ArchMap файл не примет; у узла без children не ставится)" in p
        )
        assert "значения shape/status/element — латиницей" in p
        assert "7. shape, status и element — только из разрешённых значений." in p


def test_замечание_об_элементе_лечится_правкой_а_не_удалением():
    """Тексты замечаний ввоза (app/import_element): «…элемент архитектуры пропущен»,
    «…не может входить в состав контейнера, поэтому вынесена на уровень выше»."""
    for depth in (2, 3):
        p = build_import_prompt("Ярмарка", depth=depth)
        assert (
            "Замечания об элементе архитектуры (со словами «элемент архитектуры» или «не "
            "может входить в состав контейнера») лечатся правкой поля element или переносом "
            "базы и брокера на уровень выше, а не удалением узлов." in p
        )


def test_слой_компонентов_словами_элемента():
    """Решения 0а плана: «коробка» и «модуль» в продукт не идут; «подсистема» в
    промпте значила часть кода, а в документации — вложенную систему (лексикон §6
    п.11). Правило о связях слоя 3 прежнее — поменялись только слова (Ф13а: компоненты —
    части кода одной запускаемой программы)."""
    p3 = build_import_prompt("Ярмарка")
    assert "children контейнера — крупные части кода ОДНОЙ запускаемой" in p3
    assert "Вызовы делает не контейнер, а лежащие в нём компоненты" in p3
    for p in (p3, build_import_prompt("Ярмарка", depth=2)):
        assert not re.search(r"коробк|модул|подсистем", p, re.IGNORECASE)


def test_процесс_из_перечня_контейнер_а_не_компонент():
    """Ф13а (2026-10-31): по элементу архитектуры отдельно запускаемый процесс — контейнер
    рядом с другими, а компоненты — части кода одной программы. Пример держит это
    устройство (billing-worker — контейнер системы, у orders — части его процесса),
    слой 3 называет правило словами. v2 (замер 2026-10-31, Zabbix 7): «отдельно
    запускаемый» — у кого своя команда запуска; процессы, которые порождает main одной
    программы (таблица типов процессов одного бинарника), — её компоненты."""
    doc = yaml.safe_load(example_yaml(3))
    containers = {c["name"]: c for c in doc["nodes"][0]["children"]}
    assert "billing-worker" in containers and "children" not in containers["billing-worker"]
    assert [c["name"] for c in containers["orders"]["children"]] == ["api", "outbox"]
    p3 = build_import_prompt("X", depth=3)
    assert "не компонент, а контейнер" in p3 and "billing-worker рядом с orders" in p3
    assert "воркеры, планировщик" not in p3
    v2 = (
        "ОТДЕЛЬНО ЗАПУСКАЕМЫЙ —",
        "СВОЯ команда запуска",
        "порождает сам",
        "контейнеров, если у каждой записи своя команда",
    )
    assert all(фраза in p3 for фраза in v2)
    p2 = build_import_prompt("X", depth=2)
    assert not any(фраза in p2 for фраза in v2)


def test_у_компонента_есть_вызывающий_внутри_контейнера():
    """Замер 2026-10-31 (Zabbix 7 / Sentry): строители дробили контейнер на
    компоненты-обёртки по вызываемой системе с единственной связью наружу и без связей
    между компонентами — изолированные группы. Слой 3 требует вызывающего внутри."""
    p3 = build_import_prompt("X", depth=3)
    assert "У КАЖДОГО КОМПОНЕНТА ЕСТЬ ВЫЗЫВАЮЩИЙ ВНУТРИ КОНТЕЙНЕРА" in p3
    assert "клиентская обёртка" in p3
    p2 = build_import_prompt("X", depth=2)
    assert "У КАЖДОГО КОМПОНЕНТА ЕСТЬ ВЫЗЫВАЮЩИЙ ВНУТРИ КОНТЕЙНЕРА" not in p2
    assert "клиентская обёртка" not in p2


# ── Шаг сборщика фактов (фаза 3 docs/tasks/fact-collector.md) ─────────────────

SCAN_URL = "https://archmap.example.com/api/v1/scan/archmap-scan.pyz"


@pytest.mark.parametrize("depth", [2, 3])
def test_без_адреса_сборщика_промпт_прежний(depth):
    """Поставка без файла и старые клиенты: шага нет, текст байт-в-байт прежний."""
    p = build_import_prompt("Ярмарка", depth=depth)
    assert build_import_prompt("Ярмарка", depth=depth, scan_url=None) == p
    assert "archmap-scan" not in p and "\n0. " not in p


@pytest.mark.parametrize("depth", [2, 3])
def test_шаг_сборщика_первым_и_пункт_чек_листа(depth):
    p = build_import_prompt("Ярмарка", depth=depth, scan_url=SCAN_URL)
    порядок = p.split("## Порядок обследования", 1)[1].split("## Модель", 1)[0]
    assert порядок.index("\n0. Сначала запусти СБОРЩИК ФАКТОВ ArchMap.") < порядок.index(
        "\n1. Инфраструктурные манифесты"
    )
    assert f"   curl -sSfL -o archmap-scan.pyz {SCAN_URL}\n" in p
    assert '   python3 archmap-scan.pyz . --system "Ярмарка" --out archmap-scan\n' in p
    assert "если среди твоих инструментов есть archmap_scan" in p
    assert "иди по шагам 1–6" in p
    for файл in ("summary.txt", "coverage.yaml", "agent/hints.yaml", "agent/entrypoints.yaml",
                 "agent/evidence.yaml", "schema.yaml", "facts/*.yaml"):
        assert f"archmap-scan/{файл}" in p
    assert "archmap_facts_preview и archmap_facts_apply (аргумент paths)" in p
    assert "Каталог archmap-scan в репозиторий не коммить." in p
    вывод = p.split("## Вывод", 1)[1]
    номера = [int(m) for m in re.findall(r"^(\d+)\. ", вывод, flags=re.M)]
    assert номера == list(range(1, 18))
    assert "17. Каждый контейнер, база данных и брокер из archmap-scan/schema.yaml" in вывод


def test_общий_код_отдаётся_контейнеру_который_его_выполняет():
    """Решение владельца 2026-11-10: правило владельца в сборщике не меняется, записи общего
    кода агент отдаёт контейнеру, который этот код выполняет, а файлы facts/shared/ подаёт с
    адресом в первой строке, как просит их шапка (scan texts.SHARED_FILE_ASK). Без сборщика
    фразы нет: нет ни hints.yaml, ни файлов фактов."""
    for depth in (2, 3):
        p = build_import_prompt("Ярмарка", depth=depth, scan_url=SCAN_URL)
        assert (
            "Записи archmap-scan/agent/hints.yaml с причиной «общий код» (файл вне каталогов "
            "кода всех контейнеров или нет контейнера на этом языке) отдай контейнеру, который "
            "этот код выполняет: маршруты и каналы в его компоненты и связи.\n" in p
        )
        assert (
            "Параметры общего кода лежат в archmap-scan/facts/shared/*.yaml без адреса "
            "владельца, поэтому впиши в первую строку адрес контейнера, который выполняет "
            "этот код, и подай эти файлы как остальные файлы фактов." in p
        )
        assert "общий код" not in build_import_prompt("Ярмарка", depth=depth)


@pytest.mark.parametrize("scan_url", [None, SCAN_URL])
def test_тёзка_системы_остаётся_со_своим_именем(scan_url):
    """Находка замера 2026-11-01: контейнер, названный как система (sentry в Sentry),
    строитель переименовывал. Ввоз тёзку принимает и различает путём; источник имени —
    скелет сборщика, а без него имя программы в коде и манифестах."""
    p = build_import_prompt("Ярмарка", scan_url=scan_url)
    именование = p.split("## Правила именования", 1)[1].split("## Поле source", 1)[0]
    assert (
        "Если это имя совпадает с именем системы без учёта регистра (контейнер sentry в системе "
        "Sentry), оставь его как есть. ArchMap различает такие объекты по пути от корня "
        "(«Sentry / sentry»), поэтому переименовывать контейнер и придумывать ему другое имя "
        "не нужно." in именование
    )
    assert ("archmap-scan/schema.yaml" in именование) == (scan_url is not None)
    assert "так, как программа названа в коде и манифестах: образ, сервис compose, бинарник." in (
        именование
    )


def test_тёзка_системы_принимается_ввозом():
    """Правило промпта говорит правду: контейнер с именем системы в любом регистре ввоз
    принимает, связи до него доходят путём от корня."""
    for имя in ("sentry", "Sentry"):
        документ = (
            "nodes:\n- name: Sentry\n  element: system\n  children:\n"
            f"  - name: {имя}\n  - name: postgres\n    shape: database\n"
            f"edges:\n- {{from: Sentry / {имя}, to: postgres}}\n"
        )
        parsed, errors = parse_import(документ)
        assert errors == [] and parsed is not None, имя
        (связь,) = parsed.edges
        assert parsed.nodes[связь.source_idx].name == имя
        assert parsed.nodes[связь.source_idx].parent_idx == 0


def test_компоненты_в_шаге_сборщика_только_при_слое_3():
    p3 = build_import_prompt("X", depth=3, scan_url=SCAN_URL)
    p2 = build_import_prompt("X", depth=2, scan_url=SCAN_URL)
    assert "(вызовы между сервисами по коду), компоненты слоя 3." in p3
    assert "(вызовы между сервисами по коду). Семьи" in p2
    assert "компоненты слоя 3" not in p2.split("## Модель", 1)[0]


def test_шаг_сборщика_по_русски_при_английских_значениях():
    p = build_import_prompt("X", lang="en", scan_url=SCAN_URL)
    assert "0. Сначала запусти СБОРЩИК ФАКТОВ ArchMap." in p


def test_имя_системы_в_команде_не_раскрывается_оболочкой():
    """Имя при обновлении из кода — имя проекта: его задаёт другой человек, а команду
    выполнит агент. Опасное внутри двойных кавычек уходит в одинарные."""
    p = build_import_prompt('Я"рмарка $(rm -rf ~)', scan_url=SCAN_URL)
    assert """--system 'Я"рмарка $(rm -rf ~)' --out archmap-scan""" in p
    assert '--system "Платёжная платформа"' in build_import_prompt(
        "Платёжная  платформа", scan_url=SCAN_URL
    )


def test_аудиту_шаг_сборщика_не_достаётся():
    """Скептик проверяет готовую модель и строительного промпта не содержит; обёртка
    вшивает строительный промпт целиком, со всем шагом."""
    без = build_import_prompt("Ярмарка")
    с = build_import_prompt("Ярмарка", scan_url=SCAN_URL)
    assert prompt_for_variant("skeptic", "import", с, system_name="Ярмарка") == prompt_for_variant(
        "skeptic", "import", без, system_name="Ярмарка"
    )
    assert с in prompt_for_variant("orchestrated", "import", с, system_name="Ярмарка")


@pytest.fixture()
def файл_сборщика(tmp_path, monkeypatch):
    path = tmp_path / "archmap-scan.pyz"
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        zf.writestr("archmap_scan/__init__.py", '__version__ = "0.1.0"\n')
    path.write_bytes(buf.getvalue())
    monkeypatch.setattr(settings, "scan_file", str(path))
    return path


def test_ручка_с_адресом_клиента_и_файлом(db, файл_сборщика):
    user = ensure_architect(db)
    out = import_prompt(
        system_name="Ярмарка", depth=3, lang="ru", hints=None, origin="http://localhost:5173",
        _user=user,
    )
    assert out.scan_url == "http://localhost:5173/api/v1/scan/archmap-scan.pyz"
    assert f"curl -sSfL -o archmap-scan.pyz {out.scan_url}\n" in out.prompt
    # Без адреса клиента промпт прежний: старые клиенты и MCP до обновления.
    прежний = import_prompt(system_name="Ярмарка", depth=3, lang="ru", hints=None, _user=user)
    assert прежний.scan_url is None
    assert прежний.prompt == build_import_prompt("Ярмарка")
    аудит = import_prompt(
        system_name="Ярмарка", depth=3, lang="ru", hints=None, variant="skeptic",
        origin="http://localhost:5173", _user=user,
    )
    assert аудит.scan_url is None and "archmap-scan" not in аудит.prompt


def test_ручка_без_файла_в_поставке(db, tmp_path, monkeypatch):
    monkeypatch.setattr(settings, "scan_file", str(tmp_path / "нет" / "archmap-scan.pyz"))
    out = import_prompt(
        system_name="Ярмарка", depth=3, lang="ru", hints=None, origin="https://archmap.example.com",
        _user=ensure_architect(db),
    )
    assert out.scan_url is None
    assert out.prompt == build_import_prompt("Ярмарка")


@pytest.mark.parametrize(
    ("origin", "code"),
    [
        ("http://localhost:5173", 200),
        ("https://[::1]:8443", 200),
        ("https://archmap.example.com/путь", 422),
        ("javascript:alert(1)", 422),
        ("https://a.example.com; rm -rf ~", 422),
        ("https://" + "a" * 300, 422),
    ],
)
def test_адрес_клиента_проверяется_схемой(db, файл_сборщика, origin, code):
    app.dependency_overrides[get_current_user] = lambda: ensure_architect(db)
    try:
        r = TestClient(app).get(
            "/api/v1/projects/import/prompt", params={"system_name": "Ярмарка", "origin": origin}
        )
    finally:
        app.dependency_overrides.clear()
    assert r.status_code == code, r.text
    if code == 200:
        assert r.json()["scan_url"] == f"{origin}/api/v1/scan/archmap-scan.pyz"
