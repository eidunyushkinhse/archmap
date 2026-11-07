"""Очереди фоновых задач в коде (ТЗ §15 п. 13): BullMQ на Node.js (В2) и Sidekiq на Ruby (В3).
Брокер очередей Redis, каналы и связи кладёт codefacts."""

from __future__ import annotations

from archmap_scan.model import Findings
from archmap_scan.parsers import bullmq
from tests.helpers import FIXTURES, files_of, model_of

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
        ("server", "redis", "использует", None),
        ("server", "redis", "публикует", "exports"),
        ("server", "redis", "публикует", "hashed"),
        ("redis", "server", "доставляет", "thumbnailGeneration"),
        ("redis", "server", "доставляет", "metadataExtraction"),
        ("redis", "server", "доставляет", "reports"),
    }
    assert [c.channel for c in model.consumers["server"]] == [
        "metadataExtraction", "reports", "thumbnailGeneration",
    ]
