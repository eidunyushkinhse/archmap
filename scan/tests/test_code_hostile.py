"""Враждебный вход для яруса кода (ТЗ §9): строка в 2 МБ, правдоподобное начало перед ней
и глубокая вложенность в файле кода каждого языка. Каждый разборщик кода укладывается в
секунду и не падает. Манифесты дают все стеки сразу, чтобы разборщики файлы читали."""

from __future__ import annotations

import time
from pathlib import Path

import pytest

from archmap_scan import registry
from tests.helpers import files_of, time_limit, tree

PAYLOAD = 2_000_000
A = "a" * PAYLOAD

MANIFESTS: dict[str, str | bytes] = {
    "py/requirements.txt": "fastapi\nflask\ndjango\ncelery\nkafka-python\npika\nnats-py\n",
    "js/package.json": (
        '{"dependencies": {"express": "*", "@nestjs/core": "*", "kafkajs": "*", "amqplib": "*",'
        ' "nats": "*", "bullmq": "*"}}'
    ),
    "rb/Gemfile": 'gem "sidekiq"\n',
    "go/go.mod": (
        "module x\n\nrequire (\n\tgithub.com/gin-gonic/gin v1.0.0\n"
        "\tgithub.com/segmentio/kafka-go v0.4.0\n\tgithub.com/nats-io/nats.go v1.0.0\n)\n"
    ),
    "cs/app.csproj": '<Project Sdk="Microsoft.NET.Sdk.Web"></Project>\n',
    "java/pom.xml": "<project><artifactId>x</artifactId></project>\n",
    "rs/Cargo.toml": '[package]\nname = "x"\n',
}

# Подключение клиента: без него разборщики каналов JS и Go файл не читают.
KJS, AMQP, NJS = "require('kafkajs');\n", "require('amqplib');\n", "require('nats');\n"
BMQ = "require('bullmq');\n"
KGO, NGO = 'import "github.com/segmentio/kafka-go"\n', 'import "github.com/nats-io/nats.go"\n'

# Схема zod применяется к окружению (ТЗ §15 п. 14 Е3).
ZOD = "E.safeParse(process.env);\n"
# Обёртка чтения окружения Go: строковый параметр уходит в os.Getenv (ТЗ §15 п. 14 Е1).
GO_WRAP = "func w(k string) string {\n\treturn os.Getenv(k)\n}\n"

# Начала строк, после которых разборщик доходит до содержимого: имя файла → начала.
STARTS: dict[str, tuple[str, ...]] = {
    "py/app.py": (
        '@app.get("', "@app.route('", "@", "@a.", 'app.include_router(r, prefix="',
        'r = APIRouter(prefix="', 'urlpatterns = [path("', 'ROOT_URLCONF = "',
        "urlpatterns = [path('', include('", 'os.getenv("', 'os.environ["',
        "class S(BaseSettings):\n    x: int = ", '@app.task(queue="', "import kafka\np.send(\"",
        "import pika\nch.queue_declare(queue='", "import nats\nnc.subscribe('",
        "app.conf.task_routes = {'a': {'queue': '",
        "app.conf.beat_schedule = {'", "CELERYBEAT_SCHEDULE = {'a': {'schedule': '",
        "@periodic_task(run_every=", "app.add_periodic_task(1, '",
        # Реестры каналов и декоратор потребителя (pyregistry.py).
        "class Topic(Enum):\n    A = '", "KAFKA_TOPICS = {'", "TOPICS: dict[str, str] = {'",
        "@assign_queue('", "@assign_queue(", "@a.b.queue_", "class Queue:\n    X = '",
        "import kafka\nfrom t import Topic\np.send(Topic.",
        # Обёртка регистрации маршрутов Django в том же модуле (ТЗ §15 п. 1).
        "def w(r, **h):\n    return path(r, v, h)\nurlpatterns = [w('",
        # Обёртка чтения окружения и имя константой (ТЗ §15 п. 14 Е2).
        "import os\ndef w(k, default=None):\n    return os.getenv(k)\nX = w('",
        "import os\ndef w(k):\n    return os.environ[k]\nX = w(K, '", "K = '",
    ),
    "js/app.js": (
        "app.get('", "app.get(`", "router.route('", "@Controller(", "@Get('", "@Controller({",
        "const app = express(", "app.use('", "app.use(", "/*", "'", "`", "\\", ".",
        "app.get(", "app.setGlobalPrefix(", "process.env.", "process.env['",
        "process.env.X || '", "process.env[", KJS + "producer.send({ topic: '",
        KJS + "consumer.subscribe({ topics: ['", KJS + "producer.send({", AMQP + "ch.assertQueue('",
        AMQP + "ch.publish('', '", NJS + "nc.subscribe('",
        # Очереди BullMQ и реестр enum (ТЗ §15 п. 13 В2).
        BMQ + "new Worker('", BMQ + "new Queue(QueueName.", BMQ + "@Processor({ name: '",
        BMQ + "BullModule.registerQueue({ name: '", BMQ + "BullModule.registerQueue({",
        "enum QueueName {\n  A = '", "enum QueueName {\n  ",
        # Схема zod, применённая к окружению (ТЗ §15 п. 14 Е3).
        ZOD + "const E = z.object({", ZOD + "const E = z.object({ A: ",
        ZOD + "const E = z.object({ A: z.enum([", ZOD + "const E = z.object({ A: v, ",
        ZOD + "const v = z.string()\nconst E = z.object({ A: v.default(",
    ),
    # Классы воркеров Sidekiq и их наследники (ТЗ §15 п. 13 В3).
    "rb/app.rb": (
        "class A\n  include Sidekiq::Worker\n  sidekiq_options queue: '",
        "class A\n  include Sidekiq::Worker\n  sidekiq_options queue: ",
        "class A\n  include Sidekiq::Worker\nend\nclass B < A", "class A < ",
        "include Sidekiq::Worker\n", "class ",
    ),
    "go/main.go": (
        'r.GET("', 'http.HandleFunc("', 'v1 := r.Group("', 'r.Route("/x", func(r chi.Router) {',
        'r.HandleFunc("/p", h).Methods(', "r.GET(", "x := gin.Default(", "`", "{",
        'r.Handle("GET", ', 'os.Getenv("', "type C struct {\n\tA string `env:\"",
        "os.LookupEnv(", KGO + 'w := kafka.Writer{Topic: "', KGO + 'g.Consume(ctx, []string{"',
        NGO + 'nc.Subscribe("', KGO + "Topics: []string{",
        # Путь в обёртке на известном получателе (ТЗ §15 п. 2).
        'x := gin.Default()\nx.GET(toPath("', "x := gin.Default()\nx.GET(toPath(",
        "x := gin.Default()\nx.GET(toPath(`",
        # Функция регистрации с параметром-маршрутизатором и её вызовы (ТЗ §15 п. 3).
        'func reg(r chi.Router) {\n\tr.Get("/x", h)\n}\nreg(', "func (s *S) reg(r chi.Router",
        'func reg(r chi.Router) {\n\tr.Get("/x", h)\n}\nfunc main() {\n\treg(' + "reg(" * 9,
        # Обёртка чтения окружения, её вызовы и имя константой (ТЗ §15 п. 14 Е1).
        GO_WRAP + 'func main() {\n\tw("', GO_WRAP + "func main() {\n\tw(", 'const (\n\tA = "',
        "const A = `", 'os.Getenv(A)\nconst A = "', "os.Getenv(c.", "os.Getenv(",
    ),
    # Параметры C#: индексатор конфигурации, окружение, интерполяция, константы (ТЗ §15 п. 14 Е4).
    "cs/App.cs": (
        "Configuration[", 'Configuration["', 'configuration[$"{', '$"{configuration["', '$"{',
        '$"{"', '@"', '"""', 'Environment.GetEnvironmentVariable("',
        "Environment.GetEnvironmentVariable(", 'const string A = "', "x.Configuration[A] ?? ",
        'bool.TryParse(Configuration["X"] ?? "', "Configuration[Keys.",
    ),
    # Параметры Java: System.getenv, карта окружения, константы и импорты (ТЗ §15 п. 14 Е4).
    "java/App.java": (
        "System.getenv(", 'System.getenv("', 'System.getenv().getOrDefault("X", "',
        "System.getenv().get(", 'static final String A = "', "import static a.b.",
        "Integer.parseInt(System.getenv(", '"""', "System.getenv(Env.",
    ),
}

# Параметры Rust (ТЗ §15 п. 14 И2): атрибуты envconfig и clap, env::var, макросы, тесты.
STARTS["rs/main.rs"] = (
    "#[envconfig(", '#[envconfig(from = "', "#[envconfig(default = 1)]\n", "#[arg(env = ",
    "#[arg(env)]\n#[serde(", 'std::env::var("', "env::var(", 'env!("', "#[cfg(test)]\nmod t {",
    "r#\"", "'", 'env::var("X").unwrap_or("',
)
# DDL в шаблонах миграций (ТЗ §15 п. 14 З2): шаблон, вставка, откат, sql.raw.
STARTS["js/migrations/1-a.ts"] = (
    "sql`", "sql`CREATE TABLE t (", "sql`CREATE TABLE ${", "sql`CREATE TABLE t AS SELECT ",
    "sql<", "sql.raw(`", "function down(", "export async function down(db) {", "down = (",
    "down(db) {",
)

CASES = [(name, start) for name, starts in STARTS.items() for start in starts]


def _check(root: Path) -> None:
    ctx, files = files_of(root)
    for spec in registry.PARSERS:
        if not spec.code:
            continue
        started = time.perf_counter()
        spec.parse(files, ctx)
        took = time.perf_counter() - started
        assert took < time_limit(), f"{spec.name}: {took:.2f} с"


@pytest.mark.parametrize(("name", "start"), CASES)
def test_prefixed_line(tmp_path: Path, name: str, start: str) -> None:
    _check(tree(tmp_path, {**MANIFESTS, name: start + A + "\n"}))


@pytest.mark.parametrize("kind", ["line", "nested", "repeated"])
def test_whole_file(tmp_path: Path, kind: str) -> None:
    files: dict[str, str | bytes] = dict(MANIFESTS)
    for name, starts in STARTS.items():
        if kind == "line":
            files[name] = A
        elif kind == "nested":
            files[name] = "(" * (PAYLOAD // 2)
        else:  # одно и то же начало много раз подряд в одной строке
            unit = starts[0]
            files[name] = unit * (PAYLOAD // len(unit))
    _check(tree(tmp_path, files))


# Синтаксически верный код с литералом в 2 МБ: разбор доходит до ast и до вывода.
VALID: dict[str, str] = {
    "py/app.py": '@app.get("/' + A + '")\ndef f():\n    return 1\n',
    "js/app.js": "const app = express();\napp.get('/" + A + "', h);\n",
    "go/main.go": 'package main\nfunc main() {\n\tr := gin.Default()\n\tr.GET("/' + A + '", h)\n}\n',
    "cs/App.cs": 'class A {\n  void F() {\n    var x = Configuration["' + A + '"];\n  }\n}\n',
    "java/App.java": 'class A {\n  String x = System.getenv("' + A + '");\n}\n',
    "rs/main.rs": 'fn main() {\n    let x = std::env::var("' + A + '").unwrap();\n}\n',
}


@pytest.mark.parametrize("name", sorted(VALID))
def test_valid_code_with_huge_literal(tmp_path: Path, name: str) -> None:
    _check(tree(tmp_path, {**MANIFESTS, name: VALID[name]}))


# Второй проход разборщика Go по пакету (ТЗ §15 п. 3): функция регистрации с
# параметром-маршрутизатором и враждебный остаток файла. Окна скобок списков и тел не
# перекрываются, вызовы и их аргументы ограничены: время линейно по размеру файла.
GO_REG = 'package x\nfunc reg(r chi.Router) {\n\tr.Get("/x", h)\n}\nfunc main() {\n'
GO_PACKAGE = {
    "calls": "reg(" * (PAYLOAD // 4),
    "member-calls": "a.reg(g)\n" * (PAYLOAD // 9),
    "definitions": "func (s *S) reg(" * (PAYLOAD // 16),
    "bodies": "func f() {\n" * (PAYLOAD // 11),
    # Вызовы обёртки, чтения по константе и длинный блок констант (ТЗ §15 п. 14 Е1).
    "wrapper-calls": "}\n" + GO_WRAP + 'w("X")\n' * (PAYLOAD // 7),
    "named-reads": "os.Getenv(c.X)\n" * (PAYLOAD // 15),
    "const-block": "const (\n" + '\tA = "x"\n' * (PAYLOAD // 9) + ")\nos.Getenv(A)\n",
}
# Схема zod с множеством ключей и констант-валидаторов (ТЗ §15 п. 14 Е3).
JS_ZOD = {
    "keys": ZOD + "const E = z.object({" + "a: z.string().optional(), " * (PAYLOAD // 26) + "})",
    "locals": ZOD + "".join(f"const v{i} = z.string()\n" for i in range(300)) + "const E = z.object({"
    + "".join(f"k{i}: v{i % 300}, " for i in range(PAYLOAD // 20)) + "})",
}


# C# и Java (ТЗ §15 п. 14 Е4): много констант и чтений по ним, подстановки интерполяции,
# которые не закрываются, чтения по имени класса, которого в репозитории нет.
CLIKE = {
    "java/App.java:constants": 'static final String A = "x";\n' * (PAYLOAD // 28)
    + "System.getenv(A);\n" * 1000,
    "java/App.java:class-reads": "System.getenv(Env.A);\n" * 1999,
    "java/App.java:static-imports": "import static a.b.C.*;\n" * (PAYLOAD // 23)
    + "System.getenv(A);\n" * 1000,
    "cs/App.cs:holes": '$"' + '{"a"' * (PAYLOAD // 4),
    "cs/App.cs:verbatim": '@"' + '""' * (PAYLOAD // 2),
    "cs/App.cs:coalesce": 'Configuration["A"] ?? ' * 1999,
}


# Миграции с шаблонами sql (ТЗ §15 п. 14 З2): тысячи шаблонов и инструкций, вставки без
# конца, вложенные и закрытые откаты, длинный список SELECT в CREATE TABLE … AS.
KYSELY = {
    "templates": "sql`CREATE TABLE t (a int)`;\n" * (PAYLOAD // 30),
    "statements": "sql`" + "ALTER TABLE t ADD c int;" * (PAYLOAD // 24) + "`",
    "holes": "sql`CREATE TABLE " + "${" * (PAYLOAD // 2) + "`",
    "closed-holes": "sql`CREATE TABLE t (" + "a ${b}, " * (PAYLOAD // 9) + ")`",
    "downs": "function down(db) {" * (PAYLOAD // 19),
    "closed-downs": "function down() {}\nsql`CREATE TABLE t (a int)`;\n" * (PAYLOAD // 50),
    "unclosed-params": "function down(" * (PAYLOAD // 14),
    "ctas": "sql`CREATE TABLE t AS SELECT " + "a.b AS c, " * 25_000 + "(" * 1000 + "`",
}


# Rust: тысячи атрибутов, сплошные атрибуты без поля, модули тестов, время жизни.
RUST = {
    "attributes": '#[envconfig(from = "A", default = "1")]\npub a: u16,\n' * 1999,
    "attr-chain": "#[envconfig(default = 1)]" + "#[a]" * (PAYLOAD // 4),
    "open-attr": "#[envconfig(" + "(" * (PAYLOAD // 2),
    "test-modules": "#[cfg(test)]\nmod t {\n" * (PAYLOAD // 20),
    "lifetimes": "fn f<'a>(x: &'a str) " * (PAYLOAD // 20),
    "reads": 'std::env::var("A").unwrap_or_else(|_| "b".into());\n' * 1999,
}


@pytest.mark.parametrize("kind", sorted(RUST))
def test_rust_config(tmp_path: Path, kind: str) -> None:
    _check(tree(tmp_path, {**MANIFESTS, "rs/main.rs": RUST[kind]}))


@pytest.mark.parametrize("kind", sorted(KYSELY))
def test_kysely_migrations(tmp_path: Path, kind: str) -> None:
    _check(tree(tmp_path, {**MANIFESTS, "js/migrations/1-a.ts": KYSELY[kind]}))


@pytest.mark.parametrize("kind", sorted(CLIKE))
def test_clike_config(tmp_path: Path, kind: str) -> None:
    name = kind.split(":")[0]
    _check(tree(tmp_path, {**MANIFESTS, name: CLIKE[kind]}))


@pytest.mark.parametrize("kind", sorted(JS_ZOD))
def test_zod_schema(tmp_path: Path, kind: str) -> None:
    _check(tree(tmp_path, {**MANIFESTS, "js/app.js": JS_ZOD[kind]}))


@pytest.mark.parametrize("kind", sorted(GO_PACKAGE))
def test_go_package_pass(tmp_path: Path, kind: str) -> None:
    _check(tree(tmp_path, {**MANIFESTS, "go/main.go": GO_REG + GO_PACKAGE[kind]}))
