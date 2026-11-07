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
}

# Подключение клиента: без него разборщики каналов JS и Go файл не читают.
KJS, AMQP, NJS = "require('kafkajs');\n", "require('amqplib');\n", "require('nats');\n"
BMQ = "require('bullmq');\n"
KGO, NGO = 'import "github.com/segmentio/kafka-go"\n', 'import "github.com/nats-io/nats.go"\n'

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
    ),
}

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
}


@pytest.mark.parametrize("kind", sorted(GO_PACKAGE))
def test_go_package_pass(tmp_path: Path, kind: str) -> None:
    _check(tree(tmp_path, {**MANIFESTS, "go/main.go": GO_REG + GO_PACKAGE[kind]}))
