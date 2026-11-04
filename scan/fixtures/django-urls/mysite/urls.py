from django.urls import include, path, re_path
from rest_framework.routers import DefaultRouter

from mysite import extra_urls
from shop.routing import api_path
from shop.views import OrderViewSet, cart, health

router = DefaultRouter()
router.register(r"orders", OrderViewSet, basename="order")

api_patterns = [
    path("items/<int:pk>/", health),
    re_path(r"^legacy/(?P<slug>[-\w]+)/$", health),
]


def health_path(name):
    # Путь литералом, а не параметром: это не обёртка, её вызов маршрутом не считается.
    return path("health/", health, name=name)


CART = "<int:pk>/"
# Обёртка из shop/routing.py: маршрут на каждый метод; список подключён дважды.
rest_patterns = [
    api_path("carts/", GET=cart, POST=cart),
    api_path("carts/<int:pk>/", DELETE=(cart, {"flag"})),
    health_path("hc"),
    api_path("carts/" + CART, PATCH=cart),
]

urlpatterns = [
    path("", health),
    path("shop/", include("shop.urls")),
    path("api/v1/", include(api_patterns)),
    path("api/", include(router.urls)),
    path("inline/", include([path("a/", health), path("b/", health)])),
    path("api/v1/", include(rest_patterns)),
    path("json/", include(rest_patterns)),
]
urlpatterns += extra_urls.urlpatterns

NAME = "dyn/"
# Путь не строкой: маршрут уходит в подсказки.
urlpatterns.append(path(NAME, health))
# path("commented/", health) — строка в комментарии маршрутом не считается.
