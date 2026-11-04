from django.urls import path, re_path

from shop import views

urlpatterns = [
    path("cart/", views.cart),
    re_path(r"^checkout/$", views.checkout),
]
