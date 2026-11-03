from django.urls import path

from shop.views import health

urlpatterns = [path("extra/", health)]
