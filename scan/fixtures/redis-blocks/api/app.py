import redis

r = redis.Redis()


def notify(order):
    pipe = r.pipeline()
    pipe.publish("orders:piped", order)
    with r.pipeline() as tx:
        tx.publish("orders:with", order)


async def notify_async(order, client):
    async with client.pipeline() as atx:
        await atx.publish("orders:async", order)
    with open("x") as fh:
        fh.publish("trap:file", order)
