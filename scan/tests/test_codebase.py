"""Отбор файлов кода (codebase.code_files, ТЗ §6.2): кандидаты языка считаются один раз на
запуск (ТЗ §15 п. 19 П9), отбор по зависимостям и пропуск кода для разработки — на каждом
вызове."""

from __future__ import annotations

from pathlib import Path

from archmap_scan import codebase
from tests.helpers import files_of, tree


def test_code_files_once_per_language(tmp_path: Path) -> None:
    """Повторный вызов с другим wanted отбирает по зависимостям заново; код для разработки
    записывается в files.dev_code на каждом вызове, поэтому сброс множества между вызовами
    (приём nodeconst._export_files) его не теряет; объявления типов и файл без пакета не
    кандидаты; кандидаты лежат в files.memo по языку."""
    ctx, files = files_of(tree(tmp_path, {
        "a/package.json": '{"name": "a", "dependencies": {"ioredis": "*"}}',
        "a/src/x.ts": "x\n", "a/src/dev/tool.ts": "x\n", "a/src/types.d.ts": "x\n",
        "b/package.json": '{"name": "b", "dependencies": {"kafkajs": "*"}}',
        "b/src/y.js": "x\n", "b/hack/run.js": "x\n",
        "c/z.ts": "x\n",
        "go/go.mod": "module x\n\nrequire github.com/segmentio/kafka-go/v2 v2.0.0\n",
        "go/main.go": "package main\n",
    }))
    assert sorted(codebase.code_files(files, ctx, codebase.NODE)) == ["a/src/x.ts", "b/src/y.js"]
    assert files.dev_code == {"a/src/dev/tool.ts", "b/hack/run.js"}
    files.dev_code = set()
    assert codebase.code_files(files, ctx, codebase.NODE, frozenset({"ioredis"})) == ["a/src/x.ts"]
    assert files.dev_code == {"a/src/dev/tool.ts"}
    assert codebase.code_files(files, ctx, codebase.NODE, frozenset({"nats"})) == []
    # Модуль Go с версией совпадает с зависимостью без неё, как раньше.
    wanted = frozenset({"github.com/segmentio/kafka-go"})
    assert codebase.code_files(files, ctx, codebase.GO, wanted) == ["go/main.go"]
    assert {"code-candidates:" + codebase.NODE, "code-candidates:" + codebase.GO} <= set(files.memo)
