"""Чтение YAML: номера строк, пределы против враждебного входа."""

from __future__ import annotations

import time

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
    started = time.perf_counter()
    doc = load("\n".join(lines))  # псевдонимы не копируются: документ маленький
    assert isinstance(doc, LineDict)
    many = "\n".join(f"k{i}: *a0" for i in range(1100))
    with pytest.raises(BadYaml):
        load("a0: &a0 [x]\n" + many)
    assert time.perf_counter() - started < 1.0


def test_merge_bomb() -> None:
    lines = ["m0: &m0 {a: 1}"]
    for i in range(1, 12):
        refs = ", ".join([f"*m{i - 1}"] * 10)
        lines.append(f"m{i}: &m{i} {{<<: [{refs}]}}")
    started = time.perf_counter()
    with pytest.raises(BadYaml):
        load("\n".join(lines))
    assert time.perf_counter() - started < 1.0


def test_deep_nesting_and_bad_syntax() -> None:
    started = time.perf_counter()
    with pytest.raises(BadYaml):
        load("[" * 5000 + "]" * 5000)
    with pytest.raises(BadYaml):
        load("a: [unclosed\n")
    with pytest.raises(BadYaml):
        load("? [a, b]\n: c\n")
    assert time.perf_counter() - started < 1.0
