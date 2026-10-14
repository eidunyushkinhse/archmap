"""Быстрый YAML (app/yaml_io.py): те же объекты и те же ошибки, что у yaml.safe_*."""

import pytest
import yaml

from app import yaml_io

DOC = """
tables:
  - name: orders
    schema: public
    columns:
      - {name: id, type: uuid, pk: true}
      - {name: note, type: text, description: "двоеточие: в кавычках"}
"""


def test_разбор_совпадает_с_safe_load() -> None:
    assert yaml_io.safe_load(DOC) == yaml.safe_load(DOC)


def test_ошибка_разбора_с_текстом_чистого_разборщика() -> None:
    broken = "tables:\n  - name: a\n    actor: кто перевёл: user\n"
    with pytest.raises(yaml.YAMLError) as ours:
        yaml_io.safe_load(broken)
    with pytest.raises(yaml.YAMLError) as theirs:
        yaml.safe_load(broken)
    assert str(ours.value) == str(theirs.value)


def test_выгрузка_совпадает_с_safe_dump() -> None:
    doc = yaml.safe_load(DOC)
    kw = {"allow_unicode": True, "sort_keys": False, "default_flow_style": False}
    assert yaml_io.safe_dump(doc, **kw) == yaml.safe_dump(doc, **kw)
