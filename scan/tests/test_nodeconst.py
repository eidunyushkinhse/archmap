"""Строковые константы Node.js (nodeconst, ТЗ §15 п. 18 В1, К1): объявления верхнего уровня,
шаблон с подстановками констант файла, поиск в файле, пакете и репозитории."""

from __future__ import annotations

from pathlib import Path

from archmap_scan import codetext, nodeconst
from tests.helpers import files_of, tree


def test_declarations() -> None:
    """Литерал, тип и «as const», шаблон с подстановкой литерала файла; склейка, вызов,
    шаблон с выражением и объявление внутри функции константами не считаются."""
    code = codetext.Code(
        "export const PREFIX = '/control';\n"
        "const TYPED: string = \"typed\";\n"
        "export const FIXED = 'fixed' as const;\n"
        "export const STATUS = `${PREFIX}/status`;\n"
        "export const NESTED = `${STATUS}/x`;\n"
        "const JOINED = 'a' + b;\n"
        "const CALLED = f('x');\n"
        "const EXPR = `${a.b}`;\n"
        "function f() {\n  const INNER = 'inner';\n}\n",
        codetext.JS,
    )
    found = nodeconst.declarations(code, "a.ts")
    values = {name: (c.value if c else None, exported) for name, (c, exported) in found.items()}
    assert values == {
        "PREFIX": ("/control", True), "TYPED": ("typed", False), "FIXED": ("fixed", True),
        "STATUS": ("/control/status", True), "NESTED": (None, True), "EXPR": (None, False),
    }


def test_lookup_file_package_repo(tmp_path: Path) -> None:
    """Сначала файл, потом, если файл импортирует имя (и под псевдонимом «as»), экспорт пакета
    файла, потом единственное значение в репозитории; разные значения в пакете или
    репозитории дают неоднозначность."""
    root = tree(tmp_path, {
        "a/package.json": '{"name": "a"}',
        "a/src/use.ts": (
            "import { SHARED, ONLY_B as B_ONLY } from '@/names';\n"
            "import { TWICE, MISSING } from './more';\nconst OWN = 'own';\n"
        ),
        "a/src/plain.ts": "const local = 1;\n",
        "a/src/names.ts": "export const SHARED = 'from-a';\nexport const TWICE = 'one';\n",
        "a/src/more.ts": "export const TWICE = 'two';\n",
        "b/package.json": '{"name": "b"}',
        "b/src/names.ts": "export const SHARED = 'from-b';\nexport const ONLY_B = 'b';\n",
    })
    ctx, files = files_of(root)
    index = nodeconst.index(files, ctx)
    assert index is nodeconst.index(files, ctx)

    def value(rel: str, name: str) -> str | None:
        found = index.lookup(rel, name)
        if found is nodeconst.AMBIGUOUS:
            return "?"
        return found.value if found is not None else None

    assert value("a/src/use.ts", "OWN") == "own"
    assert value("a/src/use.ts", "SHARED") == "from-a"
    assert value("a/src/use.ts", "B_ONLY") == "b"
    assert value("a/src/use.ts", "ONLY_B") is None
    assert value("a/src/use.ts", "TWICE") == "?"
    assert value("a/src/use.ts", "MISSING") is None
    # Имя без импорта в файле — переменная или параметр, а не константа другого файла.
    assert value("a/src/plain.ts", "SHARED") is None


def test_index_does_not_count_dev_code(tmp_path: Path) -> None:
    """Индекс экспортов проходит весь код Node.js, но пропуск кода для разработки в чужих
    пакетах не записывается разборщику, который спросил константу первым: у redis-pubsub в
    покрытии только файлы пакетов с клиентом Redis."""
    from archmap_scan.parsers import redispubsub

    ctx, files = files_of(tree(tmp_path, {
        "a/package.json": '{"name": "a", "dependencies": {"ioredis": "*"}}',
        "a/src/pub.ts": (
            "import Redis from 'ioredis';\nimport { CHANNEL } from 'b';\nredis.publish(CHANNEL, 1);\n"
        ),
        "a/src/dev/tool.ts": "redis.publish('x', 1);\n",
        "b/package.json": '{"name": "b"}',
        "b/src/names.ts": "export const CHANNEL = 'events';\n",
        "b/hack/run.ts": "export const OTHER = 'o';\n",
    }))
    files.dev_code = set()
    found = redispubsub.parse(files, ctx)
    assert [(u.name, str(u.loc)) for u in found.channels] == [("events", "a/src/pub.ts:3")]
    assert files.dev_code == {"a/src/dev/tool.ts"}
