"""Тесты промпта «Из репозитория» (app/import_prompt.py + GET /projects/import/prompt).

Главная гарантия: встроенный в промпт пример — ВАЛИДНЫЙ документ импорта
(кормим его в parse_import на обеих глубинах); промпт не может протухнуть
относительно формата. Плюс параметры: имя системы вшито в требования к корню,
depth=2 вырезает слой компонентов и из инструкции, и из примера, язык и
подсказки попадают в текст.
"""

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
            "go.mod), а не угадывай по роли узла." in p
        )
        # Чек-лист — последнее, что модель читает перед выводом: правило про манифесты
        # продублировано и там (как правило кавычек).
        assert "technology каждого узла взята из манифеста сборки" in p


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


def test_без_мультипродукта_промпт_байт_в_байт():
    """⚠ Сентинел (ловушка №1 плана): одно-репо прогоны НЕ регрессируют. Флаг обязан
    ДОБАВЛЯТЬ раздел и ничего больше — вырезав раздел из мультипродуктового текста,
    получаем прежний байт-в-байт. Тест падает и если генератор флаг игнорирует
    (раздела нет — разрезать нечего), и если флаг заодно правит что-то ещё."""
    парам = {"depth": 3, "lang": "ru", "hints": "монорепо"}
    без = build_import_prompt("Zabbix+Grafana", **парам)
    assert без == build_import_prompt("Zabbix+Grafana", **парам, multi_product=False)
    assert МУЛЬТИ_ЗАГОЛОВОК not in без

    с_флагом = build_import_prompt("Zabbix+Grafana", **парам, multi_product=True)
    голова, хвост = с_флагом.split(МУЛЬТИ_ЗАГОЛОВОК)
    assert голова + "## Поле source" + хвост.split("## Поле source", 1)[1] == без


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
    """Пример учит конвенции якорей (Фаза 0 синка): свой сервис — repo + host,
    чужой — только host. Тест держит пример и парсер синхронными: правило из
    промпта обязано разбираться в ключи identity."""
    for depth in (2, 3):
        parsed, errors = parse_import(example_yaml(depth))
        assert errors == [] and parsed is not None
        keys = {n.name: n.source_keys for n in parsed.nodes if n.source_keys}
        assert keys["orders"] == ["git:github.com/org/orders", "host:orders"]
        # Сервис из чужого репозитория — только сетевое имя, ничего выдуманного.
        assert keys["payments"] == ["host:payments"]
        # Корню-системе и людям-акторам якорь не нужен.
        assert "Ярмарка" not in keys and "Покупатель" not in keys


def test_prompt_explains_source_field():
    text = build_import_prompt("Ярмарка")
    assert "## Поле source" in text
    for field in ("repo", "path", "image", "deployment", "host"):
        assert field in text
