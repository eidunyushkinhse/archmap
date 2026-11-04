"""Командная строка: справка, ключи, коды выхода, каталог вывода и маркер."""

from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

from archmap_scan import __version__, cli
from tests.helpers import tree


def test_help_and_version(capsys: pytest.CaptureFixture[str]) -> None:
    assert cli.run(["--help"]) == 0
    out = capsys.readouterr().out
    assert "Запуск: python3 archmap-scan.pyz" in out and __version__ in out
    assert cli.run(["--version"]) == 0
    assert capsys.readouterr().out.strip() == __version__


@pytest.mark.parametrize(
    ("argv", "message"),
    [
        (["--bogus"], "Неизвестный ключ «--bogus»"),
        (["--out"], "Ключу --out нужно значение"),
        (["--json=1"], "Ключ --json не принимает значения"),
        (["a", "b"], "Путь к репозиторию указывается один раз"),
        (["--system", " "], "не может быть пустым"),
    ],
)
def test_usage_errors(argv: list[str], message: str, capsys: pytest.CaptureFixture[str]) -> None:
    assert cli.run(argv) == 1
    assert message in capsys.readouterr().err


def test_parse_args_forms() -> None:
    args = cli.parse_args(
        ["repo", "--system=Ярмарка", "--out", "o", "--exclude", "a/", "--exclude=b",
         "--include", "fixtures/", "--no-git", "--json"]
    )
    assert args.path == "repo" and args.system == "Ярмарка" and args.out == "o"
    assert args.excludes == ["a/", "b"] and args.includes == ["fixtures/"]
    assert args.no_git and args.json
    assert cli.parse_args(["--", "-weird"]).path == "-weird"


def test_missing_path_and_file_path(tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    assert cli.run([str(tmp_path / "nope"), "--no-git"]) == 1
    assert "не найден" in capsys.readouterr().err
    (tmp_path / "f.txt").write_text("x", encoding="utf-8")
    assert cli.run([str(tmp_path / "f.txt"), "--no-git"]) == 1
    assert "не каталог" in capsys.readouterr().err


def test_out_dir_marker_rules(tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    repo = tree(tmp_path / "repo", {"README.md": "x", "tests/t.py": ""})
    out = tmp_path / "out"
    assert cli.run([str(repo), "--no-git", "--out", str(out)]) == 0
    printed = capsys.readouterr().out
    assert "Результат записан в каталог" in printed
    assert (out / ".archmap-scan").is_file()
    assert (out / "coverage.yaml").is_file() and (out / "summary.txt").is_file()

    # С маркером каталог перезаписывается целиком: чужой хвост прошлого запуска уходит.
    (out / "facts").mkdir()
    (out / "facts" / "old.yaml").write_text("x", encoding="utf-8")
    assert cli.run([str(repo), "--no-git", "--out", str(out)]) == 0
    assert not (out / "facts").exists()

    busy = tmp_path / "busy"
    busy.mkdir()
    (busy / "mine.txt").write_text("x", encoding="utf-8")
    assert cli.run([str(repo), "--no-git", "--out", str(busy)]) == 1
    assert "чужие файлы" in capsys.readouterr().err
    assert (busy / "mine.txt").read_text(encoding="utf-8") == "x"

    empty = tmp_path / "empty"
    empty.mkdir()
    assert cli.run([str(repo), "--no-git", "--out", str(empty)]) == 0

    afile = tmp_path / "afile"
    afile.write_text("x", encoding="utf-8")
    assert cli.run([str(repo), "--no-git", "--out", str(afile)]) == 1
    assert "не каталог" in capsys.readouterr().err


def test_json_output(tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    repo = tree(tmp_path / "repo", {"a.txt": "x"})
    assert cli.run([str(repo), "--no-git", "--json", "--out", str(tmp_path / "o")]) == 0
    doc = json.loads(capsys.readouterr().out)
    assert doc["coverage"]["scanner"] == __version__
    assert set(doc["coverage"]["families"]) >= {"containers", "tables", "config"}


def test_old_python_gets_plain_message(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    monkeypatch.setattr(sys, "version_info", (3, 9, 18, "final", 0))
    with pytest.raises(SystemExit) as stop:
        cli.main(["--version"])
    assert stop.value.code == 1
    assert "нужен Python 3.10 или новее, а запущен Python 3.9.18" in capsys.readouterr().err


def test_main_exits_with_run_code(capsys: pytest.CaptureFixture[str]) -> None:
    with pytest.raises(SystemExit) as stop:
        cli.main(["--version"])
    assert stop.value.code == 0
    capsys.readouterr()


def test_crash_is_reported(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    from archmap_scan import scan

    def boom(*_a: object, **_k: object) -> None:
        raise RuntimeError("сломалось")

    monkeypatch.setattr(scan, "list_files", boom)
    assert cli.run([str(tmp_path), "--no-git", "--out", str(tmp_path / "o")]) == 1
    assert "Сборщик остановился с ошибкой: RuntimeError: сломалось" in capsys.readouterr().err
