"""Дозаливка КОНФИГУРАЦИИ сервиса от агента (BYOA, Ф3 plan-config-docs.md).

Здесь проверяется то, чем этот путь отличается от двух предыдущих семей:
  • владелец всегда САМ СЕРВИС, поэтому чужая форма — предупреждение, а не ошибка:
    секция конфигурации показывает записи у любой формы, и данные не пропадают;
  • параметр ПЛОСКИЙ — второго уровня нет, дубль внутри пакета сливается в одну
    запись (иначе применение упало бы на уникальности (node_id, name));
  • ЗНАЧЕНИЙ НЕ ХРАНИМ, и запрет держится только текстом промпта — поэтому приёмник
    показывает подозрительные дефолты человеку, а промпт учит запрету примером.
"""

import uuid

from conftest import ensure_architect, ensure_project

from app.config_import import (
    MAX_DUPLICATE_WARNINGS,
    MAX_SECRET_WARNINGS,
    parse_config_file,
)
from app.config_prompt import build_config_prompt
from app.models.config_param import ConfigParam
from app.models.node import Node
from app.routers.config_import import (
    config_import_apply,
    config_import_preview,
    config_prompt,
)
from app.schemas.config_import import ConfigImportIn

ПАКЕТ = """# archmap-node: Платежи
config:
  - name: FEATURE_NEW_CHECKOUT
    type: bool
    required: false
    default: "false"
    description: включает новый расчёт корзины
  - name: RETRY_TIMEOUT
    type: duration
    default: 30s
    description: сколько ждать перед повтором запроса к банку
  - name: DATABASE_URL
    type: string
    required: true
    default: ""
    description: основное хранилище заказов
"""


def _node(db, name, shape="service", parent=None):
    n = Node(
        id=uuid.uuid4(),
        name=name,
        shape=shape,
        parent_id=parent.id if parent else None,
        project_id=ensure_project(db).id,
    )
    db.add(n)
    db.flush()
    return n


def _in(*files, node_id=None, overwrite=False):
    return ConfigImportIn(
        files=[{"name": n, "content": c} for n, c in files],
        node_id=node_id,
        overwrite=overwrite,
    )


def _preview(db, payload):
    return config_import_preview(
        payload, db=db, project=ensure_project(db), _=ensure_architect(db)
    )


def _apply(db, payload):
    return config_import_apply(
        payload, db=db, project=ensure_project(db), user=ensure_architect(db)
    )


# ── Разбор ────────────────────────────────────────────────────────────────────


def test_разбор_берёт_адрес_и_параметры():
    pc = parse_config_file(ПАКЕТ)
    assert pc is not None
    assert pc.node_ref == "Платежи"
    assert [p.name for p in pc.params] == [
        "FEATURE_NEW_CHECKOUT", "RETRY_TIMEOUT", "DATABASE_URL",
    ]
    первый = pc.params[0]
    assert (первый.value_type, первый.required, первый.default_value) == ("bool", False, "false")
    assert pc.params[2].required is True


def test_разбор_чужой_файл_пакета_пропускается():
    # В пакете рядом лежат схемы логики, спеки, таблицы и каналы — не наше дело.
    assert parse_config_file("tables:\n  - name: orders\n") is None
    assert parse_config_file("channels:\n  - name: orders.created\n") is None
    assert parse_config_file("graph TD\n  A --> B") is None


def test_битый_yaml_нашего_файла_не_молчит(db):
    _node(db, "Платежи")
    # Двоеточие с пробелом внутри значения — самая частая причина битого YAML.
    битый = "config:\n  - name: X\n    description: таймаут: секунды\n"
    отчёт = _preview(db, _in(("c.yaml", битый)))

    # Молча пропустить значило бы сказать «в пакете нет конфигурации», хотя она есть.
    assert any("YAML не разобрался" in e for e in отчёт.errors)


# ── Превью и применение ───────────────────────────────────────────────────────


def test_пакет_создаёт_параметры_у_адресованного_сервиса(db):
    сервис = _node(db, "Платежи")
    _node(db, "Заказы")  # сосед: пакет к нему не относится

    отчёт = _preview(db, _in(("cfg.yaml", ПАКЕТ)))
    assert [i.action for i in отчёт.params] == ["create", "create", "create"]
    assert all(i.node_path == "Платежи" for i in отчёт.params)
    assert db.query(ConfigParam).count() == 0  # превью не пишет

    применение = _apply(db, _in(("cfg.yaml", ПАКЕТ)))
    assert применение.applied is True
    assert применение.params_written == 3
    записи = {p.name: p for p in db.query(ConfigParam).all()}
    assert set(записи) == {"FEATURE_NEW_CHECKOUT", "RETRY_TIMEOUT", "DATABASE_URL"}
    assert записи["RETRY_TIMEOUT"].default_value == "30s"
    assert записи["DATABASE_URL"].node_id == сервис.id
    assert записи["DATABASE_URL"].required is True


def test_повторный_заход_дублей_не_плодит_и_чужое_не_трёт(db):
    _node(db, "Платежи")
    _apply(db, _in(("cfg.yaml", ПАКЕТ)))
    # Человек уточнил назначение руками — второй прогон агента не вправе его затереть.
    руками = db.query(ConfigParam).filter(ConfigParam.name == "RETRY_TIMEOUT").one()
    руками.description = "уточнено человеком"
    db.commit()

    отчёт = _apply(db, _in(("cfg.yaml", ПАКЕТ)))

    assert [i.action for i in отчёт.params] == ["unchanged", "unchanged", "unchanged"]
    assert db.query(ConfigParam).count() == 3
    assert db.get(ConfigParam, руками.id).description == "уточнено человеком"


def test_перезапись_по_галке_обновляет_заполненное(db):
    _node(db, "Платежи")
    _apply(db, _in(("cfg.yaml", ПАКЕТ)))
    старый = db.query(ConfigParam).filter(ConfigParam.name == "RETRY_TIMEOUT").one()
    старый.description = "устарело"
    db.commit()
    было = старый.version

    отчёт = _apply(db, _in(("cfg.yaml", ПАКЕТ), overwrite=True))

    assert [i.action for i in отчёт.params] == ["overwrite"] * 3
    свежий = db.get(ConfigParam, старый.id)
    assert свежий.description == "сколько ждать перед повтором запроса к банку"
    assert свежий.version == было + 1


def test_без_адреса_параметры_едут_к_объекту_окна(db):
    сервис = _node(db, "Платежи")
    безадресный = "config:\n  - name: LOG_LEVEL\n    type: string\n"

    _apply(db, _in(("cfg.yaml", безадресный), node_id=сервис.id))

    assert db.query(ConfigParam).one().node_id == сервис.id


def test_ключ_вместо_комментария_не_молчит(db):
    сервис = _node(db, "Платежи")
    # Агент потерял решётку: адрес стал обычным YAML-ключом и невидим (урок Н11).
    пакет = "archmap-node: Платежи\nconfig:\n  - name: LOG_LEVEL\n"

    отчёт = _preview(db, _in(("cfg.yaml", пакет), node_id=сервис.id))

    assert any("адресом не является" in w for w in отчёт.warnings)


def test_неизвестный_адрес_называет_допустимые(db):
    _node(db, "Платежи")
    пакет = "# archmap-node: Биллинг\nconfig:\n  - name: X\n"

    отчёт = _preview(db, _in(("cfg.yaml", пакет)))

    # Без перечня слабая модель гадает вслепую — раунд переписки за раунд (урок Н8).
    assert any("не найден" in e and "Платежи" in e for e in отчёт.errors)


def test_чужая_форма_предупреждение_а_не_ошибка(db):
    """Расхождение с каналами осознанное: там применённое стало бы НЕВИДИМЫМ (секция
    рендерится только у брокера), здесь секция показывает записи у любой формы с
    предупреждением — значит данные не теряются и отклонять пакет не за что."""
    база = _node(db, "Postgres", shape="database")

    отчёт = _apply(db, _in(("cfg.yaml", "config:\n  - name: MAX_CONNECTIONS\n"), node_id=база.id))

    assert отчёт.errors == []
    assert any("не сервис" in w for w in отчёт.warnings)
    assert db.query(ConfigParam).one().node_id == база.id


# ── Слияние дублей внутри пакета ──────────────────────────────────────────────


def test_один_параметр_в_двух_файлах_сливается_в_одну_запись(db):
    """Без слияния превью показало бы две строки «create», а применение упало бы на
    уникальности (node_id, name) — ровно тот случай, что разбирали у каналов."""
    _node(db, "Платежи")
    первый = "# archmap-node: Платежи\nconfig:\n  - name: LOG_LEVEL\n    type: string\n"
    второй = (
        "# archmap-node: Платежи\nconfig:\n  - name: LOG_LEVEL\n"
        "    default: info\n    description: уровень подробности логов\n"
    )

    отчёт = _apply(db, _in(("a.yaml", первый), ("b.yaml", второй)))

    assert len(отчёт.params) == 1
    запись = db.query(ConfigParam).one()
    # Пустое значение спором не считается: второй файл долил то, чего первый не видел.
    assert (запись.value_type, запись.default_value) == ("string", "info")
    assert запись.description == "уровень подробности логов"
    assert any("описан в нескольких файлах" in w for w in отчёт.warnings)


def test_расхождение_меты_между_файлами_названо_поимённо(db):
    _node(db, "Платежи")
    первый = "# archmap-node: Платежи\nconfig:\n  - name: TIMEOUT\n    default: 30s\n"
    второй = "# archmap-node: Платежи\nconfig:\n  - name: TIMEOUT\n    default: 60s\n"

    отчёт = _apply(db, _in(("a.yaml", первый), ("b.yaml", второй)))

    # Побеждает описанное раньше — иначе смысл карты зависел бы от порядка файлов.
    assert db.query(ConfigParam).one().default_value == "30s"
    assert any("«60s»" in w and "a.yaml" in w for w in отчёт.warnings)


def test_расхождение_с_archmap_названо_а_значение_оставлено(db):
    _node(db, "Платежи")
    _apply(db, _in(("a.yaml", "# archmap-node: Платежи\nconfig:\n  - name: TIMEOUT\n    type: int\n")))

    отчёт = _preview(
        db, _in(("b.yaml", "# archmap-node: Платежи\nconfig:\n  - name: TIMEOUT\n    type: duration\n"))
    )

    assert any("в ArchMap «int»" in w for w in отчёт.warnings)
    assert db.query(ConfigParam).one().value_type == "int"


def test_кап_дублей_не_даёт_классу_съесть_весь_список(db):
    _node(db, "Платежи")
    имена = [f"P{i}" for i in range(MAX_DUPLICATE_WARNINGS + 3)]
    файл = "# archmap-node: Платежи\nconfig:\n" + "".join(f"  - name: {n}\n" for n in имена)

    отчёт = _preview(db, _in(("a.yaml", файл), ("b.yaml", файл)))

    дубли = [w for w in отчёт.warnings if "описан в нескольких файлах" in w]
    assert len(дубли) == MAX_DUPLICATE_WARNINGS
    assert any("…ещё 3" in w for w in отчёт.warnings)


# ── Значения ──────────────────────────────────────────────────────────────────


def test_дефолт_у_секретного_имени_показывается_человеку(db):
    """Запрет на значения держится только текстом промпта (флаг «секрет» в модели
    отклонён), а модели в дисциплине правил ненадёжны. Резать нельзя — в .env.example
    законно стоит dev-строка, — но и молчать нельзя: человек решает сам."""
    _node(db, "Платежи")
    пакет = (
        "# archmap-node: Платежи\nconfig:\n"
        "  - name: DATABASE_PASSWORD\n    default: hunter2\n"
        "  - name: LOG_LEVEL\n    default: info\n"
    )

    отчёт = _preview(db, _in(("cfg.yaml", пакет)))

    подозрения = [w for w in отчёт.warnings if "ArchMap значений не хранит" in w]
    assert len(подозрения) == 1
    assert "DATABASE_PASSWORD" in подозрения[0]


def test_пустой_дефолт_у_секрета_подозрений_не_вызывает(db):
    _node(db, "Платежи")
    пакет = "# archmap-node: Платежи\nconfig:\n  - name: API_TOKEN\n    required: true\n"

    отчёт = _preview(db, _in(("cfg.yaml", пакет)))

    assert not any("ArchMap значений не хранит" in w for w in отчёт.warnings)


def test_кап_подозрительных_дефолтов(db):
    _node(db, "Платежи")
    строки = "".join(
        f"  - name: SVC_{i}_PASSWORD\n    default: v{i}\n"
        for i in range(MAX_SECRET_WARNINGS + 2)
    )
    отчёт = _preview(db, _in(("cfg.yaml", f"# archmap-node: Платежи\nconfig:\n{строки}")))

    подозрения = [w for w in отчёт.warnings if "ArchMap значений не хранит" in w]
    assert len(подозрения) == MAX_SECRET_WARNINGS
    assert any("…ещё у 2" in w for w in отчёт.warnings)


def test_секрет_опознаётся_по_концу_имени_а_не_по_вхождению(db):
    """⚠ Находка полевого прогона (docs/qa-config-field.md): вхождение где угодно
    ловило «ACCESS_TOKEN_EXPIRE_MINUTES» — а это срок жизни, а не секрет. Класс стал
    бы шумом на всех «*_TOKEN_TTL», а шумное замечание хоронит настоящие."""
    _node(db, "Платежи")
    пакет = (
        "# archmap-node: Платежи\nconfig:\n"
        "  - name: ACCESS_TOKEN_EXPIRE_MINUTES\n    default: \"10080\"\n"
        "  - name: PARTITION_KEY\n    default: order_id\n"
        "  - name: SECRET_KEY\n    default: подставлено\n"
        "  - name: AWS_SECRET_ACCESS_KEY\n    default: подставлено\n"
        "  - name: SENTRY_DSN\n    default: подставлено\n"
    )

    отчёт = _preview(db, _in(("cfg.yaml", пакет)))

    подозрения = [w for w in отчёт.warnings if "ArchMap значений не хранит" in w]
    названные = {w.split("«")[1].split("»")[0] for w in подозрения}
    assert названные == {"SECRET_KEY", "AWS_SECRET_ACCESS_KEY", "SENTRY_DSN"}


# ── Промпт ────────────────────────────────────────────────────────────────────


def test_промпт_называет_сервисы_проекта(db):
    _node(db, "Платежи")
    _node(db, "Заказы")
    _node(db, "Kafka", shape="broker")  # не сервис — в перечень адресов не идёт

    промпт = config_prompt(
        db=db, project=ensure_project(db), _=ensure_architect(db)
    ).prompt

    assert "«Платежи»" in промпт and "«Заказы»" in промпт
    assert "Kafka" not in промпт


def test_промпт_с_единственным_сервисом_ставит_его_в_пример():
    промпт = build_config_prompt(["Платформа / Платежи"])

    # Один узел — в примере стоит ровно он: места для выдумки не остаётся.
    assert "# archmap-node: Платформа / Платежи" in промпт
    assert "пиши ровно этот адрес" in промпт


def test_промпт_без_сервисов_честно_говорит_что_адресовать_некуда():
    промпт = build_config_prompt([])

    # Слепой адрес блокирует пакет целиком, и раунд уходит на угадывание (урок Н8).
    assert "ещё нет узла-сервиса" in промпт


def test_промпт_запрещает_значения_и_учит_этому_примером():
    """⚠ Сторож главного риска эпика. Запрет держится ТОЛЬКО текстом, а «пример
    сильнее правила» — пятикратно подтверждённый урок проекта: поэтому в образце
    формата обязан стоять секрет с ПУСТЫМ дефолтом и подписью, почему он пуст."""
    промпт = build_config_prompt(["Платежи"])

    assert "Значения не выписывать" in промпт
    assert "пароли, токены, ключи" in промпт
    # Сам образец учит правилу: значение секрета в нём пустое.
    assert 'default: ""                 # СЕКРЕТ' in промпт
    # И ни одного правдоподобного секрета в примере — иначе он утечёт в данные.
    assert "postgres://" not in промпт


def test_промпт_не_даёт_запрету_значений_съесть_саму_ручку():
    """⚠ Находка полевого прогона (docs/qa-zobnin-field.md): запрет значений дал
    ОБРАТНЫЙ класс — модель выкинула из пакета сами секретные ручки (username,
    password), и перечень стал неполным ровно в самом важном месте. Это тот же
    поворот, что в эпике разведки: лечение лжи рождает молчание, поэтому «не
    пропускай» должно стоять рядом с «не выписывай»."""
    промпт = build_config_prompt(["Платежи"])

    assert "САМУ РУЧКУ не пропускай" in промпт
    assert "не защита, а потеря" in промпт


def test_промпт_отсылает_зависимости_к_пометкам():
    промпт = build_config_prompt(["Платежи"])

    # Иначе агент пришлёт раздел, который некуда деть.
    assert "зависит от: ИМЯ" in промпт
    assert "раздела для этого в формате нет" in промпт
