CELERY_BEAT_SCHEDULE = {
    "cleanup": {"task": "proj.tasks.cleanup", "schedule": 3600},
}
