"""Единый импорт: N входов любого типа → один план (Ф1, docs/plan-unified-import.md).

Главные гарантии фазы: (1) семья фактов архива доезжает до узла СЛИТОГО дерева —
адрес разрешается по C4 своего архива и переводится происхождением вкладов (Ф0);
(2) равные тела дедуплицируются молча, разные — становятся конфликтом с точным
происхождением кандидатов; (3) беда одного входа адресуется ему, а не роняет
превью целиком; (4) id конфликтов и их порядок стабильны — на них будет опираться
применение (Ф2), считающее план заново.
"""

import io
import uuid
import zipfile

import pytest
import yaml
from fastapi.testclient import TestClient

from app.auth import require_architect
from app.main import app
from app.models.user import User
from app.unified_import import (
    MAX_INPUTS,
    DocIn,
    UnifiedImportError,
    build_unified_plan,
)

РУЧКА = "/api/v1/projects/import/unified-preview"

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


def test_пустой_вход_и_превышение_капа_ломают_план_целиком():
    with pytest.raises(UnifiedImportError, match="ни один файл"):
        build_unified_plan([])
    много = [(f"{i}.yaml", C4_ЯРМАРКА.encode()) for i in range(MAX_INPUTS + 1)]
    with pytest.raises(UnifiedImportError, match=str(MAX_INPUTS)):
        build_unified_plan(много)
    assert build_unified_plan(много[:MAX_INPUTS]).ok  # ровно кап — принимаем


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


def test_эндпоинт_пустого_запроса_и_превышения_капа(клиент):
    пусто = клиент.post(РУЧКА)
    assert пусто.status_code == 400 and "ни один файл" in пусто.json()["detail"]

    много = _post(клиент, *[(f"{i}.yaml", C4_ЯРМАРКА.encode()) for i in range(MAX_INPUTS + 1)])
    assert много.status_code == 400
    assert str(MAX_INPUTS) in много.json()["detail"]
