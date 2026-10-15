"""Счётчик событий с одного адреса в скользящем окне — в памяти процесса.

Им ограничены старты песочниц демо-стенда (app/demo.py) и неудачные попытки входа
в режиме одного процесса (app/standalone.py). Счётчик у каждого рабочего процесса
свой, после перезапуска история забывается: это защита от перебора и злоупотреблений,
а не точный учёт.
"""

import threading
import time
from collections import deque

from starlette.datastructures import Headers
from starlette.types import Scope

from app.config import settings


def client_address(scope: Scope) -> str:
    """Адрес человека для лимитов: последний в X-Forwarded-For — его дописывает наш
    прокси (nginx серверной поставки, Gateway/Ingress в Kubernetes), а первые значения присылает
    клиент и может подделать. Без заголовка — адрес соединения.

    Одна функция на все лимиты (аудит M4, P-17): адрес из соединения (request.client)
    зависит от доверия uvicorn прокси, и при FORWARDED_ALLOW_IPS=* это
    ПЕРВЫЙ адрес заголовка — его клиент выбирает сам.

    Без прокси перед ArchMap (TRUST_FORWARDED_FOR=false, docker compose) заголовок целиком
    от клиента — тогда только адрес соединения."""
    if settings.trust_forwarded_for:
        forwarded = ",".join(Headers(scope=scope).getlist("x-forwarded-for"))
        last = forwarded.rsplit(",", 1)[-1].strip()
        if last:
            return last
    client = scope.get("client")
    return client[0] if client else "unknown"


class AddressLimiter:
    """Сколько событий было с адреса за последние window_seconds секунд."""

    def __init__(self, window_seconds: float) -> None:
        self.window_seconds = window_seconds
        self._hits: dict[str, deque[float]] = {}
        self._lock = threading.Lock()
        # Время последней уборки в той же шкале, что и события (тесты передают now явно).
        self._swept_at = 0.0

    def _fresh(self, ip: str, now: float) -> deque[float] | None:
        """События адреса в окне; адрес без событий из словаря уходит (аудит M5:
        иначе словарь рос бы на каждый уникальный адрес за всю жизнь процесса)."""
        hits = self._hits.get(ip)
        if hits is None:
            return None
        while hits and now - hits[0] >= self.window_seconds:
            hits.popleft()
        if not hits:
            del self._hits[ip]
            return None
        return hits

    def _sweep(self, now: float) -> None:
        """Раз в окно убрать адреса, которые больше не приходили: сами они в _fresh
        уже не попадут."""
        if now - self._swept_at < self.window_seconds:
            return
        self._swept_at = now
        for ip in list(self._hits):
            self._fresh(ip, now)

    def allowed(self, ip: str, limit: int, now: float | None = None) -> bool:
        moment = time.monotonic() if now is None else now
        with self._lock:
            hits = self._fresh(ip, moment)
            return (len(hits) if hits is not None else 0) < limit

    def record(self, ip: str, now: float | None = None) -> float:
        moment = time.monotonic() if now is None else now
        with self._lock:
            self._sweep(moment)
            hits = self._fresh(ip, moment)
            if hits is None:
                hits = self._hits[ip] = deque()
            hits.append(moment)
        return moment

    def forget(self, ip: str, moment: float) -> None:
        """Снять событие, записанное заранее (record вернул его время)."""
        with self._lock:
            hits = self._hits.get(ip)
            if hits is not None and moment in hits:
                hits.remove(moment)
                if not hits:
                    del self._hits[ip]

    def reset(self) -> None:
        with self._lock:
            self._hits.clear()
