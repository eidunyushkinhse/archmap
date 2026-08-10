"""HTTP-клиент ArchMap для MCP-сервера.

Держит одну ответственность: доставить запрос до /api/v1 с валидным токеном и
превратить отказ сервера в понятную агенту фразу. Никакой доменной логики —
она в tools.py.

Аутентификация: логин/пароль из окружения, токен добывается сам и живёт в
памяти процесса. Пользователю негде взять JWT руками (выдачи токена в
интерфейсе нет), поэтому просить его — значит отправить человека в DevTools.
"""

from __future__ import annotations

import os
from pathlib import Path
from typing import Any

import httpx

API_PREFIX = "/api/v1"
# Пакет доков/схемы — до 2 МБ на файл (лимиты полей на бэке); прогон агента по
# крупному монолиту идёт долго, поэтому таймаут щедрый.
TIMEOUT = httpx.Timeout(120.0, connect=10.0)


class ArchMapError(RuntimeError):
    """Отказ ArchMap, пригодный для показа агенту как есть."""


def load_env_file(path: Path) -> dict[str, str]:
    """Прочитать mcp/.env (KEY=VALUE построчно), если он есть.

    Зачем файл, когда есть окружение: у Claude Code конфиг MCP-серверов —
    `.mcp.json` в корне проекта, а он ТРЕКАЕТСЯ git. Пароль в нём уехал бы в
    репозиторий. `.env` рядом с сервером лежит в .gitignore.
    Настоящее окружение приоритетнее файла — им и переопределяют.
    """
    values: dict[str, str] = {}
    if not path.is_file():
        return values
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        values[key.strip()] = value.strip().strip('"').strip("'")
    return values


class Config:
    """Настройки из окружения (и опционального mcp/.env). Проверяются при
    старте — сервер не должен подниматься «наполовину» и падать на первом же
    вызове инструмента."""

    def __init__(self) -> None:
        env_file = load_env_file(Path(__file__).resolve().parent.parent / ".env")

        def get(name: str, default: str = "") -> str:
            return os.environ.get(name) or env_file.get(name, default)

        self.base_url = get("ARCHMAP_URL", "http://localhost:8000").rstrip("/")
        self.username = get("ARCHMAP_USERNAME")
        self.password = get("ARCHMAP_PASSWORD")

    def missing(self) -> list[str]:
        return [
            name
            for name, value in (
                ("ARCHMAP_USERNAME", self.username),
                ("ARCHMAP_PASSWORD", self.password),
            )
            if not value
        ]


class ArchMapClient:
    """Клиент с ленивым логином и одной повторной попыткой при 401.

    Повтор нужен не для надёжности сети, а для протухшего токена: сессия агента
    живёт дольше срока жизни JWT, и без релогина длинный разговор обрывался бы
    посередине.
    """

    def __init__(self, config: Config | None = None, http: httpx.AsyncClient | None = None) -> None:
        self.config = config or Config()
        self._http = http or httpx.AsyncClient(timeout=TIMEOUT)
        self._token: str | None = None

    async def aclose(self) -> None:
        await self._http.aclose()

    async def _login(self) -> str:
        """POST /auth/login — форма OAuth2 (username/password), не JSON."""
        url = f"{self.config.base_url}{API_PREFIX}/auth/login"
        try:
            resp = await self._http.post(
                url,
                data={"username": self.config.username, "password": self.config.password},
            )
        except httpx.RequestError as exc:
            raise ArchMapError(
                f"ArchMap недоступен по адресу {self.config.base_url}: {exc}. "
                "Проверьте ARCHMAP_URL и что сервис запущен."
            ) from exc
        if resp.status_code == 401:
            raise ArchMapError(
                "ArchMap отклонил логин: неверные ARCHMAP_USERNAME или ARCHMAP_PASSWORD."
            )
        if resp.status_code >= 400:
            raise ArchMapError(f"Не удалось войти в ArchMap: {_detail(resp)}")
        token = resp.json().get("access_token")
        if not token:
            raise ArchMapError("ArchMap не вернул токен доступа.")
        return str(token)

    async def request(
        self,
        method: str,
        path: str,
        *,
        project_id: str | None = None,
        json: Any | None = None,
        params: dict[str, Any] | None = None,
    ) -> Any:
        """Запрос к /api/v1. project_id уходит заголовком X-Project-Id — им
        бэкенд скоупит все доменные сущности."""
        if self._token is None:
            self._token = await self._login()

        async def attempt() -> httpx.Response:
            headers = {"Authorization": f"Bearer {self._token}"}
            if project_id:
                headers["X-Project-Id"] = project_id
            try:
                return await self._http.request(
                    method,
                    f"{self.config.base_url}{API_PREFIX}{path}",
                    headers=headers,
                    json=json,
                    params=params,
                )
            except httpx.RequestError as exc:
                raise ArchMapError(
                    f"ArchMap недоступен по адресу {self.config.base_url}: {exc}."
                ) from exc

        resp = await attempt()
        if resp.status_code == 401:
            self._token = await self._login()
            resp = await attempt()

        if resp.status_code == 403:
            raise ArchMapError(
                "Недостаточно прав: операция доступна только роли «архитектор». "
                "Войдите пользователем-архитектором."
            )
        if resp.status_code == 404:
            raise ArchMapError(f"Не найдено: {_detail(resp)}")
        if resp.status_code == 409:
            raise ArchMapError(
                f"Конфликт версий: {_detail(resp)}. Схему изменили — перечитайте её и повторите."
            )
        if resp.status_code == 422:
            raise ArchMapError(f"ArchMap отклонил данные: {_detail(resp)}")
        if resp.status_code >= 400:
            raise ArchMapError(f"Ошибка ArchMap ({resp.status_code}): {_detail(resp)}")
        if resp.status_code == 204 or not resp.content:
            return None
        return resp.json()


def _detail(resp: httpx.Response) -> str:
    """Текст ошибки: ArchMap отвечает {"detail": ...}; у 422 FastAPI кладёт туда
    список полей — сворачиваем его в строку, чтобы агент прочёл причину."""
    try:
        body = resp.json()
    except ValueError:
        return resp.text[:400] or f"HTTP {resp.status_code}"
    detail = body.get("detail") if isinstance(body, dict) else None
    if detail is None:
        return str(body)[:400]
    if isinstance(detail, str):
        return detail
    if isinstance(detail, list):
        parts = []
        for item in detail:
            if isinstance(item, dict):
                loc = ".".join(str(x) for x in item.get("loc", [])[1:])
                parts.append(f"{loc}: {item.get('msg', '')}".strip(": "))
        return "; ".join(parts)[:400] or str(detail)[:400]
    return str(detail)[:400]
