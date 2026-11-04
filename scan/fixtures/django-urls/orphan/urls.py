from django.urls import path

from shop.views import health

# Модуль никто не подключает: где он смонтирован, не известно.
urlpatterns = [path("lost/", health)]
