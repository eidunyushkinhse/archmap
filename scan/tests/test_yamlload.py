"""Чтение YAML: номера строк, пределы против враждебного входа."""

from __future__ import annotations

import pytest

from archmap_scan.yamlload import (
    MAX_YAML_BYTES,
    BadYaml,
    LineDict,
    LineList,
    YamlTooLarge,
    load,
    load_all,
)
from tests.helpers import timed


def test_lines() -> None:
    doc = load("a: 1\nb:\n  - x\n  - y\nc: {d: 2}\n")
    assert isinstance(doc, LineDict)
    assert doc.line == 1 and doc.line_of("b") == 2 and doc.line_of("nope") == 1
    b = doc["b"]
    assert isinstance(b, LineList) and b.line_at(1) == 4 and b.line_at(9) == b.line


def test_multi_documents_and_empty() -> None:
    assert len(load_all("a: 1\n---\nb: 2\n")) == 2
    assert load("") is None


def test_size_limit() -> None:
    with pytest.raises(YamlTooLarge):
        load("a: " + "x" * MAX_YAML_BYTES)


def test_alias_bomb() -> None:
    lines = ["a0: &a0 [x, x, x, x, x, x, x, x, x, x]"]
    for i in range(1, 9):
        refs = ", ".join([f"*a{i - 1}"] * 10)
        lines.append(f"a{i}: &a{i} [{refs}]")
    many = "\n".join(f"k{i}: *a0" for i in range(1100))

    def run() -> None:
        # В памяти псевдонимы не копируются, но любой обход значения раскрыл бы 10^9 элементов.
        with pytest.raises(BadYaml):
            load("\n".join(lines))
        with pytest.raises(BadYaml):
            load("a0: &a0 [x]\n" + many)
        with pytest.raises(BadYaml):
            load("a: &a [x, *a]\n")

    assert timed(run, 1.0)[1] < 1.0


def test_shared_anchors_within_limits() -> None:
    # Обычный приём compose: общий кусок настроек у многих сервисов.
    common = "x-common: &common {restart: always, environment: [A=1, B=2], labels: {a: b}}\n"
    services = "".join(f"  s{i}:\n    <<: *common\n    image: x\n" for i in range(200))
    doc = load(common + "services:\n" + services)
    assert isinstance(doc, LineDict)
    assert doc["services"]["s199"]["restart"] == "always"


def test_merge_bomb() -> None:
    lines = ["m0: &m0 {a: 1}"]
    for i in range(1, 12):
        refs = ", ".join([f"*m{i - 1}"] * 10)
        lines.append(f"m{i}: &m{i} {{<<: [{refs}]}}")
    def run() -> None:
        with pytest.raises(BadYaml):
            load("\n".join(lines))

    assert timed(run, 1.0)[1] < 1.0


def test_deep_nesting_and_bad_syntax() -> None:
    def run() -> None:
        with pytest.raises(BadYaml):
            load("[" * 5000 + "]" * 5000)
        with pytest.raises(BadYaml):
            load("a: [unclosed\n")
        with pytest.raises(BadYaml):
            load("? [a, b]\n: c\n")

    assert timed(run, 1.0)[1] < 1.0
