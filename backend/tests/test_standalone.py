"""Режим одного процесса (app/standalone.py): бэкенд сам отдаёт фронт вместо nginx."""

import asyncio
import uuid

import httpx
import pytest
from fastapi.testclient import TestClient
from starlette.responses import JSONResponse

from app import standalone
from app.auth import hash_password
from app.config import settings
from app.database import get_db
from app.main import app as api
from app.models.user import User
from app.standalone import IMMUTABLE, LOGIN_LIMITED_DETAIL, Standalone

INDEX = b"<!doctype html><title>ArchMap</title>"
BUNDLE = b"console.log('archmap');" * 200  # больше 1 КБ: такой ответ сжимается
PASSWORD = "верный-пароль-1"


@pytest.fixture()
def frontend(tmp_path):
    dist = tmp_path / "dist"
    (dist / "assets").mkdir(parents=True)
    (dist / "index.html").write_bytes(INDEX)
    (dist / "favicon.svg").write_text("<svg/>")
    (dist / "assets" / "index-abc123.js").write_bytes(BUNDLE)
    return dist


@pytest.fixture()
def make_client(db, frontend):
    def _db():
        yield db

    api.dependency_overrides[get_db] = _db

    def make(**limits: int) -> TestClient:
        options = {"max_request_mb": 64, "login_attempts_per_minute": 10} | limits
        return TestClient(Standalone(api, frontend, **options))

    try:
        yield make
    finally:
        api.dependency_overrides.clear()


@pytest.fixture()
def client(make_client):
    return make_client()


@pytest.fixture()
def user(db):
    db.add(
        User(id=uuid.uuid4(), username="ivan", hashed_password=hash_password(PASSWORD), role="architect")
    )
    db.commit()


def _login(client: TestClient, password: str, forwarded: str = "10.0.0.5"):
    return client.post(
        "/api/v1/auth/login",
        data={"username": "ivan", "password": password},
        headers={"X-Forwarded-For": forwarded},
    )


# ── Сборка фронта ───────────────────────────────────────────────────────────


def test_маршруты_интерфейса_и_swagger_отдают_index(client):
    for path in ("/", "/index.html", "/projects/3f2a/nodes/x", "/api", "/docs", "/openapi.json"):
        res = client.get(path)
        assert res.status_code == 200, path
        assert res.content == INDEX, path
        assert res.headers["cache-control"] == "no-cache"
        # Без валидаторов: после обновления браузер не получит старый index из кэша
        assert "etag" not in res.headers and "last-modified" not in res.headers


def test_сборка_кэшируется_навсегда(client):
    res = client.get("/assets/index-abc123.js")
    assert res.status_code == 200
    assert res.content == BUNDLE
    assert res.headers["cache-control"] == IMMUTABLE
    assert "javascript" in res.headers["content-type"]


def test_пропавший_файл_сборки_404_а_не_страница(client):
    res = client.get("/assets/index-old999.js")
    assert res.status_code == 404
    assert res.content != INDEX


def test_файлы_из_корня_сборки_без_кэша(client):
    res = client.get("/favicon.svg")
    assert res.status_code == 200
    assert res.text == "<svg/>"
    assert res.headers["cache-control"] == "no-cache"


def test_за_каталог_сборки_не_выйти(client, frontend):
    (frontend.parent / "secret.txt").write_text("секрет")
    for path in ("/%2e%2e/secret.txt", "/assets/%2e%2e/%2e%2e/secret.txt"):
        assert "секрет" not in client.get(path).text, path


def test_запись_во_фронт_405(client):
    assert client.post("/").status_code == 405


# ── API ─────────────────────────────────────────────────────────────────────


def test_api_и_health_уходят_в_бэкенд(client):
    assert client.get("/health").json() == {"status": "ok"}
    res = client.get("/api/v1/auth/config")
    assert res.status_code == 200
    assert "allow_signup" in res.json()


def test_промахи_api_как_без_обёртки(client):
    bare = TestClient(api)
    for method, path in (
        ("GET", "/api/v1/nope"),
        ("POST", "/api/v1/projects/"),  # хвостовой слэш — честный 404
        ("DELETE", "/api/v1/auth/config"),  # не тот метод — 405
    ):
        got, want = client.request(method, path), bare.request(method, path)
        assert (got.status_code, got.json()) == (want.status_code, want.json()), (method, path)


def test_служебные_события_доходят_до_api(make_client):
    with make_client() as client:
        assert client.get("/health").status_code == 200


def test_большой_запрос_отклоняется_до_чтения(make_client):
    client = make_client(max_request_mb=1)
    res = client.post(
        "/api/v1/projects/import",
        content=b"x" * (1024 * 1024 + 1),
        headers={"Content-Type": "application/octet-stream"},
    )
    assert res.status_code == 413
    assert "1 МБ" in res.json()["detail"]


def test_большое_тело_без_длины_отклоняется_при_чтении(make_client):
    client = make_client(max_request_mb=1)

    def chunks():
        yield b"username=ivan&password="
        for _ in range(3):
            yield b"y" * (600 * 1024)

    res = client.post(
        "/api/v1/auth/login",
        content=chunks(),
        headers={"Content-Type": "application/x-www-form-urlencoded"},
    )
    assert res.status_code == 413
    assert "1 МБ" in res.json()["detail"]


# ── Попытки входа ───────────────────────────────────────────────────────────


def test_перебор_пароля_упирается_в_лимит(make_client, user):
    client = make_client(login_attempts_per_minute=3)
    for _ in range(3):
        assert _login(client, "неверный").status_code == 401
    res = _login(client, PASSWORD)
    assert res.status_code == 429
    assert res.json()["detail"] == LOGIN_LIMITED_DETAIL
    # У другого адреса свой счётчик
    assert _login(client, PASSWORD, forwarded="10.0.0.6").status_code == 200


def test_подделанный_адрес_в_начале_заголовка_не_обходит_лимит(make_client, user):
    client = make_client(login_attempts_per_minute=2)
    # Роутер дописывает настоящий адрес последним; первые значения шлёт клиент
    for fake in ("1.1.1.1", "2.2.2.2"):
        assert _login(client, "неверный", forwarded=f"{fake}, 10.0.0.5").status_code == 401
    assert _login(client, "неверный", forwarded="3.3.3.3, 10.0.0.5").status_code == 429


def test_удачные_входы_лимит_не_съедают(make_client, user):
    client = make_client(login_attempts_per_minute=2)
    for _ in range(4):
        assert _login(client, PASSWORD).status_code == 200


def test_параллельный_перебор_не_проскакивает_лимит(frontend):
    """Попытка засчитывается при приходе, а не после проверки пароля: пачка
    одновременных запросов упирается в лимит сразу."""

    async def scenario() -> list[int]:
        release = asyncio.Event()

        async def slow_api(scope, receive, send):
            await release.wait()  # пароль «проверяется», пока тест не отпустит
            await JSONResponse({"detail": "Неверный логин или пароль"}, status_code=401)(
                scope, receive, send
            )

        app = Standalone(slow_api, frontend, max_request_mb=64, login_attempts_per_minute=3)
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://archmap") as client:
            form = {"username": "ivan", "password": "неверный"}
            attempts = [
                asyncio.create_task(client.post("/api/v1/auth/login", data=form)) for _ in range(5)
            ]
            await asyncio.sleep(0.1)  # все пять дошли до лимита, три ждут проверки
            release.set()
            return sorted(r.status_code for r in await asyncio.gather(*attempts))

    assert asyncio.run(scenario()) == [401, 401, 401, 429, 429]


def test_лимит_входа_выключается_нулём(make_client, user):
    client = make_client(login_attempts_per_minute=0)
    for _ in range(4):
        assert _login(client, "неверный").status_code == 401


# ── Сборка приложения ───────────────────────────────────────────────────────


def test_create_app_сжимает_ответы(monkeypatch, make_client, frontend):
    monkeypatch.setattr(settings, "frontend_dir", str(frontend))
    client = TestClient(standalone.create_app())
    res = client.get("/assets/index-abc123.js", headers={"Accept-Encoding": "gzip"})
    assert res.headers["content-encoding"] == "gzip"
    assert res.content == BUNDLE


def test_create_app_без_сборки_фронта_не_стартует(monkeypatch, tmp_path):
    monkeypatch.setattr(settings, "frontend_dir", "")
    with pytest.raises(RuntimeError, match="FRONTEND_DIR"):
        standalone.create_app()
    monkeypatch.setattr(settings, "frontend_dir", str(tmp_path))
    with pytest.raises(RuntimeError, match="index.html"):
        standalone.create_app()
