"""Адреса объектов литералами в коде Java и Kotlin (ТЗ §15 п. 17 С2): связь контейнера
модуля к объекту по хосту литерала; для других языков правило не действует."""

from __future__ import annotations

from pathlib import Path

from archmap_scan import texts
from archmap_scan.parsers import jvmaddr
from tests.helpers import FIXTURES, files_of, model_of, tree

ROOT = FIXTURES / "jvm-address"
WEB = "web/src/main/java/shop/Web.java"
WORKER = "worker/src/main/kotlin/shop/Worker.kt"
POM = "<project><artifactId>x</artifactId></project>\n"
COMPOSE = "services:\n  a:\n    build: ./a\n  b:\n    image: x/b\n"


def _links(root: Path) -> list[tuple[str, str, str | None, list[str]]]:
    model = model_of(root)
    return [
        (lk.src.name, lk.dst.name, lk.technology, sorted(str(loc) for loc in lk.locs))
        for lk in model.links
    ]


def test_fixture_links() -> None:
    """http и lb, один объект-цель на пару даёт одну связь со всеми основаниями; хост с
    точкой, localhost, порт, хост не объект, сам контейнер, адрес внутри текста, комментарии,
    литералы тестов и шаблоны Kotlin связей не дают."""
    assert _links(ROOT) == [
        ("web", "helper", "HTTP", [f"{WEB}:6", f"{WEB}:8"]),
        ("web", "worker", "HTTP", [f"{WEB}:5", f"{WEB}:7"]),
        ("worker", "web", "HTTP", [f"{WORKER}:3"]),
    ]


def test_fixture_no_hints() -> None:
    """Хост, который не объект схемы, ни связи, ни подсказки: адрес литералом в коде
    чаще внешний, чем пропущенный объект."""
    model = model_of(ROOT)
    assert [h for h in model.hints.get("unassigned", []) if h["kind"] == "edge"] == []
    assert "jvm-address" in model.code_parsers["edges"]


def test_without_owner(tmp_path: Path) -> None:
    """Литерал вне каталогов кода контейнеров: подсказка о владельце, а не связь."""
    tree(tmp_path, {
        "compose.yaml": COMPOSE.replace("build: ./a", "image: x/a"),
        "lib/pom.xml": POM,
        "lib/src/main/java/L.java": 'class L { String u = "http://b/"; }\n',
    })
    model = model_of(tmp_path)
    assert model.links == []
    hints = [h for h in model.hints.get("unassigned", []) if h["kind"] == "edge"]
    assert [(h["name"], h["reason"]) for h in hints] == [("b", texts.REASON_SHARED_LIB)]


def test_other_languages(tmp_path: Path) -> None:
    """Python, Go и JavaScript с тем же литералом связей не дают: правило только для Java и
    Kotlin."""
    tree(tmp_path, {
        "compose.yaml": COMPOSE,
        "a/requirements.txt": "requests\n",
        "a/app.py": 'URL = "http://b/x"\n',
        "a/go.mod": "module a\n",
        "a/main.go": 'package main\nvar u = "http://b/x"\n',
        "a/package.json": "{}\n",
        "a/app.js": 'const u = "http://b/x";\n',
    })
    assert _links(tmp_path) == []


def test_literal_forms(tmp_path: Path) -> None:
    """Сырая строка Kotlin с адресом целиком и запрос «?» после хоста дают связь; адрес
    после экранированной кавычки, текстовый блок Java и хост с пробелом не дают."""
    tree(tmp_path, {
        "compose.yaml": COMPOSE,
        "a/build.gradle.kts": 'plugins { kotlin("jvm") }\n',
        "a/src/main/kotlin/A.kt": (
            'val a = """http://b/"""\nval q = "http://b?x=1"\nval e = "x\\"http://b/\\""\n'
            'val s = "http://b c/"\n'
        ),
        "a/src/main/java/A.java": 'class A { String t = """\n  http://b/\n  """; }\n',
    })
    assert _links(tmp_path) == [
        ("a", "b", "HTTP", ["a/src/main/kotlin/A.kt:1", "a/src/main/kotlin/A.kt:2"]),
    ]


def test_budget(tmp_path: Path) -> None:
    """Больше 2000 адресов в файле (враждебный вход): файл непрочитан, связей из него нет."""
    many = "".join(f'  String u{i} = "http://h{i}/";\n' for i in range(2001))
    tree(tmp_path, {
        "m/pom.xml": POM,
        "m/src/main/java/M.java": "class M {\n" + many + "}\n",
        "m/src/main/java/N.java": 'class N { String u = "http://h/"; }\n',
    })
    ctx, files = files_of(tmp_path)
    found = jvmaddr.parse(files, ctx)
    assert [(lk.host, str(lk.loc)) for lk in found.path_links] == [
        ("h", "m/src/main/java/N.java:1"),
    ]
    assert "m/src/main/java/M.java" in files.too_large
