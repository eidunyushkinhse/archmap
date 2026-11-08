import os


def get_from_env(key, default=None):
    return os.environ.get(key, default)
