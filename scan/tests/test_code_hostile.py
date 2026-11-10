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
    "py/requirements.txt": "fastapi\nflask\ndjango\ncelery\nkafka-python\npika\nnats-py\nredis\n",
    "js/package.json": (
        '{"dependencies": {"express": "*", "@nestjs/core": "*", "kafkajs": "*", "amqplib": "*",'
        ' "nats": "*", "bullmq": "*", "cron": "*", "@nestjs/schedule": "*", "ioredis": "*"}}'
    ),
    "rb/Gemfile": 'gem "sidekiq"\ngem "rails"\ngem "redis"\n',
    "go/go.mod": (
        "module x\n\nrequire (\n\tgithub.com/gin-gonic/gin v1.0.0\n"
        "\tgithub.com/segmentio/kafka-go v0.4.0\n\tgithub.com/nats-io/nats.go v1.0.0\n"
        "\tgithub.com/robfig/cron/v3 v3.0.1\n\tgithub.com/redis/go-redis/v9 v9.5.1\n)\n"
    ),
    "cs/app.csproj": '<Project Sdk="Microsoft.NET.Sdk.Web"></Project>\n',
    "java/pom.xml": (
        "<project><artifactId>x</artifactId><dependencies><dependency>"
        "<artifactId>spring-boot-starter-web</artifactId></dependency><dependency>"
        "<artifactId>jakarta.ws.rs-api</artifactId></dependency><dependency>"
        "<artifactId>kafka-clients</artifactId></dependency></dependencies></project>\n"
    ),
    "kt/build.gradle.kts": (
        'plugins {\n    kotlin("jvm")\n    id("org.springframework.boot")\n}\n'
        'dependencies {\n    implementation("io.quarkus:quarkus-rest")\n'
        '    implementation("org.springframework.kafka:spring-kafka")\n}\n'
    ),
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

# Маршруты Spring (ТЗ §15 п. 17 К1): аннотации без закрытия, массивы путей, методы, классы,
# параметры типа и маска Kotlin (вложенные комментарии, сырые строки, подстановки).
RC = "@RestController\nclass A {\n  "
STARTS["java/App.java"] += (
    '@GetMapping("', RC + '@GetMapping("', RC + '@GetMapping(value = {"', RC + "@GetMapping(",
    "@RequestMapping(", RC + "@RequestMapping(method = {RequestMethod.", RC + "@GetMapping\n  public ",
    "@RestController\nclass A<", RC + "@GetMapping(A.", '@RestController\n@RequestMapping("',
    "@", "@a.", "class A ", "@RestController\nclass A(", RC + "@GetMapping\n  public <",
)
STARTS["kt/App.kt"] = (
    RC + '@GetMapping("', '"""', "/*", '"${', '"$', "@RestController\nclass A(",
    RC + '@GetMapping(value = ["', RC + "@RequestMapping(method = [RequestMethod.",
    RC + "@GetMapping\n  fun ", RC + "@GetMapping\n  val ", "/* /* */", "'",
)
# Ресурсы JAX-RS (ТЗ §15 п. 17 К2): @Path и глаголы без закрытия, локаторы, базовые классы.
RES = '@Path("/a")\npublic class A {\n  '
STARTS["java/App.java"] += (
    '@Path("', RES + '@GET\n  @Path("', '@ApplicationPath("', RES + '@Path("b")\n  public ',
    RES + '@Path("b")\n  public B<', RES + "@GET\n  public ", "public class B extends ",
    RES + '@Path("{a: ', RES + "@Path(A.", '@Path("/a")\npublic abstract class ',
)
STARTS["kt/App.kt"] += (
    '@Path("/a")\nclass A {\n  @Path("b")\n  fun b(): ', '@Path("/a")\nclass A : ',
    '@Path("/a")\nclass A(', '@Path("/a")\nclass A {\n  @GET\n  fun ',
)
# Параметры Spring в коде (ТЗ §15 п. 17 Е2): @Value без закрытия, подстановки, классы свойств
# с незакрытыми полями, сеттерами, компонентами record и параметрами конструктора Kotlin.
CP = '@ConfigurationProperties("p")\npublic class A {\n  '
STARTS["java/App.java"] += (
    '@Value("${', '@Value("${a:', "@Value(", '@Value("#{', CP + "private ", CP + "private int a = ",
    CP + "void setA(", '@ConfigurationProperties(prefix = "', "@lombok.Data\n" + CP + "private ",
    '@ConfigurationProperties("p")\npublic record A(', '@ConfigurationProperties("p")\npublic record A(@DefaultValue("',
    'class A {\n  A(@Value("${a}") ', 'class A {\n  @Value("${a}") private Map<',
)
STARTS["kt/App.kt"] += (
    '@Value("\\${', '@field:Value("\\${a:', '@ConfigurationProperties("p")\nclass A(val a: ',
    '@ConfigurationProperties("p")\nclass A {\n  var a: ', 'class A(@Value("\\${a}") val a: ',
)
# Окружение в Kotlin и Optional в Java (ТЗ §15 п. 17 Е3): незакрытые элвис, преобразование,
# хвост Optional и лямбда orElseGet.
GE = 'System.getenv("A")'
STARTS["kt/App.kt"] += (
    'System.getenv("', GE + ' ?: "', GE + " ?: ", GE + "?.", GE + "?.toInt() ?: ", "(" + GE + ' ?: "',
    GE + " ?: throw ", GE + ' ?: "${',
)
STARTS["java/App.java"] += (
    "Optional.ofNullable(" + GE + ').orElse("', "Optional.ofNullable(" + GE + ').orElseGet(() -> "',
    "Integer.parseInt(Optional.ofNullable(" + GE + ").orElse(", "Optional.ofNullable(",
)
# Топики Kafka (ТЗ §15 п. 17 В1): подписки, записи и аннотации без закрытия, списки и
# параметры типа без конца, переменные файла с дефолтом окружения.
KS = "c.subscribe("
STARTS["java/App.java"] += (
    KS, KS + 'List.of("', KS + "Arrays.asList(", KS + "Collections.singletonList(",
    'new ProducerRecord<>("', "new ProducerRecord<", 'kafkaTemplate.send("',
    '@KafkaListener(topics = {"', '@KafkaListener(topics = "', "@KafkaListener(",
    'String t = Optional.ofNullable(System.getenv("A")).orElse("',
)
STARTS["kt/App.kt"] += (
    'subscribe(listOf("', "subscribe(setOf(", 'ProducerRecord("', '@KafkaListener(topics = ["',
    'val t = System.getenv("A") ?: "', "val t: String = System.getenv(",
)
# Расписания Spring (ТЗ §15 п. 17 Л1): @Scheduled и @Schedules без закрытия, подстановки и
# единицы времени без конца.
SC = "@Scheduled("
STARTS["java/App.java"] += (
    SC, SC + 'cron = "', SC + "fixedRate = ", SC + 'fixedRateString = "${', SC + 'cron = "${a:',
    '@Schedules({' + SC + 'cron = "', SC + "fixedRate = 1, timeUnit = TimeUnit.",
)
STARTS["kt/App.kt"] += (SC + 'cron = "', SC + 'fixedDelayString = "\\${', SC + "fixedRate = ")
# Адреса объектов литералами (ТЗ §15 п. 17 С2): литерал адреса без закрытия, хост и путь без
# конца, сырые строки и шаблоны Kotlin. Разборщик смотрит только src/main.
STARTS["java/src/main/java/A.java"] = (
    '"http://', '"lb://', '"https://a', '"http://a/', '"http://a?', 'String a = "', '"\\"http://',
)
STARTS["kt/src/main/kotlin/A.kt"] = (
    '"http://', '"""http://', '"http://a/$', '"http://a/${', '"http://a/\\$', "'\"' + \"http://",
)
# Файл настроек модуля, из которого маршрутам берётся префикс приложения.
STARTS["java/src/main/resources/application.properties"] = (
    "server.servlet.context-path=${", "server.servlet.context-path=", "a=\\\n", "#---\n", "!",
    "%dev.server.servlet.context-path=", "server.servlet.context-path: \\u",
)
STARTS["java/src/main/resources/application.yml"] = (
    "server:\n  servlet:\n    context-path: ", "spring:\n  webflux:\n    base-path: '${",
    "---\nspring.config.activate.on-profile: a\n---\n", "a: [",
)

# Маршруты Rails (ТЗ §15 п. 15 К1): незакрытые строки, литералы, heredoc и блоки маски Ruby.
STARTS["rb/config/routes.rb"] = (
    "Rails.application.routes.draw do\n  get '", "resources :", "get ", "scope '",
    "  get '/a', to: redirect { |p| ", "%w(", "x = <<~A\n", "concern :a do\n", "draw(:",
    "match 'a', via: [", "=begin\n", "c = { id: /", 'get "#{', "member { get :",
    "resources :a, only: %i[", "mount A => '",
    # Необязательные группы, devise_for и shallow (ТЗ §15 п. 16 П6).
    "scope '(", "get 'a(", "get 'a(/", "devise_for :", "devise_for :users, path: '",
    "devise_for :users, path_names: { sign_in: '", "devise_for :users, :path_names => { :a => '",
    "devise_for :users, skip: [", "shallow do\n", "resources :a, shallow: true do\n  resources :",
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
# Шаблоны маршрутов по соглашению (ТЗ §15 п. 16 П5): незакрытый вызов, аргументы, литералы.
STARTS["cs/App.cs"] += (
    "app.MapControllerRoute(", 'app.MapControllerRoute("a", "', "app.MapControllerRoute(name: ",
    'app.MapControllerRoute(pattern: "{', "app.MapDefaultControllerRoute(",
    "app.MapDefaultControllerRoute();\nclass A : Controller {\n  [HttpGet]\n  public X ",
)
# Чтения через биндер конфигурации .NET (ТЗ §15 п. 16 Р1): GetValue, GetConnectionString,
# разделы, привязки к классу, nameof, переменная раздела и свойства класса настроек.
BIND = 'c.GetSection("A").Get<A>();\n'
STARTS["cs/App.cs"] += (
    'c.GetValue<int>("', "c.GetValue<", 'c.GetValue<int>("A", ', "c.GetValue<int>(A.",
    'c.GetConnectionString("', "c.GetConnectionString(", 'c.GetSection("', "c.GetSection(nameof(",
    'var s = c.GetSection("A");\ns.GetValue<int>("', 'c.GetSection("A").Get<',
    'c.GetSection("A").Bind(', "s.Configure<A>(", "s.Configure<A>(c.GetSection(",
    "s.AddOptions<A>().BindConfiguration(", 's.AddOptions<A>().BindConfiguration("',
    "s.AddOptions<A>()\n  .Bind(c.GetSection(", 'var o = new A();\nc.GetSection("A").Bind(o',
    BIND + "class A {\n  public int B { get; set; } = ", BIND + "public class A {\n  public required ",
    BIND + "class A {\n  public ", BIND + "class A ",
)
# Параметры Rust (ТЗ §15 п. 14 И2): атрибуты envconfig и clap, env::var, макросы, тесты.
STARTS["rs/main.rs"] = (
    "#[envconfig(", '#[envconfig(from = "', "#[envconfig(default = 1)]\n", "#[arg(env = ",
    "#[arg(env)]\n#[serde(", 'std::env::var("', "env::var(", 'env!("', "#[cfg(test)]\nmod t {",
    "r#\"", "'", 'env::var("X").unwrap_or("',
)
# Структуры envconfig (ТЗ §15 п. 16 Р3): derive, struct, поле без атрибута.
STARTS["rs/main.rs"] += (
    "#[derive(", "#[derive(Envconfig)]\n", "#[derive(Envconfig)]\nstruct A {\n    ",
    "#[derive(Envconfig)]\npub struct A {\n    pub a: Option<", "#[derive(Envconfig)]\nstruct A<",
    "#[derive(Envconfig)]\n#[", "#[derive(Envconfig)]\nstruct A {\n    #[serde(",
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

# Каналы Redis pub/sub (ТЗ §15 п. 18 В1): литерал, условный оператор, константа, шаблон,
# подписка без скобок у Ruby и Publish(ctx, у Go, незакрытые аргументы.
RJS, RDG = "require('ioredis');\n", 'import "github.com/redis/go-redis/v9"\n'
STARTS["py/app.py"] += (
    "import redis\nredis.publish('", "import redis\nr = redis.Redis()\np = r.pubsub()\np.subscribe(",
    "import redis\nredis.publish('a' if c else '", "import redis\nredis.psubscribe('",
    "import redis\nredis.subscribe(**{'",
)
STARTS["js/app.js"] += (
    RJS + "redis.publish('", RJS + "client.subscribe(", RJS + "redis.publish(c ? 'a' : '",
    RJS + "redis.publish(A, ", RJS + "redis\n  .publish(", "export const A = `${",
    RJS + "redis.subscribe('a', (",
)
STARTS["rb/app.rb"] += (
    "redis.publish('", "redis.publish(", "redis.subscribe 'a', '", "redis.publish(c ? 'a' : '",
    'redis.publish("#{', "Redis.current.subscribe('",
)
STARTS["go/main.go"] += (
    RDG + 'rdb.Publish(ctx, "', RDG + "rdb.Subscribe(ctx, ", RDG + "rdb.PSubscribe(ctx, A, ",
    RDG + 'const A = "a"\nrdb.Publish(ctx, A, ',
)

# GetRequiredValue и индексатор раздела .NET (ТЗ §15 п. 18 Р1): литерал, параметр типа,
# переменная раздела и цепочка без закрытия.
STARTS["cs/App.cs"] += (
    'c.GetRequiredValue("', "c.GetRequiredValue<", "c.GetRequiredValue<int>(",
    'var s = c.GetSection("A");\ns["', 'var s = c.GetSection("A");\ns[', 'c.GetSection("A")["',
    'c.GetRequiredSection("A").GetRequiredValue("',
)
# Путь маршрута константой и app.get(Класс) NestJS (ТЗ §15 п. 18 К1): импорт по именам и
# require без закрытия, шаблон константы, незакрытые аргументы.
STARTS["js/app.js"] += (
    "app.get(X", "app.get(X, {", "app.get(X, ", "import { A } from './a';\napp.get(A, ",
    "import {", "import { A as ", "const { A } = require(", "export const A = `${B}/",
    "export const A = '/a';\napp.get(A", "@Controller(A", "@Controller(A)\nclass C {\n  @Get(B",
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


# Аннотации Spring (ТЗ §15 п. 17 К1): аннотаций и классов сверх предела, скобки сверх
# предела, далёкие от аннотаций члены, вложенные в аргументы аннотации, длинные заголовки
# классов и параметры типа без закрытия.
SPRING = {
    "java/App.java:annotations": '@GetMapping("/a")\n' * (PAYLOAD // 18),
    "java/App.java:stacked": RC + '@GetMapping("/a") ' * 1999 + "void a() {}\n}\n",
    "java/App.java:classes": "class A {}\n" * (PAYLOAD // 11),
    "java/App.java:brackets": "{" * (PAYLOAD // 2),
    "java/App.java:far-members": RC + ('@GetMapping("/a")' + " a" * 1400 + "\n") * 600,
    "java/App.java:nested-args": RC + "@GetMapping @A(" * 1000 + ")" * 1000 + " a" * 1500,
    "java/App.java:headers": "@RestController class A " + "(a) " * (PAYLOAD // 5),
    "java/App.java:type-args": RC + "@GetMapping public " + "<" * (PAYLOAD // 2),
    "java/App.java:arrays": RC + '@GetMapping({"' + '", "' * (PAYLOAD // 5) + '"}) void a() {}\n}',
    "kt/App.kt:nested-comments": RC + "/*" * (PAYLOAD // 4) + "*/" * (PAYLOAD // 4),
    "kt/App.kt:properties": RC + ('@GetMapping("/a") val a = 1\n' * 1999) + "}\n",
    "kt/App.kt:headers": "@RestController\nclass A :\n" * (PAYLOAD // 26),
}


# Классы свойств и @Value на файле в 2 МБ: сотни тысяч полей без сеттеров и с ними, одно поле
# в миллион слов, параметры типа без закрытия, тысячи классов со ссылками друг на друга,
# список параметров в сотни тысяч, стопки аннотаций, подстановки без конца.
KCP = '@ConfigurationProperties("p")\nclass A {\n'
SPRING_VALUE = {
    "java/App.java:values": '@Value("${a}") int a;\n' * (PAYLOAD // 22),
    "java/App.java:fields": CP + "private int a;\n" * (PAYLOAD // 15) + "void setB(int b) {}\n}\n",
    "java/App.java:setters": CP + "private int a;\n  void setA(int a) {}\n" * (PAYLOAD // 38) + "}\n",
    "java/App.java:long-field": CP + "private " + "a " * (PAYLOAD // 2) + ";\nvoid setA() {}\n}\n",
    "java/App.java:spaced-field": (
        CP + "private " + "a" * 100 + " " * (PAYLOAD - 300) + "b;\nvoid setB() {}\n}\n"
    ),
    "java/App.java:spaced-fields": CP + ("a" * 100 + " " * 200) * 6000 + "b;\nvoid setB() {}\n}\n",
    "java/App.java:type-args": CP + "private Map" + "<" * (PAYLOAD // 2) + " a;\nvoid setA() {}\n}\n",
    "java/App.java:linked-classes": "".join(
        f'@ConfigurationProperties("p{i}")\nclass C{i} {{\n  private C{i + 1} f;\n'
        f"  public void setF(C{i + 1} f) {{}}\n}}\n"
        for i in range(1999)
    ),
    "java/App.java:params": "class A {\n  A(" + '@Value("${a}") int a, ' * 1999 + ") {}\n}\n",
    "java/App.java:setter-params": '@Value("${a}") ' * 1999 + "void setA(" + "int a, " * (PAYLOAD // 8) + ") {}\n",
    "java/App.java:record": '@ConfigurationProperties("p")\npublic record A(' + "int a, " * (PAYLOAD // 7) + ") {}\n",
    "java/App.java:default-values": (
        '@ConfigurationProperties("p")\npublic record A(' + '@DefaultValue("1") ' * (PAYLOAD // 19)
        + "int a) {}\n"
    ),
    "java/App.java:holes": '@Value("' + "${" * (PAYLOAD // 2 - 10) + '") int a;\n',
    "java/App.java:closed-holes": '@Value("' + "${a}" * (PAYLOAD // 4 - 10) + '") int a;\n',
    "java/App.java:lombok-heads": "@Data " * (PAYLOAD // 6) + CP + "private int a;\n}\n",
    "kt/App.kt:vars": KCP + "  var a: Int = 1\n" * (PAYLOAD // 17) + "}\n",
    "kt/App.kt:vars-in-fun": KCP + "  fun f() {\n" + "    var a: Int = 1\n" * (PAYLOAD // 19) + "  }\n}\n",
    "kt/App.kt:ctor": '@ConfigurationProperties("p")\nclass A(' + "val a: Int = 1, " * (PAYLOAD // 16) + ")\n",
    "kt/App.kt:values": "class A {\n" + '  @Value("\\${a}") var a: Int = 1\n' * 1999 + "}\n",
}


SPRING_VALUE.update({
    # Окружение Kotlin и Optional Java (Е3): чтения подряд до предела записей файла.
    "kt/App.kt:elvis": (GE + ' ?: "b"\n') * (PAYLOAD // 26),
    "kt/App.kt:elvis-spaces": GE + " ?:" + " " * (PAYLOAD - 30) + '"b"\n',
    "java/App.java:optional": ("Optional.ofNullable(" + GE + ').orElse("b");\n') * 1999,
    "java/App.java:optional-spaces": "Optional.ofNullable(" + GE + ")" + " " * (PAYLOAD - 60) + '.orElse("b");\n',
})


# Топики Kafka на файле в 2 МБ: сотни тысяч подписок, записей и аннотаций, список в
# миллион элементов, параметры типа без закрытия, переменные с дефолтом подряд.
SPRING_VALUE.update({
    "java/App.java:subscribes": 'c.subscribe(List.of("t"));\n' * (PAYLOAD // 27),
    "java/App.java:long-list": KS + "List.of(" + '"t", ' * (PAYLOAD // 5) + "));\n",
    "java/App.java:records": 'p.send(new ProducerRecord<>("t", v));\n' * (PAYLOAD // 37),
    "java/App.java:record-types": "new ProducerRecord<" + "<" * (PAYLOAD // 2) + "(\n",
    "java/App.java:listeners": '@KafkaListener(topics = "t")\nvoid f() {}\n' * (PAYLOAD // 40),
    "java/App.java:listener-array": '@KafkaListener(topics = {"' + '", "' * (PAYLOAD // 4) + '"})\n',
    "java/App.java:templates": "kafkaTemplate.send(" * (PAYLOAD // 19),
    "java/App.java:template-name": "a" * PAYLOAD + 'Template.send("t");\n',
    "java/App.java:handlers": "f.subscribe(v -> g(v));\n" * (PAYLOAD // 24),
    "kt/App.kt:env-vars": 'val t = System.getenv("A") ?: "x"\n' * (PAYLOAD // 34),
    "kt/App.kt:var-spaces": 'val t = System.getenv("A")' + " " * (PAYLOAD - 40) + '?: "x"\n',
    "kt/App.kt:subscribes": "subscribe(listOf(t))\n" * (PAYLOAD // 21),
})


# Расписания Spring на файле в 2 МБ: сотни тысяч @Scheduled и групп, одна группа в сотни
# тысяч аннотаций, подстановки без конца, единицы времени без конца.
SPRING_VALUE.update({
    "java/App.java:scheduled": (SC + 'cron = "0 0 * * * *")\nvoid f() {}\n') * (PAYLOAD // 45),
    "java/App.java:schedules-groups": ("@Schedules({" + SC + 'cron = "x")})\nvoid f() {}\n') * (PAYLOAD // 47),
    "java/App.java:schedules-one": "@Schedules({" + (SC + 'cron = "x"), ') * (PAYLOAD // 22) + "})\nvoid f() {}\n",
    "java/App.java:schedule-holes": SC + 'cron = "' + "${" * (PAYLOAD // 2 - 20) + '")\nvoid f() {}\n',
    "java/App.java:time-units": SC + "fixedRate = 1" + ", timeUnit = TimeUnit.SECONDS" * (PAYLOAD // 30) + ")\nvoid f() {}\n",
    "kt/App.kt:scheduled": (SC + 'fixedDelayString = "\\${a:PT1S}")\nfun f() {}\n') * (PAYLOAD // 46),
})


# Адреса литералами на файле в 2 МБ: сотни тысяч адресов на разных строках и в одной, хост
# и путь в мегабайт, литералы без закрытия построчно.
SPRING_VALUE.update({
    "java/src/main/java/A.java:addresses": 'String u = "http://a/";\n' * (PAYLOAD // 24),
    "java/src/main/java/A.java:one-line": '"http://a/" + ' * (PAYLOAD // 14),
    "java/src/main/java/A.java:long-host": '"http://' + A + '/"\n',
    "java/src/main/java/A.java:long-path": '"http://a/' + A + '"\n',
    "java/src/main/java/A.java:unclosed": ('"http://a/' + "a" * 1000 + "\n") * 1999,
    "kt/src/main/kotlin/A.kt:templates": 'val u = "http://$a/"\n' * (PAYLOAD // 22),
})


@pytest.mark.parametrize("kind", sorted(SPRING_VALUE))
def test_spring_value(tmp_path: Path, kind: str) -> None:
    name = kind.split(":", 1)[0]
    _check(tree(tmp_path, {**MANIFESTS, name: SPRING_VALUE[kind]}))


# Локаторы JAX-RS: цепочка из тысяч классов, ветвление (десять локаторов на класс), цикл
# A → B → A из тысяч пар, базовые классы цепочкой, тысячи корней.
def _jaxrs_chain(n: int, fanout: int, cycle: bool = False) -> str:
    out = []
    for i in range(n):
        nxt = 0 if cycle and i == n - 1 else i + 1
        head = '@Path("/r")\n' if i == 0 else ""
        locators = "".join(
            f'  @Path("s{k}")\n  public C{nxt} n{k}() {{ return null; }}\n' for k in range(fanout)
        )
        out.append(f'{head}public class C{i} {{\n  @GET\n  public String g() {{ return ""; }}\n{locators}}}\n')
    return "".join(out)


JAXRS = {
    "java/App.java:chain": _jaxrs_chain(600, 1),
    "java/App.java:fanout": _jaxrs_chain(150, 10),
    "java/App.java:cycle": _jaxrs_chain(600, 2, cycle=True),
    "java/App.java:bases": "".join(
        f'public class C{i} extends C{i + 1} {{\n  @GET\n  public String g{i}() {{ return ""; }}\n}}\n'
        for i in range(1999)
    ) + '@Path("/r")\npublic class R extends C0 {}\n',
    "java/App.java:roots": "".join(
        f'@Path("/r{i}")\npublic class C{i} {{\n  @GET\n  public String g() {{ return ""; }}\n}}\n'
        for i in range(999)
    ),
    "kt/App.kt:chain": "".join(
        ('@Path("/r")\n' if i == 0 else "")
        + f'class C{i} {{\n  @GET\n  fun g() = ""\n  @Path("s")\n  fun n(): C{i + 1} = C{i + 1}()\n}}\n'
        for i in range(999)
    ),
}


@pytest.mark.parametrize("kind", sorted(JAXRS))
def test_jaxrs_locators(tmp_path: Path, kind: str) -> None:
    name = kind.split(":", 1)[0]
    _check(tree(tmp_path, {**MANIFESTS, name: JAXRS[kind]}))


def test_jaxrs_locators_across_files(tmp_path: Path) -> None:
    """Цепочка и ветвление локаторов по 1000 файлам по классу в каждом (цикл через все):
    пределы глубины и обхода действуют на репозиторий, а не на файл. Скорость разбора
    плотного кода меряют строки выше на файле в 2 МБ."""
    files: dict[str, str | bytes] = dict(MANIFESTS)
    for i in range(1000):
        head = '@Path("/r")\n' if i == 0 else ""
        nxt = (i + 1) % 1000
        locators = "".join(
            f'  @Path("s{k}")\n  public C{nxt} n{k}() {{ return null; }}\n' for k in range(10)
        )
        files[f"java/C{i}.java"] = (
            f'{head}public class C{i} {{\n  @GET\n  public String g() {{ return ""; }}\n{locators}}}\n'
        )
    _check(tree(tmp_path, files))


@pytest.mark.parametrize("kind", sorted(SPRING))
def test_spring_routes(tmp_path: Path, kind: str) -> None:
    name = kind.split(":", 1)[0]
    _check(tree(tmp_path, {**MANIFESTS, name: SPRING[kind]}))


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
    # Циклы sql.raw по спискам (М1): тысячи циклов и списков, список длиннее предела,
    # предельный список из 1000 переименований, сплошные скобки тела, заголовки без тела.
    "loops": "".join(
        f"const l{i} = [{{ a: 'x', b: 'y' }}];\nfor (const {{ a, b }} of l{i}) "
        f"sql.raw(`ALTER TABLE \"${{a}}\" RENAME TO \"${{b}}\"`);\n" for i in range(9000)
    ),
    "long-list": "const l = [" + "{ a: 'x', b: 'y' }, " * (PAYLOAD // 20) + "];\n"
    "for (const { a, b } of l) sql.raw(`ALTER TABLE \"${a}\" RENAME TO \"${b}\"`);\n",
    "full-list": "const l = ["
    + "".join(f"{{ a: 't{i}', b: 'u{i}' }}, " for i in range(1000)) + "];\n"
    + "".join(f"sql`CREATE TABLE t{i} (a int REFERENCES t0 (a))`;\n" for i in range(1000))
    + "for (const { a, b } of l) sql.raw(`ALTER TABLE \"${a}\" RENAME TO \"${b}\"`);\n",
    "loop-braces": "const l = [['x', 'y']];\nfor (const [a, b] of l) {" + "{" * (PAYLOAD // 2)
    + "sql.raw(`DROP TABLE ${a}`)",
    "loop-heads": "const l = [['x', 'y']];\n" + "for (const { a, b } of l) " * (PAYLOAD // 26)
    + "sql.raw(`DROP TABLE ${a}`)",
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
    # Группы в пути, devise_for без модели и вложенные неглубокие ресурсы (П6).
    "groups": "get 'a" + "(/b" * 30_000 + ")" * 30_000 + "', to: 'a#b'\n",
    "group-verbs": "get 'a(/:b)', to: 'a#b'\n" * 4900,
    "devise": "devise_for :users, path: 'a', path_names: { sign_in: 'b' }, skip: [:c]\n" * 4900,
    "shallow": "shallow do\n" + "resources :a do\n" * 49 + "end\n" * 50,
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


# Биндер конфигурации .NET (ТЗ §15 п. 16 Р1): привязок и свойств сверх предела, классы с
# одним именем, разделы цепочкой, переменные раздела и объявления для .Bind(obj).
DOTNET_BINDER = {
    "binds": BIND * 1999 + "class A {\n" + "  public int B { get; set; } = 1;\n" * 3 + "}\n",
    "props": BIND + "class A {\n" + "  public int B { get; set; } = 1;\n" * (PAYLOAD // 34) + "}\n",
    "props-many": BIND * 50 + "class A {\n" + "  public int B { get; set; }\n" * 1000 + "}\n",
    "classes": BIND + "class A { public int B { get; set; } }\n" * (PAYLOAD // 40),
    "class-names": BIND + "".join(f"class A{i} {{ }}\n" for i in range(PAYLOAD // 14)),
    "chain": 'c' + '.GetSection("a")' * (PAYLOAD // 17) + ".Get<A>();\n",
    "vars": "".join(f'var s{i} = c.GetSection("a");\n' for i in range(1999))
    + "".join(f'var x{i} = s{i}.GetValue<int>("b");\n' for i in range(1999)),
    "binds-objects": "".join(f'c.GetSection("a").Bind(o{i});\n' for i in range(1999)),
    "values": 'c.GetValue<int>("a", 1);\n' * 1999,
    "nested-braces": BIND + "class A " + "{" * (PAYLOAD // 2),
}


@pytest.mark.parametrize("kind", sorted(DOTNET_BINDER))
def test_dotnet_binder(tmp_path: Path, kind: str) -> None:
    _check(tree(tmp_path, {**MANIFESTS, "cs/App.cs": DOTNET_BINDER[kind]}))


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
    # Структуры envconfig (ТЗ §15 п. 16 Р3): тысячи полей без атрибута, тысячи derive,
    # атрибуты между derive и struct, тело без конца, вложенные скобки типа.
    "fields": "#[derive(Envconfig)]\nstruct A {\n" + "    a: Option<u32>,\n" * (PAYLOAD // 20)
    + "}\n",
    "derives": "#[derive(Envconfig)]\nstruct A {\n    a: u32,\n}\n" * 1999,
    "open-derives": "#[derive(Envconfig)]\nstruct A {\n" * 1999 + "a: u32,\n" * (PAYLOAD // 9),
    "derive-attrs": "#[derive(Envconfig)]\n" + "#[a]\n" * (PAYLOAD // 5),
    "open-struct": "#[derive(Envconfig)]\nstruct A {\n" + "a: u32,\n" * (PAYLOAD // 8),
    "type-brackets": "#[derive(Envconfig)]\nstruct A {\n    a: " + "Option<" * (PAYLOAD // 7)
    + "\n}\n",
    "field-attrs": "#[derive(Envconfig)]\nstruct A {\n"
    + "    #[serde(default)]\n" * (PAYLOAD // 22) + "    a: u32,\n}\n",
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
