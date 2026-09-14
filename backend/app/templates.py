"""Преднастроенные шаблоны схемы для старта нового проекта (POST /projects
с start="template:<id>") и их каталог для витрины выбора (GET /projects/templates).
Каждый шаблон — набор узлов (с локальным ключом и опциональным родителем) и
связей между ключами.

Узлам задаём ГОТОВУЮ раскладку (x/y — левый-верхний угол, как отдаёт ELK): эти
координаты ложатся строками view_layout (вид = родитель узла) и становятся
savedPos на холсте (перетирают авто-ELK), а главное — попадают в реальную БД,
поэтому превью карточки лендинга и живое превью в модалке создания показывают
шаблонный проект так же, как он выглядит на холсте (иначе у узлов без координат
превью гадало бы раскладку).
Сетка: узел 190×100, шаг колонок 310 (NODE_W+120 межрангового зазора ELK),
шаг рядов 160 (NODE_H+60), слои слева направо.

ВТОРОЙ ВИД ШАБЛОНА — ПАКЕТНЫЙ (demo-marketplace): не каркас, а готовый проект
целиком (процессы, схемы логики, спеки, три семьи фактов). Его содержание НЕ
объявляется здесь декларацией — оно лежит распакованным архивом знания в
template_packages/<id>/, а сеется существующими приёмниками единого импорта.
Своего сидера у него нет СОЗНАТЕЛЬНО: ручной перечень копируемых полей трижды
отставал от модели (см. app/copy_plan.py), и шаблон отстал бы так же.
Раскладку пакетный шаблон не везёт вовсе (решение Р3, docs/plan-demo-template.md):
ведёт себя ровно как импорт — всё раскладывает движок, x/y каталога пустые.
"""

import io
import uuid
import zipfile
from dataclasses import dataclass, field
from functools import cache
from pathlib import Path

from sqlalchemy.orm import Session

from app.import_yaml import parse_import
from app.models.edge import Edge
from app.models.node import Node
from app.models.project import Project
from app.models.view_layout import ViewLayoutItem
from app.unified_apply import apply_unified_plan
from app.unified_import import build_unified_plan


@dataclass
class _NodeSpec:
    key: str
    name: str
    shape: str = "service"
    role: str | None = None
    technology: str | None = None
    parent: str | None = None
    ext: bool = False  # внешняя система (серая на холсте) → Node.is_external
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
    tagline: str  # короткая строка-подзаголовок (1 строка) для витрины
    blurb: str  # абзац-описание под превью в модалке
    techs: list[str]  # чипы-технологии
    nodes: list[_NodeSpec] = field(default_factory=list)
    edges: list[_EdgeSpec] = field(default_factory=list)


# ── Каталог шаблонов ──────────────────────────────────────────────────────────
_TEMPLATES: dict[str, _Template] = {
    "monolith": _Template(
        id="monolith",
        name="Монолит",
        tagline="Одно приложение, база и внешние сервисы.",
        blurb="Самый простой старт: единое разворачиваемое приложение с базой данных. "
        "Оплата и почта вынесены во внешние системы, как на реальной контекст-схеме C4.",
        techs=["Django", "PostgreSQL", "Stripe"],
        nodes=[
            _NodeSpec("user", "Пользователь", shape="person", role="актор", ext=True, x=30, y=190),
            _NodeSpec("app", "Монолит", role="приложение", technology="Django", x=340, y=190),
            _NodeSpec("db", "База данных", shape="database", technology="PostgreSQL", x=650, y=30),
            _NodeSpec("mail", "Сервис email", technology="SendGrid", ext=True, x=650, y=190),
            _NodeSpec("pay", "Платёжный провайдер", technology="Stripe", ext=True, x=650, y=350),
        ],
        edges=[
            _EdgeSpec("user", "app", "пользуется", "HTTPS"),
            _EdgeSpec("app", "db", "читает/пишет", "SQL"),
            _EdgeSpec("app", "mail", "шлёт письма", "SMTP"),
            _EdgeSpec("app", "pay", "проводит оплату", "HTTPS"),
        ],
    ),
    "webapp": _Template(
        id="webapp",
        name="Веб-приложение",
        tagline="SPA, API, база и внешние провайдеры.",
        blurb="Классические три слоя: одностраничный фронтенд, серверное API и база. "
        "Вход через внешний провайдер и почта показаны как внешние системы, "
        "типовая container-схема.",
        techs=["React", "FastAPI", "PostgreSQL", "OIDC"],
        nodes=[
            _NodeSpec("user", "Пользователь", shape="person", role="актор", ext=True, x=30, y=190),
            _NodeSpec("spa", "Веб-приложение", role="SPA", technology="React", x=340, y=190),
            _NodeSpec("api", "API-приложение", role="API", technology="FastAPI", x=650, y=190),
            _NodeSpec("db", "База данных", shape="database", technology="PostgreSQL", x=960, y=30),
            _NodeSpec("idp", "Провайдер входа", technology="OIDC", ext=True, x=960, y=190),
            _NodeSpec("mail", "Сервис email", technology="SendGrid", ext=True, x=960, y=350),
        ],
        edges=[
            _EdgeSpec("user", "spa", "пользуется", "HTTPS"),
            _EdgeSpec("spa", "api", "вызывает", "REST"),
            _EdgeSpec("api", "db", "читает/пишет", "SQL"),
            _EdgeSpec("api", "idp", "проверяет вход", "OIDC"),
            _EdgeSpec("api", "mail", "шлёт письма", "API"),
        ],
    ),
    "microservices": _Template(
        id="microservices",
        name="Микросервисы",
        tagline="Шлюз, пара сервисов, свои БД и брокер.",
        blurb="Шлюз раздаёт запросы независимым сервисам, у каждого собственная база "
        "(идиома «сервис + хранилище»). Сервисы связаны асинхронным брокером событий.",
        techs=["Kong", "Go", "Java", "Kafka"],
        nodes=[
            _NodeSpec("user", "Пользователь", shape="person", role="актор", ext=True, x=30, y=190),
            _NodeSpec("gw", "API Gateway", role="шлюз", technology="Kong", x=340, y=190),
            _NodeSpec("orders", "Сервис заказов", technology="Go", x=650, y=30),
            _NodeSpec("broker", "Брокер событий", shape="broker", technology="Kafka", x=650, y=190),
            _NodeSpec("payments", "Сервис оплаты", technology="Java", x=650, y=350),
            _NodeSpec("ordersDb", "БД заказов", shape="database", technology="PostgreSQL", x=960, y=30),
            _NodeSpec("paymentsDb", "БД оплаты", shape="database", technology="PostgreSQL", x=960, y=350),
        ],
        edges=[
            _EdgeSpec("user", "gw", "REST", "HTTPS"),
            _EdgeSpec("gw", "orders", "REST", "HTTP"),
            _EdgeSpec("gw", "payments", "REST", "HTTP"),
            _EdgeSpec("orders", "ordersDb", "SQL"),
            _EdgeSpec("payments", "paymentsDb", "SQL"),
            _EdgeSpec("orders", "broker", "публикует", "Kafka"),
            _EdgeSpec("broker", "payments", "подписка", "Kafka"),
        ],
    ),
    "eventdriven": _Template(
        id="eventdriven",
        name="Событийная",
        tagline="Продюсер, брокер, консьюмеры и хранилище.",
        blurb="Продюсер публикует события в брокер, несколько консьюмеров обрабатывают их "
        "независимо. Аналитика пишет в хранилище, уведомления уходят во внешний сервис пушей.",
        techs=["Kafka", "Spark", "ClickHouse"],
        nodes=[
            _NodeSpec("producer", "Сервис-продюсер", technology="Python", x=30, y=190),
            _NodeSpec("broker", "Брокер событий", shape="broker", technology="Kafka", x=340, y=190),
            _NodeSpec("analytics", "Консьюмер аналитики", technology="Spark", x=650, y=30),
            _NodeSpec("notify", "Консьюмер уведомлений", technology="Node.js", x=650, y=350),
            _NodeSpec("store", "Хранилище", shape="database", technology="ClickHouse", x=960, y=30),
            _NodeSpec("push", "Сервис уведомлений", technology="FCM / APNs", ext=True, x=960, y=350),
        ],
        edges=[
            _EdgeSpec("producer", "broker", "публикует", "Kafka"),
            _EdgeSpec("broker", "analytics", "подписка", "Kafka"),
            _EdgeSpec("broker", "notify", "подписка", "Kafka"),
            _EdgeSpec("analytics", "store", "пишет", "SQL"),
            _EdgeSpec("notify", "push", "шлёт пуш", "HTTPS"),
        ],
    ),
    "serverless": _Template(
        id="serverless",
        name="Бессерверная",
        tagline="Статика, API-шлюз, функции и облачные хранилища.",
        blurb="Фронтенд раздаётся с CDN, шлюз вызывает функции по событию, состояние хранится "
        "в управляемых NoSQL и объектном хранилище. Аутентификация вынесена во внешний "
        "облачный провайдер.",
        techs=["CloudFront", "Lambda", "DynamoDB", "S3"],
        nodes=[
            _NodeSpec("user", "Пользователь", shape="person", role="актор", ext=True, x=30, y=190),
            _NodeSpec("cdn", "Веб-клиент", role="SPA", technology="CloudFront", x=340, y=190),
            _NodeSpec("auth", "Аутентификация", technology="Cognito", ext=True, x=650, y=30),
            _NodeSpec("apigw", "API Gateway", technology="API Gateway", x=650, y=190),
            _NodeSpec("fn", "Функции", role="FaaS", technology="AWS Lambda", x=960, y=190),
            _NodeSpec("nosql", "NoSQL-база", shape="database", technology="DynamoDB", x=1270, y=30),
            _NodeSpec("objstore", "Объектное хранилище", shape="database", technology="S3", x=1270, y=350),
        ],
        edges=[
            _EdgeSpec("user", "cdn", "открывает", "HTTPS"),
            _EdgeSpec("cdn", "apigw", "REST", "HTTPS"),
            _EdgeSpec("apigw", "auth", "проверяет токен", "OIDC"),
            _EdgeSpec("apigw", "fn", "вызывает", "event"),
            _EdgeSpec("fn", "nosql", "читает/пишет"),
            _EdgeSpec("fn", "objstore", "хранит файлы"),
        ],
    ),
    "cqrs": _Template(
        id="cqrs",
        name="CQRS",
        tagline="Раздельные модели команд и запросов.",
        blurb="Запись и чтение разнесены: сервис команд пишет в свою базу и публикует события, "
        "сервис запросов строит из них проекцию для быстрого чтения. Для зрелых, "
        "нагруженных доменов.",
        techs=["FastAPI", "Kafka", "Elasticsearch"],
        nodes=[
            _NodeSpec("user", "Пользователь", shape="person", role="актор", ext=True, x=30, y=190),
            _NodeSpec("api", "API", technology="FastAPI", x=340, y=190),
            _NodeSpec("cmd", "Сервис команд", role="запись", x=650, y=30),
            _NodeSpec("broker", "Брокер событий", shape="broker", technology="Kafka", x=650, y=190),
            _NodeSpec("query", "Сервис запросов", role="чтение", x=650, y=350),
            _NodeSpec("writeDb", "БД записи", shape="database", technology="PostgreSQL", x=960, y=30),
            _NodeSpec("readDb", "БД чтения", shape="database", technology="Elasticsearch", x=960, y=350),
        ],
        edges=[
            _EdgeSpec("user", "api", "пользуется", "HTTPS"),
            _EdgeSpec("api", "cmd", "команды", "REST"),
            _EdgeSpec("api", "query", "запросы", "REST"),
            _EdgeSpec("cmd", "writeDb", "пишет", "SQL"),
            _EdgeSpec("cmd", "broker", "события", "Kafka"),
            _EdgeSpec("broker", "query", "проекции", "Kafka"),
            _EdgeSpec("query", "readDb", "читает"),
        ],
    ),
}


def template_ids() -> list[str]:
    return list(_TEMPLATES.keys())


def list_templates() -> list[dict]:
    """Каталог для витрины выбора (GET /projects/templates).

    У КАРКАСОВ x/y заданы всегда — превью в модалке совпадает с раскладкой на
    холсте. У ПАКЕТНОГО шаблона координат нет (раскладку он не везёт): превью
    считает их тем же ELK, что и холст, и снова показывает будущую раскладку."""
    frames: list[dict] = [
        {
            "id": t.id,
            "name": t.name,
            "tagline": t.tagline,
            "blurb": t.blurb,
            "techs": t.techs,
            "nodes": [
                {
                    "key": n.key,
                    "name": n.name,
                    "shape": n.shape,
                    "role": n.role,
                    "technology": n.technology,
                    "is_external": n.ext,
                    "x": n.x,
                    "y": n.y,
                }
                for n in t.nodes
            ],
            "edges": [
                {
                    "source": e.source,
                    "target": e.target,
                    "label": e.label,
                    "technology": e.technology,
                }
                for e in t.edges
            ],
        }
        for t in _TEMPLATES.values()
    ]
    return frames + [_package_entry(pkg) for pkg in _PACKAGES.values()]


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
        parent_id = id_by_key.get(ns.parent) if ns.parent else None
        db.add(
            Node(
                id=nid,
                project_id=project_id,
                name=ns.name,
                role=ns.role,
                technology=ns.technology,
                shape=ns.shape,
                parent_id=parent_id,
                is_external=ns.ext,
            )
        )
        # Готовая раскладка шаблона — строками view_layout (R3): вид = родитель
        # узла (None — корневой вид). Эти же строки видит превью карточки лендинга.
        if ns.x is not None and ns.y is not None:
            db.add(
                ViewLayoutItem(
                    project_id=project_id,
                    view_id=parent_id,
                    item_id=str(nid),
                    payload={"x": ns.x, "y": ns.y},
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


# ── Пакетные шаблоны ──────────────────────────────────────────────────────────
# Содержание пакетного шаблона — распакованный архив знания эталонного проекта в
# template_packages/<id>/ (обновляется scripts/refresh-demo-template.py). Здесь —
# только подписи витрины: перечни узлов/связей превью читаются из самого пакета,
# поэтому разойтись с содержанием они не могут.

_PACKAGES_DIR = Path(__file__).resolve().parent / "template_packages"


@dataclass(frozen=True)
class _Package:
    id: str
    name: str
    tagline: str
    blurb: str
    techs: tuple[str, ...]


_PACKAGES: dict[str, _Package] = {
    "demo-marketplace": _Package(
        id="demo-marketplace",
        name="Маркетплейс «Ярмарка»",
        tagline="Заполненный демо-проект: процессы, логика, спеки и факты.",
        blurb="Не каркас, а готовый проект целиком: многоуровневое C4 с внешними "
        "системами, бизнес-процессы со схемой логики на каждом шаге, спеки OpenAPI, "
        "структура БД, каналы брокера и параметры конфигурации. Видно, как выглядит "
        "доведённая до конца документация, и есть что покрутить, не заполняя схему руками.",
        techs=("Python/FastAPI", "React", "Kafka", "PostgreSQL", "Elasticsearch"),
    ),
}


def package_ids() -> list[str]:
    return list(_PACKAGES.keys())


def is_package_template(template_id: str) -> bool:
    """Пакетный ли это шаблон. Роутер создания проекта спрашивает ДО создания
    пустого Project: пакет создаёт проект сам (его делает единый импорт)."""
    return template_id in _PACKAGES


@cache
def _package_zip(template_id: str) -> bytes:
    """Пакет шаблона → zip в памяти: ровно тот формат, который читает ввоз архива.

    Пакет лежит в репозитории РОССЫПЬЮ (правку шаблона надо уметь прочитать в
    git-diff), а приёмник ждёт архив — поэтому упаковка на лету. Штампы времени
    фиксированы, порядок файлов детерминирован: одинаковый пакет даёт одинаковые
    байты. Кэш — на процесс: пакет статичен, читать его с диска каждый раз незачем."""
    root = _PACKAGES_DIR / template_id
    names = sorted(p.relative_to(root).as_posix() for p in root.rglob("*") if p.is_file())
    # Манифест первым — как в build_archive (читается он всё равно по имени).
    names.sort(key=lambda n: (n != "manifest.yaml", n))
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        for name in names:
            info = zipfile.ZipInfo(name, date_time=(1980, 1, 1, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            zf.writestr(info, (root / name).read_bytes())
    return buf.getvalue()


@cache
def _package_preview(template_id: str) -> tuple[tuple[dict, ...], tuple[dict, ...]]:
    """Узлы и связи КОРНЕВОГО уровня пакета для превью витрины — из его же c4.yaml.

    Топология как у мини-превью карточки проекта (_previews в роутере): узлы —
    корни дерева, связи — все рёбра с концами, поднятыми до корневого предка,
    петли отброшены. Подпись и технология остаются только у связи, которая и в
    пакете идёт корень-в-корень: у поднятой стрелки подпись говорила бы о другой
    паре объектов. Битый пакет роняет каталог громко — это ошибка сборки, её
    ловит сторож tests/test_template_package.py, а не пользователь."""
    text = (_PACKAGES_DIR / template_id / "c4.yaml").read_text(encoding="utf-8")
    parsed, errors = parse_import(text)
    if parsed is None:
        raise RuntimeError(f"Пакет шаблона «{template_id}» не разбирается: {'; '.join(errors[:3])}")

    def root_of(idx: int) -> int:
        cur = idx
        while parsed.nodes[cur].parent_idx is not None:
            nxt = parsed.nodes[cur].parent_idx
            assert nxt is not None  # цикл while гарантирует
            cur = nxt
        return cur

    nodes = tuple(
        {
            "key": f"n{i}",
            "name": n.name,
            "shape": n.shape,
            "role": n.role,
            "technology": n.technology,
            "is_external": n.is_external,
            "x": None,
            "y": None,
        }
        for i, n in enumerate(parsed.nodes)
        if n.parent_idx is None
    )
    seen: dict[tuple[int, int], dict] = {}
    for e in parsed.edges:
        s, t = root_of(e.source_idx), root_of(e.target_idx)
        if s == t or (s, t) in seen:
            continue
        direct = e.source_idx == s and e.target_idx == t
        seen[(s, t)] = {
            "source": f"n{s}",
            "target": f"n{t}",
            "label": e.label if direct else None,
            "technology": e.technology if direct else None,
        }
    return nodes, tuple(seen.values())


def _package_entry(pkg: _Package) -> dict:
    """Запись пакетного шаблона для витрины — в той же форме, что у каркасов."""
    nodes, edges = _package_preview(pkg.id)
    return {
        "id": pkg.id,
        "name": pkg.name,
        "tagline": pkg.tagline,
        "blurb": pkg.blurb,
        "techs": list(pkg.techs),
        "nodes": [dict(n) for n in nodes],
        "edges": [dict(e) for e in edges],
    }


def seed_package_template(
    db: Session,
    template_id: str,
    name: str,
    description: str | None,
    user_id: uuid.UUID,
) -> Project | None:
    """Создать проект из ПАКЕТНОГО шаблона. None — шаблон неизвестен (роутер вернёт
    404). Коммит — на вызывающей стороне, как у seed_template.

    Проект создаёт единый импорт: пакет едет ему одним входом-архивом, и все семьи
    ложатся РОДНЫМИ приёмниками — теми же, что у ввоза архива пользователем. Споров
    у одного входа не бывает по построению, поэтому резолюции пустые."""
    if template_id not in _PACKAGES:
        return None
    plan = build_unified_plan([(f"{template_id}.zip", _package_zip(template_id))])
    project, _result = apply_unified_plan(db, plan, {}, name, description, user_id)
    return project
