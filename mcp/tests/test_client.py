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
    api.routes[("POST", "/nodes")] = httpx.Response(
        422, json={"detail": [{"loc": ["body", "name"], "msg": "Field required"}]}
    )

    with pytest.raises(ArchMapError) as exc:
        await client.request("POST", "/nodes", project_id=PROJECT_ID, json={})

    assert "name: Field required" in str(exc.value)


async def test_сервис_не_поднят_говорит_куда_смотреть() -> None:
    from archmap_mcp.client import Config

    config = Config()
    config.username, config.password, config.base_url = "a", "b", "http://archmap.test"

    async def refuse(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("connection refused")

    broken = ArchMapClient(config, http=httpx.AsyncClient(transport=httpx.MockTransport(refuse)))
    with pytest.raises(ArchMapError) as exc:
        await broken.request("GET", "/projects")

    assert "ARCHMAP_URL" in str(exc.value)


async def test_промах_формы_пути_виден_отказом(client: ArchMapClient, api: FakeApi) -> None:
    """Коллекции — без хвостового слэша, и промах формы обязан ПАДАТЬ.

    Раньше бэк отвечал на «/projects/» 307-редиректом с пустым телом, клиент без
    follow_redirects возвращал None, и живой ArchMap выглядел как «проектов нет»
    при полной базе (полевая находка Ф1). Лечили следованием редиректу, но это
    маскировка: с 2026-09-05 redirect_slashes на бэке выключен, лишний слэш —
    честный 404, и клиент поднимает ArchMapError С ТЕКСТОМ, а не молчит."""
    api.get("/projects", [{"id": PROJECT_ID, "name": "Ярмарка", "object_count": 3}])

    with pytest.raises(ArchMapError) as exc:
        await client.request("GET", "/projects/")
    assert "/projects/" in str(exc.value)

    # Канонический путь той же коллекции работает — промахнулась форма, не доступ.
    assert await client.request("GET", "/projects") == [
        {"id": PROJECT_ID, "name": "Ярмарка", "object_count": 3}
    ]


async def test_multipart_уходит_файлами_и_полями_формы(
    client: ArchMapClient, api: FakeApi
) -> None:
    """Единый импорт принимает multipart: files[] + поля формы. httpx не даст
    послать json и files разом, поэтому тело обязано быть формой целиком."""
    api.post("/projects/import-unified", {"ok": True})

    await client.request(
        "POST",
        "/projects/import-unified",
        files=[
            ("files", ("a.yaml", b"nodes: []", "text/yaml")),
            ("files", ("b.zip", b"PK\x03\x04", "application/zip")),
        ],
        data={"name": "Проект", "description": None, "resolutions": '{"x": "cand:1"}'},
    )

    sent = api.calls[-1]
    assert sent.headers["content-type"].startswith("multipart/form-data; boundary=")
    body = sent.content
    assert b'name="files"; filename="a.yaml"' in body
    assert b'name="files"; filename="b.zip"' in body
    assert b'name="name"' in body
    assert "Проект".encode() in body
    assert b'"cand:1"' in body
    # Пустое поле формы не отправляется: у бэка Form(default=None), и «» вместо
    # отсутствия — другой смысл (пустое имя вместо «возьми из манифеста»).
    assert b'name="description"' not in body


async def test_бинарный_ответ_возвращает_байты(client: ArchMapClient, api: FakeApi) -> None:
    # Архив проекта — zip; resp.json() на нём падает разбором.
    api.routes[("GET", "/export/archive")] = httpx.Response(
        200, content=b"PK\x03\x04nonjson", headers={"content-type": "application/zip"}
    )

    payload = await client.request_bytes("GET", "/export/archive", project_id=PROJECT_ID)

    assert payload.startswith(b"PK\x03\x04")
    assert api.calls[-1].headers["X-Project-Id"] == PROJECT_ID


async def test_отказ_на_бинарном_пути_переводится_так_же(
    client: ArchMapClient, api: FakeApi
) -> None:
    """Словарь отказов у бинарного и JSON-пути общий — иначе формулировки
    разойдутся, и агент на архиве получит «Ошибка 409» вместо инструкции."""
    api.routes[("GET", "/export/archive")] = httpx.Response(409, json={"detail": "причина"})

    with pytest.raises(ArchMapError) as exc:
        await client.request_bytes("GET", "/export/archive", project_id=PROJECT_ID)

    assert "Конфликт версий" in str(exc.value)
