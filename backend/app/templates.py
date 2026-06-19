"""Преднастроенные шаблоны схемы для старта нового проекта (POST /projects
с start="template:<id>"). Каждый шаблон — набор узлов (с локальным ключом и
опциональным родителем) и связей между ключами.

Узлам задаём ГОТОВУЮ раскладку (x/y — левый-верхний угол, как отдаёт ELK): эти
координаты ложатся в pos_x/pos_y и становятся savedPos на холсте (перетирают
авто-ELK), а главное — попадают в реальную БД, поэтому превью карточки лендинга
показывает шаблонный проект так же, как он выглядит на холсте (иначе у узлов без
координат превью гадало бы раскладку). Сетка: узел 190×100, шаг колонок 310
(NODE_W+120 межрангового зазора ELK), шаг рядов 160 (NODE_H+60), слои слева
направо.
"""

import uuid
from dataclasses import dataclass, field

from sqlalchemy.orm import Session

from app.models.edge import Edge
from app.models.node import Node


@dataclass
class _NodeSpec:
    key: str
    name: str
    shape: str = "service"
    role: str | None = None
    technology: str | None = None
    parent: str | None = None
    # Готовая позиция узла (левый-верхний угол) для холста и превью.
    x: float | None = None
    y: float | None = None


@dataclass
class _EdgeSpec:
    source: str
    target: str
    label: str | None = None
    technology: str | None = None


@dataclass
class _Template:
    id: str
    name: str
    description: str
    nodes: list[_NodeSpec] = field(default_factory=list)
    edges: list[_EdgeSpec] = field(default_factory=list)


# ── Каталог шаблонов ──────────────────────────────────────────────────────────
_TEMPLATES: dict[str, _Template] = {
    "microservices": _Template(
        id="microservices",
        name="Микросервисы",
        description="API-шлюз, пара сервисов, БД и брокер.",
        nodes=[
            # L0: шлюз; L1: сервисы; L2: БД и брокер.
            _NodeSpec("gw", "API Gateway", role="шлюз", technology="Nginx", x=30, y=110),
            _NodeSpec("svc_a", "Сервис заказов", role="сервис", technology="Python", x=340, y=30),
            _NodeSpec("svc_b", "Сервис оплаты", role="сервис", technology="Go", x=340, y=190),
            _NodeSpec("db", "PostgreSQL", shape="database", technology="PostgreSQL", x=650, y=30),
            _NodeSpec("mq", "Kafka", shape="broker", technology="Kafka", x=650, y=190),
        ],
        edges=[
            _EdgeSpec("gw", "svc_a", "REST", "HTTP"),
            _EdgeSpec("gw", "svc_b", "REST", "HTTP"),
            _EdgeSpec("svc_a", "db", "SQL", "PostgreSQL"),
            _EdgeSpec("svc_a", "mq", "события", "Kafka"),
            _EdgeSpec("svc_b", "mq", "события", "Kafka"),
        ],
    ),
    "c4": _Template(
        id="c4",
        name="C4: система и контейнеры",
        description="Пользователь, система и её контейнеры (веб, API, БД).",
        nodes=[
            # Цепочка слева направо: пользователь → веб → api → БД.
            _NodeSpec("user", "Пользователь", shape="person", role="актор", x=30, y=30),
            _NodeSpec("web", "Веб-приложение", role="frontend", technology="React", x=340, y=30),
            _NodeSpec("api", "API-приложение", role="backend", technology="FastAPI", x=650, y=30),
            _NodeSpec("db", "База данных", shape="database", technology="PostgreSQL", x=960, y=30),
        ],
        edges=[
            _EdgeSpec("user", "web", "пользуется", "HTTPS"),
            _EdgeSpec("web", "api", "вызывает", "REST"),
            _EdgeSpec("api", "db", "читает/пишет", "SQL"),
        ],
    ),
    "eventdriven": _Template(
        id="eventdriven",
        name="Событийная архитектура",
        description="Продюсер, брокер, консьюмеры и хранилище.",
        nodes=[
            # L0: продюсер; L1: брокер; L2: консьюмеры; L3: хранилище.
            _NodeSpec("producer", "Продюсер", role="источник", technology="Python", x=30, y=110),
            _NodeSpec("broker", "Брокер событий", shape="broker", technology="Kafka", x=340, y=110),
            _NodeSpec("consumer_a", "Консьюмер аналитики", role="обработчик", x=650, y=30),
            _NodeSpec("consumer_b", "Консьюмер уведомлений", role="обработчик", x=650, y=190),
            _NodeSpec("store", "Хранилище", shape="database", technology="ClickHouse", x=960, y=30),
        ],
        edges=[
            _EdgeSpec("producer", "broker", "публикует", "Kafka"),
            _EdgeSpec("broker", "consumer_a", "подписка", "Kafka"),
            _EdgeSpec("broker", "consumer_b", "подписка", "Kafka"),
            _EdgeSpec("consumer_a", "store", "пишет", "SQL"),
        ],
    ),
}


def template_ids() -> list[str]:
    return list(_TEMPLATES.keys())


def seed_template(db: Session, project_id: uuid.UUID, template_id: str) -> bool:
    """Засеять схему проекта узлами/связями шаблона. Возвращает False, если шаблон
    неизвестен (роутер вернёт 404). Коммит — на вызывающей стороне."""
    tpl = _TEMPLATES.get(template_id)
    if tpl is None:
        return False

    id_by_key: dict[str, uuid.UUID] = {}
    for ns in tpl.nodes:
        nid = uuid.uuid4()
        id_by_key[ns.key] = nid
        db.add(
            Node(
                id=nid,
                project_id=project_id,
                name=ns.name,
                role=ns.role,
                technology=ns.technology,
                shape=ns.shape,
                parent_id=id_by_key.get(ns.parent) if ns.parent else None,
                pos_x=ns.x,
                pos_y=ns.y,
            )
        )
    db.flush()  # узлы до рёбер (FK)
    for es in tpl.edges:
        db.add(
            Edge(
                id=uuid.uuid4(),
                project_id=project_id,
                source_id=id_by_key[es.source],
                target_id=id_by_key[es.target],
                label=es.label,
                technology=es.technology,
            )
        )
    return True
