from django.urls import include, path, re_path
from rest_framework.routers import DefaultRouter

from mysite import extra_urls
from shop.views import OrderViewSet, health

router = DefaultRouter()
router.register(r"orders", OrderViewSet, basename="order")

api_patterns = [
    path("items/<int:pk>/", health),
    re_path(r"^legacy/(?P<slug>[-\w]+)/$", health),
]

urlpatterns = [
    path("", health),
    path("shop/", include("shop.urls")),
    path("api/v1/", include(api_patterns)),
    path("api/", include(router.urls)),
    path("inline/", include([path("a/", health), path("b/", health)])),
]
urlpatterns += extra_urls.urlpatterns

NAME = "dyn/"
# Путь не строкой: маршрут уходит в подсказки.
urlpatterns.append(path(NAME, health))
# path("commented/", health) — строка в комментарии маршрутом не считается.
