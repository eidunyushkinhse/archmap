"""Конфигурация сервиса — параметры и переменные окружения
(docs/plan-config-docs.md §6, Ф0).

Проверяется то, ради чего модель именно такая:
  • владелец параметра — САМ СЕРВИС, поэтому одинаковое имя у двух сервисов это две
    записи, а не одна общая (решение §2.2);
  • имя уникально в пределах узла — и на нём же держится будущий резолв «зависит от:»,
    которому больше искать негде;
  • форма узла на мутациях НЕ проверяется, в отличие от каналов брокера, — расхождение
    осознанное (см. routers/config_params.py);
  • снос узла уносит его конфигурацию, чужой проект недоступен даже по прямому id;
  • конфигурация это МЕТА узла: мутации двигают meta_rev, а не graph_rev.
"""

import uuid

import pytest
from conftest import ensure_architect, ensure_project
from fastapi import HTTPException

from app.models.config_param import ConfigParam
from app.models.node import Node
from app.models.project import Project
from app.routers.config_params import (
    create_param,
    delete_param,
    list_params,
    update_param,
)
from app.schemas.config_param import ConfigParamCreate, ConfigParamUpdate


def _node(db, name, shape="service", project=None):
    n = Node(
        id=uuid.uuid4(),
        name=name,
        shape=shape,
        project_id=(project or ensure_project(db)).id,
    )
    db.add(n)
    db.flush()
    return n


def _param(db, node, name="FEATURE_NEW_CHECKOUT", project=None, **мета):
    return create_param(
        node.id,
        ConfigParamCreate(name=name, **мета),
        db=db,
        project=project or ensure_project(db),
        user=ensure_architect(db),
    )


# ── CRUD-цикл ─────────────────────────────────────────────────────────────────


def test_параметр_создаётся_правится_и_читается(db):
    сервис = _node(db, "Платежи")
    параметр = _param(
        db,
        сервис,
        "RETRY_TIMEOUT",
        value_type="duration",
        required=False,
        default_value="30s",
        description="сколько ждать перед повтором запроса к банку",
    )

    было = параметр.version
    обновлённый = update_param(
        сервис.id,
        параметр.id,
        ConfigParamUpdate(required=True, default_value="", base_version=было),
        db=db,
        project=ensure_project(db),
        user=ensure_architect(db),
    )
    assert обновлённый.required is True
    assert обновлённый.version == было + 1

    [прочитанный] = list_params(
        сервис.id, db=db, project=ensure_project(db), _=ensure_architect(db)
    )
    assert (прочитанный.name, прочитанный.value_type) == ("RETRY_TIMEOUT", "duration")
    assert прочитанный.description == "сколько ждать перед повтором запроса к банку"
    # Дефолта нет — пустая строка, а не NULL: «дефолт есть, и он пустой» мы отличать
    # не стали осознанно (см. модель), и API обязан отдавать ровно строку.
    assert прочитанный.default_value == ""


def test_параметры_отдаются_по_алфавиту(db):
    """Порядок у конфигурации свой не хранится (поля order нет — решение §2.3):
    перечень ручек читают глазами, и алфавит здесь единственный неспорный порядок."""
    сервис = _node(db, "Платежи")
    _param(db, сервис, "TIMEOUT_MS")
    _param(db, сервис, "DATABASE_URL")
    _param(db, сервис, "LOG_LEVEL")

    имена = [
        p.name
        for p in list_params(
            сервис.id, db=db, project=ensure_project(db), _=ensure_architect(db)
        )
    ]
    assert имена == ["DATABASE_URL", "LOG_LEVEL", "TIMEOUT_MS"]


def test_удаление_убирает_только_свой_параметр(db):
    сервис = _node(db, "Платежи")
    лишний = _param(db, сервис, "OLD_FLAG")
    _param(db, сервис, "LOG_LEVEL")

    delete_param(
        сервис.id, лишний.id, db=db, project=ensure_project(db), user=ensure_architect(db)
    )
    assert [p.name for p in db.query(ConfigParam).all()] == ["LOG_LEVEL"]


# ── Уникальность и владение ───────────────────────────────────────────────────


def test_имя_уникально_у_узла_но_общий_параметр_живёт_у_каждого_сервиса(db):
    """Решение §2.2: LOG_LEVEL у двух сервисов — ДВЕ записи. Назначение и дефолт у них
    разные, и единая запись врала бы про общность."""
    платежи = _node(db, "Платежи")
    заказы = _node(db, "Заказы")

    _param(db, платежи, "LOG_LEVEL", default_value="info")
    with pytest.raises(HTTPException) as e:
        _param(db, платежи, "LOG_LEVEL")
    assert e.value.status_code == 409

    у_заказов = _param(db, заказы, "LOG_LEVEL", default_value="debug")
    assert у_заказов.default_value == "debug"
    assert db.query(ConfigParam).filter(ConfigParam.name == "LOG_LEVEL").count() == 2


def test_переименование_в_занятое_имя_отвергается(db):
    сервис = _node(db, "Платежи")
    _param(db, сервис, "LOG_LEVEL")
    другой = _param(db, сервис, "LOG_FORMAT")
    with pytest.raises(HTTPException) as e:
        update_param(
            сервис.id,
            другой.id,
            ConfigParamUpdate(name="LOG_LEVEL"),
            db=db,
            project=ensure_project(db),
            user=ensure_architect(db),
        )
    assert e.value.status_code == 409


def test_форма_узла_на_мутациях_не_проверяется(db):
    """Осознанное расхождение с каналами брокера: конфигурация ведёт себя как схемы
    логики — принадлежит сервису, а у неподходящей формы показывается legacy-механикой.
    Запрещать на входе нечего, «применённого-но-невидимого» не возникает."""
    база = _node(db, "Postgres", shape="database")
    параметр = _param(db, база, "MAX_CONNECTIONS")
    assert параметр.node_id == база.id


# ── CAS ───────────────────────────────────────────────────────────────────────


def test_правка_от_устаревшей_версии_отвергается(db):
    сервис = _node(db, "Платежи")
    параметр = _param(db, сервис, "LOG_LEVEL")
    update_param(
        сервис.id,
        параметр.id,
        ConfigParamUpdate(default_value="info", base_version=параметр.version),
        db=db,
        project=ensure_project(db),
        user=ensure_architect(db),
    )
    # Вторая сессия правит от той же (уже устаревшей) версии — 409, чужая правка цела.
    with pytest.raises(HTTPException) as e:
        update_param(
            сервис.id,
            параметр.id,
            ConfigParamUpdate(default_value="debug", base_version=1),
            db=db,
            project=ensure_project(db),
            user=ensure_architect(db),
        )
    assert e.value.status_code == 409
    assert db.get(ConfigParam, параметр.id).default_value == "info"


# ── Каскад ────────────────────────────────────────────────────────────────────


def test_снос_узла_уносит_его_конфигурацию(db):
    сервис = _node(db, "Платежи")
    сосед = _node(db, "Заказы")
    _param(db, сервис, "LOG_LEVEL")
    чужой = _param(db, сосед, "LOG_LEVEL")

    db.delete(сервис)
    db.commit()

    # Ушли ровно свои: конфигурация принадлежит узлу, а не проекту.
    assert [p.id for p in db.query(ConfigParam).all()] == [чужой.id]


# ── Скоуп проекта ─────────────────────────────────────────────────────────────


def test_чужой_проект_не_виден(db):
    """Скоуп — проект, а не вся база: db.get по PK его игнорирует, и без явной
    проверки параметр чужого узла был бы доступен по прямому id."""
    свой = ensure_project(db)
    чужой = Project(id=uuid.uuid4(), name="Другой проект")
    db.add(чужой)
    db.flush()

    сервис = _node(db, "Платежи", project=свой)
    чужой_сервис = _node(db, "Платежи", project=чужой)
    параметр = _param(db, сервис, "LOG_LEVEL")
    чужой_параметр = _param(db, чужой_сервис, "LOG_LEVEL", project=чужой)

    with pytest.raises(HTTPException) as e:
        list_params(чужой_сервис.id, db=db, project=свой, _=ensure_architect(db))
    assert e.value.status_code == 404

    # И параметр чужого узла не доехать через СВОЙ узел: id скоупится узлом.
    with pytest.raises(HTTPException) as e:
        update_param(
            сервис.id,
            чужой_параметр.id,
            ConfigParamUpdate(value_type="string"),
            db=db,
            project=свой,
            user=ensure_architect(db),
        )
    assert e.value.status_code == 404

    [видимый] = list_params(сервис.id, db=db, project=свой, _=ensure_architect(db))
    assert видимый.id == параметр.id


# ── Курсор меты ───────────────────────────────────────────────────────────────


def test_мутации_двигают_meta_rev_а_не_graph_rev(db):
    """Конфигурация — МЕТА узла (видна на его странице, не на схеме): поллинг обязан
    отличать её от изменений схемы, иначе холст пересобирался бы на каждую правку."""
    сервис = _node(db, "Платежи")
    проект = ensure_project(db)
    db.commit()
    g0, m0 = проект.graph_rev, проект.meta_rev

    параметр = _param(db, сервис, "LOG_LEVEL")
    assert (проект.graph_rev, проект.meta_rev) == (g0, m0 + 1)

    update_param(
        сервис.id,
        параметр.id,
        ConfigParamUpdate(value_type="string"),
        db=db,
        project=проект,
        user=ensure_architect(db),
    )
    assert (проект.graph_rev, проект.meta_rev) == (g0, m0 + 2)

    delete_param(
        сервис.id, параметр.id, db=db, project=проект, user=ensure_architect(db)
    )
    assert (проект.graph_rev, проект.meta_rev) == (g0, m0 + 3)
