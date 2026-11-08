"""Маршруты actix-web (ТЗ §15 п. 15 К3): `.route`, `web::resource`, вложенные `web::scope` по
парным скобкам маски и атрибуты обработчиков. Ловушки: вызов в комментарии, путь через
`format!`, scope с путём из переменной, модуль тестов."""

from __future__ import annotations

from pathlib import Path

from archmap_scan import registry, stats, texts
from archmap_scan.parsers import actix
from tests.helpers import FIXTURES, files_of, model_of, tree

CARGO = '[package]\nname = "x"\n\n[dependencies]\nactix-web = "4"\n'


def _routes(root: Path) -> list[tuple[str, str, bool, str]]:
    ctx, files = files_of(root)
    found = actix.parse(files, ctx)
    return sorted((r.method, r.path, r.prefix_unresolved, str(r.loc)) for r in found.routes)


def test_fixture() -> None:
    main = "src/main.rs"
    assert _routes(FIXTURES / "actix-routes") == [
        # .to(h) прямо на ресурсе и web::method(…) — любой метод.
        ("ANY", "/any", False, f"{main}:41"),
        ("ANY", "/text", False, f"{main}:45"),
        # По записи на каждый .route ресурса.
        ("DELETE", "/x", False, f"{main}:39"),
        # Путь без «/» в начале идёт от корня.
        ("GET", "/.well-known/webfinger", False, f"{main}:18"),
        # Вложенные scope складываются по скобкам, «""» — путь самого scope.
        ("GET", "/api/v3/icon", False, f"{main}:34"),
        ("GET", "/api/v3/post", False, f"{main}:31"),
        # Атрибут обработчика: путь как написан, без префикса.
        ("GET", "/health", False, f"{main}:5"),
        ("GET", "/multi", False, f"{main}:10"),
        ("GET", "/nodeinfo", False, f"{main}:17"),
        # scope с путём из переменной: префикс не решён.
        ("GET", "/unresolved", True, f"{main}:44"),
        ("GET", "/x", False, f"{main}:38"),
        ("HEAD", "/multi", False, f"{main}:10"),
        ("POST", "/api/v3/post/list", False, f"{main}:32"),
        # Константа файла раскрывается.
        ("PUT", "/admin/users", False, f"{main}:42"),
    ]


def test_fixture_hints() -> None:
    """format! и переменная — подсказки о динамическом пути; вызов в комментарии и в модуле
    тестов не читается."""
    ctx, files = files_of(FIXTURES / "actix-routes")
    found = actix.parse(files, ctx)
    assert [(h.section, h.data["name"], h.data["reason"], h.data["source"]) for h in found.hints] == [
        ("dynamic_names", '&format!("/{}/dynamic", version)', texts.REASON_DYNAMIC_ROUTE,
         "src/main.rs:43"),
        ("dynamic_names", "version", texts.REASON_DYNAMIC_ROUTE, "src/main.rs:44"),
    ]
    paths = {r.path for r in found.routes}
    assert "/commented" not in paths and "/from-test" not in paths


def test_owner_and_coverage() -> None:
    """Маршруты у контейнера крейта, семья покрыта: Rust с actix-web не назван."""
    model = model_of(FIXTURES / "actix-routes")
    assert [len(v) for v in model.http.values()] == [14]
    assert {e.framework for v in model.http.values() for e in v} == {"actix-web"}
    ctx, files = files_of(FIXTURES / "actix-routes")
    found, errors = registry.collect(files, ctx)
    assert errors == {}
    assert "http_routes" not in stats.code_unsupported(found)


def test_without_actix_not_read(tmp_path: Path) -> None:
    """Крейт без actix-web не читается: `.route("/a", get(h))` у axum не маршрут actix, axum
    назван в непрочитанных маршрутах, а библиотечный крейт без серверного фреймворка
    языком не назван (vocab.UNSUPPORTED_ROUTE_DEPS)."""
    tree(tmp_path, {
        "Cargo.toml": '[package]\nname = "x"\n\n[dependencies]\naxum = "0.7"\n',
        "src/main.rs": 'fn main() { Router::new().route("/a", get(h)); }\n',
        "lib/Cargo.toml": '[package]\nname = "db"\n\n[dependencies]\ndiesel = "2"\n',
    })
    ctx, files = files_of(tmp_path)
    found = actix.parse(files, ctx)
    assert found.routes == [] and actix.NAME not in found.applied
    collected, _ = registry.collect(files, ctx)
    assert stats.code_unsupported(collected)["http_routes"] == ["Rust: axum"]


def test_chains(tmp_path: Path) -> None:
    """Цепочка scope кончается на «,» и «;» своего уровня: соседний вызов префикса не
    получает. Замыкание в configure наследует префикс, имена без web:: читаются, `fn
    scope(` — не вызов."""
    tree(tmp_path, {
        "Cargo.toml": CARGO,
        "src/lib.rs": (
            "use actix_web::web::*;\n"
            "fn scope(x: &str) {}\n"
            "pub fn config(cfg: &mut ServiceConfig) {\n"
            '  cfg.service(scope("/a").route("/b", get().to(h)))\n'
            '    .route("/c", post().to(h));\n'
            '  cfg.service(scope("/d").configure(|c| { c.route("/e", put().to(h)); }));\n'
            '  let s = scope("/f");\n'
            '  cfg.route("/g", patch().to(h));\n'
            "}\n"
        ),
    })
    assert _routes(tmp_path) == [
        ("GET", "/a/b", False, "src/lib.rs:4"),
        ("PATCH", "/g", False, "src/lib.rs:8"),
        ("POST", "/c", False, "src/lib.rs:5"),
        ("PUT", "/d/e", False, "src/lib.rs:6"),
    ]


def test_limits(tmp_path: Path) -> None:
    """Больше 5000 записей в файле — файл непрочитан, записей из него нет."""
    tree(tmp_path, {
        "Cargo.toml": CARGO,
        "src/main.rs": "cfg" + '.route("/a", web::get().to(h))\n' * 5001 + ";\n",
        "src/other.rs": 'cfg.route("/b", web::get().to(h));\n',
    })
    ctx, files = files_of(tmp_path)
    found = actix.parse(files, ctx)
    assert [r.path for r in found.routes] == ["/b"]
    assert files.too_large == {"src/main.rs"}
