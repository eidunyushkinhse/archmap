from django.urls import path

from shop.views import dispatch


def api_path(route, **handlers):
    # Обёртка регистрации, как rest_path у Zulip: методы приходят именованными аргументами.
    return path(route, dispatch, handlers)
