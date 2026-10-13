"""/health и /ready: процесс жив и процесс готов (аудит P-16).

/health отвечал «ок» и при лежащей базе — установщик и readiness-проба считали сервис
готовым. /ready трогает базу (SELECT 1) и отвечает 503, если она недоступна.
"""

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.exc import OperationalError

from app.database import get_db
from app.main import app


class _DeadDb:
    def execute(self, *_args: object, **_kwargs: object) -> None:
        raise OperationalError("SELECT 1", {}, Exception("connection refused"))


@pytest.fixture()
def client():
    try:
        yield TestClient(app)
    finally:
        app.dependency_overrides.clear()


def test_ready_с_живой_базой(client, db) -> None:
    app.dependency_overrides[get_db] = lambda: db
    r = client.get("/ready")
    assert r.status_code == 200
    assert r.json() == {"status": "ok"}


def test_ready_без_базы_503_а_health_жив(client) -> None:
    app.dependency_overrides[get_db] = lambda: _DeadDb()
    r = client.get("/ready")
    assert r.status_code == 503
    assert r.json() == {"detail": "База данных недоступна"}
    assert client.get("/health").json() == {"status": "ok"}
