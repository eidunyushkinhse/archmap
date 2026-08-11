"""Стенд алертов: проект, на котором горят ВСЕ классы алертов схемы.

Нужен, чтобы читать и править ТЕКСТОВКИ панели алертов на живых данных: каждый
класс из docs/specs/alerts.md представлен минимум одной записью, а те классы, где
формулировка зависит от флагов (контейнер со своими доками), — всеми вариантами.

Запуск (из корня репозитория, бэкенд поднимать не нужно — пишем прямо в БД):
    backend/venv/bin/python scripts/seed-alerts-demo.py

Идемпотентен: проект с тем же именем сносится и создаётся заново (каскадом уходят
узлы, связи, процессы и раскладка). Схема нарочно кривая — это фикстура, а не
пример для подражания.
"""

import os
import sys
import uuid
from pathlib import Path

BACKEND = Path(__file__).resolve().parent.parent / "backend"
sys.path.insert(0, str(BACKEND))
# Settings читает .env ОТ ТЕКУЩЕЙ ДИРЕКТОРИИ — иначе database_url не найдётся.
os.chdir(BACKEND)

# Регистрация моделей в реестре SQLAlchemy (как в alembic/env.py): без полного
# набора импортов relationship'ы не резолвятся по строковым именам.
import app.models.business_process  # noqa: E402
import app.models.edge  # noqa: E402
import app.models.node  # noqa: E402
import app.models.node_doc  # noqa: E402
import app.models.process_fragment  # noqa: F401,E402
import app.models.process_message  # noqa: E402
import app.models.process_participant  # noqa: E402
import app.models.project  # noqa: E402
import app.models.user  # noqa: E402
import app.models.view_layout  # noqa: F401,E402
import app.models.view_state  # noqa: F401,E402
from app.database import SessionLocal  # noqa: E402
from app.models.business_process import BusinessProcess  # noqa: E402
from app.models.edge import Edge  # noqa: E402
from app.models.node import Node  # noqa: E402
from app.models.node_doc import NodeDoc  # noqa: E402
from app.models.process_message import ProcessMessage  # noqa: E402
from app.models.process_participant import ProcessParticipant  # noqa: E402
from app.models.project import Project  # noqa: E402
from app.models.user import User  # noqa: E402

PROJECT_NAME = "Стенд алертов"

SPEC = """openapi: 3.0.0
info:
  title: Оставшаяся на контейнере спека
  version: "1.0"
paths:
  /pay:
    post:
      summary: Списать деньги
"""

DOC = """flowchart TD
  A[Пришёл запрос] --> B{Хватает денег?}
  B -- да --> C[Списать]
  B -- нет --> D[Отказать]
"""


def main() -> None:
    db = SessionLocal()
    try:
        author = db.query(User).filter(User.username == "admin").first()
        author_id = author.id if author else None

        for old in db.query(Project).filter(Project.name == PROJECT_NAME).all():
            db.delete(old)
        db.flush()

        project = Project(
            name=PROJECT_NAME,
            description="Фикстура для проверки текстовок алертов: схема нарушает все конвенции сразу.",
            created_by_id=author_id,
            updated_by_id=author_id,
        )
        db.add(project)
        db.flush()
        pid = project.id

        def node(
            name: str,
            *,
            parent: uuid.UUID | None = None,
            shape: str = "service",
            role: str | None = None,
            technology: str | None = None,
            spec: str | None = None,
        ) -> Node:
            n = Node(
                project_id=pid,
                name=name,
                parent_id=parent,
                shape=shape,
                role=role,
                technology=technology,
                openapi_spec=spec,
            )
            db.add(n)
            db.flush()
            return n

        # --- Схема -----------------------------------------------------------
        # «Платформа» — контейнер, на котором осталась СПЕКА (AL24: только has_spec).
        platform = node("Платформа", role="система", spec=SPEC)
        gateway = node("Шлюз", parent=platform.id, role="сервис", technology="Go")
        # «Биллинг» — контейнер, на котором осталась СХЕМА ЛОГИКИ (AL24: только has_docs).
        billing = node("Биллинг", parent=platform.id, role="сервис", technology="Python")
        billing_worker = node(
            "Биллинг-воркер", parent=billing.id, role="воркер", technology="Celery"
        )
        # «Каталог» — контейнер, на котором остались И доки, И спека (AL24: оба флага).
        catalog = node("Каталог", parent=platform.id, role="сервис", spec=SPEC)
        catalog_db = node(
            "Каталог-БД", parent=catalog.id, shape="database", role="БД", technology="PostgreSQL"
        )
        # AL25: человек ВНУТРИ системы — по C4 актор живёт за её границей.
        operator = node("Оператор поддержки", parent=platform.id, shape="person", role="человек")

        # Второй кластер, ничем не связанный с первым (AL7).
        storefront = node("Витрина", role="сервис", technology="Node.js")
        storefront_cache = node("Кэш витрины", shape="database", role="кэш", technology="Redis")

        # AL5: ни связей, ни детей.
        node("Забытый сервис", role="сервис")
        node("Старый обменник", shape="broker", role="брокер", technology="RabbitMQ")

        db.add(NodeDoc(node_id=billing.id, name="Списание", kind="operation", content=DOC))
        db.add(NodeDoc(node_id=catalog.id, name="Обзор", kind="overview", content=DOC))

        def edge(
            src: uuid.UUID, dst: uuid.UUID, label: str, *, sync: bool | None = None
        ) -> Edge:
            e = Edge(
                project_id=pid, source_id=src, target_id=dst, label=label, is_synchronous=sync
            )
            db.add(e)
            db.flush()
            return e

        # AL6, все три комбинации флагов: конец-контейнер справа, слева, с обеих сторон.
        edge(gateway.id, billing.id, "создать платёж")
        edge(platform.id, gateway.id, "маршрутизация")
        edge(platform.id, billing.id, "внутренний вызов")
        # Нормальные связи — держат первый кластер связным.
        queue = edge(gateway.id, billing_worker.id, "поставить в очередь", sync=False)
        edge(gateway.id, catalog_db.id, "читать товары")
        edge(operator.id, gateway.id, "оформляет заказ")
        # Второй кластер.
        edge(storefront.id, storefront_cache.id, "читать кэш")

        # --- Процессы --------------------------------------------------------
        payment = BusinessProcess(project_id=pid, name="Оплата заказа")
        db.add(payment)
        recon = BusinessProcess(project_id=pid, name="Ночная сверка")
        db.add(recon)
        db.flush()

        def participant(
            proc: BusinessProcess, name: str, order: int, node_id: uuid.UUID | None
        ) -> ProcessParticipant:
            p = ProcessParticipant(process_id=proc.id, name=name, order=order, node_id=node_id)
            db.add(p)
            db.flush()
            return p

        p_gateway = participant(payment, "Шлюз", 0, gateway.id)
        p_worker = participant(payment, "Биллинг-воркер", 1, billing_worker.id)
        p_cache = participant(payment, "Кэш витрины", 2, storefront_cache.id)
        # AL27: линия жизни есть, узла за ней нет.
        p_mailer = participant(payment, "Почтовый робот", 3, None)

        def message(
            proc: BusinessProcess,
            order: int,
            frm: ProcessParticipant,
            to: ProcessParticipant,
            caption: str,
            *,
            edge_id: uuid.UUID | None,
            leg: str = "forward",
        ) -> None:
            db.add(
                ProcessMessage(
                    process_id=proc.id,
                    order=order,
                    edge_id=edge_id,
                    leg=leg,
                    from_participant_id=frm.id,
                    to_participant_id=to.id,
                    caption=caption,
                )
            )

        message(payment, 0, p_gateway, p_worker, "поставить в очередь", edge_id=queue.id)
        # AL28: канал на месте, но он асинхронный — плеча «ответ» у него не бывает.
        message(
            payment, 1, p_worker, p_gateway, "квитанция об оплате", edge_id=queue.id, leg="return"
        )
        # AL26: связь, которой шёл шаг, из схемы удалили.
        message(payment, 2, p_gateway, p_cache, "сбросить кэш витрины", edge_id=None)
        message(payment, 3, p_gateway, p_mailer, "отправить письмо", edge_id=None)

        p_worker2 = participant(recon, "Биллинг-воркер", 0, billing_worker.id)
        p_export = participant(recon, "Отчётный экспортёр", 1, None)
        message(recon, 0, p_worker2, p_export, "выгрузить реестр", edge_id=None)

        db.commit()
        print(f"Проект «{PROJECT_NAME}» создан: {pid}")
    finally:
        db.close()


if __name__ == "__main__":
    main()
