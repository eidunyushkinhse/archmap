"""Враждебный вход для яруса кода (ТЗ §9): строка в 2 МБ, правдоподобное начало перед ней
и глубокая вложенность в файле кода каждого языка. Каждый разборщик кода укладывается в
секунду и не падает. Манифесты дают все стеки сразу, чтобы разборщики файлы читали."""

from __future__ import annotations

import time
from pathlib import Path

import pytest

from archmap_scan import registry
from tests.helpers import files_of, tree

PAYLOAD = 2_000_000
A = "a" * PAYLOAD

MANIFESTS: dict[str, str | bytes] = {
    "py/requirements.txt": "fastapi\nflask\ndjango\n",
}

# Начала строк, после которых разборщик доходит до содержимого: имя файла → начала.
STARTS: dict[str, tuple[str, ...]] = {
    "py/app.py": (
        '@app.get("', "@app.route('", "@", "@a.", 'app.include_router(r, prefix="',
        'r = APIRouter(prefix="', 'urlpatterns = [path("', 'ROOT_URLCONF = "',
        "urlpatterns = [path('', include('",
    ),
}

CASES = [(name, start) for name, starts in STARTS.items() for start in starts]


def _check(root: Path) -> None:
    ctx, files = files_of(root)
    for spec in registry.PARSERS:
        if not spec.code:
            continue
        started = time.perf_counter()
        spec.parse(files, ctx)
        took = time.perf_counter() - started
        assert took < 1.0, f"{spec.name}: {took:.2f} с"


@pytest.mark.parametrize(("name", "start"), CASES)
def test_prefixed_line(tmp_path: Path, name: str, start: str) -> None:
    _check(tree(tmp_path, {**MANIFESTS, name: start + A + "\n"}))


@pytest.mark.parametrize("kind", ["line", "nested", "repeated"])
def test_whole_file(tmp_path: Path, kind: str) -> None:
    files: dict[str, str | bytes] = dict(MANIFESTS)
    for name, starts in STARTS.items():
        if kind == "line":
            files[name] = A
        elif kind == "nested":
            files[name] = "(" * (PAYLOAD // 2)
        else:  # одно и то же начало много раз подряд в одной строке
            unit = starts[0]
            files[name] = unit * (PAYLOAD // len(unit))
    _check(tree(tmp_path, files))


# Синтаксически верный код с литералом в 2 МБ: разбор доходит до ast и до вывода.
VALID: dict[str, str] = {
    "py/app.py": '@app.get("/' + A + '")\ndef f():\n    return 1\n',
}


@pytest.mark.parametrize("name", sorted(VALID))
def test_valid_code_with_huge_literal(tmp_path: Path, name: str) -> None:
    _check(tree(tmp_path, {**MANIFESTS, name: VALID[name]}))
