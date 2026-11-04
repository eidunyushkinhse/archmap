"""Сборщик фактов едет во всех поставках (docs/tasks/fact-collector.md, §3).

Сервер раздаёт archmap-scan.pyz по /api/v1/scan (app/scan_file.py): без файла адрес
отвечает 404, и ничего больше не ломается, поэтому пропажу файла из поставки увидел бы
только пользователь. Сторожим дёшево, текстом, как пакет MCP (test_delivery_mcp.py):
контекст образа (.dockerignore) и список путей архива (build-bundle.sh) отрезают всё, что
не названо явно, а путь к файлу задают образ и служба systemd.
"""

from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
IMAGE_FILE = "/opt/archmap/scan/archmap-scan.pyz"


def test_образ_собирает_и_задаёт_сборщик() -> None:
    dockerfile = (REPO / "Dockerfile").read_text(encoding="utf-8")
    assert "COPY scan/build.py /tmp/scan/build.py" in dockerfile
    assert "COPY scan/archmap_scan /tmp/scan/archmap_scan" in dockerfile
    assert f"python3 /tmp/scan/build.py --out {IMAGE_FILE}" in dockerfile
    assert f"SCAN_FILE={IMAGE_FILE}" in dockerfile
    ignore = (REPO / ".dockerignore").read_text(encoding="utf-8").splitlines()
    assert "!scan/build.py" in ignore and "!scan/archmap_scan/" in ignore


def test_архив_поставки_несёт_сборщик() -> None:
    bundle = (REPO / "deploy" / "build-bundle.sh").read_text(encoding="utf-8")
    paths = next(line for line in bundle.splitlines() if line.startswith("PATHS=("))
    listed = paths.removeprefix("PATHS=(").rstrip(")").split()
    assert "scan/build.py" in listed and "scan/archmap_scan" in listed
    assert '"$SRC/scan/build.py" --out "$STAGE/scan/archmap-scan.pyz"' in bundle
    service = (REPO / "deploy" / "archmap.service").read_text(encoding="utf-8")
    env = next(line for line in service.splitlines() if line.startswith("Environment="))
    assert "SCAN_FILE=__PREFIX__/current/scan/archmap-scan.pyz" in env.split()
