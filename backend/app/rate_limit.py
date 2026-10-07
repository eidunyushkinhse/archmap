"""Счётчик событий с одного адреса в скользящем окне — в памяти процесса.

Им ограничены старты песочниц демо-стенда (app/demo.py) и неудачные попытки входа
в режиме одного процесса (app/standalone.py). Счётчик у каждого рабочего процесса
свой, после перезапуска история забывается: это защита от перебора и злоупотреблений,
а не точный учёт.
"""

import threading
import time
from collections import deque


class AddressLimiter:
    """Сколько событий было с адреса за последние window_seconds секунд."""

    def __init__(self, window_seconds: float) -> None:
        self.window_seconds = window_seconds
        self._hits: dict[str, deque[float]] = {}
        self._lock = threading.Lock()

    def _fresh(self, ip: str, now: float) -> deque[float]:
        hits = self._hits.setdefault(ip, deque())
        while hits and now - hits[0] >= self.window_seconds:
            hits.popleft()
        return hits

    def allowed(self, ip: str, limit: int, now: float | None = None) -> bool:
        moment = time.monotonic() if now is None else now
        with self._lock:
            return len(self._fresh(ip, moment)) < limit

    def record(self, ip: str, now: float | None = None) -> float:
        moment = time.monotonic() if now is None else now
        with self._lock:
            self._fresh(ip, moment).append(moment)
        return moment

    def forget(self, ip: str, moment: float) -> None:
        """Снять событие, записанное заранее (record вернул его время)."""
        with self._lock:
            hits = self._hits.get(ip)
            if hits is not None and moment in hits:
                hits.remove(moment)

    def reset(self) -> None:
        with self._lock:
            self._hits.clear()
