"""Пакет MCP-сервера едет во всех поставках (docs/plan-remote-mcp.md, Р9).

Эндпоинт /mcp импортирует пакет archmap_mcp. В поставках он лежит рядом с app/; без него
импорт app.main падает на старте — /ready красный, установщик откатывает релиз. Сторожим
дёшево — текстом, до сборки образа и архива: контекст образа (.dockerignore) и список
путей архива (build-bundle.sh) отрезают всё, что не названо явно.
"""

from pathlib import Path

REPO = Path(__file__).resolve().parents[2]


def test_образ_несёт_пакет_mcp() -> None:
    dockerfile = (REPO / "Dockerfile").read_text(encoding="utf-8")
    assert "COPY mcp/archmap_mcp ./archmap_mcp" in dockerfile
    assert "/opt/archmap/backend/archmap_mcp" in dockerfile  # байткод заранее
    assert "!mcp/archmap_mcp/" in (REPO / ".dockerignore").read_text(encoding="utf-8").splitlines()


def test_архив_поставки_несёт_пакет_mcp() -> None:
    bundle = (REPO / "deploy" / "build-bundle.sh").read_text(encoding="utf-8")
    paths = next(line for line in bundle.splitlines() if line.startswith("PATHS=("))
    assert "mcp/archmap_mcp" in paths.removeprefix("PATHS=(").rstrip(")").split()
    assert 'cp -a "$SRC/mcp/archmap_mcp" "$STAGE/backend/archmap_mcp"' in bundle
