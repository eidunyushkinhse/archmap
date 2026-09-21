"""Единый импорт: N входов любого типа → один план (Ф1, docs/plan-unified-import.md).

Главные гарантии фазы: (1) семья фактов архива доезжает до узла СЛИТОГО дерева —
адрес разрешается по C4 своего архива и переводится происхождением вкладов (Ф0);
(2) равные тела дедуплицируются молча, разные — становятся конфликтом с точным
происхождением кандидатов; (3) беда одного входа адресуется ему, а не роняет
превью целиком; (4) id конфликтов и их порядок стабильны — на них будет опираться
применение (Ф2), считающее план заново.
"""

import io
import json
import uuid
import zipfile
from dataclasses import asdict

import pytest
import yaml
from conftest import ensure_architect
from fastapi.testclient import TestClient

from app.auth import require_architect
from app.data_import import parse_data_file
from app.database import get_db
from app.import_merge import _MAX_CONTAINER_EDGES
from app.main import app
from app.models.broker_channel import BrokerChannel
from app.models.business_process import BusinessProcess
from app.models.config_param import ConfigParam
from app.models.db_table import DbTable
from app.models.edge import Edge
from app.models.node import Node
from app.models.node_doc import NodeDoc
from app.models.process_message import ProcessMessage
from app.models.project import Project
from app.models.user import User
from app.processes import node_path
from app.unified_apply import (
    _synthetic_files,
    _winners,
    apply_unified_plan,
    dedup_edges,
    parse_decisions,
)
from app.unified_import import (
    MAX_ARCHIVES,
    MAX_INPUTS,
    DocIn,
    UnifiedImportError,
    build_unified_plan,
    preview_from_plan,
    remainder_from_plan,
    source_label,
)

РУЧКА = "/api/v1/projects/import/unified-preview"
ПРИМЕНЕНИЕ = "/api/v1/projects/import-unified"

# ── Строители входов ─────────────────────────────────────────────────────────

C4_ЯРМАРКА = """
nodes:
  - name: Ярмарка
    role: система
    children:
      - name: orders
        technology: Python
      - name: Каталог-БД
        shape: database
"""

# Тот же корень и те же дети — узлы склеятся по пути (общий случай федерации).
C4_ЯРМАРКА_2 = """
nodes:
  - name: Ярмарка
    role: система
    children:
      - name: orders
        description: Сервис заказов
      - name: Каталог-БД
        shape: database
"""


# Тот же корень с брокером — для каналов (у семьи свой адресат-владелец).
C4_С_БРОКЕРОМ = """
nodes:
  - name: Ярмарка
    children:
      - name: orders
      - name: Kafka
        shape: broker
"""


def _док(node: str, name: str, body: str, operation: str | None = None) -> str:
    шапка = f"%% archmap-name: {name}\n%% archmap-kind: operation\n"
    if operation:
        шапка += f"%% archmap-operation: {operation}\n"
    return шапка + f"%% archmap-node: {node}\n" + body


def _таблица(node: str, тип: str = "uuid") -> str:
    return (
        f"# archmap-node: {node}\n"
        "tables:\n"
        "- name: orders\n"
        "  schema: public\n"
        "  columns:\n"
        "  - name: id\n"
        f"    type: {тип}\n"
        "    pk: true\n"
    )


def _конфиг(node: str, default: str) -> str:
    return (
        f"# archmap-node: {node}\n"
        "config:\n"
        "- name: TIMEOUT_MS\n"
        "  type: int\n"
        f"  default: '{default}'\n"
    )


def _канал(node: str, delivery: str) -> str:
    return (
        f"# archmap-node: {node}\n"
        "channels:\n"
        "- name: orders.created\n"
        "  group: shop\n"
        "  kind: topic\n"
        f"  delivery: {delivery}\n"
        "  fields:\n"
        "  - name: order_id\n"
        "    type: uuid\n"
    )


def _спека(node: str, title: str) -> str:
    return f"# archmap-node: {node}\nopenapi: 3.0.3\ninfo:\n  title: {title}\npaths: {{}}\n"


def _архив(
    *,
    name: str = "Архив",
    description: str | None = None,
    c4: str = C4_ЯРМАРКА,
    docs: tuple[tuple[str, str], ...] = (),
    db: tuple[tuple[str, str], ...] = (),
    channels: tuple[tuple[str, str], ...] = (),
    config: tuple[tuple[str, str], ...] = (),
    specs: tuple[tuple[str, str], ...] = (),
    processes: tuple[tuple[str, str, str], ...] = (),
    формат: int = 1,
) -> bytes:
    """Архив знания в памяти: манифест + файлы категорий (как build_archive)."""
    файлы: dict[str, str] = {"c4.yaml": c4}
    contents: dict = {"c4": "c4.yaml"}
    for категория, items in (("docs", docs), ("db", db), ("channels", channels),
                             ("config", config), ("specs", specs)):
        if items:
            contents[категория] = [f for f, _ in items]
            файлы.update(dict(items))
    if processes:
        contents["processes"] = [{"file": f, "name": n} for f, n, _ in processes]
        файлы.update({f: t for f, _, t in processes})
    manifest: dict = {"archmap-archive": формат, "project": {"name": name}}
    if description:
        manifest["project"]["description"] = description
    manifest["contents"] = contents
    файлы["manifest.yaml"] = yaml.safe_dump(manifest, allow_unicode=True, sort_keys=False)

    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        for имя, содержимое in файлы.items():
            zf.writestr(имя, содержимое)
    return buf.getvalue()


def _путь(план, node_idx: int) -> str:
    return план.node_paths[node_idx]


def _вклады(план, family: str) -> dict[str, list]:
    """Бесконфликтные вклады семьи: «путь узла + ключ» → список вкладов."""
    out: dict[str, list] = {}
    for it in план.items:
        if it.family == family:
            out.setdefault(f"{_путь(план, it.node_idx)} :: {it.key}", []).append(it)
    return out


# ── 1. Два архива с пересечением: спор доков и молчаливый дедуп таблицы ───────


def test_дока_тёзка_конфликтует_а_равная_таблица_дедуплицируется():
    a = _архив(
        name="A",
        docs=(("docs/001-a.mmd", _док("Ярмарка / orders", "POST /orders",
                                      "graph TD\n  A --> B\n", "POST /orders")),),
        db=(("db/001-katalog.yaml", _таблица("Ярмарка / Каталог-БД")),),
    )
    b = _архив(
        name="B",
        c4=C4_ЯРМАРКА_2,
        docs=(("docs/001-b.mmd", _док("Ярмарка / orders", "POST /orders",
                                      "graph TD\n  A --> C\n  C --> D\n", "POST /orders")),),
        db=(("db/001-katalog.yaml", _таблица("Ярмарка / Каталог-БД")),),
    )

    план = build_unified_plan([("a.zip", a), ("b.zip", b)])

    assert план.ok and план.errors == []
    # C4 смерджен: узлов трое, не шесть.
    assert план.node_paths == ["Ярмарка", "Ярмарка / orders", "Ярмарка / Каталог-БД"]
    # Таблица одинаковая в обоих архивах — дедуп молча: ни конфликта, ни дубля.
    assert план.counts.tables == 1
    assert list(_вклады(план, "table")) == ["Ярмарка / Каталог-БД :: public.orders"]
    # Дока-тёзка с разными телами — конфликт с двумя кандидатами и происхождением.
    [спор] = план.conflicts
    assert спор.family == "doc" and спор.key == "POST /orders"
    assert спор.node_path == "Ярмарка / orders"
    assert спор.id == "doc|Ярмарка / orders|POST /orders"
    assert [(c.origin, c.origin_label) for c in спор.candidates] == [(0, "a.zip"), (1, "b.zip")]
    assert [c.summary for c in спор.candidates] == ["2 строки", "3 строки"]
    assert спор.candidates[1].body == "graph TD\n  A --> C\n  C --> D\n"
    assert not спор.candidates[0].truncated
    # Дефолт доков — «взять все» (схемы дополняют друг друга), счётчик считает оба.
    assert (спор.default, спор.allow_all) == ("all", True)
    assert план.counts.docs == 2
    # Замечаний входам нет: ничего не потерялось.
    assert план.input_remarks == [[], []]


def test_равные_тела_доков_с_разными_шапками_дедуплицируются():
    """Дедуп доков — ПОСЛЕ strip_header: шапка несёт node-путь и имя, они законно
    различаются между экспортами при одинаковом теле."""
    тело = "graph TD\n  A --> B\n"
    a = _архив(name="A", docs=(("docs/001-x.mmd", _док("Ярмарка / orders", "POST /orders", тело)),))
    b = _архив(name="B", c4=C4_ЯРМАРКА_2,
               docs=(("docs/007-y.mmd", "%% archmap-node: Ярмарка / orders\n"
                                        "%% archmap-name: POST /orders\n" + тело),))

    план = build_unified_plan([("a.zip", a), ("b.zip", b)])

    assert план.conflicts == [] and план.counts.docs == 1
    [док] = план.items
    assert isinstance(док.value, DocIn) and док.value.body == тело
    assert док.origin == 0  # выигрывает первый вход, порядок панели значим


# ── 2. Архив + YAML: семьи на смердженных узлах ──────────────────────────────


def test_семьи_архива_едут_на_узел_обогащённый_yaml_входом():
    архив = _архив(
        name="Ярмарка",
        docs=(("docs/001-a.mmd", _док("Ярмарка / orders", "POST /orders", "graph TD\n A\n")),),
        config=(("config/001-orders.yaml", _конфиг("Ярмарка / orders", "5000")),),
    )
    # Голый YAML: тот же orders (обогащает полями) + новый сосед.
    yaml_вход = """
nodes:
  - name: Ярмарка
    children:
      - name: orders
        role: сервис
        description: Оформление заказов
      - name: notify
        technology: Go
"""

    план = build_unified_plan([("archive.zip", архив), ("second.yaml", yaml_вход.encode())])

    assert план.ok, план.errors
    assert план.node_paths == [
        "Ярмарка", "Ярмарка / orders", "Ярмарка / Каталог-БД", "Ярмарка / notify",
    ]
    # Узел действительно обогащён вторым входом (склейка состоялась, а не задвоение).
    orders = план.merged.nodes[1]
    assert (orders.technology, orders.role, orders.description) == (
        "Python", "сервис", "Оформление заказов")
    # Семьи архива приехали на ЭТОТ merged-узел.
    assert list(_вклады(план, "doc")) == ["Ярмарка / orders :: POST /orders"]
    assert list(_вклады(план, "config")) == ["Ярмарка / orders :: TIMEOUT_MS"]
    assert (план.counts.docs, план.counts.params) == (1, 1)
    assert план.conflicts == [] and план.input_remarks == [[], []]


# ── 3. Имя проекта: манифест только у одиночного архива (П3) ─────────────────


def test_имя_из_манифеста_только_у_одиночного_архива():
    архив = _архив(name="Ярмарка v2", description="полигон")
    другой = _архив(name="Другой", c4=C4_ЯРМАРКА_2)

    один = build_unified_plan([("a.zip", архив)])
    assert один.name_source == "manifest"
    assert (один.manifest_name, один.manifest_description) == ("Ярмарка v2", "полигон")

    только_yaml = build_unified_plan([("a.yaml", C4_ЯРМАРКА.encode())])
    assert только_yaml.name_source == "fields"
    assert (только_yaml.manifest_name, только_yaml.manifest_description) == (None, None)

    два = build_unified_plan([("a.zip", архив), ("b.zip", другой)])
    assert два.name_source == "fields" and два.manifest_name is None


# ── 4. Конфликты скалярных семей: спека и параметр конфигурации ──────────────


def test_конфликт_спеки_и_параметра_конфига():
    a = _архив(
        name="A",
        specs=(("specs/001-orders.yaml", _спека("Ярмарка / orders", "Orders API")),),
        config=(("config/001-orders.yaml", _конфиг("Ярмарка / orders", "5000")),),
    )
    b = _архив(
        name="B",
        c4=C4_ЯРМАРКА_2,
        specs=(("specs/001-orders.yaml", _спека("Ярмарка / orders", "Заказы")),),
        config=(("config/001-orders.yaml", _конфиг("Ярмарка / orders", "9000")),),
    )

    план = build_unified_plan([("a.zip", a), ("b.zip", b)])

    споры = {c.family: c for c in план.conflicts}
    assert set(споры) == {"spec", "config"}
    спека = споры["spec"]
    assert спека.key == "openapi" and спека.id == "spec|Ярмарка / orders|openapi"
    # Адресная строка «# archmap-node:» в теле кандидата не едет — она наша, не автора.
    assert "archmap-node" not in спека.candidates[0].body
    assert "Orders API" in спека.candidates[0].body and "Заказы" in спека.candidates[1].body
    # Скалярам «взять всё» некуда: спека у узла одна, параметр-тёзка один.
    assert (спека.default, спека.allow_all) == ("cand:0", False)
    параметр = споры["config"]
    assert параметр.key == "TIMEOUT_MS" and параметр.id == "config|Ярмарка / orders|TIMEOUT_MS"
    assert [c.summary for c in параметр.candidates] == [
        "тип int, дефолт «5000»", "тип int, дефолт «9000»"]
    assert (параметр.default, параметр.allow_all) == ("cand:0", False)
    # При дефолтных резолюциях приедет по одному экземпляру каждого.
    assert (план.counts.specs, план.counts.params) == (1, 1)


def test_конфликт_канала_ключом_группа_и_имя():
    a = _архив(name="A", c4=C4_С_БРОКЕРОМ,
               channels=(("channels/001-k.yaml", _канал("Ярмарка / Kafka", "at-least-once")),))
    b = _архив(name="B", c4=C4_С_БРОКЕРОМ,
               channels=(("channels/001-k.yaml", _канал("Ярмарка / Kafka", "exactly-once")),))

    план = build_unified_plan([("a.zip", a), ("b.zip", b)])

    [спор] = план.conflicts
    assert спор.family == "channel" and спор.key == "shop/orders.created"
    assert спор.id == "channel|Ярмарка / Kafka|shop/orders.created"
    assert [c.summary for c in спор.candidates] == [
        "1 поле, at-least-once", "1 поле, exactly-once"]
    # Тело кандидата — YAML своего ввозного формата (пользователь видел его в архиве).
    assert "delivery: at-least-once" in спор.candidates[0].body
    assert "order_id" in спор.candidates[0].body
    assert план.counts.channels == 1  # дефолт скаляра — первый кандидат


def test_равные_спеки_дедуплицируются_молча():
    текст = _спека("Ярмарка / orders", "Orders API")
    a = _архив(name="A", specs=(("specs/001-orders.yaml", текст),))
    b = _архив(name="B", c4=C4_ЯРМАРКА_2,
               specs=(("specs/002-orders.yaml", текст + "\n"),))  # хвостовой перевод строки

    план = build_unified_plan([("a.zip", a), ("b.zip", b)])

    assert план.conflicts == [] and план.counts.specs == 1


# ── 5. Кривой вход среди валидных ────────────────────────────────────────────


def test_кривой_zip_адресуется_своему_входу_а_не_роняет_превью():
    хороший = _архив(name="A")
    кривой = io.BytesIO()
    with zipfile.ZipFile(кривой, "w") as zf:
        zf.writestr("readme.txt", "это не архив ArchMap")

    план = build_unified_plan([
        ("a.zip", хороший), ("чужой.zip", кривой.getvalue()), ("c.yaml", C4_ЯРМАРКА.encode()),
    ])

    assert not план.ok and план.merged is None
    assert план.errors == ["вход 2: В архиве нет manifest.yaml — это не архив ArchMap"]
    # Адресация — структурой отчёта: чип №2 подсвечивается, остальные чисты.
    assert list(план.report.file_errors) == [1]
    assert план.report.files == 3


def test_архив_без_c4_и_текст_не_в_utf8_адресуются_входам():
    без_c4 = io.BytesIO()
    with zipfile.ZipFile(без_c4, "w") as zf:
        zf.writestr("manifest.yaml", "archmap-archive: 1\ncontents: {}\n")

    план = build_unified_plan([("a.zip", без_c4.getvalue()), ("b.yaml", b"\xff\xfe nodes")])

    assert not план.ok
    assert план.errors == [
        "вход 1: В архиве нет файла C4 (contents.c4)",
        "вход 2: Файл не читается ни как zip-архив, ни как текст в UTF-8",
    ]


def test_неразобранный_c4_входа_адресуется_ему():
    план = build_unified_plan([("a.yaml", C4_ЯРМАРКА.encode()), ("b.yaml", "- просто список\n".encode())])

    assert not план.ok and план.merged is None
    assert план.errors and all(e.startswith("вход 2: ") for e in план.errors)
    assert list(план.report.file_errors) == [1]


# ── 6. Промах адреса семьи — замечание входу, остальное живо ─────────────────


def test_неразрешённый_адрес_семьи_замечание_входу():
    архив = _архив(
        name="A",
        docs=(
            ("docs/001-x.mmd", _док("Нет такого", "Схема", "graph TD\n A\n")),
            ("docs/002-y.mmd", _док("Ярмарка / orders", "POST /orders", "graph TD\n B\n")),
        ),
        db=(("db/001-x.yaml", _таблица("Ярмарка / Каталог-БД")),),
    )

    план = build_unified_plan([("a.zip", архив), ("b.yaml", C4_ЯРМАРКА_2.encode())])

    assert план.ok
    assert план.input_remarks[0] == ["docs/001-x.mmd: узел «Нет такого» не найден — файл пропущен"]
    assert план.input_remarks[1] == []
    # Остальное применилось: вторая схема и таблица на месте.
    assert (план.counts.docs, план.counts.tables) == (1, 1)


def test_тёзки_путей_внутри_входа_пропускают_файл():
    c4 = """
nodes:
  - name: Ярмарка
    children:
      - name: orders
      - name: orders
"""
    архив = _архив(
        name="A", c4=c4,
        docs=(("docs/001-x.mmd", _док("Ярмарка / orders", "Схема", "graph TD\n A\n")),),
    )

    план = build_unified_plan([("a.zip", архив)])

    assert план.ok and план.counts.docs == 0
    assert план.input_remarks[0] == [
        "docs/001-x.mmd: путь «Ярмарка / orders» неоднозначен (узлы-тёзки) — файл пропущен"
    ]


def test_внутриархивный_дубль_ключа_замечание_входу_а_не_конфликт():
    архив = _архив(
        name="A",
        docs=(
            ("docs/001-x.mmd", _док("Ярмарка / orders", "POST /orders", "graph TD\n A\n")),
            ("docs/002-y.mmd", _док("Ярмарка / orders", "POST /orders", "graph TD\n Б\n")),
        ),
    )

    план = build_unified_plan([("a.zip", архив)])

    assert план.conflicts == []  # спор одного входа рассудит его автор, не пользователь
    assert план.counts.docs == 1
    assert план.input_remarks[0] == [
        "docs/002-y.mmd: схема «POST /orders» у узла уже описана этим входом — запись пропущена"
    ]


def test_файл_семьи_не_разбирается_замечание_входу():
    архив = _архив(
        name="A",
        db=(("db/001-x.yaml", "# archmap-node: Ярмарка / Каталог-БД\ntables: [ {name: a\n"),),
    )

    план = build_unified_plan([("a.zip", архив)])

    assert план.ok and план.counts.tables == 0
    assert план.input_remarks[0] == [
        "db/001-x.yaml: похоже на файл структуры данных, но YAML не разобрался — файл пропущен"
    ]


# ── 7. Процессы: не мерджим никогда, тёзки предупреждаются ───────────────────


def test_процессы_тёзки_двух_архивов_предупреждают_о_суффиксе():
    текст = "sequenceDiagram\n  participant orders\n  orders->>orders: оформить\n"
    a = _архив(name="A", processes=(("processes/001-o.mmd", "Оформление", текст),))
    b = _архив(name="B", c4=C4_ЯРМАРКА_2,
               processes=(("processes/001-o.mmd", "Оформление", текст + "  Note over orders: x\n"),))

    план = build_unified_plan([("a.zip", a), ("b.zip", b)])

    assert план.counts.processes == 2  # авторские диаграммы не склеиваются никогда
    assert [(p.origin, p.name) for p in план.processes] == [(0, "Оформление"), (1, "Оформление")]
    assert план.warnings == [
        "процесс «Оформление» есть в нескольких входах (a.zip, b.zip) — "
        "процессы не сливаются, тёзка приедет с суффиксом « (2)»"
    ]
    assert план.conflicts == []


def test_пропавший_файл_процесса_замечание_входу():
    архив = _архив(name="A", processes=(("processes/001-o.mmd", "Оформление", "seq"),))
    # Вырезаем файл процесса из zip, манифест оставляем прежним.
    src = zipfile.ZipFile(io.BytesIO(архив))
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        for info in src.infolist():
            if info.filename != "processes/001-o.mmd":
                zf.writestr(info.filename, src.read(info))

    план = build_unified_plan([("a.zip", buf.getvalue())])

    assert план.counts.processes == 0
    assert план.input_remarks[0] == ["processes/001-o.mmd: файла процесса нет в архиве — пропущен"]


# ── 9. Стабильность плана и капы ─────────────────────────────────────────────


def test_повторный_расчёт_даёт_те_же_id_и_порядок():
    """Инвариант применения (Ф2): apply считает план заново и адресует резолюции по
    id — значит id и порядок обязаны совпадать до символа."""
    a = _архив(
        name="A",
        docs=(("docs/001-a.mmd", _док("Ярмарка / orders", "POST /orders", "graph TD\n A\n")),),
        db=(("db/001-k.yaml", _таблица("Ярмарка / Каталог-БД", "uuid")),),
        specs=(("specs/001-o.yaml", _спека("Ярмарка / orders", "A")),),
        config=(("config/001-o.yaml", _конфиг("Ярмарка / orders", "5000")),),
    )
    b = _архив(
        name="B", c4=C4_ЯРМАРКА_2,
        docs=(("docs/001-b.mmd", _док("Ярмарка / orders", "POST /orders", "graph TD\n B\n")),),
        db=(("db/001-k.yaml", _таблица("Ярмарка / Каталог-БД", "bigint")),),
        specs=(("specs/001-o.yaml", _спека("Ярмарка / orders", "B")),),
        config=(("config/001-o.yaml", _конфиг("Ярмарка / orders", "9000")),),
    )
    входы = [("a.zip", a), ("b.zip", b)]

    первый = build_unified_plan(входы)
    второй = build_unified_plan(входы)

    assert [c.id for c in первый.conflicts] == [c.id for c in второй.conflicts]
    assert [c.id for c in первый.conflicts] == [
        "doc|Ярмарка / orders|POST /orders",
        "table|Ярмарка / Каталог-БД|public.orders",
        "config|Ярмарка / orders|TIMEOUT_MS",
        "spec|Ярмарка / orders|openapi",
    ]
    assert len({c.id for c in первый.conflicts}) == 4  # id уникальны в пределах плана
    assert [c.summary for c in первый.conflicts[1].candidates] == ["1 колонка", "1 колонка"]


def test_пустой_вход_и_превышение_капов_ломают_план_целиком():
    """Капа ДВА, и они про разное: голых YAML принимаем столько же, сколько
    мульти-репо импорт (файл на репозиторий), а архивов — вшестнадцатеро меньше
    (каждый распаковывается в память целиком). Тексты ошибок различимы."""
    with pytest.raises(UnifiedImportError, match="ни один файл"):
        build_unified_plan([])

    много = [(f"{i}.yaml", C4_ЯРМАРКА.encode()) for i in range(MAX_INPUTS + 1)]
    with pytest.raises(UnifiedImportError, match=f"Больше {MAX_INPUTS} файлов"):
        build_unified_plan(много)
    assert build_unified_plan(много[:2]).ok  # обычный пакет проходит

    архивы = [(f"{i}.zip", _архив(name=f"A{i}")) for i in range(MAX_ARCHIVES + 1)]
    with pytest.raises(UnifiedImportError, match=f"Больше {MAX_ARCHIVES} архивов"):
        build_unified_plan(архивы)
    assert build_unified_plan(архивы[:MAX_ARCHIVES]).ok  # ровно кап — принимаем


def test_один_yaml_вход_проходит_как_обычный_импорт():
    план = build_unified_plan([("a.yaml", C4_ЯРМАРКА.encode())])

    assert план.ok and план.node_paths[0] == "Ярмарка"
    assert план.conflicts == [] and план.processes == []
    assert план.counts.docs == 0 and план.report.files == 1


# ── 8. Эндпоинт: multipart смесью типов ──────────────────────────────────────


@pytest.fixture()
def клиент():
    """HTTP-клиент с подменённой ролью. БД подменять нечего: превью её не трогает
    (проекта ещё нет), а форму multipart видно только настоящим запросом."""
    app.dependency_overrides[require_architect] = lambda: User(
        id=uuid.uuid4(), username="arch", hashed_password="x", role="architect"
    )
    try:
        yield TestClient(app)
    finally:
        app.dependency_overrides.clear()


def _post(клиент, *входы: tuple[str, bytes]):
    return клиент.post(
        РУЧКА,
        files=[("files", (имя, payload, "application/octet-stream")) for имя, payload in входы],
    )


def test_эндпоинт_принимает_смесь_архива_и_yaml(клиент):
    архив = _архив(
        name="Ярмарка v2",
        description="полигон",
        docs=(("docs/001-a.mmd", _док("Ярмарка / orders", "POST /orders", "graph TD\n A\n")),),
        db=(("db/001-k.yaml", _таблица("Ярмарка / Каталог-БД")),),
    )

    r = _post(клиент, ("a.zip", архив), ("b.yaml", C4_ЯРМАРКА_2.encode()))

    assert r.status_code == 200, r.text
    тело = r.json()
    assert тело["ok"] is True and тело["errors"] == []
    # C4-часть — та же модель, что у обычного превью; входы нумеруются как файлы.
    assert тело["c4"]["ok"] is True and тело["c4"]["files"] == 2
    assert тело["c4"]["node_count"] == 3 and тело["c4"]["merged_count"] == 3
    assert [f["file"] for f in тело["c4"]["file_remarks"]] == [1, 2]
    assert тело["families"] == {"docs": 1, "specs": 0, "tables": 1, "channels": 0,
                                "params": 0, "processes": 0}
    assert тело["family_conflicts"] == [] and тело["warnings"] == []
    # Входов двое — имя проекта спрашиваем полями, манифест не при чём (П3).
    assert тело["name_source"] == "fields" and тело["manifest_name"] is None


def test_эндпоинт_отдаёт_конфликт_с_происхождением(клиент):
    a = _архив(name="A", docs=(("docs/001-a.mmd",
                                _док("Ярмарка / orders", "POST /orders", "graph TD\n A\n")),))
    b = _архив(name="B", c4=C4_ЯРМАРКА_2,
               docs=(("docs/001-b.mmd",
                      _док("Ярмарка / orders", "POST /orders", "graph TD\n B\n")),))

    тело = _post(клиент, ("прогон-1.zip", a), ("прогон-2.zip", b)).json()

    [спор] = тело["family_conflicts"]
    assert спор["id"] == "doc|Ярмарка / orders|POST /orders"
    assert спор["family"] == "doc" and спор["default"] == "all" and спор["allow_all"] is True
    assert [(k["origin"], k["origin_label"]) for k in спор["candidates"]] == [
        (0, "прогон-1.zip"), (1, "прогон-2.zip")]
    assert спор["candidates"][0]["body"] == "graph TD\n A\n"
    assert спор["candidates"][0]["truncated"] is False


def test_эндпоинт_кладёт_замечания_семей_в_корзину_своего_входа(клиент):
    архив = _архив(name="A", docs=(("docs/001-x.mmd",
                                    _док("Нет такого", "Схема", "graph TD\n A\n")),))

    тело = _post(клиент, ("a.zip", архив), ("b.yaml", C4_ЯРМАРКА_2.encode())).json()

    первый, второй = тело["c4"]["file_remarks"]
    # Замечание семьи дописано в корзину СВОЕГО входа — рядом с замечаниями слияния
    # (у пользователя один список на чип, а не два).
    assert первый["warnings"][-1] == (
        "docs/001-x.mmd: узел «Нет такого» не найден — файл пропущен")
    assert not any("docs/001-x.mmd" in w for w in второй["warnings"])
    assert тело["ok"] is True  # промах адреса — деградация, а не отказ ввоза


def test_эндпоинт_адресует_кривой_вход_и_не_падает(клиент):
    мусор = b"PK\x03\x04" + "не архив вовсе".encode()

    r = _post(клиент, ("a.yaml", C4_ЯРМАРКА.encode()), ("bad.zip", мусор))

    assert r.status_code == 200, r.text
    тело = r.json()
    assert тело["ok"] is False and тело["c4"]["ok"] is False
    assert тело["errors"] == ["вход 2: Файл не читается как zip-архив"]
    assert тело["c4"]["file_remarks"][1]["errors"] == ["Файл не читается как zip-архив"]
    assert тело["c4"]["file_remarks"][0]["errors"] == []


def test_эндпоинт_одиночного_архива_отдаёт_имя_из_манифеста(клиент):
    тело = _post(клиент, ("a.zip", _архив(name="Ярмарка v2", description="полигон"))).json()

    assert тело["name_source"] == "manifest"
    assert (тело["manifest_name"], тело["manifest_description"]) == ("Ярмарка v2", "полигон")


def test_эндпоинт_пустого_запроса_и_превышения_капов(клиент):
    пусто = клиент.post(РУЧКА)
    assert пусто.status_code == 400 and "ни один файл" in пусто.json()["detail"]

    много = _post(клиент, *[(f"{i}.yaml", C4_ЯРМАРКА.encode()) for i in range(MAX_INPUTS + 1)])
    assert много.status_code == 400
    assert f"Больше {MAX_INPUTS} файлов" in много.json()["detail"]

    архивов = _post(клиент, *[(f"{i}.zip", _архив(name=f"A{i}"))
                              for i in range(MAX_ARCHIVES + 1)])
    assert архивов.status_code == 400
    assert f"Больше {MAX_ARCHIVES} архивов" in архивов.json()["detail"]


# ── 9. Применение плана: новый проект из N входов (Ф2а) ──────────────────────

C4_ПОЛНЫЙ = """
nodes:
  - name: Ярмарка
    children:
      - name: orders
        technology: Python
      - name: Каталог-БД
        shape: database
      - name: Kafka
        shape: broker
edges:
  - from: Ярмарка / orders
    to: Ярмарка / Kafka
    channel: orders.created
    sync: false
"""

ПРОЦЕСС = """sequenceDiagram
    participant orders
    participant Каталог-БД
    %% archmap-doc: Ярмарка / orders / POST /orders
    orders->>Каталог-БД: положить заказ
    Каталог-БД-->>orders: ок
"""


def _таблицы_с_ссылкой(node: str) -> str:
    """Две таблицы: вторая ссылается на первую — так проверяется, что ссылка
    доезжает до references_column_id (резолвит её родной приёмник, не мы)."""
    return (
        f"# archmap-node: {node}\n"
        "tables:\n"
        "- name: customers\n"
        "  schema: public\n"
        "  description: покупатели\n"
        "  columns:\n"
        "  - name: id\n"
        "    type: uuid\n"
        "    pk: true\n"
        "    required: true\n"
        "- name: orders\n"
        "  schema: public\n"
        "  description: заказы\n"
        "  columns:\n"
        "  - name: id\n"
        "    type: uuid\n"
        "    pk: true\n"
        "  - name: customer_id\n"
        "    type: uuid\n"
        "    required: true\n"
        "    references: customers.id\n"
        "    description: покупатель\n"
    )


def _полный_архив(имя: str = "Ярмарка v2") -> bytes:
    """Архив со ВСЕМИ категориями знания: C4 со связью-каналом, схемы логики
    (включая заглушку), спека, таблицы со ссылкой, канал, параметр, процесс с
    привязкой шага."""
    return _архив(
        name=имя,
        description="полигон единого ввоза",
        c4=C4_ПОЛНЫЙ,
        docs=(
            ("docs/001-orders.mmd", _док("Ярмарка / orders", "POST /orders",
                                         "graph TD\n  A --> B\n", "POST /orders")),
            ("docs/002-health.mmd", _док("Ярмарка / orders", "GET /health", "")),
        ),
        db=(("db/001-katalog.yaml", _таблицы_с_ссылкой("Ярмарка / Каталог-БД")),),
        channels=(("channels/001-kafka.yaml", _канал("Ярмарка / Kafka", "at-least-once")),),
        config=(("config/001-orders.yaml", _конфиг("Ярмарка / orders", "5000")),),
        specs=(("specs/001-orders.yaml", _спека("Ярмарка / orders", "Orders API")),),
        processes=(("processes/001-oformlenie.mmd", "Оформление", ПРОЦЕСС),),
    )


def _снимок(db, project_id) -> dict:
    """СОДЕРЖИМОЕ проекта в проверяемом виде: id и время выкинуты, ссылки развёрнуты
    в человеческие адреса — так видно, что знание доехало до последнего поля."""
    узлы = db.query(Node).filter(Node.project_id == project_id).all()
    все = {n.id: n for n in узлы}
    путь = {n.id: node_path(все, n.id) for n in узлы}

    таблицы = db.query(DbTable).join(Node, Node.id == DbTable.node_id).filter(
        Node.project_id == project_id).all()
    колонка_по_id = {c.id: f"{t.name}.{c.name}" for t in таблицы for c in t.columns}
    каналы = db.query(BrokerChannel).join(Node, Node.id == BrokerChannel.node_id).filter(
        Node.project_id == project_id).all()
    доки = db.query(NodeDoc).join(Node, Node.id == NodeDoc.node_id).filter(
        Node.project_id == project_id).all()
    док_по_id = {d.id: f"{путь[d.node_id]} / {d.name}" for d in доки}
    процессы = db.query(BusinessProcess).filter(
        BusinessProcess.project_id == project_id).all()

    return {
        "узлы": sorted(
            (путь[n.id], n.role, n.technology, n.shape, n.status, n.is_external,
             n.source_ref, n.description, n.openapi_spec)
            for n in узлы
        ),
        "связи": sorted(
            (путь[e.source_id], путь[e.target_id], e.label, e.technology, e.channel,
             e.is_synchronous)
            for e in db.query(Edge).filter(Edge.project_id == project_id).all()
        ),
        "доки": sorted(
            (путь[d.node_id], d.name, d.kind, d.operation, d.content) for d in доки
        ),
        "таблицы": sorted(
            (путь[t.node_id], t.schema_name, t.name, t.description,
             tuple(sorted(
                 (c.name, c.type, c.is_primary_key, c.nullable, c.description,
                  колонка_по_id.get(c.references_column_id))
                 for c in t.columns
             )))
            for t in таблицы
        ),
        "каналы": sorted(
            (путь[c.node_id], c.group_name, c.name, c.kind, c.partition_key, c.delivery,
             c.retention, c.description,
             tuple(sorted((f.name, f.type, f.required, f.description) for f in c.fields)))
            for c in каналы
        ),
        "параметры": sorted(
            (путь[p.node_id], p.name, p.value_type, p.required, p.default_value, p.description)
            for p in db.query(ConfigParam).join(Node, Node.id == ConfigParam.node_id).filter(
                Node.project_id == project_id).all()
        ),
        "процессы": sorted(
            (
                proc.name,
                tuple((p.order, p.name, путь.get(p.node_id) if p.node_id else None)
                      for p in sorted(proc.participants, key=lambda p: p.order)),
                tuple((m.order, m.leg, m.caption, док_по_id.get(m.doc_id),
                       m.edge_id is not None)
                      for m in sorted(proc.messages, key=lambda m: m.order)),
            )
            for proc in процессы
        ),
    }


def test_единый_импорт_архива_везёт_всё_знание(db):
    """Архив со ВСЕМИ категориями знания доезжает единым ввозом до последнего поля.

    Проверка прямая, литералами: раньше здесь сравнивались снимки старого
    (import_archive) и нового путей, но одноархивный путь снят (Ф2в) — да и общую
    потерю поля сравнение двух путей всё равно не ловило. Полнота по семьям: пути
    узлов, доки с телами и видом (заглушка ОСТАЁТСЯ пустой — Д4), спека без нашей
    адресной строки, таблицы с колонками и разрешённой FK-ссылкой, канал с полями,
    параметр, процесс с автосопоставленными участниками и привязкой шага к схеме."""
    план = build_unified_plan([("archive.zip", _полный_архив())])
    проект, отчёт = apply_unified_plan(db, план, {}, None, None, ensure_architect(db).id)
    db.commit()

    assert план.ok and план.conflicts == [] and план.input_remarks == [[]]
    # Имя и описание — из манифеста: вход единственный и архив (П3).
    assert (проект.name, проект.description) == ("Ярмарка v2", "полигон единого ввоза")

    снимок = _снимок(db, проект.id)
    # C4: три узла под корнем, форма и технология на месте, спека — байт-в-байт
    # авторская (ведущий «# archmap-node:» наш, в тело узла он не едет).
    assert снимок["узлы"] == [
        ("Ярмарка", None, None, "service", "existing", False, None, None, None),
        ("Ярмарка / Kafka", None, None, "broker", "existing", False, None, None, None),
        ("Ярмарка / orders", None, "Python", "service", "existing", False, None, None,
         "openapi: 3.0.3\ninfo:\n  title: Orders API\npaths: {}\n"),
        ("Ярмарка / Каталог-БД", None, None, "database", "existing", False, None, None, None),
    ]
    assert снимок["связи"] == [
        ("Ярмарка / orders", "Ярмарка / Kafka", None, None, "orders.created", False),
    ]
    # Доки: обе схемы с видом и операцией; заглушка приехала ЗАГЛУШКОЙ (пустое тело).
    assert снимок["доки"] == [
        ("Ярмарка / orders", "GET /health", "operation", None, ""),
        ("Ярмарка / orders", "POST /orders", "operation", "POST /orders",
         "graph TD\n  A --> B\n"),
    ]
    # Структура данных: описания таблиц и колонок, флаги, и главное — ссылка
    # customer_id → customers.id разрешена в references_column_id, а не потеряна.
    assert снимок["таблицы"] == [
        ("Ярмарка / Каталог-БД", "public", "customers", "покупатели",
         (("id", "uuid", True, False, None, None),)),
        ("Ярмарка / Каталог-БД", "public", "orders", "заказы",
         (("customer_id", "uuid", False, False, "покупатель", "customers.id"),
          ("id", "uuid", True, True, None, None))),
    ]
    assert снимок["каналы"] == [
        ("Ярмарка / Kafka", "shop", "orders.created", "topic", "", "at-least-once", "", None,
         (("order_id", "uuid", False, None),)),
    ]
    assert снимок["параметры"] == [
        ("Ярмарка / orders", "TIMEOUT_MS", "int", False, "5000", None),
    ]
    # Процесс: участники сопоставлены узлам сами (кандидат единственный), шаг
    # привязан к схеме НОВОГО проекта по адресу «%% archmap-doc».
    assert снимок["процессы"] == [
        ("Оформление",
         ((0, "orders", "Ярмарка / orders"), (1, "Каталог-БД", "Ярмарка / Каталог-БД")),
         ((0, "forward", "положить заказ", "Ярмарка / orders / POST /orders", False),
          (1, "return", "ок", None, False))),
    ]

    # Отчёт — тем же ArchiveImportResult: числа семей из родных приёмников.
    assert (отчёт.nodes, отчёт.edges) == (4, 1)
    assert (отчёт.docs_created, отчёт.specs_applied) == (2, 1)
    assert отчёт.db is not None and (отчёт.db.tables_written, отчёт.db.columns_written) == (2, 3)
    assert отчёт.channels is not None and отчёт.channels.channels_written == 1
    assert отчёт.config is not None and отчёт.config.params_written == 1
    assert отчёт.warnings == [] and отчёт.resolved_conflicts == 0
    [итог] = отчёт.processes
    assert (итог.messages, итог.doc_linked, итог.doc_unresolved) == (2, 1, 0)


def test_круговой_прогон_вклада_таблицы_через_синтетический_файл(db):
    """Вклад → синтетический YAML → родной парсер → вклад: применение НЕ пишет
    таблицы моделями, а собирает файлы ввозного формата, и потеря поля здесь
    молча обрезала бы знание."""
    архив = _архив(c4=C4_ПОЛНЫЙ, db=(("db/001-k.yaml", _таблицы_с_ссылкой("Ярмарка / Каталог-БД")),))
    план = build_unified_plan([("a.zip", архив)])
    победители = _winners(план, {})

    [(имя_файла, текст)] = _synthetic_files("table", победители, план.node_paths)

    assert имя_файла == "db/001-k.yaml"  # человек увидит его в замечаниях приёмника
    assert текст.startswith("# archmap-node: Ярмарка / Каталог-БД\n")
    разобрано = parse_data_file(текст)
    assert разобрано is not None and разобрано.node_ref == "Ярмарка / Каталог-БД"
    assert [asdict(t) for t in разобрано.tables] == [
        asdict(w.value) for w in победители if w.family == "table"
    ]


def test_применение_с_дефолтами_разводит_тёзок_и_берёт_первого(db):
    a = _архив(
        name="A",
        docs=(("docs/001-a.mmd", _док("Ярмарка / orders", "POST /orders", "graph TD\n  A\n")),),
        config=(("config/001.yaml", _конфиг("Ярмарка / orders", "5000")),),
        specs=(("specs/001.yaml", _спека("Ярмарка / orders", "A API")),),
    )
    b = _архив(
        name="B",
        c4=C4_ЯРМАРКА_2,
        docs=(("docs/001-b.mmd", _док("Ярмарка / orders", "POST /orders", "graph TD\n  B\n")),),
        config=(("config/001.yaml", _конфиг("Ярмарка / orders", "9000")),),
        specs=(("specs/001.yaml", _спека("Ярмарка / orders", "B API")),),
    )
    план = build_unified_plan([("a.zip", a), ("b.zip", b)])

    проект, отчёт = apply_unified_plan(
        db, план, {}, "Слитая ярмарка", None, ensure_architect(db).id)
    db.commit()

    assert проект.name == "Слитая ярмарка" and отчёт.resolved_conflicts == 3
    orders = db.query(Node).filter(Node.project_id == проект.id, Node.name == "orders").one()
    # Доки: дефолт спора — «взять все», тёзке достаётся суффикс « (2)».
    доки = {d.name: d.content for d in db.query(NodeDoc).filter(NodeDoc.node_id == orders.id)}
    assert доки == {"POST /orders": "graph TD\n  A\n", "POST /orders (2)": "graph TD\n  B\n"}
    assert отчёт.docs_created == 2
    # Скаляры: брать всё некуда — едет первый кандидат (порядок входов значим).
    assert "A API" in (orders.openapi_spec or "")
    [параметр] = db.query(ConfigParam).filter(ConfigParam.node_id == orders.id).all()
    assert параметр.default_value == "5000"


def test_применение_с_явными_резолюциями_берёт_выбранное(db):
    a = _архив(
        name="A",
        docs=(("docs/001-a.mmd", _док("Ярмарка / orders", "POST /orders", "graph TD\n  A\n")),),
        specs=(("specs/001.yaml", _спека("Ярмарка / orders", "A API")),),
    )
    b = _архив(
        name="B",
        c4=C4_ЯРМАРКА_2,
        docs=(("docs/001-b.mmd", _док("Ярмарка / orders", "POST /orders", "graph TD\n  B\n")),),
        specs=(("specs/001.yaml", _спека("Ярмарка / orders", "B API")),),
    )
    план = build_unified_plan([("a.zip", a), ("b.zip", b)])
    выбор = {
        "doc|Ярмарка / orders|POST /orders": "cand:1",
        "spec|Ярмарка / orders|openapi": "cand:1",
    }

    проект, отчёт = apply_unified_plan(db, план, выбор, "Выбор", None, ensure_architect(db).id)
    db.commit()

    orders = db.query(Node).filter(Node.project_id == проект.id, Node.name == "orders").one()
    # Выбран второй кандидат — он ОДИН и под ИСХОДНЫМ именем, суффикса нет.
    доки = {d.name: d.content for d in db.query(NodeDoc).filter(NodeDoc.node_id == orders.id)}
    assert доки == {"POST /orders": "graph TD\n  B\n"} and отчёт.docs_created == 1
    assert "B API" in (orders.openapi_spec or "")


ПРОЦЕСС_B = (
    "sequenceDiagram\n"
    "    participant orders\n"
    "    %% archmap-doc: Ярмарка v2 / orders / POST /orders\n"
    "    orders->>orders: обработать\n"
)


def _архивы_с_якорем() -> tuple[bytes, bytes]:
    """Два архива одного сервиса с ОДНИМ якорем source, но разной иерархией: узлы
    склеятся якорем (он сильнее иерархии), и путь узла в проекте станет не тем, что
    в архиве B. На такой паре видно обе части переписывания адреса — и путь, и имя."""
    c4 = (
        "nodes:\n"
        "  - name: {root}\n"
        "    children:\n"
        "      - name: orders\n"
        "        source:\n"
        "          repo: github.com/shop/orders\n"
    )
    a = _архив(
        name="A",
        c4=c4.format(root="Ярмарка"),
        docs=(("docs/001-a.mmd", _док("Ярмарка / orders", "POST /orders", "graph TD\n  A\n")),),
    )
    b = _архив(
        name="B",
        c4=c4.format(root="Ярмарка v2"),
        docs=(("docs/001-b.mmd", _док("Ярмарка v2 / orders", "POST /orders",
                                      "graph TD\n  B\n")),),
        processes=(("processes/001.mmd", "Обработка", ПРОЦЕСС_B),),
    )
    return a, b


def test_привязка_процесса_переезжает_на_свой_узел_и_имя(db):
    """Адрес шага входа-2 написан ЕГО координатами: путь узла свой, имя схемы своё.
    В проекте узел лежит по пути входа-1 (склейка якорем), а тёзке-схеме достался
    суффикс — привязка обязана переехать, иначе шаг тихо потеряет схему."""
    a, b = _архивы_с_якорем()
    план = build_unified_plan([("a.zip", a), ("b.zip", b)])
    assert план.node_paths[:2] == ["Ярмарка", "Ярмарка / orders"]

    проект, отчёт = apply_unified_plan(db, план, {}, "Слияние", None, ensure_architect(db).id)
    db.commit()

    [итог] = отчёт.processes
    assert (итог.doc_linked, итог.doc_unresolved) == (1, 0)
    [шаг] = db.query(ProcessMessage).filter(
        ProcessMessage.process_id == итог.process_id).all()
    привязка = db.query(NodeDoc).filter(NodeDoc.id == шаг.doc_id).one()
    # Шаг привёз тело СВОЕГО архива — под именем, которое ему досталось при разводе.
    assert (привязка.name, привязка.content) == ("POST /orders (2)", "graph TD\n  B\n")
    assert node_path(
        {n.id: n for n in db.query(Node).filter(Node.project_id == проект.id)},
        привязка.node_id,
    ) == "Ярмарка / orders"


def test_проигравшая_дока_оставляет_шаг_без_привязки(db):
    """Резолюция «cand:0» — тела входа-2 в проекте нет. Адрес его процесса НЕ
    переписывается: шаг честно едет без привязки, а не цепляется к чужому телу."""
    a, b = _архивы_с_якорем()
    план = build_unified_plan([("a.zip", a), ("b.zip", b)])
    спор = next(c for c in план.conflicts if c.family == "doc")

    _, отчёт = apply_unified_plan(
        db, план, {спор.id: "cand:0"}, "Слияние", None, ensure_architect(db).id)
    db.commit()

    [итог] = отчёт.processes
    assert (итог.doc_linked, итог.doc_unresolved) == (0, 1)
    [шаг] = db.query(ProcessMessage).filter(
        ProcessMessage.process_id == итог.process_id).all()
    assert шаг.doc_id is None


def test_тёзки_процессов_разводятся_суффиксом_и_замечанием(db):
    процесс = "sequenceDiagram\n    participant orders\n    orders->>orders: шаг\n"
    a = _архив(name="A", processes=(("processes/001.mmd", "Оформление", процесс),))
    b = _архив(name="B", c4=C4_ЯРМАРКА_2,
               processes=(("processes/001.mmd", "Оформление", процесс),))
    план = build_unified_plan([("a.zip", a), ("b.zip", b)])

    проект, отчёт = apply_unified_plan(db, план, {}, "Оба", None, ensure_architect(db).id)
    db.commit()

    имена = sorted(p.name for p in db.query(BusinessProcess).filter(
        BusinessProcess.project_id == проект.id))
    assert имена == ["Оформление", "Оформление (2)"]
    assert any("«Оформление (2)»" in w for w in отчёт.warnings)


def test_имя_из_манифеста_у_одиночного_архива(db):
    план = build_unified_plan([("a.zip", _архив(name="Ярмарка v2", description="полигон"))])

    проект, _ = apply_unified_plan(db, план, {}, None, None, ensure_architect(db).id)
    db.commit()

    assert (проект.name, проект.description) == ("Ярмарка v2", "полигон")


def test_применение_отвергает_кривые_резолюции_и_пустое_имя(db):
    a = _архив(
        name="A",
        docs=(("docs/001-a.mmd", _док("Ярмарка / orders", "POST /orders", "graph TD\n  A\n")),),
        specs=(("specs/001.yaml", _спека("Ярмарка / orders", "A API")),),
    )
    b = _архив(
        name="B", c4=C4_ЯРМАРКА_2,
        docs=(("docs/001-b.mmd", _док("Ярмарка / orders", "POST /orders", "graph TD\n  B\n")),),
        specs=(("specs/001.yaml", _спека("Ярмарка / orders", "B API")),),
    )
    план = build_unified_plan([("a.zip", a), ("b.zip", b)])
    юзер = ensure_architect(db).id
    было = db.query(Project).count()

    # Резолюция к спору, которого в плане нет — превью устарело.
    with pytest.raises(UnifiedImportError, match="несуществующему спору"):
        apply_unified_plan(db, план, {"doc|Нет узла|Схема": "cand:0"}, "П", None, юзер)
    # «Взять все» у скаляра: спеке брать всё некуда.
    with pytest.raises(UnifiedImportError, match="взять все"):
        apply_unified_plan(db, план, {"spec|Ярмарка / orders|openapi": "all"}, "П", None, юзер)
    # Кандидата с таким номером нет.
    with pytest.raises(UnifiedImportError, match="всего 2"):
        apply_unified_plan(
            db, план, {"doc|Ярмарка / orders|POST /orders": "cand:9"}, "П", None, юзер)
    # Два входа — имя спрашиваем полем, и пустым оно быть не может (П3).
    with pytest.raises(UnifiedImportError, match="имя проекта"):
        apply_unified_plan(db, план, {}, "   ", None, юзер)
    assert db.query(Project).count() == было  # ни один отказ не оставил проекта


def test_непригодный_план_не_применяется(db):
    план = build_unified_plan([("bad.zip", b"PK\x03\x04" + "мусор".encode())])

    assert план.ok is False
    with pytest.raises(UnifiedImportError, match="непригоден"):
        apply_unified_plan(db, план, {}, "П", None, ensure_architect(db).id)


# ── 10. Эндпоинт применения ──────────────────────────────────────────────────


@pytest.fixture()
def клиент_с_бд(db):
    """Клиент с настоящей БД: применение пишет, и форму multipart с текстовыми
    полями (имя, описание, JSON резолюций) видно только настоящим запросом."""
    app.dependency_overrides[get_db] = lambda: db
    app.dependency_overrides[require_architect] = lambda: ensure_architect(db)
    try:
        yield TestClient(app)
    finally:
        app.dependency_overrides.clear()


def test_эндпоинт_применения_создаёт_проект_по_резолюциям(клиент_с_бд, db):
    a = _архив(
        name="A",
        docs=(("docs/001-a.mmd", _док("Ярмарка / orders", "POST /orders", "graph TD\n  A\n")),),
    )
    b = _архив(
        name="B", c4=C4_ЯРМАРКА_2,
        docs=(("docs/001-b.mmd", _док("Ярмарка / orders", "POST /orders", "graph TD\n  B\n")),),
    )

    r = клиент_с_бд.post(
        ПРИМЕНЕНИЕ,
        files=[("files", ("a.zip", a, "application/zip")),
               ("files", ("b.zip", b, "application/zip"))],
        data={
            "name": "Федерация",
            "description": "два прогона",
            "resolutions": json.dumps({"doc|Ярмарка / orders|POST /orders": "cand:1"}),
        },
    )

    assert r.status_code == 201, r.text
    тело = r.json()
    assert тело["project_name"] == "Федерация" and тело["nodes"] == 3
    assert тело["docs_created"] == 1 and тело["resolved_conflicts"] == 1
    проект = db.get(Project, uuid.UUID(тело["project_id"]))
    assert проект is not None and проект.description == "два прогона"
    [док] = db.query(NodeDoc).join(Node, Node.id == NodeDoc.node_id).filter(
        Node.project_id == проект.id).all()
    assert док.content == "graph TD\n  B\n"


def test_эндпоинт_применения_отвергает_кривой_json_и_пустой_запрос(клиент_с_бд, db):
    было = db.query(Project).count()

    r = клиент_с_бд.post(
        ПРИМЕНЕНИЕ,
        files=[("files", ("a.zip", _архив(), "application/zip"))],
        data={"resolutions": "{это не json"},
    )
    assert r.status_code == 400 and "resolutions" in r.json()["detail"]

    # Отказ применения (резолюция не из плана) — тоже 400 с человеческим текстом,
    # а не 500: превью устарело, и пользователю надо это сказать.
    устарело = клиент_с_бд.post(
        ПРИМЕНЕНИЕ,
        files=[("files", ("a.zip", _архив(), "application/zip"))],
        data={"resolutions": json.dumps({"doc|Нет узла|Схема": "cand:0"})},
    )
    assert устарело.status_code == 400
    assert "превью устарело" in устарело.json()["detail"]

    пусто = клиент_с_бд.post(ПРИМЕНЕНИЕ)
    assert пусто.status_code == 400 and "ни один файл" in пусто.json()["detail"]
    assert db.query(Project).count() == было


# ── Заглушки каналов по связям (решение пользователя 2026-09-06) ─────────────


C4_С_КАНАЛОМ_НА_СВЯЗИ = C4_С_БРОКЕРОМ + """
edges:
  - from: orders
    to: Kafka
    channel: orders.created
"""


def test_импорт_c4_заводит_заглушки_каналов_по_связям_и_гасит_AL31(db):
    from app.channels_import import is_edge_stub
    from app.routers.nodes import get_alerts

    план = build_unified_plan([("c4.yaml", C4_С_КАНАЛОМ_НА_СВЯЗИ.encode())])
    проект, отчёт = apply_unified_plan(db, план, {}, "П", None, ensure_architect(db).id)
    db.commit()

    assert отчёт.channel_stubs == 1
    kafka = db.query(Node).filter(Node.project_id == проект.id, Node.name == "Kafka").one()
    [канал] = db.query(BrokerChannel).filter(BrokerChannel.node_id == kafka.id).all()
    assert канал.name == "orders.created" and is_edge_stub(канал)
    assert get_alerts(db=db, project=проект, _=ensure_architect(db)).broker_edge_channels == []


def test_канал_описанный_пакетом_архива_заглушкой_не_дублируется(db):
    архив = _архив(
        c4=C4_С_КАНАЛОМ_НА_СВЯЗИ,
        channels=(("channels/kafka.yaml", _канал("Ярмарка / Kafka", "at-least-once")),),
    )
    план = build_unified_plan([("archive.zip", архив)])
    проект, отчёт = apply_unified_plan(db, план, {}, "П", None, ensure_architect(db).id)
    db.commit()

    # Пакет описал канал первым (группа shop, имя orders.created — точное имя со связи);
    # заглушке закрывать нечего.
    assert отчёт.channels is not None and отчёт.channels.channels_written == 1
    assert отчёт.channel_stubs == 0
    kafka = db.query(Node).filter(Node.project_id == проект.id, Node.name == "Kafka").one()
    [канал] = db.query(BrokerChannel).filter(BrokerChannel.node_id == kafka.id).all()
    assert (канал.group_name, канал.kind, канал.delivery) == ("shop", "topic", "at-least-once")


# ── Ф-E: структурный остаток слияния в превью ────────────────────────────────
#
# Остаток (что мердж решить не может) приезжает не только строками, но и
# структурой: фронт задаёт по ней вопросы, применение меняет дерево до записи в
# БД. Проверяем состав остатка, подписи источников (§4.7 ТЗ), детерминизм id —
# на них стоит применение, считающее план заново, — и тексты «что исправит только
# новый прогон агента».

# Два «репозитория» одного магазина: оба описали Ярмарку изнутри (равная
# содержательность → спор описания), сосед видит orders коробкой (связь в
# контейнер), биллинг приехал островом, актор назван по-разному (fuzzy-пара).
_ОСТАТОК_1 = """
nodes:
  - name: Ярмарка
    description: Торговая площадка
    children:
      - name: orders
        children:
          - name: api
      - name: Каталог-БД
        shape: database
  - name: Оператор
    shape: person
edges:
  - from: Оператор
    to: orders
    label: смотрит
  - from: orders
    to: Каталог-БД
    label: пишет
"""

_ОСТАТОК_2 = """
nodes:
  - name: Ярмарка
    description: Магазин
    children:
      - name: orders
  - name: Оператор смены
    shape: person
  - name: Биллинг
    children:
      - name: счета
      - name: Биллинг-БД
        shape: database
edges:
  - from: счета
    to: Биллинг-БД
    label: пишет
"""


def _план_остатка():
    return build_unified_plan(
        [("shop.yaml", _ОСТАТОК_1.encode()), ("billing.yaml", _ОСТАТОК_2.encode())]
    )


def test_остаток_все_четыре_вопроса_в_превью():
    """Полевой набор одним планом: спор поля, связь в контейнер, остров, похожие
    имена — каждый со своим адресом в слитом дереве."""
    план = _план_остатка()
    остаток = preview_from_plan(план).remainder

    [спор] = остаток.field_conflicts
    assert спор.id == "field|Ярмарка|description"
    assert (спор.node_path, спор.field, спор.default) == ("Ярмарка", "description", 0)
    assert [(c.origin, c.value) for c in спор.candidates] == [
        (0, "Торговая площадка"), (1, "Магазин")
    ]
    assert [c.source_label for c in спор.candidates] == [
        "От агента · shop.yaml", "От агента · billing.yaml"
    ]

    # Обе связи упираются в один контейнер, но разными концами — это два вопроса.
    вход, выход = остаток.container_edges
    assert вход.id == "edge|Оператор|Ярмарка / orders|смотрит|target"
    assert (вход.end, вход.container_path) == ("target", "Ярмарка / orders")
    assert [c.path for c in вход.components] == ["Ярмарка / orders / api"]
    assert [c.has_children for c in вход.components] == [False]
    assert выход.id == "edge|Ярмарка / orders|Ярмарка / Каталог-БД|пишет|source"
    assert (выход.end, выход.label, выход.technology) == ("source", "пишет", None)

    [остров] = остаток.isolated_groups
    assert остров.id == "group|Биллинг / счета"
    assert остров.node_paths == ["Биллинг / счета", "Биллинг / Биллинг-БД"]

    [пара] = остаток.fuzzy_pairs
    assert пара.id == "pair|Оператор|Оператор смены"
    assert (пара.a_path, пара.b_path) == ("Оператор", "Оператор смены")
    assert (пара.a_edges, пара.b_edges) == (1, 0)
    assert пара.where == "на верхнем уровне"
    assert (пара.a_current, пара.b_current) == (False, False)

    # Пикер концов новой связи: всё слитое дерево и признак «контейнер».
    assert остаток.node_paths == план.node_paths
    контейнер = dict(zip(остаток.node_paths, остаток.node_has_children, strict=True))
    assert контейнер["Ярмарка / orders"] and not контейнер["Ярмарка / Каталог-БД"]


def test_остаток_строки_остаются_на_месте():
    """Р1: структура ДОПОЛНЯЕТ отчёт, а не заменяет его — строки читает MCP."""
    превью = preview_from_plan(_план_остатка())

    assert превью.c4 is not None
    assert any("description" in c for c in превью.c4.conflicts)
    assert any("похожи" in w for w in превью.c4.warnings)
    assert any("конец в контейнере" in w for w in превью.c4.warnings)


def test_остаток_id_детерминированы_между_сборками():
    """Применение считает план ЗАНОВО по тем же файлам — id обязаны совпасть."""
    первый = remainder_from_plan(_план_остатка(), None)
    второй = remainder_from_plan(_план_остатка(), None)

    assert первый.model_dump() == второй.model_dump()


def test_остаток_подписи_источников():
    """§4.7: один корень — именем корня, несколько — именем файла; архив своим
    словом. Кандидат спора семьи подписан тем же."""
    два_корня = "nodes:\n  - name: Ярмарка\n  - name: Склад\n"
    план = build_unified_plan([
        ("shop.yaml", C4_ЯРМАРКА.encode()),
        ("wide.yaml", два_корня.encode()),
        ("arch.zip", _архив(name="Архив", c4=C4_ЯРМАРКА_2)),
    ])

    assert source_label(план, 0) == "От агента Ярмарка"
    assert source_label(план, 1) == "От агента · wide.yaml"
    assert source_label(план, 2) == "Из архива Ярмарка"
    # Тот же вход в догрузке (вход №0 — живой проект) называется «Из проекта».
    assert source_label(план, 0, current=0) == "Из проекта"
    assert source_label(план, 2, current=0) == "Из архива Ярмарка"


def test_остаток_подпись_источника_у_кандидата_семьи():
    a = _архив(name="A", docs=(("docs/a.mmd", _док("Ярмарка / orders", "POST /orders",
                                                   "graph TD\n  A\n")),))
    b = _архив(name="B", c4=C4_ЯРМАРКА_2,
               docs=(("docs/b.mmd", _док("Ярмарка / orders", "POST /orders",
                                         "graph TD\n  B\n")),))
    план = build_unified_plan([("a.zip", a), ("b.zip", b)])

    [спор] = preview_from_plan(план).family_conflicts
    assert [c.source_label for c in спор.candidates] == [
        "Из архива Ярмарка", "Из архива Ярмарка"
    ]
    assert [c.origin_label for c in спор.candidates] == ["a.zip", "b.zip"]


def test_остаток_незакрываемое_замечание_с_путём_починки():
    """§6: замечание, которое выбором не закрыть, приезжает структурой — текст,
    путь починки и цена бездействия, чтобы фронту не парсить строки."""
    a = "nodes:\n  - name: Система A\n"
    b = "nodes:\n  - name: Система B\n"
    план = build_unified_plan([("a.yaml", a.encode()), ("b.yaml", b.encode())])

    [замечание] = remainder_from_plan(план, None).unfixable
    assert "не имеют общих корневых узлов" in замечание.text
    assert замечание.how.startswith("Можно доработать прогоном агента.")
    assert "назовут корень одинаково" in замечание.how
    assert замечание.if_left.startswith("Если оставить: проект создастся с несколькими")
    # Замечание о ВЗАИМНОМ устройстве файлов адресата не имеет (правило Ф7).
    assert (замечание.agent, замечание.file) == (None, None)


def test_остаток_хвост_счётчик_приклеен_к_последнему_своего_класса():
    """«…ещё N таких …» — не самостоятельное замечание: он о тех же объектах,
    что строки перед ним, и едет второй строкой последнего из них."""
    n = 11  # на один больше капа перечня склеек по общему источнику
    a = "nodes:\n" + "".join(
        f"  - name: s{i}\n    source: {{repo: 'github.com/org/r{i}'}}\n" for i in range(n)
    )
    b = "nodes:\n" + "".join(
        f"  - name: t{i}\n    source: {{repo: 'github.com/org/r{i}'}}\n" for i in range(n)
    )
    план = build_unified_plan([("a.yaml", a.encode()), ("b.yaml", b.encode())])

    замечания = remainder_from_plan(план, None).unfixable
    assert len(замечания) == 10  # хвост отдельным элементом не стал
    assert замечания[-1].text.endswith("\n…ещё 1 таких склеек по общему источнику")
    assert "свой source.path" in замечания[-1].how
    assert замечания[-1].if_left.startswith("Если оставить: вместо нескольких объектов")


def test_остаток_вопросы_не_дублируют_строки_замечаний():
    """Строка, ставшая вопросом, в «только новым прогоном агента» не едет:
    иначе пользователь увидел бы одно и то же дважды."""
    остаток = remainder_from_plan(_план_остатка(), None)

    assert остаток.fuzzy_pairs and остаток.unfixable == []


def test_остаток_пуст_когда_спрашивать_не_о_чем():
    план = build_unified_plan([("a.yaml", C4_ЯРМАРКА.encode())])
    остаток = preview_from_plan(план).remainder

    assert остаток.field_conflicts == [] and остаток.container_edges == []
    assert остаток.isolated_groups == [] and остаток.fuzzy_pairs == []
    assert остаток.unfixable == []
    assert остаток.node_paths == план.node_paths  # пикер работает и без вопросов


# ── Ф-E: решения пользователя по остатку в применении ───────────────────────
#
# Ответы приезжают JSON-полем decisions и правят слитое дерево ДО записи в БД.
# Главные гарантии: ни один ответ не обязателен (без них проект прежний), ответ,
# не нашедший своего вопроса, — отказ, а не тихое «применим похожее».


def _состав(db, проект) -> tuple[set[str], set[tuple]]:
    """Что в проекте: пути узлов и связи путями (имя проекта и id несравнимы)."""
    узлы = db.query(Node).filter(Node.project_id == проект.id).all()
    все = {n.id: n for n in узлы}
    пути = {n.id: node_path(все, n.id) for n in узлы}
    связи = {
        (пути[e.source_id], пути[e.target_id], e.label, e.technology, e.is_synchronous)
        for e in db.query(Edge).filter(Edge.project_id == проект.id).all()
    }
    return set(пути.values()), связи


def test_решения_поле_конец_связи_и_новая_связь(db):
    """Три вида ответа разом: выбранное значение поля, перевешенный конец связи и
    дорисованная человеком связь между островом и ядром."""
    план = _план_остатка()
    решения = parse_decisions(json.dumps({
        "fields": {"field|Ярмарка|description": 1},
        "edges": {
            "edge|Оператор|Ярмарка / orders|смотрит|target": {"to_path": "Ярмарка / orders / api"},
            "edge|Ярмарка / orders|Ярмарка / Каталог-БД|пишет|source": "keep",
        },
        "new_edges": [{
            "group_id": "group|Биллинг / счета",
            "from_path": "Биллинг / счета",
            "to_path": "Ярмарка / Каталог-БД",
            "label": "сверяет остатки",
            "tech": "SQL",
            "channel": "async",
        }],
    }))

    проект, отчёт = apply_unified_plan(
        db, план, {}, "Ярмарка", None, ensure_architect(db).id, decisions=решения
    )
    db.commit()

    ярмарка = db.query(Node).filter(
        Node.project_id == проект.id, Node.name == "Ярмарка", Node.parent_id.is_(None)
    ).one()
    assert ярмарка.description == "Магазин"  # выбран второй кандидат
    _, связи = _состав(db, проект)
    assert ("Оператор", "Ярмарка / orders / api", "смотрит", None, None) in связи
    assert not any(c[:2] == ("Оператор", "Ярмарка / orders") for c in связи)
    # «keep» — это сегодняшнее поведение: связь осталась на контейнере.
    assert ("Ярмарка / orders", "Ярмарка / Каталог-БД", "пишет", None, None) in связи
    новая = ("Биллинг / счета", "Ярмарка / Каталог-БД", "сверяет остатки", "SQL", False)
    assert новая in связи
    assert отчёт.edges == len(связи)
    assert "Ваши решения: перевешено связей 1 · добавлено связей 1 · выбрано значений полей 1" \
        in отчёт.warnings


_СКЛЕЙКА_A = """
nodes:
  - name: Grafana
    children:
      - name: Сервер
  - name: Плагин Zabbix
    children:
      - name: backend
edges:
  - from: backend
    to: Сервер
    label: gRPC
"""

_СКЛЕЙКА_B = """
nodes:
  - name: Grafana
    children:
      - name: Веб
  - name: Плагин
    children:
      - name: frontend
edges:
  - from: frontend
    to: Веб
    label: module.js
  - from: Плагин
    to: Grafana
    label: ставится
"""


def test_решение_склейка_переносит_связи_детей_и_имя(db):
    """«Это один объект» + своё имя: выживает первый по порядку файлов, к нему
    переезжают связи и компоненты второго, второго в проекте нет."""
    план = build_unified_plan(
        [("a.yaml", _СКЛЕЙКА_A.encode()), ("b.yaml", _СКЛЕЙКА_B.encode())]
    )
    [пара] = remainder_from_plan(план, None).fuzzy_pairs
    assert пара.id == "pair|Плагин Zabbix|Плагин"
    решения = parse_decisions(json.dumps(
        {"merges": {пара.id: {"name": "Плагин Zabbix для Grafana"}}}
    ))

    проект, отчёт = apply_unified_plan(
        db, план, {}, "Федерация", None, ensure_architect(db).id, decisions=решения
    )
    db.commit()

    пути, связи = _состав(db, проект)
    assert "Плагин" not in пути  # поглощённого узла нет
    assert "Плагин Zabbix для Grafana" in пути  # выживший назван выбранным именем
    # Компоненты обоих — под выжившим.
    assert {"Плагин Zabbix для Grafana / backend", "Плагин Zabbix для Grafana / frontend"} <= пути
    # Связь поглощённого переехала на выжившего.
    assert ("Плагин Zabbix для Grafana", "Grafana", "ставится", None, None) in связи
    assert отчёт.nodes == len(пути) and отчёт.nodes == len(план.merged.nodes) - 1
    assert "Ваши решения: склеено объектов 1" in отчёт.warnings


def test_решения_keep_diff_и_пустое_поле_дают_прежний_проект(db):
    """Ни один вопрос не обязателен: отказы и пустое поле — это дефолт."""
    юзер = ensure_architect(db).id
    без, _ = apply_unified_plan(db, _план_остатка(), {}, "Без ответов", None, юзер)
    отказы = parse_decisions(json.dumps({
        "fields": {},
        "edges": {"edge|Оператор|Ярмарка / orders|смотрит|target": "keep"},
        "merges": {"pair|Оператор|Оператор смены": "diff"},
        "new_edges": [],
    }))
    с_отказами, отчёт = apply_unified_plan(
        db, _план_остатка(), {}, "С отказами", None, юзер, decisions=отказы
    )
    db.commit()

    assert _состав(db, без) == _состав(db, с_отказами)
    assert not any(w.startswith("Ваши решения") for w in отчёт.warnings)


def test_перевес_на_компонент_выбрасывает_точный_дубль(db):
    """Связь, уточнённая до компонента, может совпасть с уже существующей —
    остаётся одна (ключ дубля тот же, что у мерджа)."""
    текст = """
nodes:
  - name: Zabbix
    children:
      - name: web
  - name: Датасорс
edges:
  - from: Датасорс
    to: Zabbix
    label: HTTP
  - from: Датасорс
    to: web
    label: HTTP
"""
    план = build_unified_plan([("a.yaml", текст.encode())])
    решения = parse_decisions(json.dumps({
        "edges": {"edge|Датасорс|Zabbix|HTTP|target": {"to_path": "Zabbix / web"}}
    }))

    проект, отчёт = apply_unified_plan(
        db, план, {}, "Zabbix", None, ensure_architect(db).id, decisions=решения
    )
    db.commit()

    _, связи = _состав(db, проект)
    assert связи == {("Датасорс", "Zabbix / web", "HTTP", None, None)}
    assert отчёт.edges == 1
    # Выброшена ИМЕННО перевешенная: связей, которых решение не касалось, дедуп
    # не трогает (два одинаковых ребра в одном документе — дело его автора).
    план2 = build_unified_plan([("a.yaml", текст.encode())])
    apply_unified_plan(db, план2, {}, "Без решений", None, ensure_architect(db).id)
    db.commit()
    assert len(план2.merged.edges) == 2


def test_решения_не_из_плана_отвергаются(db):
    план = _план_остатка()
    юзер = ensure_architect(db).id
    было = db.query(Project).count()

    for кривое in (
        {"fields": {"field|Нет узла|description": 0}},
        {"fields": {"field|Ярмарка|description": 9}},  # кандидата с таким номером нет
        {"edges": {"edge|Оператор|Ярмарка / orders|смотрит|target": {"to_path": "Ярмарка"}}},
        {"merges": {"pair|Нет|Пары": {"name": "Х"}}},
        {"new_edges": [{"group_id": "group|Биллинг / счета",
                        "from_path": "Биллинг / счета", "to_path": "Нет такого"}]},
    ):
        with pytest.raises(UnifiedImportError, match="Превью устарело"):
            apply_unified_plan(
                db, _план_остатка(), {}, "П", None, юзер,
                decisions=parse_decisions(json.dumps(кривое)),
            )
    # Форма поля проверяется отдельно от плана — там свой человеческий текст.
    with pytest.raises(UnifiedImportError, match="не разбирается как JSON"):
        parse_decisions("{это не json")
    with pytest.raises(UnifiedImportError, match="неизвестный раздел"):
        parse_decisions(json.dumps({"fields": {}, "лишнее": 1}))
    with pytest.raises(UnifiedImportError, match="номером кандидата"):
        parse_decisions(json.dumps({"fields": {"x": "cand:1"}}))
    with pytest.raises(UnifiedImportError, match="«keep» либо объект с to_path"):
        parse_decisions(json.dumps({"edges": {"x": "все равно"}}))
    with pytest.raises(UnifiedImportError, match="«sync» либо «async»"):
        parse_decisions(json.dumps({"new_edges": [
            {"from_path": "a", "to_path": "b", "channel": "быстрый"}]}))
    with pytest.raises(UnifiedImportError, match="«diff» либо объект с name"):
        parse_decisions(json.dumps({"merges": {"x": {"name": "  "}}}))
    assert план.ok and db.query(Project).count() == было  # ни один отказ не создал проекта


def test_эндпоинт_применения_принимает_decisions(клиент_с_бд, db):
    """Ответы приезжают тем же multipart, что и файлы; ответ не из плана — 400."""
    файлы = [
        ("files", ("shop.yaml", _ОСТАТОК_1.encode(), "text/yaml")),
        ("files", ("billing.yaml", _ОСТАТОК_2.encode(), "text/yaml")),
    ]

    r = клиент_с_бд.post(ПРИМЕНЕНИЕ, files=файлы, data={
        "name": "Ярмарка",
        "decisions": json.dumps({"fields": {"field|Ярмарка|description": 1}}),
    })

    assert r.status_code == 201, r.text
    assert any("Ваши решения: выбрано значений полей 1" in w for w in r.json()["warnings"])
    проект = db.get(Project, uuid.UUID(r.json()["project_id"]))
    корень = db.query(Node).filter(
        Node.project_id == проект.id, Node.parent_id.is_(None), Node.name == "Ярмарка"
    ).one()
    assert корень.description == "Магазин"

    устарело = клиент_с_бд.post(ПРИМЕНЕНИЕ, files=файлы, data={
        "name": "Ярмарка", "decisions": json.dumps({"fields": {"field|Нет|роль": 0}}),
    })
    assert устарело.status_code == 400 and "Превью устарело" in устарело.json()["detail"]

    кривое = клиент_с_бд.post(ПРИМЕНЕНИЕ, files=файлы, data={
        "name": "Ярмарка", "decisions": "{не json",
    })
    assert кривое.status_code == 400 and "decisions" in кривое.json()["detail"]


def test_остаток_называет_строки_ставшие_вопросами():
    """Строка, превращённая в вопрос, приезжает текстом в converted_warnings —
    им фронт прячет её из списков замечаний. Сами списки бэк не режет (Р1)."""
    план = _план_остатка()
    превью = preview_from_plan(план)
    остаток = превью.remainder
    assert превью.c4 is not None

    скрыть = остаток.converted_warnings
    # Ровно четыре вопроса-из-строк: две связи в контейнер, группа, похожие имена.
    assert len(скрыть) == 4
    assert any("похожи" in w for w in скрыть)
    assert sum(1 for w in скрыть if "конец в контейнере" in w) == 2
    assert any("не связана с остальной схемой" in w for w in скрыть)
    # Замечание, вопросом не ставшее, прятать нельзя.
    assert not any("без единой связи" in w for w in скрыть)
    # Тексты — БАЙТ-В-БАЙТ те же, что в корзинах: фронт сверяет строкой.
    корзины = set(превью.c4.warnings)
    пофайловые = {w for f in превью.c4.file_remarks for w in f.warnings}
    assert set(скрыть) <= корзины
    assert set(скрыть) <= (set(превью.c4.schema_warnings) | пофайловые)
    # Строки на месте: их читает MCP, и объединение корзин по-прежнему плоские списки.
    assert len(превью.c4.warnings) == 5


def test_остаток_называет_и_хвост_счётчик():
    """Связи, скрытые за «…ещё N таких связей», — тоже вопросы: их общая строка
    прячется вместе с ними."""
    n = _MAX_CONTAINER_EDGES + 3
    текст = "nodes:\n  - name: box\n    children:\n      - name: inner\n"
    текст += "".join(f"  - name: s{i}\n" for i in range(n))
    текст += "edges:\n" + "".join(f"  - from: s{i}\n    to: box\n" for i in range(n))
    план = build_unified_plan([("a.yaml", текст.encode())])

    остаток = remainder_from_plan(план, None)

    assert len(остаток.container_edges) == n  # вопрос задан каждой связи
    assert "…ещё 3 таких связей" in остаток.converted_warnings


# Пара похожих имён, у которых знание разложено по-разному: у первого (он выживет)
# пусто описание и нет якоря, у второго — и то, и другое; технология занята у обоих.
_ЗНАНИЕ_A = """
nodes:
  - name: Grafana
    children:
      - name: Сервер
  - name: Плагин Zabbix
    technology: Go
edges:
  - from: Плагин Zabbix
    to: Сервер
    label: gRPC
"""

_ЗНАНИЕ_B = """
nodes:
  - name: Grafana
    children:
      - name: Веб
  - name: Плагин
    technology: TypeScript
    description: Датасорс и панели Zabbix
    role: плагин
    source: {repo: 'github.com/alexanderzobnin/grafana-zabbix'}
"""


def test_склейка_доливает_знание_поглощённого(db):
    """Ничего не удаляется: пустые поля выжившего доливаются значениями
    поглощённого, заполненные не трогаются, якорь переезжает — иначе следующий
    синк того репозитория не узнает объект и привезёт дубль."""
    план = build_unified_plan(
        [("a.yaml", _ЗНАНИЕ_A.encode()), ("b.yaml", _ЗНАНИЕ_B.encode())]
    )
    [пара] = remainder_from_plan(план, None).fuzzy_pairs
    решения = parse_decisions(json.dumps({"merges": {пара.id: {"name": "Плагин Zabbix"}}}))

    проект, _ = apply_unified_plan(
        db, план, {}, "Федерация", None, ensure_architect(db).id, decisions=решения
    )
    db.commit()

    выживший = db.query(Node).filter(
        Node.project_id == проект.id, Node.name == "Плагин Zabbix"
    ).one()
    assert выживший.description == "Датасорс и панели Zabbix"  # пустое долито
    assert выживший.role == "плагин"
    assert выживший.technology == "Go"  # заполненное не тронуто
    assert выживший.source_ref == "git:github.com/alexanderzobnin/grafana-zabbix"


def test_склейка_не_перевешивает_занятый_якорь(db):
    """Якорь у выжившего есть — своим и остаётся (второго места под якорь нет,
    множественные якоря за рамками MVP)."""
    a = _ЗНАНИЕ_A.replace(
        "  - name: Плагин Zabbix\n    technology: Go\n",
        "  - name: Плагин Zabbix\n    technology: Go\n"
        "    source: {repo: 'github.com/org/plugin-fork'}\n",
    )
    план = build_unified_plan([("a.yaml", a.encode()), ("b.yaml", _ЗНАНИЕ_B.encode())])
    [пара] = remainder_from_plan(план, None).fuzzy_pairs
    решения = parse_decisions(json.dumps({"merges": {пара.id: {"name": "Плагин"}}}))

    проект, _ = apply_unified_plan(
        db, план, {}, "Федерация", None, ensure_architect(db).id, decisions=решения
    )
    db.commit()

    выживший = db.query(Node).filter(
        Node.project_id == проект.id, Node.name == "Плагин"
    ).one()
    assert выживший.source_ref == "git:github.com/org/plugin-fork"
    assert выживший.description == "Датасорс и панели Zabbix"  # поля долиты как всегда


def test_дедуп_после_склейки_смотрит_только_на_перевешенные(db):
    """Дедуп в БД трогает только связи, которым склейка сменила конец.

    Пары одинаковых рёбер в слитом дереве не бывает — мердж схлопывает их сам
    (add_edge), поэтому сквозного сценария у этого сторожа нет: проверяем сам
    dedup_edges. Одинаковая пара, написанная автором в стороне от склейки (так
    бывает в одно-файловом passthrough), решение о другом объекте переживает."""
    проект = Project(id=uuid.uuid4(), name="Дубли")
    db.add(проект)
    db.flush()
    a = Node(id=uuid.uuid4(), project_id=проект.id, name="a")
    b = Node(id=uuid.uuid4(), project_id=проект.id, name="b")
    db.add_all([a, b])
    db.flush()
    первое = Edge(id=uuid.uuid4(), project_id=проект.id, source_id=a.id,
                  target_id=b.id, label="держит")
    второе = Edge(id=uuid.uuid4(), project_id=проект.id, source_id=a.id,
                  target_id=b.id, label="держит")
    db.add_all([первое, второе])
    db.flush()

    assert dedup_edges(db, проект.id, set()) == 0  # склеек не было — молчит
    assert db.query(Edge).filter(Edge.project_id == проект.id).count() == 2

    # Ту же пару, но одну связь перевесила склейка — она и уходит как дубль.
    assert dedup_edges(db, проект.id, {первое.id}) == 1
    оставшиеся = db.query(Edge).filter(Edge.project_id == проект.id).all()
    assert [e.id for e in оставшиеся] == [второе.id]
