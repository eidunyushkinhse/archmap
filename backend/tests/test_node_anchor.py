"""Якорь узла как первоклассная сущность: контракт source в ответе и в PATCH.

Ф0 эпика docs/plan-anchor-ux.md. До неё nodes.source_ref был скрытой метаданной
прогона агента: узел, созданный руками, обречён был жить без якоря и вести себя
при обновлениях иначе, чем агентский с виду такой же узел. Здесь якорь становится
видимым (NodeResponse.source) и управляемым (NodeUpdate.source): архитектор
задаёт и чистит его сам.

Проверяем то, ради чего контракт вводился: оба вида собираются в тот же
канонический ключ, что и импорт; вид один на объект (отказы 422 с человеческими
текстами принятого пояснения); отсутствие поля в payload якорь НЕ трогает (фронт
шлёт полные свойства узла и про якорь не знает); правка якоря — мета, а не схема.
"""

import uuid

import pytest
from conftest import ensure_architect, ensure_project
from fastapi import HTTPException

from app.models.node import Node
from app.routers.nodes import get_node, update_node
from app.schemas.node import NodeResponse, NodeSource, NodeUpdate


def _node(db, name="payments", source_ref=None):
    n = Node(id=uuid.uuid4(), name=name, project_id=ensure_project(db).id, source_ref=source_ref)
    db.add(n)
    db.commit()
    return n


def _patch(db, node, **kwargs):
    return update_node(
        node.id,
        NodeUpdate(**kwargs),
        db=db,
        project=ensure_project(db),
        user=ensure_architect(db),
    )


class TestЗадатьЯкорь:
    def test_код_приводится_к_каноническому_виду(self, db):
        # Архитектор вставляет адрес клона целиком и путь как в файловой системе —
        # ArchMap приводит их к тому же ключу, что собрал бы импорт из репозитория.
        node = _node(db)
        out = _patch(
            db, node, source=NodeSource(repo="https://github.com/org/repo.git", path="./src/api/")
        )
        assert out.source_ref == "git:github.com/org/repo#src/api"
        assert out.source == {"repo": "github.com/org/repo", "path": "src/api"}
        # …и то же самое доезжает до контракта: from_attributes читает свойство ORM.
        сериализовано = NodeResponse.model_validate(out).model_dump()["source"]
        assert сериализовано == {"repo": "github.com/org/repo", "path": "src/api", "host": None}

    def test_репозиторий_без_пути(self, db):
        node = _node(db)
        out = _patch(db, node, source=NodeSource(repo="git@github.com:Org/Repo.git"))
        assert out.source_ref == "git:github.com/org/repo"
        assert out.source == {"repo": "github.com/org/repo"}

    def test_имя_зависимости_без_порта(self, db):
        # «postgres» и «postgres:5432» — одна зависимость.
        node = _node(db, "postgres")
        out = _patch(db, node, source=NodeSource(host="postgres:5432"))
        assert out.source_ref == "host:postgres"
        assert out.source == {"host": "postgres"}


class TestОчиститьЯкорь:
    def test_null_чистит(self, db):
        node = _node(db, source_ref="git:github.com/org/repo")
        assert _patch(db, node, source=None).source_ref is None

    def test_пустой_объект_чистит(self, db):
        # Форма «Очистить» может прислать и пустые поля вместо null — тот же смысл.
        node = _node(db, source_ref="host:kafka")
        out = _patch(db, node, source=NodeSource())
        assert out.source_ref is None and out.source is None


class TestОтказы:
    def test_два_вида_сразу(self, db):
        node = _node(db)
        with pytest.raises(HTTPException) as e:
            _patch(db, node, source=NodeSource(repo="github.com/org/repo", host="payments"))
        assert e.value.status_code == 422
        assert "Якорь одного вида" in e.value.detail

    def test_путь_без_репозитория(self, db):
        node = _node(db)
        with pytest.raises(HTTPException) as e:
            _patch(db, node, source=NodeSource(path="src/api"))
        assert e.value.status_code == 422
        assert e.value.detail == "Путь задаётся вместе с репозиторием"

    @pytest.mark.parametrize("host", ["localhost:5432", "127.0.0.1", "host.docker.internal"])
    def test_петлевой_адрес_не_якорь(self, db, host):
        # Адрес среды: любая БД любого продукта дала бы такой же ключ.
        node = _node(db)
        with pytest.raises(HTTPException) as e:
            _patch(db, node, source=NodeSource(host=host))
        assert e.value.status_code == 422
        assert "принадлежат среде" in e.value.detail

    def test_репозиторий_из_мусора(self, db):
        node = _node(db)
        with pytest.raises(HTTPException) as e:
            _patch(db, node, source=NodeSource(repo="///"))
        assert e.value.status_code == 422
        assert "github.com/org/repo" in e.value.detail

    def test_отказ_не_трогает_узел(self, db):
        node = _node(db, source_ref="git:github.com/org/repo")
        v0 = node.version
        with pytest.raises(HTTPException):
            _patch(db, node, source=NodeSource(path="src/api"))
        db.refresh(node)
        assert node.source_ref == "git:github.com/org/repo" and node.version == v0


class TestПоляНетЯкорьНеТрогаем:
    def test_patch_без_source_сохраняет_якорь(self, db):
        # Фронт шлёт полный payload свойств узла и про якорь ничего не знает:
        # unset-поле обязано остаться unset, иначе каждая правка описания стирала
        # бы отпечаток прогона агента.
        node = _node(db, source_ref="git:github.com/org/repo#src/api")
        out = _patch(db, node, name="payments", role="сервис", technology="Python")
        assert out.source_ref == "git:github.com/org/repo#src/api"


class TestКурсоры:
    def test_смена_якоря_двигает_мету_а_не_схему(self, db):
        # Якорь ничего не меняет на холсте — он про то, как ArchMap узнаёт объект
        # при обновлениях. Тост «схема изменилась» на него всплывать не должен.
        node = _node(db)
        project = ensure_project(db)
        g0, m0 = project.graph_rev, project.meta_rev

        _patch(db, node, source=NodeSource(host="kafka"))
        db.refresh(project)
        assert (project.graph_rev, project.meta_rev) == (g0, m0 + 1)

    def test_тот_же_якорь_курсоров_не_двигает(self, db):
        node = _node(db, source_ref="host:kafka")
        project = ensure_project(db)
        g0, m0 = project.graph_rev, project.meta_rev

        _patch(db, node, source=NodeSource(host="kafka:9092"))
        db.refresh(project)
        assert (project.graph_rev, project.meta_rev) == (g0, m0)


class TestЧтение:
    def test_get_отдаёт_разобранный_якорь_агентского_узла(self, db):
        # Узел, привезённый прогоном агента: карточка объекта показывает вид «код».
        node = _node(db, source_ref="git:github.com/org/mono#services/orders")
        out = get_node(node.id, db=db, project=ensure_project(db))
        assert out.source == {"repo": "github.com/org/mono", "path": "services/orders"}

    def test_без_якоря_поле_пустое(self, db):
        node = _node(db)
        out = get_node(node.id, db=db, project=ensure_project(db))
        assert out.source is None
        assert NodeResponse.model_validate(out).source is None
