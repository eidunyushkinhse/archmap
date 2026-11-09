"""Параметры конфигурации из кода (ТЗ §6.2): Python, Node, Go, C# и Java по фикстурам и
слияние с параметрами манифестов (дефолт из кода, секреты, required, общий код)."""

from __future__ import annotations

from functools import partial
from pathlib import Path

import pytest

from archmap_scan import clike, texts
from archmap_scan.parsers import (
    appsettings,
    dotnetenv,
    goenv,
    javaenv,
    nodeenv,
    pyenv,
    rustenv,
)
from tests.helpers import FIXTURES, files_of, model_of, time_limit, timed, tree

Row = tuple[str, str | None, bool, bool | None, str | None, str]


def _params(parser: object, root: Path) -> list[Row]:
    ctx, files = files_of(root)
    found = parser.parse(files, ctx)  # type: ignore[attr-defined]
    rows = [
        (p.name, p.default, p.has_default, p.required, p.type, str(p.loc))
        for p in found.code_params
    ]
    return sorted(rows, key=lambda r: (r[0], r[5]))


def test_python_fixture() -> None:
    # os.environ.setdefault("DJANGO_SETTINGS_MODULE", …) в строке 20 — запись значения по
    # умолчанию, а не чтение (ТЗ §13.1): ни параметра, ни подсказки.
    assert _params(pyenv, FIXTURES / "python-env") == [
        ("ALLOWED_HOSTS", None, True, None, None, "app/settings.py:10"),
        ("APP_API_KEY", "dev-key-not-for-output", True, None, "string", "app/settings.py:32"),
        ("APP_DEBUG", "false", True, None, "bool", "app/settings.py:39"),
        ("APP_PORT", "8000", True, None, "int", "app/settings.py:30"),
        ("APP_TAGS", None, True, None, None, "app/settings.py:34"),
        ("APP_TIMEOUT", None, True, None, "duration", "app/settings.py:31"),
        ("CACHE_TTL", "60", True, None, "int", "app/settings.py:13"),
        ("DATABASE_URL", None, False, True, "string", "app/settings.py:14"),
        ("DEBUG", "false", True, None, "bool", "app/settings.py:10"),
        ("DEBUG", None, False, True, "string", "app/settings.py:12"),
        ("FAST_MODE", "true", True, None, "bool", "app/settings.py:17"),
        ("HOME_DIR", "/srv", True, None, "string", "app/settings.py:18"),
        ("REGION", None, False, None, None, "app/settings.py:19"),
        ("SECRET_KEY", None, False, True, None, "app/settings.py:21"),
        ("SENTRY_DSN", "", True, None, None, "app/settings.py:15"),
        ("SERVICE_NAME", None, False, True, "string", "app/settings.py:33"),
        ("WORKERS", None, False, True, "int", "app/settings.py:16"),
    ]
    ctx, files = files_of(FIXTURES / "python-env")
    hints = pyenv.parse(files, ctx).hints
    assert [(h.data["name"], h.data["source"], h.data["reason"]) for h in hints] == [
        ("'PREFIX_' + REGION", "app/settings.py:24", texts.REASON_JOINED_NAME),
    ]


def test_node_fixture() -> None:
    assert _params(nodeenv, FIXTURES / "node-env") == [
        ("API_TOKEN", "dev-token-not-for-output", True, None, "string", "src/config.ts:5"),
        ("DEBUG", None, False, None, None, "src/config.ts:4"),
        ("HOST", "0.0.0.0", True, None, "string", "src/config.ts:3"),
        ("NODE_ENV", None, False, None, None, "src/config.ts:6"),
        ("PLAIN_NAME", None, False, None, None, "src/config.ts:17"),
        ("PORT", "3000", True, None, "int", "src/config.ts:2"),
        # Дефолт «'http://' + host» в склейке: дефолт есть, текста у него нет.
        ("URL", None, True, None, None, "src/config.ts:15"),
    ]
    ctx, files = files_of(FIXTURES / "node-env")
    hints = nodeenv.parse(files, ctx).hints
    assert [(h.data["name"], h.data["reason"]) for h in hints] == [
        ("`PREFIX_${name}`", texts.REASON_DYNAMIC_PARAM),
        ("'APP_' + name", texts.REASON_JOINED_NAME),
    ]


def test_go_fixture() -> None:
    assert _params(goenv, FIXTURES / "go-env") == [
        ("DATABASE_URL", None, False, True, None, "cmd/main.go:7"),
        ("LOG_LEVEL", None, False, None, None, "cmd/main.go:13"),
        ("OTEL_SERVICE_NAME", None, False, None, None, "cmd/main.go:26"),
        ("PORT", "8080", True, None, "int", "cmd/main.go:6"),
        ("REGION", None, False, True, None, "cmd/main.go:14"),
        ("TIMEOUT", "30s", True, None, "duration", "cmd/main.go:8"),
    ]
    ctx, files = files_of(FIXTURES / "go-env")
    hints = goenv.parse(files, ctx).hints
    # Argo CD util/trace/trace.go: «"OTEL_EXPORTER_OTLP_" + name» не параметр, а подсказка.
    # Имя идентификатором ждёт раскрытия константой и пишется в подсказки последним: порядок
    # по месту (в hints.yaml записи всё равно отсортированы).
    assert sorted(
        ((h.data["name"], h.data["reason"]) for h in hints), key=lambda r: r[0] != "key",
    ) == [
        ("key", texts.REASON_DYNAMIC_PARAM),
        ('"OTEL_EXPORTER_OTLP_" + name', texts.REASON_JOINED_NAME),
    ]


def test_go_wrappers_and_constants() -> None:
    """Обёртки чтения и имя константой (ТЗ §15 п. 14 Е1). Найдено в Argo CD:
    util/env/env.go (ParseNumFromEnv, StringFromEnv), вызов
    env.StringFromEnv(common.EnvGnuPGHome, …) и константа common/common.go:293; в Online
    Boutique src/frontend/main.go:178 mustMapEnv(&svc.collectorAddr, "COLLECTOR_SERVICE_ADDR").
    Ловушки: функция с литералом внутри (Port) — обычное чтение, не обёртка; то же имя
    StringFromEnv в пакете legacy окружение не читает; константа чужого модуля и выражение —
    подсказки; обёртка в тестовом файле main_test.go не читается."""
    assert _params(goenv, FIXTURES / "go-env-wrapper") == [
        ("PORT", None, False, None, None, "envutil/env.go:28"),
        ("SHOP_ADDR", None, False, None, None, "cmd/shop/main.go:24"),
        ("SHOP_CACHE_SIZE", "128", True, None, "int", "cmd/shop/main.go:16"),
        ("SHOP_GNUPGHOME", None, True, None, "string", "cmd/shop/main.go:15"),
        ("SHOP_GNUPGHOME", None, False, None, None, "cmd/shop/main.go:17"),
        ("SHOP_REGION", "eu", True, None, "string", "cmd/shop/main.go:13"),
        ("SHOP_WORKERS", "4", True, None, "int", "cmd/shop/main.go:14"),
    ]
    ctx, files = files_of(FIXTURES / "go-env-wrapper")
    hints = goenv.parse(files, ctx).hints
    assert sorted((h.data["name"], h.data["reason"], h.data["source"]) for h in hints) == [
        ('"SHOP_"+os.Args[0]', texts.REASON_JOINED_NAME, "cmd/shop/main.go:20"),
        ("other.EnvName", texts.REASON_DYNAMIC_PARAM, "cmd/shop/main.go:19"),
    ]
    model = model_of(FIXTURES / "go-env-wrapper")
    (owner,) = model.params
    gpg = model.params[owner]["SHOP_GNUPGHOME"]
    # Одна запись с двумя местами чтения и местом объявления константы.
    assert sorted(str(loc) for loc in gpg.locs) == [
        "cmd/shop/main.go:15", "cmd/shop/main.go:17", "common/common.go:5",
    ]
    assert "SHOP_TEST_ONLY" not in model.params[owner]
    assert "NOT_A_PARAM" not in model.params[owner]


def test_node_zod_schema() -> None:
    """Схема zod из process.env (ТЗ §15 п. 14 Е3). Найдено в immich:
    server/src/dtos/env.dto.ts:37 EnvSchema = z.object({ DB_HOSTNAME: z.string().optional(),
    … }) и server/src/repositories/config.repository.ts:209 EnvSchema.safeParse(process.env)
    в другом файле по импорту с псевдонимом src/…. Ловушки: схема тела запроса LoginSchema
    к окружению не применяется; ключ с вычисляемым именем — подсказка."""
    rows = _params(nodeenv, FIXTURES / "ts-env-zod")
    assert rows == [
        ("API_SECRET", None, False, True, "string", "src/dtos/env.dto.ts:11"),
        ("DB_HOSTNAME", None, False, None, "string", "src/dtos/env.dto.ts:7"),
        ("DB_PORT", "5432", True, None, "int", "src/dtos/env.dto.ts:8"),
        ("DB_SSL", None, False, None, "bool", "src/dtos/env.dto.ts:9"),
        ("LOG_LEVEL", "info", True, None, "string", "src/dtos/env.dto.ts:10"),
        ("SAMPLE_RATE", None, False, None, "float", "src/dtos/env.dto.ts:12"),
        ("WORKER_COUNT", "2", True, None, "int", "src/config.ts:8"),
    ]
    ctx, files = files_of(FIXTURES / "ts-env-zod")
    found = nodeenv.parse(files, ctx)
    assert [(h.data["name"], h.data["source"]) for h in found.hints] == [
        ("['DYNAMIC_' + 'KEY']", "src/dtos/env.dto.ts:13"),
    ]
    level = next(p for p in found.code_params if p.name == "LOG_LEVEL")
    assert level.description == texts.config_choices(["debug", "info", "warn"])
    assert [str(loc) for loc in level.extra_locs] == ["src/config.ts:5"]
    model = model_of(FIXTURES / "ts-env-zod")
    (owner,) = model.params
    assert model.params[owner]["LOG_LEVEL"].description == "Одно из значений: debug, info, warn."


def test_python_wrappers() -> None:
    """Обёртка чтения на Python (ТЗ §15 п. 14 Е2). Найдено в PostHog:
    posthog/settings/utils.py get_from_env(key, default=…, type_cast=…) читает os.getenv(key),
    ee/settings.py:59 get_from_env("ENFORCE_ADMIN_OAUTH2", …); импорт и через модуль-посредник
    («from posthog.settings import get_from_env»). Ловушки: функция с литералом внутри —
    обычное чтение; f-строка и склейка — подсказки; тот же параметр из os.getenv и из
    обёртки — одна запись с двумя местами; имя константой модуля раскрывается."""
    assert _params(pyenv, FIXTURES / "py-env-wrapper") == [
        ("APP_DEBUG", "false", True, None, "bool", "app/settings/utils.py:18"),
        ("CACHE_URL", "", True, None, None, "app/settings/base.py:13"),
        ("REGION", "eu", True, None, "string", "app/settings/base.py:10"),
        ("REGION", None, False, None, None, "app/settings/base.py:12"),
        ("SAMPLE_RATIO", None, False, None, "float", "app/settings/base.py:9"),
        ("SECURE_COOKIES", "false", True, None, "bool", "app/settings/base.py:8"),
        ("SITE_URL", "https://example.com", True, None, "string", "app/settings/base.py:6"),
        ("WORKERS", "4", True, None, "int", "app/settings/base.py:7"),
        ("WORKER_QUEUE", "default", True, None, "string", "app/worker.py:3"),
    ]
    ctx, files = files_of(FIXTURES / "py-env-wrapper")
    hints = pyenv.parse(files, ctx).hints
    assert sorted((h.data["name"], h.data["reason"], h.data["source"]) for h in hints) == [
        ("'SHARD_' + REGION", texts.REASON_JOINED_NAME, "app/settings/base.py:16"),
        ("f'ZONE_{REGION}'", texts.REASON_DYNAMIC_PARAM, "app/settings/base.py:15"),
    ]
    model = model_of(FIXTURES / "py-env-wrapper")
    (owner,) = model.params
    region = model.params[owner]["REGION"]
    assert sorted(str(loc) for loc in region.locs) == [
        "app/settings/base.py:10", "app/settings/base.py:12",
    ]
    assert sorted(str(loc) for loc in model.params[owner]["CACHE_URL"].locs) == [
        "app/settings/base.py:13", "app/settings/names.py:1",
    ]


COMPOSE = """services:
  api:
    build: ./api
    environment:
      LOG_LEVEL: debug
      API_KEY: ${API_KEY}
"""


def _hints(parser: object, root: Path) -> list[tuple[object, object, object]]:
    ctx, files = files_of(root)
    found = parser.parse(files, ctx)  # type: ignore[attr-defined]
    return sorted((h.data["name"], h.data["reason"], h.data["source"]) for h in found.hints)


def test_dotnet_configuration() -> None:
    """Параметры в коде C# (ТЗ §15 п. 14 Е4). Найдено в Online Boutique:
    src/cartservice/src/Startup.cs:29 Configuration["REDIS_ADDR"] и
    src/cartservice/src/cartstore/SpannerCartStore.cs:32 configuration["SPANNER_PROJECT"];
    в eShop src/WebhookClient/Endpoints/WebhookEndpoints.cs:14
    configuration["WebhookClientOptions:Token"] (ключ с двоеточием) и
    src/Identity.API/Configuration/Config.cs:84 $"{configuration["WebAppClient"]}" в
    интерполяции. Ловушки: Configuration.GetSection("Logging") — раздел, запись
    Configuration["WRITTEN_KEY"] = …, ключ в комментарии и проект тестов Cart.UnitTests/ —
    не параметры; имя выражением и склейкой — подсказки."""
    root = FIXTURES / "dotnet-env"
    assert _params(dotnetenv, root) == [
        ("CART_REGION", "eu", True, None, "string", "src/Cart/Startup.cs:17"),
        ("CART_SECRET", None, False, True, None, "src/Cart/Startup.cs:18"),
        ("Cache:TimeoutSeconds", "30", True, None, "int", "src/Cart/Startup.cs:16"),
        ("DISABLE_TRACING", None, False, None, "bool", "src/Cart/Store/RedisStore.cs:9"),
        ("PUBLIC_URL", None, False, None, None, "src/Cart/Startup.cs:19"),
        ("REDIS_ADDR", None, False, None, None, "src/Cart/Startup.cs:14"),
    ]
    assert _hints(dotnetenv, root) == [
        ('"PREFIX_" + name', texts.REASON_JOINED_NAME, "src/Cart/Store/RedisStore.cs:11"),
        ("name", texts.REASON_DYNAMIC_PARAM, "src/Cart/Store/RedisStore.cs:10"),
    ]
    model = model_of(root)
    assert sorted(str(loc) for loc in model.params["Cart"]["DISABLE_TRACING"].locs) == [
        "src/Cart/Store/Keys.cs:5", "src/Cart/Store/RedisStore.cs:9",
    ]
    assert sorted(model.params) == ["Cart"]


def test_dotnet_appsettings() -> None:
    """appsettings.json проекта (ТЗ §15 п. 16 Р1): вложенные ключи «A:B», комментарии «//» и
    «/* */», висячие запятые, метка порядка байтов в начале (как у eShop
    src/Ordering.API/appsettings.json), массив одной строкой, null без дефолта, пустой объект
    без параметров. Ловушки: appsettings.Development.json (значения сред) и appsettings.json
    проекта тестов Shop.Tests/ не читаются."""
    at = "src/Shop.Api/appsettings.json"
    assert _params(appsettings, FIXTURES / "dotnet-config") == [
        ("AllowedHosts", "*", True, None, "string", f"{at}:9"),
        ("Cache:Enabled", "true", True, None, "bool", f"{at}:18"),
        ("Cache:Prefix", None, False, None, None, f"{at}:18"),
        ("Cache:Ratio", "0.5", True, None, "float", f"{at}:18"),
        ("Cache:Ttl", "30", True, None, "int", f"{at}:18"),
        ("ConnectionStrings:db", "Host=localhost;Database=shop", True, None, "string", f"{at}:11"),
        ("EventBus:RetryCount", "5", True, None, "int", f"{at}:16"),
        ("EventBus:SubscriptionClientName", "Shop", True, None, "string", f"{at}:15"),
        ("Hosts", '["a", "b"]', True, None, "array", f"{at}:19"),
        ("Logging:LogLevel:Default", "Information", True, None, "string", f"{at}:5"),
        ("Logging:LogLevel:Microsoft.AspNetCore", "Warning", True, None, "string", f"{at}:6"),
    ]


def test_appsettings_reader() -> None:
    """Повтор ключа даёт запись по последнему (как у .NET), ошибка синтаксиса — BadJson,
    вложенность больше 50 — TooDeep; комментарий после корня допустим."""
    assert appsettings.read('{"a": 1, "a": "x"}\n// конец') == [("a", 1, "x", "string")]
    assert appsettings.read('{"a": {"b": [1, {"c": "d"}, [] ], }}') == [
        ("a:b", 1, '[1, {"c": "d"}, []]', "array"),
    ]
    for bad in ('{"a": 1', '{"a" 1}', '{"a": tru}', '["a"]', '{"a": "b\n"}', '{"a": 1} 2',
                '{"a": 1 /* без конца'):
        try:
            appsettings.read(bad)
        except appsettings.BadJson:
            continue
        raise AssertionError(bad)
    deep = '{"a": ' * 51 + "1" + "}" * 51
    try:
        appsettings.read(deep)
    except appsettings.TooDeep:
        pass
    else:
        raise AssertionError("глубина")
    assert appsettings.read('{"a": ' * 50 + "1" + "}" * 50)[0][0] == ":".join(["a"] * 50)
    assert appsettings.read('{"a": ' + "[" * 49 + "]" * 49 + "}")[0][2] == "[" * 49 + "]" * 49


# Враждебный appsettings.json вплотную к пределу 1 МБ (ТЗ §15 п. 16 Р1): тысячи ключей,
# вложенность, длинные и незакрытые строки, комментарии без конца, длинные массивы.
_NEAR = 990_000
APPSETTINGS_HOSTILE = {
    "keys": "{" + "".join(f'"k{i}": {i},' for i in range(_NEAR // 14)) + "}",
    "same-key": "{" + '"a": 1,' * (_NEAR // 7) + "}",
    "nested": '{"a": ' * (_NEAR // 6),
    "arrays": '{"a": ' + "[" * (_NEAR - 10),
    "array-items": '{"a": [' + '"x",' * (_NEAR // 4) + "]}",
    "string": '{"a": "' + "x" * _NEAR + '"}',
    "open-string": '{"a": "' + "x" * _NEAR,
    "escapes": '{"a": "' + "\\\"" * (_NEAR // 2) + '"}',
    "comments": "{" + "/* */" * (_NEAR // 5) + "}",
    "open-comments": "{" + "/*" * (_NEAR // 2),
    "line-comments": "{\n" + "//\n" * (_NEAR // 3) + "}",
    "objects-in-array": '{"a": [' + '{"b": 1},' * (_NEAR // 9) + "]}",
}


@pytest.mark.parametrize("kind", sorted(APPSETTINGS_HOSTILE))
def test_appsettings_hostile(tmp_path: Path, kind: str) -> None:
    tree(tmp_path, {
        "App/App.csproj": '<Project Sdk="Microsoft.NET.Sdk.Web"></Project>\n',
        "App/appsettings.json": APPSETTINGS_HOSTILE[kind],
    })
    ctx, files = files_of(tmp_path)
    _found, took = timed(partial(appsettings.parse, files, ctx), time_limit())
    assert took < time_limit() * 0.7, f"{took:.2f} с"


def test_appsettings_limits(tmp_path: Path) -> None:
    """Файл больше 1 МБ и вложенность глубже 50 — файл непрочитан; ошибка синтаксиса —
    файл пропущен без записей."""
    tree(tmp_path, {
        "A/A.csproj": "<Project></Project>\n", "A/appsettings.json": '{"a": "' + "x" * 1_000_001 + '"}',
        "B/B.csproj": "<Project></Project>\n", "B/appsettings.json": '{"a": ' * 60 + "1" + "}" * 60,
        "C/C.csproj": "<Project></Project>\n", "C/appsettings.json": '{"a": 1,, }',
        "D/D.csproj": "<Project></Project>\n", "D/appsettings.json": '{"d": 1}',
        # Файл не в каталоге проекта: не читается.
        "E/appsettings.json": '{"e": 1}',
    })
    ctx, files = files_of(tmp_path)
    found = appsettings.parse(files, ctx)
    assert [p.name for p in found.code_params] == ["d"]
    assert sorted(files.too_large) == ["A/appsettings.json", "B/appsettings.json"]


def test_dotnet_binder() -> None:
    """Чтения через биндер конфигурации (ТЗ §15 п. 16 Р1): GetValue<T> с дефолтом и без,
    GetConnectionString, раздел с .Get<T>(), Configure<T>(раздел константой), AddOptions<T>()
    .BindConfiguration(nameof(T)), переменная раздела перед GetValue и GetSection, .Bind(obj)
    по объявлению obj. Свойства класса проекта: set и init, required, инициализатор-литерал;
    static, свойство без set и свойство вложенного класса не параметры, класс того же имени
    в другом проекте (Shared/) не берётся. Класса нет — один параметр раздела с типом как
    написан; имя раздела переменной — подсказка. Ловушки: GetSection("Logging") без привязки,
    чтение в комментарии и в проекте тестов."""
    at = "src/Shop.Api/Program.cs"
    opts = "src/Shop.Api/Options"
    assert _params(dotnetenv, FIXTURES / "dotnet-config") == [
        ("Cache:Ttl", "60", True, None, "int", f"{at}:2"),
        ("Catalog:PicBaseUrl", None, False, None, "string", f"{at}:6"),
        ("Catalog:Timeout", None, True, None, "duration", f"{at}:6"),
        ("Catalog:UseCustomizationData", None, False, None, "bool", f"{at}:6"),
        ("ConnectionStrings:db", None, False, None, "string", f"{at}:4"),
        ("EventBus:Exchange", None, False, True, "string", f"{at}:5"),
        ("EventBus:RetryCount", "10", True, None, "int", f"{at}:5"),
        ("EventBus:SubscriptionClientName", None, False, None, "string", f"{at}:5"),
        ("Identity:Audience", None, False, None, "string", f"{at}:10"),
        ("Identity:Auth:Authority", "https://identity", True, None, "string", f"{at}:12"),
        ("Identity:Auth:Scopes", None, True, None, "array", f"{at}:12"),
        ("Missing", None, False, None, "MissingOptions", f"{at}:14"),
        ("PaymentOptions:PaymentSucceeded", "true", True, None, "bool", f"{at}:7"),
        ("Region", None, False, None, "string", f"{at}:3"),
    ]
    assert _hints(dotnetenv, FIXTURES / "dotnet-config") == [
        ("sectionName", texts.REASON_DYNAMIC_PARAM, f"{at}:15"),
    ]
    ctx, files = files_of(FIXTURES / "dotnet-config")
    found = dotnetenv.parse(files, ctx)
    extra = {p.name: sorted(str(loc) for loc in p.extra_locs) for p in found.code_params}
    assert extra["EventBus:RetryCount"] == [
        f"{opts}/EventBusOptions.cs:6", f"{opts}/SectionNames.cs:5",
    ]
    assert extra["Catalog:Timeout"] == [f"{opts}/Settings.cs:7"]


def test_dotnet_appsettings_merge() -> None:
    """Запись файла и чтение в коде одного ключа — один параметр (ТЗ §15 п. 16 Р1): дефолт
    из файла (Cache:Ttl 30, а не 60 из GetValue), тип из кода; места из обоих. Адрес из
    свойства (https://identity) дефолтом не пишется, как у примеров окружения."""
    model = model_of(FIXTURES / "dotnet-config")
    assert sorted(model.params) == ["Shop.Api"]
    params = model.params["Shop.Api"]
    ttl = params["Cache:Ttl"]
    assert (ttl.default, ttl.type) == ("30", "int")
    assert sorted(str(loc) for loc in ttl.locs) == [
        "src/Shop.Api/Program.cs:2", "src/Shop.Api/appsettings.json:18",
    ]
    retry = params["EventBus:RetryCount"]
    assert (retry.default, retry.type) == ("5", "int")
    assert params["EventBus:Exchange"].required is True
    assert params["Identity:Auth:Authority"].default is None
    assert len(params) == 21


def test_java_getenv() -> None:
    """Параметры в коде Java (ТЗ §15 п. 14 Е4). Найдено в Online Boutique:
    src/adservice/src/main/java/hipstershop/AdService.java:54
    Integer.parseInt(System.getenv().getOrDefault("PORT", "9555")) и :196
    System.getenv("DISABLE_STATS"); в Keycloak
    services/src/main/java/org/keycloak/services/resources/account/AccountConsole.java:210
    System.getenv(ViteManifest.ACCOUNT_VITE_URL) — имя константой другого класса.
    Ловушки: System.getProperty("ads.profile") — свойство JVM; System.getenv() целиком,
    комментарий, src/test/ и каталог integration-tests/ — не параметры; Env.REGION из
    shop.legacy не выбирается: импорт ведёт в shop.ads.util."""
    root = FIXTURES / "java-env"
    src = "ads/src/main/java/shop/ads/AdService.java"
    assert _params(javaenv, root) == [
        ("ADS_ENABLED", None, False, None, None, f"{src}:22"),
        ("ADS_REGION", None, False, None, None, f"{src}:18"),
        ("DISABLE_STATS", None, False, None, None, f"{src}:12"),
        ("DISABLE_TRACING", None, False, None, None, f"{src}:15"),
        ("PORT", "9555", True, None, "int", f"{src}:11"),
    ]
    assert _hints(javaenv, root) == [
        ('"ADS_" + profile', texts.REASON_JOINED_NAME, f"{src}:21"),
        ("args[0]", texts.REASON_DYNAMIC_PARAM, f"{src}:20"),
    ]
    model = model_of(root)
    assert sorted(str(loc) for loc in model.params["ads"]["ADS_REGION"].locs) == [
        f"{src}:18", "ads/src/main/java/shop/ads/util/Env.java:4",
    ]
    assert sorted(str(loc) for loc in model.params["ads"]["DISABLE_TRACING"].locs) == [
        f"{src}:15", "ads/src/main/java/shop/ads/Names.java:4",
    ]


def test_rust_env() -> None:
    """Параметры в коде Rust (ТЗ §15 п. 14 И2). Найдено в PostHog
    rust/capture/src/config.rs:306 `#[envconfig(from = "KAFKA_REPLAY_ENVELOPE_COMPRESSION",
    default = "none")]` и поля без from; в Lemmy crates/server/src/lib.rs:95 `#[arg(long,
    default_value_t = false, env = "LEMMY_DISABLE_ACTIVITY_SENDING")]` и
    crates/utils/src/settings/mod.rs:39 `env::var("LEMMY_CONFIG_LOCATION")`. Ловушки:
    структура с derive(Envconfig) без полей; nested = true; атрибут serde между envconfig
    и полем; env::var(&name) — подсказка; env!("CARGO_PKG_VERSION") не параметр и не
    подсказка, option_env! — переменная времени сборки; время жизни 'static маску не
    рвёт; комментарий и модуль #[cfg(test)] не читаются."""
    root = FIXTURES / "rust-env"
    config, main = "server/src/config.rs", "server/src/main.rs"
    assert _params(rustenv, root) == [
        ("CONFIG_PATH", "config.hjson", True, False, "string", f"{main}:16"),
        ("DATABASE_URL", None, False, True, "string", f"{config}:19"),
        ("DISABLE_HTTP", "false", True, False, "bool", f"{main}:5"),
        ("KAFKA_HOSTS", "kafka:9092", True, False, "string", f"{config}:8"),
        ("LOG_LEVEL", "info", True, False, "string", f"{main}:7"),
        ("PORT", "3000", True, False, "int", f"{config}:11"),
        ("REDIS_URL", None, False, False, "string", f"{config}:15"),
        ("SERVICE_URL", None, False, True, None, f"{main}:17"),
    ]
    assert _hints(rustenv, root) == [
        ("&name", texts.REASON_DYNAMIC_PARAM, f"{main}:19"),
        ("CI_PIPELINE", texts.REASON_BUILD_VARIABLE, f"{main}:20"),
    ]
    model = model_of(root)
    assert sorted(model.params["server"]) == [
        "CONFIG_PATH", "DATABASE_URL", "DISABLE_HTTP", "KAFKA_HOSTS", "LOG_LEVEL", "PORT",
        "REDIS_URL", "SERVICE_URL",
    ]
    # Основания: строка атрибута и строка поля.
    assert sorted(str(loc) for loc in model.params["server"]["REDIS_URL"].locs) == [
        f"{config}:15", f"{config}:17",
    ]


def test_merge_with_manifest_params(tmp_path: Path) -> None:
    tree(tmp_path, {
        # Второй контейнер: при единственном общий код достался бы ему (owners.sole_owner).
        "docker-compose.yml": COMPOSE + "  worker:\n    build: ./worker\n",
        "worker/requirements.txt": "celery\n",
        "api/requirements.txt": "fastapi\n",
        "api/.env.example": "TIMEOUT=10s\n",
        "api/app.py": "import os\n"
        'LOG_LEVEL = os.getenv("LOG_LEVEL", "info")\n'
        'API_KEY = os.getenv("API_KEY", "sk_live_in_code_123456")\n'
        'TIMEOUT = os.getenv("TIMEOUT", "30s")\n'
        'TOKEN = os.environ["TOKEN"]\n'
        'MAYBE = os.environ["MAYBE"]\n'
        'MAYBE2 = os.getenv("MAYBE", "x")\n',
        "lib/requirements.txt": "requests\n",
        "lib/shared.py": 'import os\nX = os.getenv("SHARED_ONLY")\nY = os.getenv("SHARED_ONLY")\n',
    })
    model = model_of(tmp_path)
    params = model.params["api"]
    # Дефолт из кода дополняет манифест, а пример окружения старше кода.
    assert params["LOG_LEVEL"].default == "info"
    assert params["TIMEOUT"].default == "10s" and params["TIMEOUT"].type == "duration"
    # Секрет: дефолт из кода не пишется, но место чтения в основаниях.
    assert params["API_KEY"].default is None
    assert any(loc.path == "api/app.py" for loc in params["API_KEY"].locs)
    assert params["TOKEN"].required is True
    # Где-то читается с дефолтом: параметр не обязательный.
    assert params["MAYBE"].required is None
    assert sorted(params["LOG_LEVEL"].parsers) == ["compose", "python-env"]
    assert [h for h in model.hints["unassigned"] if h["kind"] == "config"] == [{
        "kind": "config", "name": "SHARED_ONLY", "reason": texts.REASON_SHARED_LIB,
        "source": "lib/shared.py:2",
    }]


def test_owner_of_other_language_does_not_take_file() -> None:
    """Браузерный NODE_ENV в каталоге процессов Ruby не их параметр: в подсказки с причиной
    «нет контейнера на этом языке». Код Node.js в своём каталоге остаётся параметром
    потокового сервера (ТЗ §15 п. 10 А5)."""
    model = model_of(FIXTURES / "compose-lang")
    languages = {o.name: o.language for o in model.objects}
    assert languages == {"web": "Ruby", "sidekiq": "Ruby", "streaming": "Node.js"}
    assert {k: sorted(v) for k, v in model.params.items()} == {"streaming": ["STREAMING_PORT"]}
    hints = [(h["name"], h["reason"], h["source"]) for h in model.hints["unassigned"]]
    assert hints == [
        ("NODE_ENV", texts.REASON_OTHER_LANGUAGE, "app/javascript/environment.ts:2"),
    ]


_GO_MAIN = 'package main\n\nimport "os"\n\nfunc main() {\n\t_ = os.Getenv("%s")\n}\n'
_GO_BASE = {"go.mod": "module example.com/x\n\ngo 1.23\n", "Dockerfile": "FROM golang:1.23\n"}


def _go_cmd_model(tmp_path: Path, compose: str, programs: dict[str, str]) -> dict[str, set[str]]:
    files: dict[str, str | bytes] = {**_GO_BASE, "docker-compose.yml": compose}
    files.update({f"cmd/{name}/main.go": _GO_MAIN % var for name, var in programs.items()})
    model = model_of(tree(tmp_path, files))
    return {owner: set(params) for owner, params in model.params.items()}


def test_go_cmd_programs(tmp_path: Path) -> None:
    """Каталог cmd/<имя>/ принадлежит контейнеру этой программы (ТЗ §15 п. 14 Ф1). Найдено в
    Argo CD: шесть контейнеров Go из одного корня, а
    cmd/argocd-application-controller/commands/argocd_application_controller.go:292
    (ARGOCD_APPLICATION_CONTROLLER_LOGLEVEL) записывался всем шести как общий код. Контейнер
    программы по имени (worker) или по программе команды (/usr/local/bin/api); маршрут из
    cmd/api тоже только у api. Ловушки: программа cmd/migrate без контейнера уходит в
    подсказки, общий код internal/ остаётся у обоих; (а) одна программа cmd/server у
    контейнера app с командой ./server — как раньше; (б) app без команды и cmd/app, cmd/tool
    — cmd/tool в подсказки; (в) контейнеры x и y без команд и cmd/a, cmd/b — правило не
    включается, общий код у обоих."""
    model = model_of(FIXTURES / "go-cmd-dirs")
    params = {owner: set(p) for owner, p in model.params.items()}
    assert params == {
        "api": {"API_PORT", "SHARED_LOG_LEVEL"}, "worker": {"WORKER_QUEUE", "SHARED_LOG_LEVEL"},
    }
    assert [(e.method, e.path) for e in model.http["api"]] == [("ANY", "/health")]
    assert "worker" not in model.http or not model.http["worker"]
    assert [
        (h["name"], h["reason"], h["source"]) for h in model.hints["unassigned"]
        if h["kind"] == "config"
    ] == [("MIGRATE_DSN", texts.no_program_container("cmd/migrate"), "cmd/migrate/main.go:7")]

    one = "services:\n  app:\n    build: .\n    command: ./server\n"
    assert _go_cmd_model(tmp_path / "a", one, {"server": "SERVER_PORT"}) == {
        "app": {"SERVER_PORT"},
    }
    bare = "services:\n  app:\n    build: .\n"
    assert _go_cmd_model(tmp_path / "b", bare, {"app": "APP_PORT", "tool": "TOOL_TOKEN"}) == {
        "app": {"APP_PORT"},
    }
    two = "services:\n  x:\n    build: .\n  y:\n    build: .\n"
    assert _go_cmd_model(tmp_path / "c", two, {"a": "A_PORT", "b": "B_PORT"}) == {
        "x": {"A_PORT", "B_PORT"}, "y": {"A_PORT", "B_PORT"},
    }


def test_go_cmd_near_names(tmp_path: Path) -> None:
    """Программа cmd/<имя> и программа команды почти совпадают (ТЗ §15 п. 15 Н3). Найдено в
    Argo CD: cmd/argocd-notification при команде /usr/local/bin/argocd-notifications, восемь
    параметров уходили в подсказки. Совпадают конечная «s» у одного из имён (cmd/app и apps)
    и хвост -controller или -server у команды при том же хвосте имени контейнера (cmd/events
    и events-controller). Ловушки: cmd/app и application не совпадают; хвост -server у
    команды контейнера web без такого хвоста не действует; при своей программе cmd/apps
    команда apps не достаётся cmd/app."""
    near = (
        "services:\n  a:\n    build: .\n    command: /usr/local/bin/apps\n"
        "  b:\n    build: .\n    command: /usr/local/bin/application\n"
        "  events-controller:\n    build: .\n    command: /usr/local/bin/events-controller\n"
        "  web:\n    build: .\n    command: /usr/local/bin/feed-server\n"
    )
    programs = {"app": "APP_PORT", "events": "EVENTS_PORT", "feed": "FEED_PORT"}
    assert _go_cmd_model(tmp_path / "a", near, programs) == {
        "a": {"APP_PORT"}, "events-controller": {"EVENTS_PORT"},
    }
    own = "services:\n  a:\n    build: .\n    command: /usr/local/bin/apps\n"
    assert _go_cmd_model(tmp_path / "b", own, {"app": "APP_PORT", "apps": "APPS_PORT"}) == {
        "a": {"APPS_PORT"},
    }


def test_go_named_reads_limit(tmp_path: Path) -> None:
    """Предел чтений с именем не литералом на файл (ТЗ §15 п. 14 Ф2). Найдено в полном гейте
    судьи: враждебный файл tests/test_code_hostile.py GO_PACKAGE["named-reads"] из 133 тыс.
    os.Getenv(c.X) шёл 1,00 с при пределе 1,00 с. Файл сверх 2000 таких чтений непрочитан и
    не даёт ни параметров, ни подсказок, даже литеральных и найденных до предела. Ловушки:
    файл ровно на пределе разбирается целиком; соседний файл того же пакета не задет; одна
    константа раскрывается у всех мест чтения."""
    limit = clike.MAX_READS
    head = 'package app\n\nimport "os"\n\nconst Port = "APP_PORT"\n\nfunc f() {\n'
    root = tree(tmp_path, {
        "go.mod": "module example.com/app\n\ngo 1.23\n",
        "over.go": 'package app\n\nimport "os"\n\nfunc g() {\n\t_ = os.Getenv("OVER_LITERAL")\n'
        + "\t_ = os.Getenv(name)\n" * (limit + 1) + "}\n",
        "edge.go": head + "\t_ = os.Getenv(Port)\n" * limit + "}\n",
        "plain.go": 'package app\n\nimport "os"\n\nvar _ = os.Getenv("PLAIN")\n',
    })
    ctx, files = files_of(root)
    found = goenv.parse(files, ctx)
    names = {(p.name, p.loc.path) for p in found.code_params}
    assert names == {("APP_PORT", "edge.go"), ("PLAIN", "plain.go")}
    assert sum(1 for p in found.code_params if p.name == "APP_PORT") == limit
    assert not [h for h in found.hints if str(h.data["source"]).startswith("over.go")]
    assert files.too_large == {"over.go"}
