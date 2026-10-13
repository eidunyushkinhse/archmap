"""Счётчик событий с адреса (app/rate_limit.py): память не растёт с числом адресов.

Аудит M5: ключ адреса оставался в словаре и после того, как его окно опустело, —
на публичном стенде словарь рос на каждый уникальный адрес за всю жизнь процесса.
"""

from app.rate_limit import AddressLimiter


def test_вопрос_про_новый_адрес_не_заводит_ключ() -> None:
    lim = AddressLimiter(window_seconds=60)
    assert lim.allowed("1.2.3.4", 1, now=0.0)
    assert lim._hits == {}


def test_адрес_с_опустевшим_окном_уходит_из_словаря() -> None:
    lim = AddressLimiter(window_seconds=60)
    lim.record("1.2.3.4", now=0.0)
    assert lim.allowed("1.2.3.4", 1, now=61.0)
    assert "1.2.3.4" not in lim._hits


def test_уборка_раз_в_окно_снимает_адреса_которые_не_вернулись() -> None:
    lim = AddressLimiter(window_seconds=60)
    for i in range(100):
        lim.record(f"10.0.0.{i}", now=float(i % 10))
    assert len(lim._hits) == 100
    lim.record("5.6.7.8", now=200.0)
    assert set(lim._hits) == {"5.6.7.8"}


def test_снятое_событие_последнее_у_адреса_снимает_и_ключ() -> None:
    lim = AddressLimiter(window_seconds=60)
    moment = lim.record("1.2.3.4", now=5.0)
    lim.forget("1.2.3.4", moment)
    assert lim._hits == {}
    assert lim.allowed("1.2.3.4", 1, now=6.0)
