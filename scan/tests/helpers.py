"""Общие помощники тестов: дерево файлов во временном каталоге и запуск сборщика."""

from __future__ import annotations

import os
import subprocess
from pathlib import Path

from archmap_scan import registry
from archmap_scan.assemble import assemble
from archmap_scan.context import Context, make_context
from archmap_scan.objects import Model
from archmap_scan.walk import Files, list_files

# Фикстуры сборщика: чужой код, который сборщик только читает.
FIXTURES = Path(__file__).resolve().parent.parent / "fixtures"


def tree(root: Path, files: dict[str, str | bytes]) -> Path:
    """Разложить файлы {путь: содержимое} под root и вернуть root."""
    for rel, content in files.items():
        target = root / rel
        target.parent.mkdir(parents=True, exist_ok=True)
        if isinstance(content, bytes):
            target.write_bytes(content)
        else:
            target.write_text(content, encoding="utf-8")
    return root


def ctx_of(root: Path, system: str | None = None) -> Context:
    """Контекст без git: тесты на деревьях внутри репозитория ArchMap идут с --no-git."""
    return make_context(root, use_git=False, system=system)


def files_of(root: Path) -> tuple[Context, Files]:
    ctx = ctx_of(root)
    listing = list_files(ctx)
    return ctx, Files(ctx.root, listing.files)


def git(cwd: Path, *args: str) -> None:
    """git во временном репозитории теста. Переменные GIT_* окружения убраны: под хуком
    pre-commit они указывают на индекс ArchMap, а не на репозиторий теста."""
    env = {k: v for k, v in os.environ.items() if not k.startswith("GIT_")}
    subprocess.run(
        ["git", "-c", "user.name=t", "-c", "user.email=t@example.com", *args],
        cwd=cwd, check=True, capture_output=True, env=env,
    )


def model_of(root: Path, system: str | None = "Ярмарка") -> Model:
    """Все разборщики реестра и сборка схемы по дереву root (без git)."""
    ctx = ctx_of(root, system)
    files = Files(ctx.root, list_files(ctx).files)
    findings, errors = registry.collect(files, ctx)
    assert errors == {}
    return assemble(findings, ctx)
