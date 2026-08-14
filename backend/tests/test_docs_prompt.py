"""Тесты промпта «Доки от агента» (docs_prompt, этап 2 plan-agent-docs.md).

Главная гарантия — образец файла из промпта РАЗБИРАЕТСЯ нашим же парсером
(промпт не может протухнуть относительно формата). Плюс маркеры критичных правил
(уроки стресс-теста repo-import) и переключатели.

С переездом на .mmd (docs/plan-docs-mmd.md) образец — не манифест, а сам файл
схемы: пакет манифеста больше не содержит.
"""

from app.data_refs import parse_data_refs
from app.docs_prompt import build_docs_prompt
from app.mmd_header import example_mmd, parse_mmd_header

SLICE = "nodes:\n- name: Ярмарка\n  shape: service\nedges: []\n"


def test_образец_из_промпта_разбирается_парсером():
    prompt = build_docs_prompt(SLICE, include="logic")
    assert example_mmd() in prompt  # в промпте лежит ровно то, что парсится

    header = parse_mmd_header(example_mmd())
    assert header.name and header.kind == "operation" and header.operation
    assert header.problems == []


def test_образец_учит_конвенциям():
    text = example_mmd()
    # Подписи вершин — в кавычках внутри скобок (частая ошибка слабой модели)
    assert 'A["Приём запроса"]' in text
    # Диаграмма — flowchart, а не sequence
    assert text.splitlines()[3].startswith("graph ")


def test_промпт_учит_пометкам_обращений():
    """Конвенция пометок (пивот §9 plan-db-docs.md) и её образец — в промпте логики.

    Главная гарантия — та же, что у шапки: пометку из ОБРАЗЦА разбирает наш же
    parse_data_refs. Разъезд здесь означал бы, что агента учат синтаксису, который
    ArchMap молча не читает.
    """
    prompt = build_docs_prompt(SLICE, include="logic")
    for marker in (
        "Пометки данных в подписях шагов",
        "«читает: …» или «пишет: …»",
        "ДОСЛОВНО из кода миграций",
        "Колонки НЕ ВЫДУМЫВАЙ",
        "ЛЮБОЕ изменение состояния",
        "Одноимённые таблицы в разных базах",
        # Маркер = обещание факта: проза после «читает:» тоже извлечётся
        "«читает: конфиг из файла» станет ошибкой",
        # Чек-лист самопроверки — последнее, что модель читает перед выводом
        "выдуманных колонок нет",
    ):
        assert marker in prompt, marker

    # Находки №2 и №7 полевого QA: пометки писала сессия, не читавшая DDL («action»
    # против таблицы «actions»), и помечала любой I/O — 46 алертов-шума на проект.
    for marker in (
        "Пометка — ТОЛЬКО про таблицы базы данных",
        "in-memory кэши и очереди, HTTP-вызовы пометками НЕ помечай",
        "из самой СХЕМЫ БД (DDL)",
        "«actions», если таблица называется actions",
        "открой DDL и проверь",
        "НЕ пиши пометку",
        # Чек-лист: сверка имён с DDL и периметр пометки
        "Имена в пометках сверены с DDL",
        "пометок на не-таблицах",
    ):
        assert marker in prompt, marker

    refs = {(r.ref, r.mode) for r in parse_data_refs(example_mmd())}
    assert refs == {
        ("accounts.balance", "read"), ("orders", "write"), ("order_items", "write"),
        # Событие в брокер — вторая семья пометок, и она в том же образце (§3
        # plan-broker-docs.md): иначе агент помечает публикацию словом «пишет:».
        ("orders.created", "publish"),
    }

    # В окне спеки пометкам учить нечему — схем логики там нет
    assert "пишет:" not in build_docs_prompt(SLICE, include="api")


def test_промпт_учит_пометкам_событий():
    """Конвенция каналов (§3 plan-broker-docs.md) — вторая семья пометок в том же
    промпте. Отдельные слова, а не синонимы «пишет:/читает:»: у событий своя
    семантика доставки и свой каталог, и «пишет: orders.created» ушло бы искать
    таблицу. Гарантия та же — пометка из ОБРАЗЦА разбирается нашим parse_data_refs
    (проверено в тесте выше).
    """
    prompt = build_docs_prompt(SLICE, include="logic")
    for marker in (
        "Пометки событий: публикует:/потребляет:",
        "«публикует: …» или «потребляет: …»",
        "Публикацию в топик помечай «публикует:», а не «пишет:»",
        # Периметр: без него агент помечает любой I/O — 46 алертов-шума на проект
        # (находка №7 полевого QA, класс тот же).
        "ТОЛЬКО про каналы брокеров",
        "очереди ВНУТРИ процесса",
        # Имена из головы — главный источник битых пометок (урок Н2). Правило пришито
        # к САМОМУ правилу, а не к его отголоску в чек-листе: одной формулировки в
        # конце промпта мало, слабая модель до неё уже напишет пометки.
        "Имена каналов бери ДОСЛОВНО из кода или конфига",
        "Точки, дефисы и версии в имени — норма",
        "НЕ пиши пометку",
        "Одноимённые каналы у разных брокеров",
        # Чек-лист — последнее, что модель читает перед выводом.
        "события помечены этими словами",
    ):
        assert marker in prompt, marker

    # В окне спеки схем логики нет — учить каналам нечему.
    assert "публикует:" not in build_docs_prompt(SLICE, include="api")


def test_промпт_запрещает_чинить_пометки_удалением():
    """Находка №2 полевого QA (docs/qa-sentry-brokers.md): по списку из ~7 битых
    пометок Haiku «починил» их удалением ВСЕХ 83 табличных — обратный индекс базы
    опустел, а превью стало «идеальным». Ампутация Х3 в новой одежде, и лечится тем
    же: правило «чини, а не удаляй» стоит в САМОЙ конвенции пометок, а не только в
    тексте кнопки замечаний (кнопку копируют не всегда, промпт — всегда).
    """
    prompt = build_docs_prompt(SLICE, include="logic")
    assert "УДАЛЯТЬ пометки нельзя" in prompt
    assert "удаление прячет факт, а не исправляет его" in prompt
    # Что делать вместо удаления — названо ОБЕИМ семьям: имя по структуре либо
    # квалификатор (у таблиц и каналов он свой).
    assert "чини имя по структуре или добавляй квалификатор" in prompt
    assert "«Узел-БД / таблица», «Брокер / канал»" in prompt

    # В окне спеки пометок нет — и правила о них тоже.
    assert "УДАЛЯТЬ пометки нельзя" not in build_docs_prompt(SLICE, include="api")


def test_prompt_markers_and_slice():
    prompt = build_docs_prompt(SLICE, include="both")
    assert SLICE.rstrip() in prompt  # срез вложен
    for marker in (
        "ДОСЛОВНО",
        "archmap-docs/",
        "%% archmap-name",
        "НЕ перепечатывай",
        "archmap-origin",
        "graph TD",
        "Схему НЕ меняй",
        "чью реализацию видишь в ЭТОМ репозитории",
        # Посылка перестала быть одним файлом: перечень созданных файлов —
        # единственная защита от «половину не перетащил».
        "перечисли СОЗДАННЫЕ ФАЙЛЫ",
    ):
        assert marker in prompt, marker


def test_prompt_include_toggles():
    logic_only = build_docs_prompt(SLICE, include="logic")
    assert "Схемы логики" in logic_only
    assert "OpenAPI-спека" not in logic_only
    assert "archmap-origin" not in logic_only

    api_only = build_docs_prompt(SLICE, include="api")
    assert "OpenAPI-спека" in api_only
    assert "Схемы логики" not in api_only
    # Образец .mmd в окне спеки не нужен и только сбивал бы с толку
    assert "%% archmap-name" not in api_only


def test_адресация_объяснена_только_там_где_нужна():
    # В окне логики схема может уехать вложенному узлу — адрес объясняем; в окне
    # спеки адресовать нечего, спека одна и принадлежит объекту окна.
    logic_only = build_docs_prompt(SLICE, include="logic")
    assert "%% archmap-node" in logic_only
    assert "%% archmap-node" not in build_docs_prompt(SLICE, include="api")


def test_prompt_lang_and_hints():
    en = build_docs_prompt(SLICE, include="both", lang="en", hints="Только сервис billing")
    assert "английский (English)" in en
    assert "Пример ниже написан по-русски" in en
    assert "Дополнительные указания пользователя" in en
    assert "Только сервис billing" in en

    ru = build_docs_prompt(SLICE)
    assert "Пример ниже написан по-русски" not in ru
    assert "Дополнительные указания" not in ru


def test_режим_по_одной_схеме_требует_ровно_один_файл():
    one = build_docs_prompt(SLICE, include="logic", target="Крон: счета")
    assert "Крон: счета" in one
    assert "ровно один .mmd-файл" in one
