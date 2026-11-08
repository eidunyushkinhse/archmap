from app.settings import get_from_env

QUEUE = get_from_env("WORKER_QUEUE", "default")
