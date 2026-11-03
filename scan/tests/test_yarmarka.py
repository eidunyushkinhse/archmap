"""Фикстура «Ярмарка» (ТЗ §9): вывод байт в байт, ловушки, секреты, детерминизм, git.

Ожидаемый вывод лежит в fixtures/yarmarka.expected/. После осознанной правки вывода:
UPDATE_SCAN_EXPECTED=1 ./venv/bin/python -m pytest tests/test_yarmarka.py, затем
git diff scan/fixtures/yarmarka.expected/ (это ревью правки) и коммит вместе с ней.
"""

from __future__ import annotations

import os
import shutil
from pathlib import Path

import pytest

from archmap_scan import secrets
from archmap_scan.parsers import envexample
from archmap_scan.scan import Options, run
from tests.helpers import FIXTURES, git

FIXTURE = FIXTURES / "yarmarka"
EXPECTED = FIXTURES / "yarmarka.expected"
REPO = "https://github.com/org/yarmarka.git"


def scan(path: Path, out: Path, *, use_git: bool = False) -> Path:
    run(Options(path=str(path), out=str(out), system="Ярмарка", use_git=use_git))
    return out


def tree_bytes(root: Path) -> dict[str, bytes]:
    return {
        p.relative_to(root).as_posix(): p.read_bytes()
        for p in sorted(root.rglob("*")) if p.is_file()
    }


def all_text(root: Path) -> str:
    return "\n".join(data.decode("utf-8") for data in tree_bytes(root).values())


def test_expected_output_byte_for_byte(tmp_path: Path) -> None:
    out = scan(FIXTURE, tmp_path / "out")
    if os.environ.get("UPDATE_SCAN_EXPECTED") == "1":
        shutil.rmtree(EXPECTED, ignore_errors=True)
        shutil.copytree(out, EXPECTED)
    got, want = tree_bytes(out), tree_bytes(EXPECTED)
    assert sorted(got) == sorted(want)
    for name in want:
        assert got[name].decode("utf-8") == want[name].decode("utf-8"), name


def test_twice_in_a_row_is_identical(tmp_path: Path) -> None:
    first = tree_bytes(scan(FIXTURE, tmp_path / "out"))
    # Тот же каталог вывода: сборщик узнаёт свой маркер и перезаписывает каталог целиком.
    second = tree_bytes(scan(FIXTURE, tmp_path / "out"))
    third = tree_bytes(scan(FIXTURE, tmp_path / "other"))
    assert first == second == third


TRAPS = (
    # tests/: compose с лишними сервисами и маршрут; docs/: миграция и маршрут;
    # tools/sandbox/: исключено файлом .archmapignore (сам каталог назван в «Исключено»).
    "selenium", "test-db", "test-only", "demo_only", "docs-example", "busybox",
    "integration", "examples",
)


def test_traps_not_in_output(tmp_path: Path) -> None:
    text = all_text(scan(FIXTURE, tmp_path / "out"))
    for trap in TRAPS:
        assert trap not in text, trap
    # Сервис под profiles не стал объектом, но назван в подсказках.
    assert "mailhog" in (tmp_path / "out" / "agent" / "hints.yaml").read_text(encoding="utf-8")
    assert "mailhog" not in (tmp_path / "out" / "schema.yaml").read_text(encoding="utf-8")


def test_secrets_not_in_output(tmp_path: Path) -> None:
    text = all_text(scan(FIXTURE, tmp_path / "out"))
    example = FIXTURE / "services" / "orders" / ".env.example"
    env = envexample.parse_text("x", example.read_text(encoding="utf-8"))
    hidden = [
        v.value for v in env.vars
        if v.value and (secrets.secret_name(v.name) or secrets.looks_like_address(v.value))
    ]
    assert len(hidden) >= 4
    for value in hidden:
        assert value not in text, value
    # Пароль из адреса не просочился и по частям.
    assert "orders-example-pw" not in text


def test_git_and_no_git_differ_only_in_repo_and_commit(tmp_path: Path) -> None:
    repo = tmp_path / "repo"
    shutil.copytree(FIXTURE, repo)
    git(repo, "init", "-q")
    git(repo, "remote", "add", "origin", REPO)
    git(repo, "add", "-A")
    git(repo, "commit", "-q", "-m", "init")
    with_git = tree_bytes(scan(repo, tmp_path / "git", use_git=True))
    # .git переименован: тот же каталог без репозитория.
    (repo / ".git").rename(repo / ".git-off")
    without = tree_bytes(scan(repo, tmp_path / "plain", use_git=True))
    assert sorted(with_git) == sorted(without)

    def strip(data: bytes) -> list[str]:
        """Строки без repo и commit: ключи YAML, шапки файлов и первая строка сводки."""
        lines = []
        for line in data.decode("utf-8").splitlines():
            if line.strip().lstrip("# ").split(":")[0] in ("repo", "commit"):
                continue
            lines.append(line.split(" · репозиторий ")[0])
        return lines

    changed = [name for name in with_git if with_git[name] != without[name]]
    assert "schema.yaml" in changed
    for name in with_git:
        assert strip(with_git[name]) == strip(without[name]), name
    schema = with_git["schema.yaml"].decode("utf-8")
    assert f"# repo: {REPO}\n" in schema
    assert f"      repo: {REPO}\n" in schema


@pytest.mark.parametrize("name", ["schema.yaml", "coverage.yaml", "summary.txt"])
def test_expected_has_main_files(name: str) -> None:
    assert (EXPECTED / name).is_file()
