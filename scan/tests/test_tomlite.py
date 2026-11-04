"""Чтение TOML: построчный разбор совпадает с tomllib по нужным ключам."""

from __future__ import annotations

import sys

import pytest

from archmap_scan import tomlite
from archmap_scan.parsers import manifests
from tests.helpers import FIXTURES

TOML_FIXTURES = (
    "manifests/api/pyproject.toml", "manifests/pipsvc/pyproject.toml",
    "manifests/pipsvc/Pipfile", "manifests/rs/Cargo.toml",
)


@pytest.mark.parametrize("rel", TOML_FIXTURES)
def test_lite_matches_full(rel: str, monkeypatch: pytest.MonkeyPatch) -> None:
    path = FIXTURES / rel
    text = path.read_text(encoding="utf-8")
    kind = manifests.kind_of(rel)
    assert kind is not None
    full = manifests._READERS[kind](rel, text)
    monkeypatch.setattr(sys, "version_info", (3, 10, 0, "final", 0))
    lite = manifests._READERS[kind](rel, text)
    assert (lite.name, lite.deps, lite.name_loc) == (full.name, full.deps, full.name_loc)


def test_lite_shapes() -> None:
    doc = tomlite.parse_lite(
        '[a]\nname = "x" # comment\nlist = [\n  "p", # c\n  \'q\',\n]\n'
        "inline = {k = 1, j = 2}\nbare = 42\n[\"b.c\"]\nkey = 'v'\n"
    )
    assert doc.get("a", "name") == "x"
    assert doc.get("a", "list") == ["p", "q"]
    assert doc.get("a", "inline") == {"k": "", "j": ""}
    assert doc.get("a", "bare") == "42"
    assert doc.get("b.c", "key") == "v"
    assert doc.line("a", "list") == 3 and doc.keys("missing") == []


def test_invalid_toml_falls_back_to_lite() -> None:
    doc = tomlite.parse('[project]\nname = "x"\nbroken = = =\n')
    assert doc.get("project", "name") == "x"
