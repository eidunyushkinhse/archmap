"""Очереди фоновых задач в коде (ТЗ §15 п. 13): BullMQ на Node.js (В2) и Sidekiq на Ruby (В3).
Брокер очередей Redis, каналы и связи кладёт codefacts."""

from __future__ import annotations

from pathlib import Path

from archmap_scan import texts
from archmap_scan.model import Findings
from archmap_scan.parsers import bullmq, sidekiq
from tests.helpers import FIXTURES, files_of, model_of, tree

Row = tuple[str, str | None, str]


def _rows(found: Findings) -> list[Row]:
    uses = sorted(found.channels, key=lambda u: (u.loc, u.name, u.direction or ""))
    return [(u.name, u.direction, str(u.loc)) for u in uses]


def test_bullmq_queues() -> None:
    """BullMQ (В2): immich server/src/enum.ts:852 enum QueueName из 19 очередей, new Worker
    в server/src/repositories/job.repository.ts:94 по переменной цикла,
    BullModule.registerQueue в server/src/app.module.ts:77. Члены реестра дают очереди без
    направления, QueueName.X и QueueName['X'] в new Worker раскрываются, new Queue и
    @InjectQueue публикуют, @Processor потребляет, registerQueue объявляет. Ловушки: enum
    QueueJobStatus и JobName не реестры (член QueueJobStatus в new Queue уходит в подсказки),
    new Worker из node:worker_threads не потребитель, файл *.spec.ts не читается."""
    ctx, files = files_of(FIXTURES / "bullmq-queues")
    found = bullmq.parse(files, ctx)
    assert _rows(found) == [
        ("notifications", None, "server/src/app.module.ts:5"),
        ("reports", None, "server/src/app.module.ts:5"),
        ("reports", "consume", "server/src/app.module.ts:6"),
        ("exports", "publish", "server/src/app.module.ts:8"),
        ("thumbnailGeneration", None, "server/src/enum.ts:2"),
        ("metadataExtraction", None, "server/src/enum.ts:3"),
        ("notifications", None, "server/src/enum.ts:4"),
        ("mail-digest", None, "server/src/enum.ts:9"),
        ("hashed", "publish", "server/src/hash.ts:5"),
        ("exports", "publish", "server/src/jobs.ts:4"),
        ("thumbnailGeneration", "consume", "server/src/jobs.ts:6"),
        ("metadataExtraction", "consume", "server/src/jobs.ts:7"),
    ]
    dynamic = [(h.data["name"], h.data["source"]) for h in found.hints]
    assert dynamic == [
        ("queueName", "server/src/jobs.ts:8"), ("QueueJobStatus.Active", "server/src/jobs.ts:9"),
    ]
    assert bullmq.queue_enum("QueueName") and bullmq.queue_enum("MailQueues")
    assert not bullmq.queue_enum("QueueJobStatus") and not bullmq.queue_enum("JobName")
    model = model_of(FIXTURES / "bullmq-queues")
    assert sorted(model.channels["redis"]) == [
        "exports", "hashed", "mail-digest", "metadataExtraction", "notifications", "reports",
        "thumbnailGeneration",
    ]
    links = {(lk.src.name, lk.dst.name, lk.label, lk.channel) for lk in model.links}
    assert links == {
        ("server", "redis", "публикует", "exports"),
        ("server", "redis", "публикует", "hashed"),
        ("redis", "server", "доставляет", "thumbnailGeneration"),
        ("redis", "server", "доставляет", "metadataExtraction"),
        ("redis", "server", "доставляет", "reports"),
    }
    assert [c.channel for c in model.consumers["server"]] == [
        "metadataExtraction", "reports", "thumbnailGeneration",
    ]


def test_sidekiq_queues_and_schedule() -> None:
    """Sidekiq (В3): Mastodon config/sidekiq.yml:3–10 (:queues: списками [имя, вес] и
    [имя], ERB во вставке :concurrency:), раздел :scheduler: :schedule: с every списком и
    cron со вставкой ERB; классы app/workers/*.rb с include Sidekiq::Worker и
    sidekiq_options queue: 'pull' (app/workers/unmerge_worker.rb:7). Владелец потребителей
    и расписаний — контейнер, команда которого запускает sidekiq, а не web того же каталога.
    Ловушки: sidekiq_options retry: 0 без queue — очередь default; mailers из :queues: без
    воркеров — канал без связи; наследник класса воркера берёт его очередь, и одноимённые
    классы разных модулей различаются (Mastodon: DistributionWorker и
    ActivityPub::DistributionWorker < ActivityPub::RawDistributionWorker в app/workers/);
    очередь выражением уходит в подсказки; закомментированный include и perform_async не
    читаются. Очередь записи расписания (часть 2б, Ф3): Scheduler::VacuumScheduler без своей
    очереди потребляет scheduler из записи (Mastodon: классы Scheduler::*); ловушки: своя
    очередь PushUpdateWorker (push) сильнее записи, запись без queue: даёт очередь класса
    (Scheduler::CleanupScheduler — default)."""
    ctx, files = files_of(FIXTURES / "sidekiq-queues")
    found = sidekiq.parse(files, ctx)
    assert _rows(found) == [
        ("ingress", "consume", "app/workers/application_worker.rb:2"),
        ("ingress", "consume", "app/workers/application_worker.rb:6"),
        ("default", "consume", "app/workers/distribution.rb:3"),
        ("push", "consume", "app/workers/distribution.rb:7"),
        ("push", "consume", "app/workers/distribution.rb:11"),
        ("push", "consume", "app/workers/distribution.rb:14"),
        ("push", "consume", "app/workers/push_update_worker.rb:2"),
        ("default", "consume", "app/workers/scheduler/cleanup_scheduler.rb:3"),
        ("scheduler", "consume", "app/workers/scheduler/vacuum_scheduler.rb:3"),
        ("pull", "consume", "app/workers/unmerge_worker.rb:2"),
        ("default", None, "config/sidekiq.yml:4"),
        ("push", None, "config/sidekiq.yml:5"),
        ("mailers", None, "config/sidekiq.yml:6"),
        ("pull", None, "config/sidekiq.yml:7"),
        ("scheduler", None, "config/sidekiq.yml:8"),
    ]
    assert [(h.data["name"], h.data["source"]) for h in found.hints] == [
        ("QUEUE_NAME", "app/workers/application_worker.rb:10"),
    ]
    assert [(s.name, s.schedule, s.task, str(s.loc)) for s in found.schedules] == [
        ("cleanup_scheduler", "5m", "Scheduler::CleanupScheduler", "config/sidekiq.yml:11"),
        ("vacuum_scheduler", "<%= Random.rand(0..59) %> 3 * * *", "Scheduler::VacuumScheduler",
         "config/sidekiq.yml:14"),
        ("push_refresh", "1h", "PushUpdateWorker", "config/sidekiq.yml:19"),
    ]
    model = model_of(FIXTURES / "sidekiq-queues")
    assert sorted(model.channels["redis"]) == [
        "default", "ingress", "mailers", "pull", "push", "scheduler",
    ]
    links = {(lk.src.name, lk.dst.name, lk.label, lk.channel) for lk in model.links}
    assert links == {
        # «использует» sidekiq → redis вытеснена связями с каналом той же пары (ТЗ §15 п. 13
        # В1, часть 2б); у web связей с каналом нет, его «использует» остаётся.
        ("web", "redis", "использует", None),
        ("redis", "sidekiq", "доставляет", "default"),
        ("redis", "sidekiq", "доставляет", "ingress"),
        ("redis", "sidekiq", "доставляет", "pull"),
        ("redis", "sidekiq", "доставляет", "push"),
        ("redis", "sidekiq", "доставляет", "scheduler"),
    }
    assert len(model.consumers["sidekiq"]) == 10 and "web" not in model.consumers
    assert [s.name for s in model.schedules["sidekiq"]] == [
        "cleanup_scheduler", "vacuum_scheduler", "push_refresh",
    ]


def test_sidekiq_without_runner(tmp_path: Path) -> None:
    """Нет процесса, который запускает sidekiq: потребитель и расписание уходят в подсказки
    с причиной, канал остаётся у брокера. YAML, который не разбирается, читается построчно."""
    root = tree(tmp_path, {
        "Gemfile": 'gem "sidekiq"\n',
        "Dockerfile": "FROM ruby:3.3\n",
        "docker-compose.yml": (
            "services:\n  web:\n    build: .\n    command: bundle exec puma\n"
            "    depends_on: [redis]\n  redis:\n    image: redis:7\n"
        ),
        "config/sidekiq.yml": ":queues:\n  - [default, 8]\n  - 'pull'\n:broken: [\n",
        "app/workers/a_worker.rb": "class AWorker\n  include Sidekiq::Worker\nend\n",
    })
    ctx, files = files_of(root)
    assert _rows(sidekiq.parse(files, ctx)) == [
        ("default", "consume", "app/workers/a_worker.rb:2"),
        ("default", None, "config/sidekiq.yml:2"),
        ("pull", None, "config/sidekiq.yml:3"),
    ]
    model = model_of(root)
    assert sorted(model.channels["redis"]) == ["default", "pull"]
    hints = [h for h in model.hints["unassigned"] if h["kind"] == "edge"]
    assert hints == [{
        "kind": "edge", "name": "default", "object": "redis",
        "reason": texts.REASON_NO_RUNNER.format(program="sidekiq"),
        "source": "app/workers/a_worker.rb:2",
    }]
