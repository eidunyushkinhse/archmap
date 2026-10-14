"""Lock поставки не отстаёт от requirements-prod.txt (аудит P-22).

Поставка ставится из requirements-prod.lock с --require-hashes. Если пин в
requirements-prod.txt поменяли, а lock не перегенерировали, сервер получил бы старую
версию — молча. Тест сверяет каждый пин файла с lock.
"""

import re
from pathlib import Path

BACKEND = Path(__file__).resolve().parents[1]
PIN = re.compile(r"^([A-Za-z0-9_.-]+)(?:\[[^\]]*\])?==([^\s;#\\]+)")


def _pins(path: Path) -> dict[str, str]:
    out: dict[str, str] = {}
    for line in path.read_text(encoding="utf-8").splitlines():
        m = PIN.match(line.strip())
        if m:
            out[re.sub(r"[-_.]+", "-", m.group(1)).lower()] = m.group(2)
    return out


def test_каждый_пин_поставки_совпадает_с_lock() -> None:
    wanted = _pins(BACKEND / "requirements-prod.txt")
    locked = _pins(BACKEND / "requirements-prod.lock")
    assert wanted, "в requirements-prod.txt нет пинов"
    stale = {name: (ver, locked.get(name)) for name, ver in wanted.items() if locked.get(name) != ver}
    assert stale == {}, f"lock устарел (пин, в lock): {stale} — перегенерируй, см. шапку requirements-prod.txt"


def test_в_lock_у_каждого_пакета_есть_хэш() -> None:
    text = (BACKEND / "requirements-prod.lock").read_text(encoding="utf-8")
    blocks = re.split(r"\n(?=[A-Za-z0-9])", text)
    packages = [b for b in blocks if PIN.match(b)]
    assert packages and all("--hash=sha256:" in b for b in packages)
