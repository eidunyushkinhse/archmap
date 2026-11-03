"""Маршруты Flask (ТЗ §6.2): @app.route("/p", methods=[…]), @bp.get, Blueprint(url_prefix=),
register_blueprint(bp, url_prefix=) (префикс подключения заменяет свой, как у Flask),
add_url_rule. Устройство разбора — pyroutes.py."""

from __future__ import annotations

import re

from archmap_scan import pyroutes
from archmap_scan.context import Context
from archmap_scan.model import Findings
from archmap_scan.walk import Files

NAME = "flask"
FRAMEWORKS = {"flask": "Flask"}

FLAVOR = pyroutes.Flavor(
    parser=NAME,
    apps=frozenset({"Flask"}),
    routers=frozenset({"Blueprint"}),
    prefix_kw="url_prefix",
    include="register_blueprint",
    overrides=True,
    methods=frozenset({"get", "post", "put", "patch", "delete"}),
    route_any=frozenset({"route"}),
    add_rule="add_url_rule",
    mount=None,
    path_kws=("rule",),
    needles=("flask", "Blueprint", "register_blueprint", "add_url_rule"),
    decorator=re.compile(r"@[\w.]{1,200}\.(?:route|get|post|put|patch|delete)\("),
)


def parse(files: Files, ctx: Context) -> Findings:
    return pyroutes.parse(FLAVOR, files, ctx, FRAMEWORKS)
