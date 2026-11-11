"""Каналы Redis pub/sub в коде (ТЗ §15 п. 18 В1): Python, Node.js, Ruby и Go по фикстуре
redis-pubsub; объект Redis становится брокером только по записи с владельцем-контейнером,
без объекта Redis вызовы дают подсказки."""

from __future__ import annotations

from pathlib import Path

from archmap_scan import texts
from archmap_scan.objects import BROKER, DATABASE
from archmap_scan.parsers import redispubsub
from tests.helpers import FIXTURES, files_of, model_of, tree

Row = tuple[str, str, str | None, str]


def _parse(root: Path) -> tuple[list[Row], list[tuple[object, object, object]]]:
    ctx, files = files_of(root)
    found = redispubsub.parse(files, ctx)
    uses = sorted(found.channels, key=lambda u: (u.loc, u.name))
    rows = [(u.name, u.kind, u.direction, str(u.loc)) for u in uses]
    hints = [(h.data["name"], h.data["reason"], h.data["source"]) for h in found.hints]
    return rows, hints


def test_redis_pubsub_fixture() -> None:
    """Литерал, константа модуля и импортированного модуля (Python), константа пакета
    (nodeconst), константа пакета Go из другого файла, условный оператор с двумя литералами
    (две записи с одним основанием), подписка на несколько каналов и **{канал: обработчик}.
    Ловушки: SNS boto3 и pr_assets.publish у Python, emitter.publish у Node.js, pipeline.publish
    и publish! у Ruby, client.Subscribe в файле Go без go-redis каналами не становятся;
    подстановка и переменная дают подсказку о выражении, psubscribe с * подсказку о шаблоне."""
    rows, hints = _parse(FIXTURES / "redis-pubsub")
    assert rows == [
        ("orders:created", "channel", "publish", "api/app.py:11"),
        ("orders:local", "channel", "publish", "api/app.py:12"),
        ("orders:remote", "channel", "publish", "api/app.py:12"),
        ("orders:events", "channel", "publish", "api/app.py:14"),
        ("orders:cancel", "channel", "consume", "api/app.py:16"),
        ("orders:refund", "channel", "consume", "api/app.py:16"),
        ("timeline:public", "channel", "publish", "feed/app/feed.rb:3"),
        ("timeline:public:local", "channel", "publish", "feed/app/feed.rb:4"),
        ("timeline:public:remote", "channel", "publish", "feed/app/feed.rb:4"),
        ("timeline:direct", "channel", "consume", "feed/app/feed.rb:6"),
        ("notify:sent", "channel", "consume", "notifier/src/index.js:7"),
        ("orders:created", "channel", "consume", "notifier/src/index.js:7"),
        ("notify:local", "channel", "publish", "notifier/src/index.js:9"),
        ("notify:remote", "channel", "publish", "notifier/src/index.js:9"),
        ("relay:revoked", "channel", "publish", "relay/main.go:12"),
        ("relay:audit", "channel", "consume", "relay/main.go:13"),
        ("relay:events", "channel", "consume", "relay/main.go:13"),
    ]
    dynamic, pattern = texts.REASON_DYNAMIC_CHANNEL, texts.REASON_CHANNEL_PATTERN
    assert hints == [
        ("f'orders:{order}'", dynamic, "api/app.py:13"),
        ("orders:*", pattern, "api/app.py:17"),
        ("`notify:${id}`", dynamic, "notifier/src/index.js:10"),
        ("notify:*", pattern, "notifier/src/index.js:11"),
        ('"timeline:#{status.id}"', dynamic, "feed/app/feed.rb:5"),
        ("relay:*", pattern, "relay/main.go:15"),
        ("key", dynamic, "relay/main.go:17"),
    ]


def test_redis_cache_becomes_broker() -> None:
    """Кэш redis:7 становится брокером (форма broker, роль «брокер»): в него публикуют
    контейнеры-владельцы. Каналы kind: channel в таблице брокера, связи с каналом в обе
    стороны, потребители у подписчиков."""
    model = model_of(FIXTURES / "redis-pubsub")
    cache = next(o for o in model.objects if o.name == "cache")
    assert (cache.shape, cache.role, cache.technology) == (BROKER, "брокер", "Redis")
    assert {c.kind for c in model.channels["cache"].values()} == {"channel"}
    assert len(model.channels["cache"]) == 16
    links = {(lk.src.name, lk.dst.name, lk.label, lk.channel) for lk in model.links}
    assert ("api", "cache", "публикует", "orders:events") in links
    assert ("cache", "api", "доставляет", "orders:refund") in links
    assert ("feed", "cache", "публикует", "timeline:public:remote") in links
    assert ("cache", "relay", "доставляет", "relay:audit") in links
    assert ("relay", "cache", "публикует", "relay:revoked") in links
    assert not any(lk.label == texts.LABEL_USES for lk in model.links)
    assert [c.channel for c in model.consumers["notifier"]] == ["notify:sent", "orders:created"]


COMPOSE_SHARED = (
    "services:\n  web:\n    build: .\n    command: python web.py\n"
    "  jobs:\n    build: .\n    command: python jobs.py\n  cache:\n    image: redis:7\n"
)


def test_owner_less_record_does_not_switch(tmp_path: Path) -> None:
    """Файл в каталоге двух контейнеров с ролью «сервис»: владельца нет, кэш остаётся базой,
    запись уходит в подсказку с объектом и причиной владельца, канала у базы нет."""
    model = model_of(tree(tmp_path, {
        "docker-compose.yml": COMPOSE_SHARED,
        "Dockerfile": "FROM python:3.12\n",
        "requirements.txt": "redis\n",
        "events.py": "import redis\n\nr = redis.Redis()\nr.publish('orders:created', 1)\n",
    }))
    cache = next(o for o in model.objects if o.name == "cache")
    assert cache.shape == DATABASE
    assert "cache" not in model.channels
    hints = [h for h in model.hints["unassigned"] if h["kind"] == "channel"]
    assert hints == [{
        "kind": "channel", "name": "orders:created", "object": "cache",
        "reason": texts.REASON_MANY_OWNERS, "source": "events.py:4",
    }]


def test_no_redis_object_gives_hints(tmp_path: Path) -> None:
    """Объекта Redis в манифестах нет (n8n): брокер не заводится, запись даёт подсказку."""
    model = model_of(tree(tmp_path, {
        "docker-compose.yml": "services:\n  api:\n    build: .\n",
        "Dockerfile": "FROM python:3.12\n",
        "requirements.txt": "redis\n",
        "app.py": "import redis\n\nr = redis.Redis()\nr.publish('orders:created', 1)\n",
    }))
    assert [o.name for o in model.objects] == ["api"]
    hints = [h for h in model.hints["unassigned"] if h["kind"] == "channel"]
    assert hints == [{
        "kind": "channel", "name": "orders:created", "reason": texts.REASON_NO_BROKER,
        "source": "app.py:4",
    }]


def test_two_redis_objects_without_broker(tmp_path: Path) -> None:
    """Два кэша Redis, адреса в окружении нет: какой из них, не определить."""
    model = model_of(tree(tmp_path, {
        "docker-compose.yml": (
            "services:\n  api:\n    build: .\n  cache:\n    image: redis:7\n"
            "  sessions:\n    image: valkey/valkey:8\n"
        ),
        "Dockerfile": "FROM python:3.12\n",
        "requirements.txt": "redis\n",
        "app.py": "import redis\n\nr = redis.Redis()\nr.publish('orders:created', 1)\n",
    }))
    assert {o.shape for o in model.objects if o.technology == "Redis"} == {DATABASE}
    hints = [h for h in model.hints["unassigned"] if h["kind"] == "channel"]
    assert [h["reason"] for h in hints] == [texts.REASON_MANY_REDIS]


def test_receiver_traps(tmp_path: Path) -> None:
    """Получатель не клиент Redis: имя из импорта модуля репозитория (PostHog
    products/wizard/backend/facade/api.py:101 pubsub.subscribe(team_id, …)), client в файле
    Node.js без подключения Redis, publish другой библиотеки. Получатель с redis в имени,
    rdb, фабрика модуля Redis репозитория (from posthog.redis import get_client) и метод
    клиента (RedisHook(…).get_conn().pubsub() у Airflow, pipeline()) читаются, boto3.client нет."""
    rows, hints = _parse(tree(tmp_path, {
        "py/requirements.txt": "redis\n",
        "py/api.py": (
            "from redis.asyncio.client import PubSub\nfrom app.sessions import pubsub\n\n"
            "async def f(team_id):\n    async with pubsub.subscribe(team_id) as ps:\n"
            "        yield ps\n"
        ),
        "py/hook.py": (
            "from app.redis import get_client\n\nget_client().publish('reload-action', 1)\n"
            "rdb.publish('a', 1)\nself.cache.publish('b', 1)\n"
        ),
        "py/sensor.py": (
            "from airflow.providers.redis.hooks.redis import RedisHook\n\n"
            "hook = RedisHook(redis_conn_id=c).get_conn().pubsub()\nhook.subscribe(self.channels)\n"
            "pipe = RedisHook(c).get_conn().pipeline()\npipe.publish('piped', 1)\n"
            "sns = boto3.client('sns')\nsns.publish(TopicArn='t')\n"
        ),
        "js/package.json": '{"dependencies": {"ioredis": "*"}}',
        "js/plain.js": "client.publish('not-redis', 1);\nthis.redisPublisher.publish('x', 1);\n",
        "js/bus.ts": (
            "import { Redis } from 'ioredis';\nthis.client.publish(this.commandChannel, 1);\n"
            "this.client?.subscribe('y');\n"
        ),
    }))
    assert rows == [
        ("y", "channel", "consume", "js/bus.ts:3"),
        ("x", "channel", "publish", "js/plain.js:2"),
        ("reload-action", "channel", "publish", "py/hook.py:3"),
        ("a", "channel", "publish", "py/hook.py:4"),
        ("piped", "channel", "publish", "py/sensor.py:6"),
    ]
    assert [(h[0], h[2]) for h in hints] == [
        ("self.channels", "py/sensor.py:4"), ("this.commandChannel", "js/bus.ts:2"),
    ]


def test_client_blocks_and_pipelines() -> None:
    """Клиент, который вернул конвейер или транзакция (ТЗ §15 п. 19 В3). Ruby: параметр блока
    pipelined, multi и with на клиенте (и вложенного блока на таком параметре), параметр метода
    того же файла, который зовут из блока с этим параметром, вместе с if, модификатором if и
    блоком each внутри метода. Node.js: имя, которому присвоен .pipeline() или .multi()
    клиента (и через await). Python: pipe = r.pipeline(), with r.pipeline() as tx и async with
    (with до В3 клиента не давал). Ловушки: pipeline.publish после конца блока, метод с тем же
    параметром, который из блока не зовут, транзакция ActiveRecord, with на пуле не Redis,
    конвейер чужого объекта у Node.js, with open() у Python."""
    rows, hints = _parse(FIXTURES / "redis-blocks")
    assert rows == [
        ("orders:piped", "channel", "publish", "api/app.py:8"),
        ("orders:with", "channel", "publish", "api/app.py:10"),
        ("orders:async", "channel", "publish", "api/app.py:15"),
        ("timeline:pool", "channel", "publish", "feed/app/timeline.rb:11"),
        ("timeline:multi", "channel", "publish", "feed/app/timeline.rb:13"),
        ("timeline:nested", "channel", "publish", "feed/app/timeline.rb:16"),
        ("timeline:public", "channel", "publish", "feed/app/timeline.rb:25"),
        ("timeline:local", "channel", "publish", "feed/app/timeline.rb:27"),
        ("timeline:remote", "channel", "publish", "feed/app/timeline.rb:27"),
        ("timeline:local:only", "channel", "publish", "feed/app/timeline.rb:32"),
        ("jobs:done", "channel", "publish", "jobs/src/jobs.js:7"),
        ("jobs:tx", "channel", "publish", "jobs/src/jobs.js:9"),
    ]
    assert hints == [
        ('"timeline:hashtag:#{tag}"', texts.REASON_DYNAMIC_CHANNEL, "feed/app/timeline.rb:30"),
    ]
