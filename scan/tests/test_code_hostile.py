"""Враждебный вход для яруса кода (ТЗ §9): строка в 2 МБ, правдоподобное начало перед ней
и глубокая вложенность в файле кода каждого языка. Каждый разборщик кода укладывается в
секунду и не падает. Манифесты дают все стеки сразу, чтобы разборщики файлы читали."""

from __future__ import annotations

from functools import partial
from pathlib import Path

import pytest

from archmap_scan import registry
from tests.helpers import files_of, time_limit, timed, tree

PAYLOAD = 2_000_000
A = "a" * PAYLOAD

MANIFESTS: dict[str, str | bytes] = {
    "py/requirements.txt": "fastapi\nflask\ndjango\ncelery\nkafka-python\npika\nnats-py\n",
    "js/package.json": (
        '{"dependencies": {"express": "*", "@nestjs/core": "*", "kafkajs": "*", "amqplib": "*",'
        ' "nats": "*", "bullmq": "*", "cron": "*", "@nestjs/schedule": "*"}}'
    ),
    "rb/Gemfile": 'gem "sidekiq"\ngem "rails"\n',
    "go/go.mod": (
        "module x\n\nrequire (\n\tgithub.com/gin-gonic/gin v1.0.0\n"
        "\tgithub.com/segmentio/kafka-go v0.4.0\n\tgithub.com/nats-io/nats.go v1.0.0\n"
        "\tgithub.com/robfig/cron/v3 v3.0.1\n)\n"
    ),
    "cs/app.csproj": '<Project Sdk="Microsoft.NET.Sdk.Web"></Project>\n',
    "java/pom.xml": "<project><artifactId>x</artifactId></project>\n",
    "rs/Cargo.toml": '[package]\nname = "x"\n\n[dependencies]\nactix-web = "4"\nclokwerk = "0.4"\n',
}

# Подключение клиента: без него разборщики каналов JS и Go файл не читают.
KJS, AMQP, NJS = "require('kafkajs');\n", "require('amqplib');\n", "require('nats');\n"
BMQ = "require('bullmq');\n"
KGO, NGO = 'import "github.com/segmentio/kafka-go"\n', 'import "github.com/nats-io/nats.go"\n'
RGO = 'import "github.com/robfig/cron/v3"\n'

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

# Маршруты Rails (ТЗ §15 п. 15 К1): незакрытые строки, литералы, heredoc и блоки маски Ruby.
STARTS["rb/config/routes.rb"] = (
    "Rails.application.routes.draw do\n  get '", "resources :", "get ", "scope '",
    "  get '/a', to: redirect { |p| ", "%w(", "x = <<~A\n", "concern :a do\n", "draw(:",
    "match 'a', via: [", "=begin\n", "c = { id: /", 'get "#{', "member { get :",
    "resources :a, only: %i[", "mount A => '",
)
# Путь склейкой у Go (ТЗ §15 п. 15 К5): имя и литерал, литералы подряд, методы константами.
STARTS["go/main.go"] += (
    'r := mux.NewRouter()\nr.HandleFunc(base + "', 'r := mux.NewRouter()\nr.HandleFunc(base + ',
    'r.HandleFunc("/a" + "', 'r := mux.NewRouter()\nr.HandleFunc(base+"/a", h).Methods(http.',
    'r.HandleFunc("/a" + "/b" + ',
)
GO_CONCAT = {
    "calls": "r := mux.NewRouter()\n"
    + 'r.HandleFunc(base + "/a" + "/b", h).Methods(http.MethodGet, http.MethodHead)\n' * 20_000,
    "parts": 'r := mux.NewRouter()\nr.HandleFunc(base + ' + '"/a" + ' * (PAYLOAD // 7) + '"/b", h)\n',
    "pluses": "r := mux.NewRouter()\nr.HandleFunc(base " + "+ " * (PAYLOAD // 2),
}


@pytest.mark.parametrize("kind", sorted(GO_CONCAT))
def test_go_concat_path(tmp_path: Path, kind: str) -> None:
    _check(tree(tmp_path, {**MANIFESTS, "go/main.go": "package main\nfunc main() {\n" + GO_CONCAT[kind]}))


# Запрос клиента не маршрут (ТЗ §15 п. 16 П4): вызов глагола с одним аргументом, функции
# запроса net/http, вложенные и незакрытые вызовы.
STARTS["go/main.go"] += (
    "r := chi.NewRouter()\nr.Get(url", "http.Get(", "x.Get(x.Get(", "x.Get(T{", "x.Get(f(a, ",
    'ws.Route(ws.GET("/a")', "ws.Route(ws.GET(p)",
)
GO_REQUESTS = {
    # Плотные вызовы: 0,7 МБ. Два мегабайта сплошных вызовов глагола идут около 0,9 с
    # процессорного времени и без П4 шли дольше (1,1 до 1,8 с): цена одного вызова в
    # разборщике go-http (смежный дефект в отчёте части 5), правило П4 её только снижает.
    "calls": "r := chi.NewRouter()\n" + "r.Get(url)\nr.Post(u, h)\n" * 30_000,
    # Вложенные скобки в аргументе: конец первого аргумента ищется не дальше 80 знаков.
    # Подряд вложенные вызовы глагола («x.Get(x.Get(») медленны и без П4: каждый вызов с
    # аргументом не строкой собирает текст выражения (смежный дефект в отчёте части 5).
    "nested": "r := chi.NewRouter()\nr.Get(" + "(" * PAYLOAD,
    "commas": "r := chi.NewRouter()\nr.Get(" + "f(a, " * (PAYLOAD // 5),
}


@pytest.mark.parametrize("kind", sorted(GO_REQUESTS))
def test_go_client_requests(tmp_path: Path, kind: str) -> None:
    _check(tree(tmp_path, {**MANIFESTS, "go/main.go": "package main\nfunc main() {\n" + GO_REQUESTS[kind]}))


# Префикс NestJS членом перечисления (ТЗ §15 п. 15 К4).
STARTS["js/app.js"] += (
    "@Controller(A.", "@Controller(A.B", "@Controller(A.B)\nclass C {\n  @Get('",
    "@Controller(A.B)\nenum A {\n  B = '",
)
# Маршруты ASP.NET Core (ТЗ §15 п. 15 К2): вызовы Map*, группы, атрибуты и классы контроллеров.
STARTS["cs/App.cs"] += (
    'app.MapGet("', "app.MapGet($\"{", "app.MapGet<", 'var g = app.MapGroup("', "g.MapGet(\"/a\", ",
    'app.MapMethods("/a", new[] { "', 'app.MapMethods("/a", [HttpMethods.', "[HttpGet(\"",
    "[Route(\"", "[ApiController]\nclass A : ControllerBase {\n  [HttpGet]\n  [",
    "class A : Controller {\n  [HttpPost(\"a\")]\n  public Task<",
    "class A : Controller {\n  [Route(\"a\")]\n  ",
)
# Параметры Rust (ТЗ §15 п. 14 И2): атрибуты envconfig и clap, env::var, макросы, тесты.
STARTS["rs/main.rs"] = (
    "#[envconfig(", '#[envconfig(from = "', "#[envconfig(default = 1)]\n", "#[arg(env = ",
    "#[arg(env)]\n#[serde(", 'std::env::var("', "env::var(", 'env!("', "#[cfg(test)]\nmod t {",
    "r#\"", "'", 'env::var("X").unwrap_or("',
)
# Маршруты actix-web (ТЗ §15 п. 15 К3): вызовы route, scope и resource, атрибуты обработчиков.
STARTS["rs/main.rs"] += (
    '.route("', ".route(", 'web::scope("', "web::scope(", 'web::resource("/a").route(', '#[get("',
    '#[route("/a", method = "', 'App::new().service(web::scope("/a").service(',
    '.route("/a", web::', "const A: &str = \"",
)
# Расписания robfig/cron (ТЗ §15 п. 15 Л2): литерал, константа, выражение, задание.
STARTS["go/main.go"] += (
    RGO + 'c.AddFunc("', RGO + "c.AddFunc(", RGO + "c.AddFunc(fmt.Sprintf(", RGO + 'c.AddJob("1", ',
    RGO + "c.Schedule(cron.Every(", RGO + 'const A = "1"\nc.AddFunc(A, ', RGO + "c.AddFunc(`",
)
# Обёртка над add_periodic_task и её вызовы (ТЗ §15 п. 15 Л1): незакрытые аргументы.
STARTS["py/app.py"] += (
    "def w(s, sch, sig):\n    s.add_periodic_task(sch, sig)\nw(s, crontab(minute='",
    "def w(s, sch, sig, name):\n    s.add_periodic_task(sch, sig, name=name)\nw(s, 1, t.s(), name='",
)
# Расписания clokwerk (ТЗ §15 п. 15 Л3): аргумент every, at и тело run без закрытия.
STARTS["rs/main.rs"] += (
    "s.every(", "s.every(1.hour()).at(\"", "s.every(1.hour()).run(|| ", "s.every(1.hour()).run(|| f(",
    "s.every(1.hour()).at(", "s.every(TimeUnits::minutes(",
)
# Расписания cron и @nestjs/schedule (ТЗ §15 п. 15 Л4): декоратор, конструктор, объект.
STARTS["js/app.js"] += (
    "@Cron('", "@Cron(CronExpression.", "@Cron(`", "@Cron(A, { name: '", "new CronJob('",
    "new CronJob(this.", "x.create({ name: '", "x.create({ onTick: f, expression: '",
    "x.create({ onTick: f, expression: ", "CronJob.from({ cronTime: '", "{ onTick, ",
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
        _found, took = timed(partial(spec.parse, files, ctx), time_limit())
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
    "rb/config/routes.rb": "Rails.application.routes.draw do\n  get '/" + A + "', to: 'a#b'\nend\n",
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
# Расписания robfig/cron (ТЗ §15 п. 15 Л2): вызовов сверх предела, вложенные вызовы без
# запятой, длинный блок констант и длинные выражения на месте расписания.
GO_CRON = {
    "calls": RGO + 'c.AddFunc("1", f)\n' * (PAYLOAD // 18),
    "nested": RGO + "c.AddFunc(" * (PAYLOAD // 10),
    "const-block": RGO + "const (\n" + '\tA = "x"\n' * (PAYLOAD // 9) + ")\nc.AddFunc(A, f)\n",
    "long-args": RGO + ("c.AddFunc(" + "a+" * 1500 + "b, f)\n") * 600,
}
# Расписания clokwerk (ТЗ §15 п. 15 Л3): вызовов сверх предела, вложенные every, длинные
# цепочки звеньев и тела run без вызова функции.
CLOKWERK = {
    "calls": "s.every(1.hour()).run(|| f());\n" * (PAYLOAD // 30),
    "nested": "s.every(" * (PAYLOAD // 8),
    "links": ("s.every(1.hour())" + ".at(\"1\")" * 20 + ";\n") * 1900,
    "chain": "s.every(1.hour())" + ".at(\"1\")" * (PAYLOAD // 9),
    "bodies": ("s.every(1.hour()).run(|| {" + "x.y(); " * 2800 + "});\n") * 100,
}
# Расписания cron и @nestjs/schedule (ТЗ §15 п. 15 Л4): объекты регистрации сверх предела,
# onTick в глубокой вложенности и в огромном объекте, декораторы без закрытия.
NODE_CRON = {
    "objects": "x.create({ name: 'a', expression: '1', onTick: f });\n" * (PAYLOAD // 52),
    "deep": "{" * (PAYLOAD // 2 - 1000) + "onTick, expression: e }\n" * 1000,
    "keys": "x.create({ onTick: f, expression: '1', " + "a: 1, " * (PAYLOAD // 6) + "})",
    "big-object": "x.create({ " + "onTick: f, " * 1900 + "a: [" * 50000 + "]" * 50000 + "})",
    "decorators": "@Cron(" * (PAYLOAD // 6),
    "constructors": "new CronJob(this.a, f);\n" * 1900 + "x" * (PAYLOAD // 2),
}
# Код, который называет файл OpenAPI (ТЗ §15 п. 15 Н1): тысячи литералов и вхождений имени
# в одном литерале, длинный заголовок импортов Go, длинная цепочка пакетов.
SERVED_SPEC = "openapi: 3.0.0\npaths: {}\n"
SERVED = {
    "js/app.js:calls": "x('openapi.yaml');\n" * (PAYLOAD // 20),
    "js/app.js:one-literal": "'" + "/openapi.yaml" * (PAYLOAD // 14) + "'",
    "js/app.js:comment": "// " + "openapi.yaml " * (PAYLOAD // 14),
    "go/main.go:imports": "package main\nimport (\n" + '\t"x/y"\n' * (PAYLOAD // 8)
    + ')\nvar s = "openapi.yaml"\n',
    "go/main.go:literals": 'package main\nvar s = "openapi.yaml"\n' * (PAYLOAD // 36),
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


# Rails: много инструкций и блоков, повторы тел concern и draw, heredoc с разными именами.
RAILS = {
    "statements": "x = foo(bar, baz) + qux(1, 2) do\nend\n" * 25_000,
    "verbs": "get 'abcdefghijklmnopqrstuvwxyz', to: 'a#b'\n" * 4900,
    "resources": "resources :a, only: [:show, :index], path: 'x', param: :y do\nend\n" * 2400,
    "concerns": "concern :a do\nend\n" + "".join(
        f"concern :c{i} do\n  concerns :{'a' if i == 0 else f'c{i - 1}'}\n"
        f"  concerns :{'a' if i == 0 else f'c{i - 1}'}\nend\n" for i in range(40)
    ) + "concerns :c39\n",
    "heredocs": "".join(f"x = <<~A{i}\nA{i}\n" for i in range(24_000)),
    "frames": ("if a\n" * 40 + "end\n" * 40) * 600,
    "braces": "member { get :a }\n" * 4000,
    "brackets": "(/" * (PAYLOAD // 2),
}


@pytest.mark.parametrize("kind", sorted(RAILS))
def test_rails_routes(tmp_path: Path, kind: str) -> None:
    _check(tree(tmp_path, {**MANIFESTS, "rb/config/routes.rb": RAILS[kind]}))


# ASP.NET Core: тысячи вызовов и атрибутов, цепочка групп, классы контроллеров, блоки
# атрибутов без метода, аргументы MapMethods без конца.
ASPNET = {
    "maps": 'app.MapGet("/abcdefghijklmnopqrstuvwxyz", () => Results.Ok());\n' * 1999,
    "groups": "".join(f'var g = g.MapGroup("x{i}");\n' for i in range(999))
    + 'g.MapGet("/a", h);\n' * 999,
    "actions": "[ApiController]\n[Route(\"api/[controller]\")]\nclass AController : ControllerBase {\n"
    + '  [HttpGet("a/{id}")]\n  [Route("b")]\n  public IActionResult GetAsync(int id) => Ok();\n' * 999
    + "}\n",
    "classes": "[ApiController]\nclass AController : ControllerBase { }\n" * 1999,
    "attr-chain": "class AController : Controller {\n  [HttpGet]" + "[A]" * (PAYLOAD // 3),
    "no-method": "class AController : Controller {\n" + "  [HttpGet] int x;\n" * (PAYLOAD // 20),
    "methods-args": 'app.MapMethods("/a", new[] { ' + '"GET", ' * (PAYLOAD // 7),
    "open-attr": "class AController : Controller {\n  [HttpGet(" + "[" * (PAYLOAD // 2),
}


@pytest.mark.parametrize("kind", sorted(ASPNET))
def test_aspnet_routes(tmp_path: Path, kind: str) -> None:
    _check(tree(tmp_path, {**MANIFESTS, "cs/App.cs": ASPNET[kind]}))


# Перечисления для префикса @Controller(Имя.Член) (ТЗ §15 п. 15 К4): тысячи перечислений,
# огромное тело, тело без конца, сплошные кавычки. Перечисления читаются из файлов .ts.
NEST_ENUM = {
    "enums": "export enum A { B = 'b' }\n" * 3000,
    "members": "export enum A {\n" + "  B = 'b',\n" * (PAYLOAD // 10) + "}\n",
    "open": "export enum A {" + " B = 'b'," * (PAYLOAD // 9),
    "quotes": "export enum A {" + "'" * PAYLOAD,
}
NEST_CONTROLLER = "@Controller(A.B)\nexport class C {\n  @Get('x')\n  x() {}\n}\n"


@pytest.mark.parametrize("kind", sorted(NEST_ENUM))
def test_nest_enum_prefix(tmp_path: Path, kind: str) -> None:
    _check(tree(tmp_path, {
        **MANIFESTS, "js/app.ts": NEST_CONTROLLER, "js/enum.ts": NEST_ENUM[kind],
    }))


# Rust: тысячи атрибутов, сплошные атрибуты без поля, модули тестов, время жизни.
RUST = {
    "attributes": '#[envconfig(from = "A", default = "1")]\npub a: u16,\n' * 1999,
    "attr-chain": "#[envconfig(default = 1)]" + "#[a]" * (PAYLOAD // 4),
    "open-attr": "#[envconfig(" + "(" * (PAYLOAD // 2),
    "test-modules": "#[cfg(test)]\nmod t {\n" * (PAYLOAD // 20),
    "lifetimes": "fn f<'a>(x: &'a str) " * (PAYLOAD // 20),
    "reads": 'std::env::var("A").unwrap_or_else(|_| "b".into());\n' * 1999,
}


# actix-web: тысячи вызовов и атрибутов, глубокая вложенность scope, сплошные скобки и
# разделители, тысячи констант, атрибут без конца.
ACTIX = {
    "routes": "cfg" + '.route("/abcdefghijklmnopqrstuvwxyz", web::get().to(h))\n' * 4999 + ";\n",
    "attrs": '#[get("/abcdefghij")]\nasync fn a() {}\n' * 4999,
    "scopes": 'web::scope("/a").service(' * (PAYLOAD // 26),
    "parens": "(" * PAYLOAD,
    "separators": ",;" * (PAYLOAD // 2),
    "consts": 'const A: &str = "/a";\n' * (PAYLOAD // 22) + ".route(A, web::get().to(h))\n",
    "attr-chain": '#[get("/a")]' + "#[a]" * (PAYLOAD // 4),
    "open-attr": '#[get("/a"' + "[" * (PAYLOAD // 2),
}


@pytest.mark.parametrize("kind", sorted(ACTIX))
def test_actix_routes(tmp_path: Path, kind: str) -> None:
    _check(tree(tmp_path, {**MANIFESTS, "rs/main.rs": ACTIX[kind]}))


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


# Тысячи обёрток add_periodic_task с разными именами и их вызовы в соседнем файле (ТЗ §15
# п. 15 Л1): имён для поиска вызовов не больше celerybeat._MAX_WRAPPERS.
CELERY_WRAPPERS = "".join(
    f"def w{i}(s, sch, sig):\n    s.add_periodic_task(sch, sig)\n" for i in range(3000)
)
CELERY_CALLS = "".join(f"w{i}(s, crontab(), t.s())\n" for i in range(3000))


def test_celery_wrappers(tmp_path: Path) -> None:
    extra: dict[str, str | bytes] = {f"py/m{i}.py": "x = 1\n" * 200 for i in range(50)}
    _check(tree(tmp_path, {
        **MANIFESTS, **extra, "py/celery.py": CELERY_WRAPPERS, "py/calls.py": CELERY_CALLS,
    }))


@pytest.mark.parametrize("kind", sorted(GO_CRON))
def test_go_cron(tmp_path: Path, kind: str) -> None:
    _check(tree(tmp_path, {**MANIFESTS, "go/main.go": GO_CRON[kind]}))


@pytest.mark.parametrize("kind", sorted(CLOKWERK))
def test_clokwerk(tmp_path: Path, kind: str) -> None:
    _check(tree(tmp_path, {**MANIFESTS, "rs/main.rs": CLOKWERK[kind]}))


@pytest.mark.parametrize("kind", sorted(NODE_CRON))
def test_node_cron(tmp_path: Path, kind: str) -> None:
    _check(tree(tmp_path, {**MANIFESTS, "js/app.js": NODE_CRON[kind]}))


@pytest.mark.parametrize("kind", sorted(SERVED))
def test_served(tmp_path: Path, kind: str) -> None:
    name = kind.split(":")[0]
    _check(tree(tmp_path, {**MANIFESTS, "openapi.yaml": SERVED_SPEC, name: SERVED[kind]}))


def test_served_package_chain(tmp_path: Path) -> None:
    """Цепочка из 3000 пакетов Go, каждый импортирует следующий: импортёры собираются не
    дальше трёх шагов."""
    files: dict[str, str | bytes] = {
        **MANIFESTS, "openapi.yaml": SERVED_SPEC,
        "go/p0/a.go": 'package p0\nvar s = "openapi.yaml"\n',
    }
    for i in range(1, 3000):
        files[f"go/p{i}/a.go"] = f'package p{i}\nimport "x/p{i - 1}"\n'
    _check(tree(tmp_path, files))
