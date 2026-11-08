"""Перечень файлов: соглашения, .archmapignore, --exclude/--include, пределы чтения, git."""

from __future__ import annotations

import shutil
import time
from pathlib import Path

import pytest

from archmap_scan import registry
from archmap_scan.assemble import assemble
from archmap_scan.context import make_context
from archmap_scan.walk import (
    MAX_BYTES,
    Excluded,
    Files,
    Pattern,
    ci_rule,
    convention_rule,
    dependency_rule,
    list_files,
    segment_match,
)
from tests.helpers import FIXTURES, ctx_of, git, model_of, tree


def test_convention_dirs_and_names(tmp_path: Path) -> None:
    tree(tmp_path, {
        "app/main.py": "",
        "tests/test_a.py": "",
        "tests/b/c.py": "",
        "app/tests/x.py": "",
        "docs/index.md": "",
        "app/test_util.py": "",
        "app/util_test.py": "",
        "pkg/x_test.go": "",
        "web/a.test.ts": "",
        "web/b.spec.tsx": "",
        "conftest.py": "",
        "docker-compose.yml": "",
        "docker-compose.test.yml": "",
        "compose.ci.yaml": "",
        "Docs/readme.md": "",
    })
    listing = list_files(ctx_of(tmp_path))
    assert listing.files == ("app/main.py", "docker-compose.yml")
    assert set(listing.excluded) == {
        Excluded("tests/", 2, "convention"),
        Excluded("app/tests/", 1, "convention"),
        Excluded("docs/", 1, "convention"),
        Excluded("Docs/", 1, "convention"),
        Excluded("test_*.py", 1, "convention"),
        Excluded("*_test.py", 1, "convention"),
        Excluded("*_test.go", 1, "convention"),
        Excluded("*.test.*", 1, "convention"),
        Excluded("*.spec.*", 1, "convention"),
        Excluded("conftest.py", 1, "convention"),
        Excluded("docker-compose.test.yml", 1, "convention"),
        Excluded("compose.ci.yaml", 1, "convention"),
    }
    # Отчёт отсортирован: двойной запуск даёт тот же порядок.
    assert listing.excluded == tuple(sorted(listing.excluded, key=lambda e: (e.path, e.reason)))


def test_convention_rule_shapes() -> None:
    assert convention_rule("a/fixtures/b.yml") == ("a/fixtures/", True)
    assert convention_rule("a/b.yml") is None
    assert convention_rule("compose.e2e.yml") == ("compose.e2e.yml", True)
    assert convention_rule("docker-compose.contest.yml") is None


def test_archmapignore_and_options(tmp_path: Path) -> None:
    tree(tmp_path, {
        ".archmapignore": "# комментарий\n\nlegacy/\n/only-root.txt\n*.bak\na/**/z.txt\n!keep.txt\n",
        "legacy/x.py": "",
        "src/legacy/y.py": "",
        "only-root.txt": "",
        "src/only-root.txt": "",
        "x.bak": "",
        "a/z.txt": "",
        "a/b/c/z.txt": "",
        "keep.txt": "",
        "gen/out.py": "",
        "fixtures/compose.yml": "",
    })
    ctx = ctx_of(tmp_path)
    listing = list_files(ctx, excludes=["gen/"], includes=["fixtures/"])
    assert listing.files == (
        ".archmapignore", "fixtures/compose.yml", "keep.txt", "src/only-root.txt",
    )
    assert set(listing.excluded) == {
        Excluded("legacy/", 2, "archmapignore"),
        Excluded("/only-root.txt", 1, "archmapignore"),
        Excluded("*.bak", 1, "archmapignore"),
        Excluded("a/**/z.txt", 2, "archmapignore"),
        Excluded("gen/", 1, "option"),
    }
    assert listing.ignore_file == ".archmapignore"


@pytest.mark.parametrize(
    ("pattern", "path", "is_dir", "expected"),
    [
        ("*.py", "a/b/c.py", False, True),
        ("*.py", "a/b/c.pyc", False, False),
        ("build/", "build", True, True),
        ("build/", "build", False, False),
        ("/build", "x/build", True, False),
        ("/build", "build", True, True),
        ("a/*/c", "a/b/c", True, True),
        ("a/*/c", "a/b/x/c", True, False),
        ("a/**/c", "a/c", True, True),
        ("a/**/c", "a/b/x/c", True, True),
        ("**/c", "x/y/c", False, True),
        ("a/**", "a/b/c", False, True),
        ("?.txt", "x.txt", False, True),
        ("?.txt", "xy.txt", False, False),
        ("**", "anything/at/all", False, True),
    ],
)
def test_pattern(pattern: str, path: str, is_dir: bool, expected: bool) -> None:
    assert Pattern(pattern).matches(path, is_dir) is expected


def test_pattern_hits_ancestor_dirs() -> None:
    assert Pattern("gen").hits("src/gen/a/b.py")
    assert not Pattern("gen").hits("src/generated/b.py")


def test_hostile_pattern_is_fast() -> None:
    name = "a" * 3000
    started = time.perf_counter()
    assert not segment_match("*a*a*a*a*a*a*a*a*a*b", name)
    assert not Pattern("**/**/**/**/**/x").matches("/".join(["a"] * 2000), False)
    assert time.perf_counter() - started < 1.0


def test_walk_skips_tool_dirs_marker_and_out(tmp_path: Path) -> None:
    tree(tmp_path, {
        "src/a.py": "",
        "node_modules/x/package.json": "{}",
        "venv/lib/x.py": "",
        "old-scan/.archmap-scan": "archmap-scan\n",
        "old-scan/schema.yaml": "",
        "out/summary.txt": "",
    })
    listing = list_files(ctx_of(tmp_path), skip=[tmp_path / "out"])
    assert listing.files == ("src/a.py",)
    assert listing.excluded == ()


def test_files_read_limits(tmp_path: Path) -> None:
    tree(tmp_path, {
        "big.sql": "x" * (MAX_BYTES + 1),
        "bin.yaml": b"a: 1\0\0",
        "latin.txt": b"caf\xe9",
        "bom.txt": "﻿hello",
    })
    files = Files(tmp_path, ["big.sql", "bin.yaml", "latin.txt", "bom.txt", "missing.txt"])
    assert files.read("big.sql") is None
    assert files.read("bin.yaml") is None
    assert files.read("latin.txt") == "caf�"
    assert files.read("bom.txt") == "hello"
    assert files.read("missing.txt") is None
    assert files.too_large == {"big.sql"}
    assert files.binary == {"bin.yaml"}
    files.refuse("bom.txt")
    assert "bom.txt" in files.too_large


def _git(cwd: Path, *args: str) -> None:
    git(cwd, *args)


def test_git_listing_respects_gitignore_and_scope(tmp_path: Path) -> None:
    repo = tmp_path / "repo"
    tree(repo, {
        ".gitignore": "ignored/\n",
        "ignored/x.py": "",
        "svc/a.py": "",
        "svc/new.py": "",
        "other/b.py": "",
    })
    _git(repo, "init", "-q")
    _git(repo, "add", ".gitignore", "svc/a.py", "other/b.py")
    _git(repo, "commit", "-qm", "init")
    _git(repo, "remote", "add", "origin", "https://user:secret@github.com/org/yarmarka.git")

    ctx = make_context(repo, use_git=True)
    assert ctx.git and ctx.scope == ""
    assert ctx.repo == "https://github.com/org/yarmarka.git"
    assert len(ctx.commit) == 40
    assert list_files(ctx).files == (".gitignore", "other/b.py", "svc/a.py", "svc/new.py")

    sub = make_context(repo / "svc", use_git=True)
    assert sub.root == repo.resolve() and sub.scope == "svc"
    assert list_files(sub).files == ("svc/a.py", "svc/new.py")

    off = make_context(repo / "svc", use_git=False)
    assert off.root == (repo / "svc").resolve() and off.repo == "" and off.commit == ""
    assert list_files(off).files == ("a.py", "new.py")


def test_ci_files_are_excluded() -> None:
    """Файлы CI и служебных инструментов не читаются (ТЗ §15 п. 10 А9): верхний services:
    .woodpecker.yml не база, примеры правил .semgrep не расписания; в покрытии они в
    excluded с причиной «ci». Каталог drone-relay без точки читается как обычно."""
    listing = list_files(ctx_of(FIXTURES / "ci-files"))
    assert listing.files == (
        "api/Dockerfile", "api/requirements.txt", "docker-compose.yml", "drone-relay/Dockerfile",
    )
    assert listing.excluded == (
        Excluded(".github/", 1, "ci"), Excluded(".semgrep/", 1, "ci"),
        Excluded(".woodpecker.yml", 1, "ci"),
    )
    model = model_of(FIXTURES / "ci-files")
    assert sorted(o.name for o in model.objects) == ["api", "db", "relay"]
    assert not [h for h in model.hints.get("unassigned", []) if h["kind"] == "schedule"]
    assert ci_rule(".gitlab-ci.yml") == ".gitlab-ci.yml"
    assert ci_rule("ops/.drone.yml") == "ops/.drone.yml"
    assert ci_rule("bitbucket-pipelines.yml") == "bitbucket-pipelines.yml"
    assert ci_rule(".buildkite/pipeline.yml") == ".buildkite/"
    assert ci_rule("src/github/client.py") is None and ci_rule(".github") is None


def test_dependency_dirs_skipped_with_git(tmp_path: Path) -> None:
    """Каталоги зависимостей с git тоже не читаются (ТЗ §15 п. 12 С1): Loki и Kubernetes
    держат в закоммиченном vendor/ чужие Dockerfile (vendor/github.com/buger/jsonparser/
    Dockerfile давал объект jsonparser, vendor/go.opentelemetry.io/otel/dependencies.Dockerfile
    объект dependencies). Ловушка: закоммиченный build/ читается, это источник
    (build/pause/Dockerfile Kubernetes)."""
    repo = tmp_path / "repo"
    shutil.copytree(FIXTURES / "vendor-git", repo)
    _git(repo, "init", "-q")
    _git(repo, "add", "-A")
    _git(repo, "commit", "-qm", "init")
    ctx = make_context(repo, use_git=True)
    listing = list_files(ctx)
    assert listing.files == ("app/Dockerfile", "build/pause/Dockerfile", "docker-compose.yml")
    assert listing.excluded == (Excluded("vendor/", 2, "dependencies"),)
    files = Files(ctx.root, listing.files)
    findings, errors = registry.collect(files, ctx)
    assert errors == {}
    assert sorted(o.name for o in assemble(findings, ctx).objects) == ["app", "pause"]
    assert dependency_rule("staging/vendor/x/Dockerfile") == "staging/vendor/"
    assert dependency_rule("vendor") is None and dependency_rule("Vendor/a") is None


def test_coverage_dir_read_with_git(tmp_path: Path) -> None:
    """Каталог coverage с git читается (ТЗ §15 п. 13 Д5): pkg/util/coverage/ Kubernetes —
    закоммиченный код, а с С1 он был исключён как каталог зависимостей. Его файлы в перечне
    и в ярусе кода: параметр из pkg/util/coverage/coverage.go у контейнера proxy. Ловушки:
    node_modules с git по-прежнему исключён; без git coverage/ пропускается, как раньше."""
    repo = tmp_path / "repo"
    shutil.copytree(FIXTURES / "coverage-git", repo)
    tree(repo, {"web/node_modules/left-pad/Dockerfile": "FROM node:22\n"})
    _git(repo, "init", "-q")
    _git(repo, "add", "-A", "-f")
    _git(repo, "commit", "-qm", "init")
    ctx = make_context(repo, use_git=True)
    listing = list_files(ctx)
    assert "pkg/util/coverage/coverage.go" in listing.files
    assert listing.excluded == (Excluded("web/node_modules/", 1, "dependencies"),)
    findings, errors = registry.collect(Files(ctx.root, listing.files), ctx)
    assert errors == {}
    model = assemble(findings, ctx)
    assert [o.name for o in model.objects] == ["proxy"]
    assert sorted(model.params["proxy"]) == ["PROXY_COVERAGE_FILE", "PROXY_PORT"]
    plain = list_files(make_context(FIXTURES / "coverage-git", use_git=False))
    assert [f for f in plain.files if "/coverage/" in f] == []
    assert dependency_rule("pkg/util/coverage/coverage.go") == "pkg/util/coverage/"
    assert dependency_rule("pkg/util/coverage/coverage.go", git=True) is None
    assert dependency_rule("web/node_modules/x/a.js", git=True) == "web/node_modules/"
