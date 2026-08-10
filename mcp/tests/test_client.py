"""Клиент: логин, скоуп проекта, протухший токен, перевод отказов в текст."""

from __future__ import annotations

import httpx
import pytest
from conftest import PROJECT_ID, FakeApi

from archmap_mcp.client import ArchMapClient, ArchMapError


async def test_логин_уходит_формой_а_не_json(client: ArchMapClient, api: FakeApi) -> None:
    # /auth/login на бэке — OAuth2PasswordRequestForm; JSON он не примет.
    api.get("/nodes/all", [])
    await client.request("GET", "/nodes/all", project_id=PROJECT_ID)

    login = api.calls[0]
    assert login.url.path.endswith("/auth/login")
    assert login.headers["content-type"] == "application/x-www-form-urlencoded"
    assert b"username=arch" in login.content


async def test_проект_уходит_заголовком(client: ArchMapClient, api: FakeApi) -> None:
    api.get("/nodes/all", [])
    await client.request("GET", "/nodes/all", project_id=PROJECT_ID)

    assert api.calls[-1].headers["X-Project-Id"] == PROJECT_ID
    assert api.calls[-1].headers["Authorization"] == "Bearer tok-1"


async def test_протухший_токен_перелогинивает_и_повторяет(
    client: ArchMapClient, api: FakeApi
) -> None:
    # Сессия агента живёт дольше JWT: без повтора длинный разговор обрывался бы.
    api.get("/nodes/all", [])
    api.expire_first_call = True

    await client.request("GET", "/nodes/all", project_id=PROJECT_ID)

    assert api.login_count == 2
    assert api.calls[-1].headers["Authorization"] == "Bearer tok-2"


async def test_логин_с_неверным_паролем_называет_переменные(
    client: ArchMapClient, api: FakeApi
) -> None:
    def failing(request: httpx.Request) -> httpx.Response:
        return httpx.Response(401, json={"detail": "Неверный логин или пароль"})

    client._http = httpx.AsyncClient(transport=httpx.MockTransport(failing))
    with pytest.raises(ArchMapError) as exc:
        await client.request("GET", "/nodes/all")

    assert "ARCHMAP_USERNAME" in str(exc.value)


@pytest.mark.parametrize(
    ("status", "expected"),
    [
        (403, "архитектор"),
        (404, "Не найдено"),
        (409, "Конфликт версий"),
        (422, "отклонил данные"),
    ],
)
async def test_отказы_переводятся_в_понятный_текст(
    client: ArchMapClient, api: FakeApi, status: int, expected: str
) -> None:
    api.routes[("GET", "/nodes/all")] = httpx.Response(status, json={"detail": "причина"})

    with pytest.raises(ArchMapError) as exc:
        await client.request("GET", "/nodes/all", project_id=PROJECT_ID)

    assert expected in str(exc.value)


async def test_ошибка_валидации_называет_поле(client: ArchMapClient, api: FakeApi) -> None:
    # FastAPI кладёт в detail список — агенту нужна причина, а не «[object]».
    api.routes[("POST", "/nodes/")] = httpx.Response(
        422, json={"detail": [{"loc": ["body", "name"], "msg": "Field required"}]}
    )

    with pytest.raises(ArchMapError) as exc:
        await client.request("POST", "/nodes/", project_id=PROJECT_ID, json={})

    assert "name: Field required" in str(exc.value)


async def test_сервис_не_поднят_говорит_куда_смотреть() -> None:
    from archmap_mcp.client import Config

    config = Config()
    config.username, config.password, config.base_url = "a", "b", "http://archmap.test"

    async def refuse(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("connection refused")

    broken = ArchMapClient(config, http=httpx.AsyncClient(transport=httpx.MockTransport(refuse)))
    with pytest.raises(ArchMapError) as exc:
        await broken.request("GET", "/projects/")

    assert "ARCHMAP_URL" in str(exc.value)
