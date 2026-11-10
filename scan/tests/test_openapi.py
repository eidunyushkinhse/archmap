"""Файлы OpenAPI: опознание по имени и ключу версии, число операций, подсказка агенту."""

from __future__ import annotations

from functools import partial
from pathlib import Path
from typing import Any

import yaml

from archmap_scan import texts
from archmap_scan.parsers import openapi, served
from archmap_scan.scan import Options, run
from tests.helpers import FIXTURES, files_of, model_of, time_limit, timed, tree


def test_candidates() -> None:
    assert openapi.is_candidate("a/openapi.yaml")
    assert openapi.is_candidate("a/Swagger-v2.JSON")
    assert openapi.is_candidate("openapi.yml")
    assert not openapi.is_candidate("a/openapi.md")
    assert not openapi.is_candidate("a/my-openapi.yaml")


def test_fixture_and_hints(tmp_path: Path) -> None:
    ctx, files = files_of(FIXTURES / "openapi")
    found = openapi.parse(files, ctx)
    assert [(s.path, s.operations) for s in found.openapi] == [
        ("api/swagger.json", 1), ("services/orders/openapi.yaml", 3),
    ]
    assert [h.data["name"] for h in found.hints] == ["web/openapi.json"]

    out = tmp_path / "out"
    run(Options(path=str(FIXTURES / "openapi"), out=str(out), system="Ярмарка", use_git=False))
    hints = yaml.safe_load((out / "agent" / "hints.yaml").read_text(encoding="utf-8"))
    assert hints["openapi_files"] == [
        {
            # Вне каталога кода сервиса и без его имени в пути и заголовке (ТЗ §15 п. 14 З3).
            "kind": "openapi", "name": "api/swagger.json",
            "reason": texts.openapi_no_owner(["orders"], 0), "source": "api/swagger.json",
            "operations": 1,
        },
        {
            "kind": "openapi", "name": "services/orders/openapi.yaml", "object": "orders",
            "reason": texts.REASON_OPENAPI_FILE, "source": "services/orders/openapi.yaml",
            "operations": 3,
        },
    ]


def test_too_large_and_hostile(tmp_path: Path) -> None:
    tree(tmp_path, {
        "big/openapi.yaml": "openapi: 3.0.0\npaths:\n" + "  /p{0}: {{get: {{}}}}\n" * 40_000,
        "deep/openapi.json": "[" * 1_000_000,
        "line/openapi.yaml": "x" * 2_000_000,
    })
    ctx, files = files_of(tmp_path)
    found, took = timed(partial(openapi.parse, files, ctx), 1.0)
    assert took < 1.0
    assert [(s.path, s.operations) for s in found.openapi] == [("big/openapi.yaml", None)]
    assert [h.data["name"] for h in found.hints] == ["deep/openapi.json"]


def test_paths_by_file_refs(tmp_path: Path) -> None:
    """Находка фазы 1а на Sentry: api-docs/openapi.json, 0 операций, потому что пути —
    ссылки $ref на paths/*.json. Ссылки на файлы репозитория разворачиваются на один
    уровень; неразворачиваемая ссылка — операции не посчитаны, причина в подсказке. Каталог
    api-docs с ТЗ §15 п. 12 С3 исключается соглашением (docs частью сегмента), поэтому в
    дереве теста он называется api-spec."""
    import json

    tree(tmp_path, {
        "api-spec/openapi.json": json.dumps({"openapi": "3.0.0", "paths": {
            "/a/": {"$ref": "paths/a.json"},
            "/b/": {"$ref": "paths/b.json#/item"},
            "/c/": {"$ref": "#/components/pathItems/c"},
            "/d/": {"get": {}},
        }, "components": {"pathItems": {"c": {"put": {}, "summary": "x"}}}}),
        "api-spec/paths/a.json": json.dumps({"get": {}, "post": {}, "parameters": []}),
        "api-spec/paths/b.json": json.dumps({"item": {"delete": {}}}),
        "whole/openapi.yaml": "openapi: 3.1.0\npaths:\n  $ref: ./routes.yaml\n",
        "whole/routes.yaml": "/x:\n  get: {}\n  patch: {}\n",
        "broken/openapi.yaml": (
            "openapi: 3.0.0\npaths:\n  /a:\n    $ref: missing.yaml\n  /b:\n    get: {}\n"
        ),
        "remote/openapi.yaml": "openapi: 3.0.0\npaths:\n  /a:\n    $ref: https://x/y.yaml\n",
        "chain/openapi.yaml": "openapi: 3.0.0\npaths:\n  /a:\n    $ref: one.yaml\n",
        "chain/one.yaml": "$ref: two.yaml\n",
        "chain/two.yaml": "get: {}\n",
    })
    ctx, files = files_of(tmp_path)
    found = openapi.parse(files, ctx)
    got = {s.path: (s.operations, s.reason) for s in found.openapi}
    refs = "пути заданы ссылками, которые не удалось развернуть, операции не посчитаны"
    assert got == {
        "api-spec/openapi.json": (5, None),
        "whole/openapi.yaml": (2, None),
        "broken/openapi.yaml": (None, refs),
        "remote/openapi.yaml": (None, refs),
        # Один уровень, без рекурсии: ссылка из целевого файла не разворачивается.
        "chain/openapi.yaml": (None, refs),
    }
    out = tmp_path / "out"
    run(Options(path=str(tmp_path), out=str(out), use_git=False))
    hints = yaml.safe_load((out / "agent" / "hints.yaml").read_text(encoding="utf-8"))
    assert {
        "kind": "openapi", "name": "broken/openapi.yaml", "reason": refs,
        "source": "broken/openapi.yaml",
    } in hints["openapi_files"]


def test_ref_file_limit(tmp_path: Path) -> None:
    files_map: dict[str, str | bytes] = {
        "api/openapi.yaml": "openapi: 3.0.0\npaths:\n" + "".join(
            f"  /p{i}:\n    $ref: p/{i}.yaml\n" for i in range(openapi.MAX_REF_FILES + 1)
        ),
    }
    for i in range(openapi.MAX_REF_FILES + 1):
        files_map[f"api/p/{i}.yaml"] = "get: {}\n"
    tree(tmp_path, files_map)
    ctx, files = files_of(tmp_path)
    found, took = timed(partial(openapi.parse, files, ctx), 2.0)
    assert took < 2.0
    [spec] = found.openapi
    assert spec.operations is None and spec.reason is not None


def test_openapi_in_docs_dir(tmp_path: Path) -> None:
    """Файл OpenAPI в каталоге документации (ТЗ §15 п. 13 Д2): Sentry api-docs/openapi.json с
    путями ссылками на api-docs/paths/*.json исключён правилом С3а, но подсказка
    openapi_files нужна. Каталог остаётся исключённым в покрытии, ссылки внутри него
    разворачиваются, причина называет каталог документации. Ловушки: docs/examples и
    tests/fixtures не читаются; Dockerfile в docs/ объектом не становится."""
    ctx, files = files_of(FIXTURES / "openapi-docs")
    found = openapi.parse(files, ctx)
    assert [(s.path, s.operations, s.in_docs) for s in found.openapi] == [
        ("openapi.yaml", 1, False), ("api-docs/openapi.json", 2, True),
    ]
    out = tmp_path / "out"
    run(Options(path=str(FIXTURES / "openapi-docs"), out=str(out), system="Ярмарка",
                use_git=False))
    hints = yaml.safe_load((out / "agent" / "hints.yaml").read_text(encoding="utf-8"))
    assert [(h["name"], h["reason"]) for h in hints["openapi_files"]] == [
        ("api-docs/openapi.json", texts.REASON_OPENAPI_DOCS),
        ("openapi.yaml", texts.REASON_OPENAPI_FILE),
    ]
    cov = yaml.safe_load((out / "coverage.yaml").read_text(encoding="utf-8"))
    assert {"path": "api-docs/", "files": 2, "reason": "convention"} in cov["excluded"]
    schema = yaml.safe_load((out / "schema.yaml").read_text(encoding="utf-8"))
    assert not schema["nodes"][0].get("children")


def test_operations_become_routes(tmp_path: Path) -> None:
    """Операции файла OpenAPI — маршруты объекта, который его отдаёт (ТЗ §15 п. 14 З3).
    Найдено в Argo CD: assets/swagger.json, 82 пути и 106 операций только в
    hints.openapi_files. Владелец: файл в каталоге кода одного сервиса (orders), иначе
    ровно у одного из сервисов каталога имя или слово команды в пути, info.title или
    servers (search по заголовку «Search service»). Ловушки: два сервиса одного каталога
    без совпадения имени (подсказка с перечнем); файл клиента чужого API (servers на
    внешнем домене) маршрутами не становится; адрес на внешнем домене рядом со своим «/»
    файл чужим не делает; путь, уже найденный в коде (<int:order_id> и {order_id}), даёт
    одну запись с двумя основаниями."""
    out = tmp_path / "out"
    run(Options(path=str(FIXTURES / "openapi-entrypoints"), out=str(out), system="Ярмарка",
                use_git=False))
    entry = yaml.safe_load(
        (out / "agent" / "entrypoints.yaml").read_text(encoding="utf-8"),
    )["containers"]
    assert entry["orders"]["http"] == [
        {"method": "GET", "path": "/orders", "framework": "openapi",
         "source": "orders/openapi.yaml:9"},
        {"method": "POST", "path": "/orders", "framework": "openapi",
         "source": "orders/openapi.yaml:9"},
        {"method": "GET", "path": "/orders/<int:order_id>", "framework": "Flask",
         "source": "orders/app.py:6", "openapi_source": "orders/openapi.yaml:14"},
    ]
    assert entry["search"]["http"] == [
        {"method": "GET", "path": "/items", "framework": "openapi",
         "source": "store/openapi.json:6"},
        {"method": "DELETE", "path": "/items/{id}", "framework": "openapi",
         "source": "store/openapi.json:9"},
        {"method": "GET", "path": "/items/{id}", "framework": "openapi",
         "source": "store/openapi.json:9"},
    ]
    assert entry["billing"]["http"] == entry["ledger"]["http"] == entry["inventory"]["http"] == []
    hints = yaml.safe_load((out / "agent" / "hints.yaml").read_text(encoding="utf-8"))
    assert [(h["name"], h.get("object"), h["reason"]) for h in hints["openapi_files"]] == [
        ("orders/clients/openapi-payments.yaml", None, texts.REASON_OPENAPI_FOREIGN),
        ("orders/openapi.yaml", "orders", texts.REASON_OPENAPI_FILE),
        ("shared/openapi.yaml", None, texts.openapi_no_owner(["billing", "ledger"], 0)),
        ("store/openapi.json", "search", texts.REASON_OPENAPI_FILE),
    ]
    coverage = yaml.safe_load((out / "coverage.yaml").read_text(encoding="utf-8"))
    routes = coverage["families"]["http_routes"]
    assert (routes["found"], routes["parsers"]) == (6, ["openapi", "flask"])


def test_operations_hostile_is_fast(tmp_path: Path) -> None:
    """Враждебный файл OpenAPI у сервиса: 40 000 путей с параметрами (в маршруты идут
    первые 10 000), длинные адреса servers и параметры пути без конца. Строки ключей JSON —
    один проход по тексту, сравнение с маршрутами кода — по словарю."""
    paths = ",\n".join(f'"/p{i}/{{id}}/:x<y": {{"get": {{}}}}' for i in range(40_000))
    tree(tmp_path, {
        "compose.yaml": "services:\n  big:\n    build: ./big\n",
        "big/openapi.json": (
            '{"openapi": "3.0.0", "servers": [{"url": "https://' + "a." * 200_000 + '"},'
            ' {"url": "/' + "{" * 200_000 + '"}], "paths": {' + paths + "}}"
        ),
    })
    model, took = timed(partial(model_of, tmp_path), time_limit() * 2)
    assert took < time_limit() * 2, f"{took:.2f} с"
    assert len(model.http["big"]) == openapi.MAX_OPS


def _served_run(root: Path, out: Path) -> tuple[dict[str, Any], list[tuple[object, ...]]]:
    run(Options(path=str(root), out=str(out), use_git=False))
    entry = yaml.safe_load((out / "agent" / "entrypoints.yaml").read_text(encoding="utf-8"))
    hints = yaml.safe_load((out / "agent" / "hints.yaml").read_text(encoding="utf-8"))
    return entry["containers"], [
        (h["name"], h.get("object"), h["reason"]) for h in hints["openapi_files"]
    ]


def _served_files() -> dict[str, str | bytes]:
    src = FIXTURES / "openapi-served"
    return {
        str(p.relative_to(src)): p.read_text(encoding="utf-8") for p in src.rglob("*") if p.is_file()
    }


def test_served_literals() -> None:
    """Литерал с именем файла OpenAPI (ТЗ §15 п. 15 Н1): "/swagger.json" и
    "assets/swagger.json" в коде Go считаются, имя в комментарии нет; у файла Go собраны
    файлы, импортирующие его пакет."""
    ctx, files = files_of(FIXTURES / "openapi-served")
    found = served.parse(files, ctx)
    assert [(r.name, str(r.loc), r.importers) for r in found.served] == [
        ("swagger.json", "util/swagger/swagger.go:7", ("cmd/api/main.go",)),
        ("swagger.json", "util/swagger/swagger.go:8", ("cmd/api/main.go",)),
    ]


def test_served_owner(tmp_path: Path) -> None:
    """Файл OpenAPI в каталоге кода двух сервисов без совпадения имени: владелец тот сервис,
    чей код (по Ф1 cmd/api) импортирует пакет кода, который называет файл; имя файла в
    комментарии кода второго сервиса (jobs/) не считается."""
    entry, hints = _served_run(FIXTURES / "openapi-served", tmp_path / "out")
    assert [(e["method"], e["path"], e["source"]) for e in entry["api"]["http"]] == [
        ("GET", "/orders", "assets/swagger.json:5"),
        ("GET", "/orders/{id}", "assets/swagger.json:6"),
    ]
    assert entry["admin"]["http"] == []
    assert hints == [("assets/swagger.json", "api", texts.REASON_OPENAPI_FILE)]


def test_served_many_and_chain(tmp_path: Path) -> None:
    """Пакет импортируют программы двух сервисов: подсказка с перечислением. Цепочка через
    общий пакет (util/swagger → server → cmd/api) и пересечение по двум литералам: второй
    файл кода с именем (util/assets) нужен обоим сервисам, первый только api."""
    base = _served_files()
    admin = 'package main\n\nimport "example.com/shop/util/swagger"\n\nfunc main() {}\n'
    tree(tmp_path / "many", {**base, "cmd/admin/main.go": admin})
    entry, hints = _served_run(tmp_path / "many", tmp_path / "o1")
    assert entry["api"]["http"] == [] and entry["admin"]["http"] == []
    assert hints == [
        ("assets/swagger.json", None, texts.openapi_served_many(["admin", "api"], 0)),
    ]
    chain: dict[str, str | bytes] = {
        **base,
        "cmd/api/main.go": 'package main\n\nimport "example.com/shop/server"\n\nfunc main() {}\n',
        "cmd/admin/main.go": (
            'package main\n\nimport "example.com/shop/util/rbac"\n\nfunc main() {}\n'
        ),
        "server/server.go": (
            'package server\n\nimport (\n\t"example.com/shop/util/assets"\n'
            '\t"example.com/shop/util/swagger"\n)\n\nfunc Run() {}\n'
        ),
        "util/rbac/rbac.go": (
            'package rbac\n\nimport "example.com/shop/util/assets"\n\nfunc Can() {}\n'
        ),
        "util/assets/assets.go": 'package assets\n\nvar Spec = "swagger.json"\n',
    }
    tree(tmp_path / "chain", chain)
    entry, hints = _served_run(tmp_path / "chain", tmp_path / "o2")
    assert len(entry["api"]["http"]) == 2 and entry["admin"]["http"] == []
    assert hints == [("assets/swagger.json", "api", texts.REASON_OPENAPI_FILE)]


def test_served_needs_unique_name(tmp_path: Path) -> None:
    """Два файла OpenAPI с одним базовым именем: литерал не говорит, какой из них отдают,
    владелец по коду не ищется."""
    base = _served_files()
    tree(tmp_path / "r", {**base, "other/swagger.json": base["assets/swagger.json"]})
    entry, hints = _served_run(tmp_path / "r", tmp_path / "o")
    assert entry["api"]["http"] == []
    assert [h[1] for h in hints] == [None, None]
