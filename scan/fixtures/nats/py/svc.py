import nats


async def main(subject, handler):
    nc = await nats.connect("nats://nats:4222")
    await nc.subscribe("orders.*", cb=handler)
    await nc.publish("orders.created", b"")
    await nc.publish(subject, b"")
