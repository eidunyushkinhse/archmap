"""Маршруты FastAPI и Starlette (ТЗ §6.2): декораторы @app.get("/p") и @router.post,
APIRouter(prefix=), include_router(r, prefix=) в одном файле и по импорту, app.mount,
add_api_route, Route и Mount Starlette. Устройство разбора — pyroutes.py."""

from __future__ import annotations

import re

from archmap_scan import pyroutes
from archmap_scan.context import Context
from archmap_scan.model import Findings
from archmap_scan.walk import Files

NAME = "fastapi"
FRAMEWORKS = {"fastapi": "FastAPI", "starlette": "Starlette"}

FLAVOR = pyroutes.Flavor(
    parser=NAME,
    apps=frozenset({"FastAPI", "Starlette"}),
    routers=frozenset({"APIRouter"}),
    prefix_kw="prefix",
    include="include_router",
    overrides=False,
    methods=frozenset({"get", "post", "put", "patch", "delete", "head", "options", "trace"}),
    route_any=frozenset({"api_route", "route"}),
    add_rule="add_api_route",
    mount="mount",
    path_kws=("path",),
    needles=("fastapi", "starlette", "APIRouter", "include_router", "add_api_route"),
    decorator=re.compile(
        r"@[\w.]{1,200}\.(?:get|post|put|patch|delete|head|options|trace|api_route|route)\("
    ),
)


def parse(files: Files, ctx: Context) -> Findings:
    return pyroutes.parse(FLAVOR, files, ctx, FRAMEWORKS)
