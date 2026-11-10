import boto3
import redis

from channels import EVENTS

r = redis.Redis.from_url("redis://cache:6379/0")
TOPIC = "orders:created"


def publish(order, local, handler, pr_assets):
    r.publish(TOPIC, order)
    r.publish("orders:local" if local else "orders:remote", order)
    r.publish(f"orders:{order}", order)
    r.publish(EVENTS, order)
    p = r.pubsub()
    p.subscribe("orders:cancel", **{"orders:refund": handler})
    p.psubscribe("orders:*")
    sns = boto3.client("sns")
    sns.publish(TopicArn="arn", Message=order)
    pr_assets.publish("assets")
