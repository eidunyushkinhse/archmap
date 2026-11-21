"""Синтетические сцены стенда движка холста (эпик render-scale, docs/plan-render-scale.md).

Генерирует детерминированные схемы (свой ГПСЧ с семенем, имена выдуманные) и ввозит их в
базу стенда проектами «Стенд: <имя>» через единый ввоз. Повторный запуск пересоздаёт проект
с нуля: так сбрасывается сохранённая раскладка после прогонов под архитектором.

    backend/venv/bin/python scripts/perf-scenes.py                # все сцены
    backend/venv/bin/python scripts/perf-scenes.py hub25 flat60   # выбранные
    backend/venv/bin/python scripts/perf-scenes.py --list
    backend/venv/bin/python scripts/perf-scenes.py --yaml <каталог>   # только файлы, без ввоза

Адрес бэкенда — ARCHMAP_BACKEND (по умолчанию http://localhost:8000), учётка —
ARCHMAP_PROBE_USER (admin). После ввоза читателю зондов нужно участие в новых проектах:
backend/venv/bin/python scripts/probe-reader.py.

Сцены:
  hubN      сценарий владельца: на корне хаб и 9 периферийных объектов, у хаба N детей,
            связей при раскрытии около 2N (hub25 — 35 объектов и 50 связей);
  hub25-*   та же форма с другой начинкой: связи почти все к периферии (ext), почти все
            внутри рамки (inner), встречные пары (twins), длинные подписи (long), другие
            семена (s2..s4);
  hub25x3   три системы по 25 детей на корне и 9 периферийных;
  flatN     один уровень из N объектов и 2N связей внутри одной системы.
"""

import argparse
import os
import random
import sys
from collections.abc import Callable
from pathlib import Path

import yaml

BACKEND_DIR = Path(__file__).resolve().parent.parent / "backend"

LABELS = [
    "REST", "gRPC", "читает и пишет", "публикует события", "подписан на события",
    "запрашивает остатки", "проверяет права", "отправляет уведомления", "синхронизирует каталог",
    "пишет журнал аудита", "читает настройки", "кэширует ответы", "ставит задачи в очередь",
    "забирает задачи", "выгружает отчёты", "запрашивает профиль клиента", "списывает оплату",
    "создаёт заказ", "обновляет статус заказа", "индексирует документы", "ищет по каталогу",
    "собирает метрики", "проверяет токен", "шлёт вебхуки", "импортирует прайс-листы",
]
LONG_LABELS = [
    "отправляет запрос на проверку статуса платежа", "получает список активных заказов клиента",
    "публикует событие об изменении остатков на складе", "запрашивает расчёт стоимости доставки",
    "передаёт данные для формирования отчёта", "синхронизирует справочник товаров и категорий",
    "проверяет права доступа пользователя к разделу", "сохраняет историю изменений документа",
]
TECH = ["HTTPS", "gRPC", "SQL", "Kafka", "AMQP", "Redis", "S3", None, None]
SERVICE_WORDS = [
    "заказов", "оплаты", "каталога", "поиска", "доставки", "склада", "уведомлений", "профилей",
    "скидок", "отзывов", "корзины", "возвратов", "тарифов", "отчётов", "аудита", "доступа",
    "рассылок", "импорта", "экспорта", "аналитики", "рекомендаций", "модерации", "биллинга",
    "расписаний", "документов", "чатов", "медиа", "геоданных", "очередей", "сессий",
]
PERIPH = [
    ("Покупатель", "person"), ("Оператор поддержки", "person"),
    ("Платёжный шлюз", "service"), ("Служба доставки", "service"),
    ("Почтовый провайдер", "service"), ("СМС-шлюз", "service"),
    ("Хранилище данных", "service"), ("Портал партнёров", "service"),
    ("Мониторинг", "service"),
]
HUB_NAME = "Ядро платформы"
FLAT_NAME = "Плоская система"


def _children(rng: random.Random, prefix: str, n: int) -> list[dict]:
    """n детей системы: примерно 70% сервисов, 20% баз, 10% брокеров."""
    n_db = max(1, round(n * 0.2))
    n_br = max(1, round(n * 0.1))
    n_svc = n - n_db - n_br
    out: list[dict] = []
    for i in range(n_svc):
        word = SERVICE_WORDS[i % len(SERVICE_WORDS)]
        suffix = "" if i < len(SERVICE_WORDS) else f" {i // len(SERVICE_WORDS) + 1}"
        out.append({
            "name": f"{prefix}Сервис {word}{suffix}", "shape": "service", "role": "сервис",
            "technology": rng.choice(["Python", "Go", "Java", "Node.js"]),
        })
    for i in range(n_db):
        out.append({
            "name": f"{prefix}БД {SERVICE_WORDS[i % len(SERVICE_WORDS)]}", "shape": "database",
            "technology": rng.choice(["PostgreSQL", "Redis", "ClickHouse", "MongoDB"]),
        })
    for i in range(n_br):
        out.append({"name": f"{prefix}Шина событий {i + 1}", "shape": "broker", "technology": "Kafka"})
    return out


def _edge(rng: random.Random, a: str, b: str, labels: list[str]) -> dict:
    e: dict = {"from": a, "to": b, "label": rng.choice(labels)}
    tech = rng.choice(TECH)
    if tech:
        e["technology"] = tech
    return e


def _inner_edges(rng: random.Random, kids: list[dict], n: int, labels: list[str]) -> list[dict]:
    """n связей внутри системы: сервис → своя база, сервис → брокер, сервис → сервис."""
    svc = [k["name"] for k in kids if k["shape"] == "service"]
    dbs = [k["name"] for k in kids if k["shape"] == "database"]
    brs = [k["name"] for k in kids if k["shape"] == "broker"]
    seen: set[tuple[str, str]] = set()
    out: list[dict] = []

    def add(a: str, b: str) -> None:
        if a == b or (a, b) in seen or (b, a) in seen or len(out) >= n:
            return
        seen.add((a, b))
        out.append(_edge(rng, a, b, labels))

    for i, db in enumerate(dbs):          # у каждой базы есть хозяин
        add(svc[i % len(svc)], db)
    for i, s in enumerate(svc):           # половина сервисов пишет в шину
        if i % 2 == 0:
            add(s, brs[i % len(brs)])
    for _ in range(10000):                # остальное — сервис → сервис
        if len(out) >= n:
            break
        a, b = rng.sample(svc, 2)
        add(a, b)
    return out


def hub_scene(
    seed: int, n_children: int, *, hubs: int = 1, n_inner: int | None = None,
    n_ext: int | None = None, long_labels: bool = False, twins: int = 0,
) -> dict:
    """Корень: хабы-системы с детьми и 9 периферийных объектов."""
    rng = random.Random(seed)  # noqa: S311 — детерминированная сцена, не криптография
    labels = LONG_LABELS if long_labels else LABELS
    nodes: list[dict] = []
    edges: list[dict] = []
    hub_kids: list[list[dict]] = []
    for h in range(hubs):
        prefix = "" if hubs == 1 else f"{'АБВ'[h]}: "
        kids = _children(rng, prefix, n_children)
        hub_kids.append(kids)
        nodes.append({
            "name": HUB_NAME if hubs == 1 else f"Платформа {'АБВ'[h]}", "shape": "service",
            "element": "system", "role": "система", "children": kids,
        })
        edges += _inner_edges(rng, kids, round(n_children * 1.2) if n_inner is None else n_inner, labels)
    for name, shape in PERIPH:
        node: dict = {"name": name, "shape": shape, "external": True}
        if shape == "service":
            node["role"] = "внешняя система"
        nodes.append(node)
    for kids in hub_kids:                 # связи детей хаба с периферией
        svc = [k["name"] for k in kids if k["shape"] == "service"]
        for i in range(round(n_children * 0.8) if n_ext is None else n_ext):
            p_name, p_shape = PERIPH[i % len(PERIPH)]
            s = svc[(i * 3 + i // len(PERIPH)) % len(svc)]
            if p_shape == "person" or i % 4 == 0:   # люди и часть систем — источники
                edges.append(_edge(rng, p_name, s, labels))
            else:
                edges.append(_edge(rng, s, p_name, labels))
    for i in range(twins):                # встречные пары: обратная связь к существующей
        e0 = edges[(i * 7) % len(edges)]
        edges.append(_edge(rng, e0["to"], e0["from"], labels))
    if hubs > 1:                          # хабы связаны между собой через детей
        for h in range(hubs):
            a = [k["name"] for k in hub_kids[h] if k["shape"] == "service"]
            b = [k["name"] for k in hub_kids[(h + 1) % hubs] if k["shape"] == "service"]
            for i in range(4):
                edges.append(_edge(rng, a[i * 2], b[i * 2 + 1], labels))
    return {"nodes": nodes, "edges": edges}


def flat_scene(seed: int, n: int) -> dict:
    """Одна система с n детьми и 2n связями между ними."""
    rng = random.Random(seed)  # noqa: S311 — детерминированная сцена, не криптография
    kids = _children(rng, "", n)
    return {
        "nodes": [{"name": FLAT_NAME, "shape": "service", "element": "system",
                   "role": "система", "children": kids}],
        "edges": _inner_edges(rng, kids, n * 2, LABELS),
    }


SCENES: dict[str, Callable[[], dict]] = {
    "hub25": lambda: hub_scene(1, 25),
    "hub25-ext": lambda: hub_scene(11, 25, n_inner=8, n_ext=42),
    "hub25-inner": lambda: hub_scene(12, 25, n_inner=42, n_ext=9),
    "hub25-twins": lambda: hub_scene(13, 25, n_inner=22, n_ext=18, twins=10),
    "hub25-long": lambda: hub_scene(14, 25, long_labels=True),
    "hub25-s2": lambda: hub_scene(21, 25),
    "hub25-s3": lambda: hub_scene(22, 25),
    "hub25-s4": lambda: hub_scene(23, 25),
    "hub35": lambda: hub_scene(31, 35),
    "hub50": lambda: hub_scene(2, 50),
    "hub25x3": lambda: hub_scene(3, 25, hubs=3),
    "flat60": lambda: flat_scene(4, 60),
    "flat120": lambda: flat_scene(5, 120),
}


def _count(nodes: list[dict]) -> int:
    return sum(1 + _count(n.get("children", [])) for n in nodes)


def _import(names: list[str]) -> None:
    sys.path.insert(0, str(BACKEND_DIR))
    os.chdir(BACKEND_DIR)  # Settings читает .env от текущей директории
    import httpx
    from app.auth import create_access_token

    base = os.environ.get("ARCHMAP_BACKEND", "http://localhost:8000") + "/api/v1"
    token = create_access_token({"sub": os.environ.get("ARCHMAP_PROBE_USER", "admin")})
    headers = {"Authorization": f"Bearer {token}"}
    with httpx.Client(timeout=120) as client:
        projects = client.get(f"{base}/projects", headers=headers).json()
        for name in names:
            title = f"Стенд: {name}"
            for p in projects:
                if p["name"] != title:
                    continue
                if not p.get("archived_at"):
                    client.post(f"{base}/projects/{p['id']}/archive", headers=headers).raise_for_status()
                client.delete(f"{base}/projects/{p['id']}", params={"confirm": title}, headers=headers)
            doc = SCENES[name]()
            body = yaml.safe_dump(doc, allow_unicode=True, sort_keys=False).encode()
            r = client.post(
                f"{base}/projects/import-unified", headers=headers,
                files=[("files", (f"{name}.yaml", body, "application/x-yaml"))], data={"name": title},
            )
            if r.status_code != 201:
                print(f"ОТКАЗ {title}: {r.status_code} {r.text[:400]}")
                continue
            print(f"{title}: объектов {_count(doc['nodes'])}, связей {len(doc['edges'])}")


def main() -> None:
    parser = argparse.ArgumentParser(description="Синтетические сцены стенда движка холста")
    parser.add_argument("names", nargs="*", help="имена сцен (по умолчанию все)")
    parser.add_argument("--list", action="store_true", help="показать сцены и размеры")
    parser.add_argument("--yaml", metavar="КАТАЛОГ", help="записать YAML-файлы без ввоза")
    args = parser.parse_args()
    unknown = [n for n in args.names if n not in SCENES]
    if unknown:
        parser.error(f"неизвестные сцены: {', '.join(unknown)}")
    names = args.names or list(SCENES)
    if args.list:
        for name in names:
            doc = SCENES[name]()
            print(f"{name}: объектов {_count(doc['nodes'])}, связей {len(doc['edges'])}")
        return
    if args.yaml:
        out = Path(args.yaml)
        out.mkdir(parents=True, exist_ok=True)
        for name in names:
            text = yaml.safe_dump(SCENES[name](), allow_unicode=True, sort_keys=False)
            (out / f"{name}.yaml").write_text(text)
        return
    _import(names)


if __name__ == "__main__":
    main()
