"""Тесты слияния нескольких импортов (app/import_merge.py).

Матрица: заглушка+богатый (поля доливаются, дети объединяются), конфликты полей
(первое побеждает + строка в отчёт), external → true, не-дефолт бьёт дефолт,
перевес рёбер + дедуп точных дублей, предупреждения (похожие подписи пары из
разных файлов, fuzzy-имена сиблингов, несовпавшие корни), проверки содержания
(люди внутри системы, объекты без связей, связи в контейнер с компонентами),
passthrough одного файла, нечувствительность к порядку файлов, суммарные лимиты,
инвариант «родители раньше детей» (совместимость с seed_import), адресация
замечаний по происхождению виновных сущностей (Ф6 разложила по корзинам, Ф7 увела
адресата от класса замечания к происхождению — состав панели на него не влияет),
тюнинг федерации Ф0: содержательный вклад бьёт заглушку (П2), матчер якорей (П3),
сироты строкой на файл-владельца (П4) и снимок одно-файлового прогона, удерживающий
его байт-в-байт; Ф1: контейнерное замечание несёт перечень реальных компонентов и
всегда адресуется файлу связи (П5); вторая итерация тюнинга Ф0: совпадение слабого
якоря не гасит спор сильного поля (К3), связь узла с собственным потомком — свой
класс замечания вместо контейнерного (К4); Ф0 «Единого импорта»: происхождение
вкладов с точностью до узла входного файла (node_contribs) — по нему семьи фактов
архивов переедут на merged-узлы; Ф2 эпика якорей: ОСНОВАНИЕ склейки (code /
dependency / name) в отчёте — доклад, не решение (порядконезависим).
"""

import uuid
from itertools import permutations

from conftest import ensure_project

from app.import_merge import (
    MergeReport,
    _run_merge,
    merge_imports,
    parse_and_merge,
    split_remarks,
)
from app.import_yaml import ParsedImport, parse_import
from app.models.edge import Edge
from app.models.node import Node
from app.routers.nodes import get_alerts


def _parse(text: str) -> ParsedImport:
    parsed, errors = parse_import(text)
    assert errors == [], errors
    return parsed


def _path_list(p: ParsedImport) -> list[str]:
    out: list[str] = []
    for n in p.nodes:
        out.append(n.name if n.parent_idx is None else f"{out[n.parent_idx]} / {n.name}")
    return out


def _node_by_path(p: ParsedImport, path: str):
    idx = _path_list(p).index(path)
    return p.nodes[idx]


def _edge_sig(p: ParsedImport) -> set[tuple]:
    paths = _path_list(p)
    return {
        (paths[e.source_idx], paths[e.target_idx], e.label, e.technology) for e in p.edges
    }


def _вклады(
    merged: ParsedImport, report: MergeReport, parts: list[ParsedImport], path: str
) -> list[tuple[int, int, str]]:
    """Происхождение merged-узла по его пути: (файл, индекс узла в файле, имя того
    узла). Имя достаётся из самого входа — чтобы тест утверждал, ЧТО найдено по
    индексу, а не сверялся с номерами на веру."""
    i = _path_list(merged).index(path)
    return [(fi, ni, parts[fi].nodes[ni].name) for fi, ni in report.node_contribs[i]]


def _вклады_согласованы(
    merged: ParsedImport, report: MergeReport, parts: list[ParsedImport]
) -> None:
    """Инвариант происхождения (Ф0 «Единого импорта», docs/plan-unified-import.md):
    node_contribs индексируется как merged.nodes, огрубляется РОВНО в node_files и
    раскладывает каждый узел каждого входа ровно по одному разу.

    Последнее и есть рабочее свойство: семья фактов архива N адресована путём по C4
    СВОЕГО архива, поэтому у неё всегда есть ровно один адресат в слитом дереве —
    ни потерянных вкладов (семье некуда переехать), ни задвоенных (переедет дважды)."""
    assert len(report.node_contribs) == len(merged.nodes)
    for i, вклады in enumerate(report.node_contribs):
        assert {fi for fi, _ni in вклады} == report.node_files[i], i
    все = [c for вклады in report.node_contribs for c in вклады]
    входные = {(fi, ni) for fi, part in enumerate(parts) for ni in range(len(part.nodes))}
    assert sorted(все) == sorted(входные)  # без потерь и без дублей


# Два «репозитория» одной системы: payments богат в A и заглушка в B, orders —
# наоборот; общий корень, ребро orders→payments есть в обоих файлах (дубль).
FILE_A = """
nodes:
  - name: Ярмарка
    role: система
    children:
      - name: payments
        technology: Python
        description: Сервис платежей
        children:
          - name: api
            role: компонент
          - name: charge-worker
            role: воркер
      - name: payments-db
        shape: database
        technology: PostgreSQL
      - name: orders
  - name: Stripe
    external: true
edges:
  - from: payments
    to: payments-db
    label: хранит
  - from: payments
    to: Stripe
    label: charge
  - from: orders
    to: payments
    label: REST
"""

FILE_B = """
nodes:
  - name: Ярмарка
    role: система
    children:
      - name: orders
        technology: Go
        description: Сервис заказов
        children:
          - name: checkout
            role: компонент
      - name: orders-db
        shape: database
        technology: PostgreSQL
      - name: payments
edges:
  - from: orders
    to: orders-db
    label: хранит
  - from: orders
    to: payments
    label: REST
"""


def test_stub_plus_rich_merge():
    """Заглушки доливаются богатыми версиями из «родных» файлов, дети объединяются,
    точный дубль ребра выброшен, конфликтов нет."""
    файлы = [_parse(FILE_A), _parse(FILE_B)]
    merged, report = merge_imports(файлы)
    paths = set(_path_list(merged))
    assert paths == {
        "Ярмарка",
        "Ярмарка / payments",
        "Ярмарка / payments / api",
        "Ярмарка / payments / charge-worker",
        "Ярмарка / payments-db",
        "Ярмарка / orders",
        "Ярмарка / orders / checkout",
        "Ярмарка / orders-db",
        "Stripe",
    }
    pay = _node_by_path(merged, "Ярмарка / payments")
    assert pay.technology == "Python" and pay.description == "Сервис платежей"
    ords = _node_by_path(merged, "Ярмарка / orders")
    assert ords.technology == "Go" and ords.description == "Сервис заказов"
    assert set(report.merged_paths) == {"Ярмарка", "Ярмарка / payments", "Ярмарка / orders"}
    assert report.dropped_edges == 1
    assert len(merged.edges) == 4
    assert report.conflicts == [] and report.errors == []
    # предупреждений о fuzzy нет: payments/payments-db жили в одном файле
    assert report.warnings == []
    # Происхождение с точностью до узла файла (Ф0 единого импорта): у склеенных узлов
    # по вкладу от каждого файла с ТОЧНЫМИ индексами (у «payments» они разные — 1 и 4),
    # у несклеенных — единственный вклад своего файла.
    _вклады_согласованы(merged, report, файлы)
    assert _вклады(merged, report, файлы, "Ярмарка / payments") == [
        (0, 1, "payments"),
        (1, 4, "payments"),
    ]
    assert _вклады(merged, report, файлы, "Ярмарка / orders") == [
        (0, 5, "orders"),
        (1, 1, "orders"),
    ]
    assert _вклады(merged, report, файлы, "Ярмарка / payments / api") == [(0, 2, "api")]
    assert _вклады(merged, report, файлы, "Ярмарка / orders / checkout") == [(1, 2, "checkout")]


def test_order_insensitive_semantics():
    """Набор узлов и рёбер не зависит от порядка файлов."""
    ab, _ = merge_imports([_parse(FILE_A), _parse(FILE_B)])
    ba, _ = merge_imports([_parse(FILE_B), _parse(FILE_A)])
    assert set(_path_list(ab)) == set(_path_list(ba))
    assert _edge_sig(ab) == _edge_sig(ba)


def test_field_conflict_first_wins():
    a = _parse("nodes:\n  - name: svc\n    technology: Python\n")
    b = _parse("nodes:\n  - name: svc\n    technology: Go\n")
    merged, report = merge_imports([a, b])
    assert merged.nodes[0].technology == "Python"
    assert len(report.conflicts) == 1
    assert "technology" in report.conflicts[0]
    assert "файл 2" in report.conflicts[0]


def test_external_disagreement_becomes_true():
    a = _parse("nodes:\n  - name: Stripe\n    external: true\n")
    b = _parse("nodes:\n  - name: Stripe\n")
    merged, report = merge_imports([a, b])
    assert merged.nodes[0].is_external is True
    assert any("external" in c for c in report.conflicts)


def test_enum_non_default_beats_default_and_conflicts():
    # дефолтный shape (service) уступает database без конфликта
    a = _parse("nodes:\n  - name: cache\n")
    b = _parse("nodes:\n  - name: cache\n    shape: database\n")
    merged, report = merge_imports([a, b])
    assert merged.nodes[0].shape == "database"
    assert report.conflicts == []
    # два разных не-дефолта — конфликт, первое побеждает
    c = _parse("nodes:\n  - name: cache\n    shape: broker\n")
    d = _parse("nodes:\n  - name: cache\n    shape: database\n")
    merged2, report2 = merge_imports([c, d])
    assert merged2.nodes[0].shape == "broker"
    assert any("shape" in x for x in report2.conflicts)


def test_same_pair_different_labels_warns():
    a = _parse("nodes:\n  - name: a\n  - name: b\nedges:\n  - from: a\n    to: b\n    label: REST\n")
    b = _parse("nodes:\n  - name: a\n  - name: b\nedges:\n  - from: a\n    to: b\n    label: gRPC\n")
    merged, report = merge_imports([a, b])
    assert len(merged.edges) == 2  # оба ребра сохранены
    assert any("разные подписи" in w for w in report.warnings)


def test_fuzzy_siblings_warn_not_merge():
    a = _parse("nodes:\n  - name: Система\n    children:\n      - name: payments\n")
    b = _parse("nodes:\n  - name: Система\n    children:\n      - name: payments-service\n")
    merged, report = merge_imports([a, b])
    paths = set(_path_list(merged))
    # НЕ склеены — оба существуют
    assert "Система / payments" in paths and "Система / payments-service" in paths
    assert any("похожи" in w for w in report.warnings)


def test_roots_mismatch_warns():
    a = _parse("nodes:\n  - name: Система A\n")
    b = _parse("nodes:\n  - name: Система B\n")
    merged, report = merge_imports([a, b])
    assert len(merged.roots) == 2
    assert any("общих корневых" in w for w in report.warnings)
    # а при общем корне-системе дополнительные корни (SaaS, акторы) — не повод шуметь
    c = _parse("nodes:\n  - name: Система\n  - name: Stripe\n    external: true\n")
    d = _parse("nodes:\n  - name: Система\n  - name: Оператор\n    shape: person\n")
    _, report2 = merge_imports([c, d])
    assert not any("корнев" in w for w in report2.warnings)


def test_single_file_passthrough():
    a = _parse(FILE_A)
    merged, report = merge_imports([a])
    assert merged is a
    assert report.files == 1
    assert report.merged_paths == [] and report.conflicts == [] and report.warnings == []
    # Происхождение заполнено и в вырожденном случае — по той же причине, что и
    # атрибуция: потребитель не должен знать, сколько было входов (Ф0 единого импорта).
    _вклады_согласованы(merged, report, [a])
    assert report.node_contribs == [[(0, i)] for i in range(len(a.nodes))]


def test_total_limit_overflow():
    def big(prefix: str) -> ParsedImport:
        lines = "\n".join(f"  - name: {prefix}{i}" for i in range(1200))
        return _parse("nodes:\n" + lines + "\n")

    _, report = merge_imports([big("a"), big("b")])
    assert any("слишком много узлов" in e.lower() for e in report.errors)


def test_parents_before_children_invariant():
    """Совместимость с seed_import: родитель всегда раньше ребёнка в списке."""
    merged, _ = merge_imports([_parse(FILE_B), _parse(FILE_A)])
    for i, n in enumerate(merged.nodes):
        assert n.parent_idx is None or n.parent_idx < i


# ── Идентичность: якорь источника поверх имени (Фаза 0 docs/plan-arch-sync.md) ──


def test_якорь_склеивает_сервис_названный_по_разному():
    """Свой репозиторий зовёт сервис «app» (имя compose-сервиса), вызывающие —
    «payments» (hostname). Без якоря это два узла; с якорем — один, а расхождение
    имён видно в отчёте."""
    own = _parse(
        "nodes:\n"
        "  - name: Система\n"
        "    children:\n"
        "      - name: app\n"
        "        technology: Go\n"
        "        source: {repo: github.com/org/payments, host: payments}\n"
    )
    caller = _parse(
        "nodes:\n"
        "  - name: Система\n"
        "    children:\n"
        "      - name: payments\n"
        "        source: {host: payments}\n"
    )
    файлы = [own, caller]
    merged, report = merge_imports(файлы)

    assert _path_list(merged) == ["Система", "Система / app"]
    assert _node_by_path(merged, "Система / app").technology == "Go"
    assert any("имя" in c and "payments" in c for c in report.conflicts)
    # Ф0 единого импорта: склейка поверх РАЗНЫХ ИМЁН адресуема точно — вклад каждого
    # файла указывает на его собственный узел («app» и «payments»), а не только на файл.
    _вклады_согласованы(merged, report, файлы)
    assert _вклады(merged, report, файлы, "Система / app") == [
        (0, 1, "app"),
        (1, 1, "payments"),
    ]


def test_якорь_разводит_тёзок_из_разных_репозиториев():
    """Два «api» разных команд имеют одно имя в одном родителе. Раньше склеились
    бы молча — теперь остаются разными узлами."""
    team_a = _parse(
        "nodes:\n"
        "  - name: Система\n"
        "    children:\n"
        "      - name: api\n"
        "        source: {repo: github.com/team-a/api}\n"
    )
    team_b = _parse(
        "nodes:\n"
        "  - name: Система\n"
        "    children:\n"
        "      - name: api\n"
        "        source: {repo: github.com/team-b/api}\n"
    )
    merged, report = merge_imports([team_a, team_b])

    assert len([n for n in merged.nodes if n.name == "api"]) == 2
    assert any("РАЗНЫЕ объекты" in w for w in report.warnings)


def test_без_якорей_поведение_прежнее():
    """Файлы старых прогонов (якорей нет) склеиваются по имени, как раньше."""
    a = _parse("nodes:\n  - name: Система\n    children:\n      - name: api\n        role: сервис\n")
    b = _parse("nodes:\n  - name: Система\n    children:\n      - name: api\n        technology: Go\n")
    merged, report = merge_imports([a, b])

    assert _path_list(merged) == ["Система", "Система / api"]
    node = _node_by_path(merged, "Система / api")
    assert node.role == "сервис" and node.technology == "Go"
    assert report.warnings == []


def test_якорь_сильнее_иерархии():
    """Прогоны положили один сервис под разных родителей (в своём репозитории он
    контейнер системы, у соседа — компонент шлюза). Якорь склеивает, место
    остаётся первым, расхождение — в отчёте."""
    a = _parse(
        "nodes:\n"
        "  - name: Система\n"
        "    children:\n"
        "      - name: auth\n"
        "        source: {repo: github.com/org/auth}\n"
    )
    b = _parse(
        "nodes:\n"
        "  - name: Система\n"
        "    children:\n"
        "      - name: gateway\n"
        "        children:\n"
        "          - name: auth\n"
        "            source: {repo: github.com/org/auth}\n"
    )
    файлы = [a, b]
    merged, report = merge_imports(файлы)

    paths = _path_list(merged)
    assert "Система / auth" in paths and "Система / gateway / auth" not in paths
    assert any("родитель" in c for c in report.conflicts)
    # Ф0 единого импорта: склейка поверх РАЗНЫХ РОДИТЕЛЕЙ тоже точна — вклад второго
    # файла указывает на его «auth» (узел 2, внук), а не на что-то по совпадению имени.
    _вклады_согласованы(merged, report, файлы)
    assert _вклады(merged, report, файлы, "Система / auth") == [(0, 1, "auth"), (1, 2, "auth")]
    assert _вклады(merged, report, файлы, "Система / gateway") == [(1, 1, "gateway")]


def test_склеенный_узел_наследует_все_грани_источника():
    """Третий файл должен найти узел по той грани, которой не было в первом:
    A знает только код, B — код и имя зависимости, C ходит только по имени."""
    a = _parse("nodes:\n  - name: svc\n    source: {repo: github.com/org/svc}\n")
    b = _parse("nodes:\n  - name: svc\n    source: {repo: github.com/org/svc, host: svc-net}\n")
    c = _parse("nodes:\n  - name: другое-имя\n    source: {host: svc-net}\n")
    merged, _report = merge_imports([a, b, c])

    assert len(merged.nodes) == 1
    assert merged.nodes[0].source_keys == ["git:github.com/org/svc", "host:svc-net"]


def test_узлы_одного_файла_не_склеиваются_общим_якорем():
    """Монорепо: агент вешает один git-remote на все свои сервисы, не различив их
    путями. Внутри файла узлы разведены осознанно — склеивать их нельзя, иначе
    поддерево второго растворяется в первом (найдено прогоном на реальном
    репозитории 2026-08-07). Предупреждение зовёт уточнить source.path."""
    mono = _parse(
        "nodes:\n"
        "  - name: Система\n"
        "    children:\n"
        "      - name: frontend\n"
        "        source: {repo: github.com/org/mono}\n"
        "      - name: backend\n"
        "        source: {repo: github.com/org/mono}\n"
        "        children:\n"
        "          - name: api\n"
    )
    neighbour = _parse("nodes:\n  - name: Система\n    children:\n      - name: backend\n        source: {host: backend}\n")
    merged, report = merge_imports([mono, neighbour])

    paths = _path_list(merged)
    assert "Система / frontend" in paths and "Система / backend" in paths
    assert "Система / backend / api" in paths  # поддерево уцелело
    assert any("указывают один источник" in w for w in report.warnings)


def test_path_различает_сервисы_монорепо():
    """С заполненным path узлы монорепо получают разные ключи — и склейка с
    соседними файлами идёт адресно."""
    mono = _parse(
        "nodes:\n"
        "  - name: Система\n"
        "    children:\n"
        "      - name: frontend\n"
        "        source: {repo: github.com/org/mono, path: web}\n"
        "      - name: backend\n"
        "        source: {repo: github.com/org/mono, path: api}\n"
    )
    caller = _parse(
        "nodes:\n"
        "  - name: Система\n"
        "    children:\n"
        "      - name: сервер\n"
        "        source: {repo: github.com/org/mono, path: api}\n"
    )
    merged, report = merge_imports([mono, caller])

    assert _path_list(merged) == ["Система", "Система / frontend", "Система / backend"]
    assert not any("указывают один источник" in w for w in report.warnings)
    # Склеился именно backend, а не frontend.
    assert any("имя" in c and "сервер" in c for c in report.conflicts)


# ── проверки содержания схемы (находки ручной проверки 2026-08-08) ────────────

def _doc(nodes_yaml: str, edges_yaml: str = "edges: []") -> str:
    return f"nodes:\n{nodes_yaml}{edges_yaml}\n"


def test_актор_внутри_системы_это_предупреждение_а_не_молчание():
    # По C4 человек пользуется системой, а не входит в неё. Агент нарушал это в
    # 3 прогонах из 4 — промпт правилу учит, но полагаться на модель нельзя.
    merged, report, errors = parse_and_merge([
        _doc(
            "- name: Voting App\n"
            "  children:\n"
            "  - name: vote\n"
            "  - name: Избиратель\n"
            "    shape: person\n",
            "edges:\n- from: Избиратель\n  to: vote\n",
        )
    ])

    assert errors == [] and merged is not None
    assert any("Избиратель" in w and "человек" in w for w in report.warnings)


def test_актор_в_корне_молчит():
    merged, report, errors = parse_and_merge([
        _doc(
            "- name: Voting App\n"
            "  children:\n"
            "  - name: vote\n"
            "- name: Избиратель\n"
            "  shape: person\n",
            "edges:\n- from: Избиратель\n  to: vote\n",
        )
    ])

    assert errors == [] and merged is not None
    assert not any("человек" in w for w in report.warnings)


def test_объекты_без_связей_считаются_и_называются():
    merged, report, errors = parse_and_merge([
        _doc(
            "- name: Voting App\n"
            "  children:\n"
            "  - name: vote\n"
            "  - name: redis\n"
            "  - name: Voting API\n"
            "  - name: Frontend Templates\n",
            "edges:\n- from: vote\n  to: redis\n",
        )
    ])

    assert errors == [] and merged is not None
    warn = next(w for w in report.warnings if "без единой связи" in w)
    assert "2" in warn and "Voting API" in warn and "Frontend Templates" in warn


def test_корень_системы_без_связей_не_считается_потерянным():
    # У корня связей и не бывает — они у его детей; жаловаться не на что.
    _merged, report, errors = parse_and_merge([
        _doc(
            "- name: Voting App\n  children:\n  - name: vote\n  - name: redis\n",
            "edges:\n- from: vote\n  to: redis\n",
        )
    ])

    assert errors == []
    assert not any("без единой связи" in w for w in report.warnings)


def test_связь_в_контейнер_с_компонентами_называется_поимённо():
    # После импорта это алерт AL8, но агент к тому моменту уже ушёл (полевой QA
    # docs/qa-zabbix-7.md, раунд 3: 13 таких связей). Замечание должно называть
    # КОНКРЕТНУЮ связь — оно лечится переносом её конца на компонент.
    _merged, report, errors = parse_and_merge([
        _doc(
            "- name: Voting App\n"
            "  children:\n"
            "  - name: vote\n"
            "    children:\n"
            "    - name: web-api\n"
            "  - name: redis\n",
            "edges:\n- from: vote\n  to: redis\n- from: web-api\n  to: redis\n",
        )
    ])

    assert errors == []
    assert (
        "связь «vote → redis»: конец в контейнере «vote», у которого есть компоненты, — "
        "уточните её до конкретного компонента: «vote / web-api»"
    ) in report.warnings
    # Ребро от компонента — законное, про него не предупреждаем.
    assert len([w for w in report.warnings if "уточните её до конкретного" in w]) == 1


def test_оба_конца_контейнеры_названы_оба():
    _merged, report, errors = parse_and_merge([
        _doc(
            "- name: Voting App\n"
            "  children:\n"
            "  - name: vote\n"
            "    children:\n"
            "    - name: web-api\n"
            "  - name: worker\n"
            "    children:\n"
            "    - name: queue-reader\n",
            "edges:\n- from: vote\n  to: worker\n",
        )
    ])

    assert errors == []
    assert (
        "связь «vote → worker»: оба конца в контейнерах «vote» и «worker», у которых "
        "есть компоненты, — уточните её до конкретных компонентов: «vote / web-api»; "
        "«worker / queue-reader»"
    ) in report.warnings


# ── «цель с ответом»: перечень компонентов прямо в замечании (П5) ─────────────
#
# Урок Ф8 брокерного эпика, подтверждённый трижды: замечание, несущее ОТВЕТ,
# слабая модель чинит за один круг, а «уточните до конкретного компонента» без
# перечня она чинила лениво и частично — это был главный поглотитель кругов
# полевых раундов (docs/qa-multirepo-federation.md). Форма «Контейнер / компонент»
# — дословно квалификатор, который понимает parse_import: строку можно вписать в
# YAML как есть.


def test_замечание_несёт_перечень_компонентов_контейнера():
    _merged, report, errors = parse_and_merge([
        _doc(
            "- name: Zabbix\n"
            "  children:\n"
            "  - name: server\n"
            "    children:\n"
            "    - name: poller\n"
            "    - name: trapper\n"
            "    - name: escalator\n"
            "  - name: db\n",
            "edges:\n- from: db\n  to: server\n",
        )
    ])

    assert errors == []
    # Компонентов мало — названы все, хвоста нет; порядок — как дети лежат в схеме.
    assert (
        "связь «db → server»: конец в контейнере «server», у которого есть компоненты, — "
        "уточните её до конкретного компонента: «server / poller», «server / trapper», "
        "«server / escalator»"
    ) in report.warnings


def test_перечень_компонентов_капится_хвостом():
    # Контейнер на девять компонентов не должен вытеснить остальные замечания:
    # шесть имён + счётчик остатка (кап того же порядка, что у имён в группе).
    дети = "".join(f"    - name: c{i}\n" for i in range(1, 10))
    _merged, report, errors = parse_and_merge([
        _doc(
            "- name: Zabbix\n  children:\n  - name: server\n    children:\n"
            + дети
            + "  - name: db\n",
            "edges:\n- from: db\n  to: server\n",
        )
    ])

    assert errors == []
    assert (
        "связь «db → server»: конец в контейнере «server», у которого есть компоненты, — "
        "уточните её до конкретного компонента: «server / c1», «server / c2», "
        "«server / c3», «server / c4», «server / c5», «server / c6» и ещё 3"
    ) in report.warnings


def test_при_двух_перечнях_кап_строже():
    # Два перечня в одной строке нечитаемы, поэтому на конец показываем четыре
    # имени, остальное — счётчиком. Перечень свой у КАЖДОГО конца.
    левые = "".join(f"    - name: l{i}\n" for i in range(1, 7))
    правые = "".join(f"    - name: r{i}\n" for i in range(1, 7))
    _merged, report, errors = parse_and_merge([
        _doc(
            "- name: Voting App\n  children:\n  - name: vote\n    children:\n"
            + левые
            + "  - name: worker\n    children:\n"
            + правые,
            "edges:\n- from: vote\n  to: worker\n",
        )
    ])

    assert errors == []
    assert (
        "связь «vote → worker»: оба конца в контейнерах «vote» и «worker», у которых "
        "есть компоненты, — уточните её до конкретных компонентов: «vote / l1», "
        "«vote / l2», «vote / l3», «vote / l4» и ещё 2; «worker / r1», «worker / r2», "
        "«worker / r3», «worker / r4» и ещё 2"
    ) in report.warnings


def test_связи_только_в_листья_молчат():
    _merged, report, errors = parse_and_merge([
        _doc(
            "- name: Voting App\n"
            "  children:\n"
            "  - name: vote\n"
            "    children:\n"
            "    - name: web-api\n"
            "  - name: redis\n",
            "edges:\n- from: web-api\n  to: redis\n",
        )
    ])

    assert errors == []
    assert not any("уточните её до конкретн" in w for w in report.warnings)


def test_кап_на_связях_в_контейнер():
    # Замечания уезжают агенту одним списком: полсотни строк одного класса
    # вытеснили бы всё остальное.
    сколько = 12
    nodes = "- name: Voting App\n  children:\n  - name: redis\n"
    for i in range(сколько):
        nodes += f"  - name: svc{i}\n    children:\n    - name: api{i}\n"
    edges = "edges:\n" + "".join(f"- from: svc{i}\n  to: redis\n" for i in range(сколько))

    _merged, report, errors = parse_and_merge([_doc(nodes, edges)])

    assert errors == []
    assert len([w for w in report.warnings if "уточните её до конкретного" in w]) == 10
    assert "…ещё 2 таких связей" in report.warnings


def test_контейнер_со_связанными_детьми_подвисшим_не_считается():
    # Прямых связей у контейнера быть и не должно — их несут дети (зеркало
    # app/alerts.compute_alerts). Иначе превью пугало бы тем, чего схема не покажет.
    _merged, report, errors = parse_and_merge([
        _doc(
            "- name: Voting App\n"
            "  children:\n"
            "  - name: vote\n"
            "    children:\n"
            "    - name: web-api\n"
            "  - name: redis\n",
            "edges:\n- from: web-api\n  to: redis\n",
        )
    ])

    assert errors == []
    assert not any("без единой связи" in w for w in report.warnings)


# ── связь узла с собственным потомком (Р2-Ф0, К4) ─────────────────────────────
#
# Полевая находка матрицы федерации (docs/qa-federation-matrix.md, находка 4): у Zulip
# пять связей «background-workers → email-senders», где цель — компонент источника.
# Иерархия уже выражает вложенность, стрелка семантически пуста, а прежний
# контейнерный текст отвечал на неё бессмыслицей («уточните её до конкретного
# компонента» — конец УЖЕ компонент, притом этого же контейнера), и круги её не лечили.

_К4_ВЛОЖЕННОСТЬ = (
    "- name: Zulip\n"
    "  children:\n"
    "  - name: background-workers\n"
    "    children:\n"
    "    - name: email-senders\n"
    "      children:\n"
    "      - name: smtp-client\n"
    "  - name: redis\n"
)


def test_связь_в_собственного_ребёнка_это_свой_класс():
    _merged, report, errors = parse_and_merge([
        _doc(_К4_ВЛОЖЕННОСТЬ, "edges:\n- from: background-workers\n  to: email-senders\n")
    ])

    assert errors == []
    assert (
        "связь «background-workers → email-senders»: «email-senders» — часть "
        "«background-workers», иерархия уже выражает вложенность — удалите связь или "
        "перевесьте её на другой узел"
    ) in report.warnings


def test_связь_во_внука_тоже_вложенность():
    """Потомок — любой глубины: внук ничем не отличается от ребёнка, иерархия и его
    вложенность уже выразила."""
    _merged, report, errors = parse_and_merge([
        _doc(_К4_ВЛОЖЕННОСТЬ, "edges:\n- from: background-workers\n  to: smtp-client\n")
    ])

    assert errors == []
    assert (
        "связь «background-workers → smtp-client»: «smtp-client» — часть "
        "«background-workers», иерархия уже выражает вложенность — удалите связь или "
        "перевесьте её на другой узел"
    ) in report.warnings


def test_связь_потомка_в_свой_контейнер_зеркальна():
    """Направление роли не играет: пуста и стрелка изнутри наружу, — но текст
    называет частью того, кто ею и является."""
    _merged, report, errors = parse_and_merge([
        _doc(_К4_ВЛОЖЕННОСТЬ, "edges:\n- from: smtp-client\n  to: background-workers\n")
    ])

    assert errors == []
    assert (
        "связь «smtp-client → background-workers»: «smtp-client» — часть "
        "«background-workers», иерархия уже выражает вложенность — удалите связь или "
        "перевесьте её на другой узел"
    ) in report.warnings


def test_на_связь_с_потомком_приходится_ровно_одно_замечание():
    """Приоритет у нового класса: контейнерное замечание на ту же связь не выдаётся —
    два ответа на одну связь противоречили бы друг другу («удалите» против
    «уточните до компонента»)."""
    _merged, report, errors = parse_and_merge([
        _doc(_К4_ВЛОЖЕННОСТЬ, "edges:\n- from: background-workers\n  to: email-senders\n")
    ])

    assert errors == []
    assert len([w for w in report.warnings if "background-workers → email-senders" in w]) == 1
    assert not any("уточните её до конкретн" in w for w in report.warnings)


def test_связь_в_чужой_контейнер_остаётся_прежним_классом():
    """Не путать с законной связью в ДРУГОЙ контейнер: её конец уточняется до
    компонента, и перечень целей на месте."""
    _merged, report, errors = parse_and_merge([
        _doc(
            "- name: Zulip\n"
            "  children:\n"
            "  - name: background-workers\n"
            "    children:\n"
            "    - name: email-senders\n"
            "  - name: zulip-web\n"
            "    children:\n"
            "    - name: django-app\n",
            "edges:\n- from: background-workers\n  to: zulip-web\n",
        )
    ])

    assert errors == []
    assert (
        "связь «background-workers → zulip-web»: оба конца в контейнерах "
        "«background-workers» и «zulip-web», у которых есть компоненты, — уточните её "
        "до конкретных компонентов: «background-workers / email-senders»; "
        "«zulip-web / django-app»"
    ) in report.warnings
    assert not any("иерархия уже выражает вложенность" in w for w in report.warnings)


def test_кап_на_связях_с_собственным_потомком():
    # Кап и хвост — как у соседних классов: одинокий класс не вытесняет остальные.
    сколько = 12
    nodes = "- name: Zulip\n  children:\n"
    for i in range(сколько):
        nodes += f"  - name: svc{i}\n    children:\n    - name: part{i}\n"
    edges = "edges:\n" + "".join(f"- from: svc{i}\n  to: part{i}\n" for i in range(сколько))

    _merged, report, errors = parse_and_merge([_doc(nodes, edges)])

    assert errors == []
    assert len([w for w in report.warnings if "иерархия уже выражает вложенность" in w]) == 10
    assert "…ещё 2 таких связей с собственным потомком" in report.warnings


def test_на_связи_с_потомком_молчат_и_брокерный_класс_и_перечень_каналов():
    """Ответ на такую связь один — «удалите или перевесьте». «Добавьте channel» и
    «разделите перечень» рядом с ним противоречивы: делить и заполнять нечего, связь
    лишняя целиком (то же правило, что у контейнерного класса)."""
    узлы = (
        "- name: Заказы\n"
        "  children:\n"
        "  - name: kafka\n"
        "    shape: broker\n"
        "  - name: сборщик\n"
    )
    for рёбра in (
        "edges:\n- from: Заказы\n  to: kafka\n",
        "edges:\n- from: Заказы\n  to: kafka\n  channel: \"orders.created, orders.paid\"\n",
    ):
        _merged, report, errors = parse_and_merge([_doc(узлы, рёбра)])

        assert errors == []
        assert len([w for w in report.warnings if "Заказы → kafka" in w]) == 1
        assert any("иерархия уже выражает вложенность" in w for w in report.warnings)
        assert not any("а канал не указан" in w for w in report.warnings)
        assert not any("в channel перечень" in w for w in report.warnings)


def test_замечание_о_потомке_адресовано_файлу_связи():
    """Виновная сущность одна — сама связь, поэтому адресат общего правила Ф7 здесь
    всегда файл-первоисточник связи (её концы объявлены тем же файлом)."""
    дерево = "nodes:\n- name: Zulip\n  children:\n  - name: workers\n    children:\n    - name: email-senders\n"
    _merged, report, errors = parse_and_merge(
        [дерево, дерево + "edges:\n- from: workers\n  to: email-senders\n"]
    )
    файлы, _ошибки_схемы, предупреждения_схемы = split_remarks(report)

    assert errors == []
    assert any("иерархия уже выражает вложенность" in w for w in файлы[1].warnings)
    assert файлы[0].warnings == [] and предупреждения_схемы == []


# ── канал на связи (Ф3 брокеров) ─────────────────────────────────────────────
# Стрелка «сервис → брокер» обязана назвать топик (решение пользователя №4). В отчёте
# это два разных класса: расхождение каналов у одной связи из двух файлов — конфликт
# слияния, а неназванный канал — предупреждение содержания (урок Х5, поимённо).


def _channel_of(p: ParsedImport, src: str, dst: str) -> str | None:
    paths = _path_list(p)
    [e] = [e for e in p.edges if paths[e.source_idx] == src and paths[e.target_idx] == dst]
    return e.channel


_БРОКЕР_A = (
    "- name: Ярмарка\n"
    "  children:\n"
    "  - name: orders\n"
    "  - name: Kafka\n"
    "    shape: broker\n"
)


def test_канал_доливается_дублем_из_другого_файла():
    # Дубль связи (та же пара, та же подпись) назвал канал, а первый файл — нет:
    # «богатое побеждает пустое», иначе порядок файлов молча терял бы поле.
    merged, report, errors = parse_and_merge([
        _doc(_БРОКЕР_A, "edges:\n- from: orders\n  to: Kafka\n  label: событие\n"),
        _doc(
            _БРОКЕР_A,
            "edges:\n- from: orders\n  to: Kafka\n  label: событие\n  channel: orders.created\n",
        ),
    ])

    assert errors == [] and merged is not None
    assert _channel_of(merged, "Ярмарка / orders", "Ярмарка / Kafka") == "orders.created"
    assert report.conflicts == []
    # Связь одна: канал не входит в ключ дедупа.
    assert len(merged.edges) == 1


def test_расхождение_каналов_двух_файлов_уходит_в_конфликты():
    merged, report, errors = parse_and_merge([
        _doc(
            _БРОКЕР_A,
            "edges:\n- from: orders\n  to: Kafka\n  channel: orders.created\n",
        ),
        _doc(
            _БРОКЕР_A,
            "edges:\n- from: orders\n  to: Kafka\n  channel: orders.v2\n",
        ),
    ])

    assert errors == [] and merged is not None
    # Побеждает первый файл — как у полей узла; факт виден в отчёте.
    assert _channel_of(merged, "Ярмарка / orders", "Ярмарка / Kafka") == "orders.created"
    assert (
        "связь «Ярмарка / orders → Ярмарка / Kafka»: канал: оставлено «orders.created» "
        "(файл 1), отброшено «orders.v2» (файл 2)"
    ) in report.conflicts


def test_связь_в_брокер_без_канала_называется_поимённо():
    # Урок Х5: к моменту алертов агент уже ушёл — предупреждаем ДО импорта и называем
    # конкретную связь, потому что лечится она дописыванием одного поля.
    _merged, report, errors = parse_and_merge([
        _doc(
            _БРОКЕР_A,
            "edges:\n- from: orders\n  to: Kafka\n- from: orders\n  to: Kafka\n"
            "  label: оплачен\n  channel: orders.paid\n",
        )
    ])

    assert errors == []
    assert (
        "связь «orders → Kafka»: конец — брокер «Kafka», а канал не указан — "
        "добавьте channel: имя топика/очереди"
    ) in report.warnings
    # Связь с каналом молчит: предупреждение ровно одно.
    assert len([w for w in report.warnings if "а канал не указан" in w]) == 1


def test_связи_без_брокера_про_канал_не_предупреждают():
    _merged, report, errors = parse_and_merge([
        _doc(
            "- name: Ярмарка\n"
            "  children:\n"
            "  - name: orders\n"
            "  - name: orders-db\n"
            "    shape: database\n",
            "edges:\n- from: orders\n  to: orders-db\n",
        )
    ])

    assert errors == []
    assert not any("канал не указан" in w for w in report.warnings)


def test_связей_в_брокер_без_канала_больше_капа_свёрнуты():
    # Кап свой у каждого класса: полсотни строк одного вытеснят из списка остальное.
    services = "".join(f"  - name: s{i}\n" for i in range(13))
    edges = "".join(f"- from: s{i}\n  to: Kafka\n" for i in range(13))
    _merged, report, errors = parse_and_merge([
        _doc(
            "- name: Ярмарка\n  children:\n" + services + "  - name: Kafka\n    shape: broker\n",
            "edges:\n" + edges,
        )
    ])

    assert errors == []
    assert len([w for w in report.warnings if "а канал не указан" in w]) == 10
    assert "…ещё 3 таких связей с брокером" in report.warnings


# ── перечень вместо имени канала (Ф8г, находка №2 docs/qa-zulip-brokers.md) ────
# Правило промпта «по ребру на канал» есть и прямое, но исполняется через раз, а
# машинной проверки формы не было: перечень «email, notify_tornado, …» проходил
# импорт немым и всплывал уже алертом AL31 с нечитаемым именем канала.


def test_перечень_каналов_в_channel_называется_поимённо():
    _merged, report, errors = parse_and_merge([
        _doc(
            _БРОКЕР_A,
            "edges:\n- from: orders\n  to: Kafka\n  channel: email, notify_tornado\n",
        )
    ])

    assert errors == []
    # Перечень назван целиком: агент чинит его расщеплением связи, и ему нужны все
    # имена, а не «в этой связи что-то не так».
    assert (
        "связь «orders → Kafka»: в channel перечень «email, notify_tornado» — "
        "разделите на отдельные связи, по одной на канал"
    ) in report.warnings


def test_точка_с_запятой_тоже_перечень():
    _merged, report, errors = parse_and_merge([
        _doc(
            _БРОКЕР_A,
            "edges:\n- from: orders\n  to: Kafka\n  channel: email; digest_emails\n",
        )
    ])

    assert errors == []
    assert any("в channel перечень «email; digest_emails»" in w for w in report.warnings)


def test_одиночный_канал_с_точками_и_дефисами_молчит():
    # Точки, дефисы и версии в имени канала — норма именования, а не перечень:
    # ложное предупреждение здесь отправило бы агента ломать верное поле.
    _merged, report, errors = parse_and_merge([
        _doc(
            _БРОКЕР_A,
            "edges:\n- from: orders\n  to: Kafka\n  channel: orders.created.v2\n"
            "- from: orders\n  to: Kafka\n  label: почта\n  channel: notify-tornado\n",
        )
    ])

    assert errors == []
    assert not any("в channel перечень" in w for w in report.warnings)


def test_пустой_channel_о_перечне_не_говорит():
    # Пустое поле — другой класс, и о нём уже говорит своё предупреждение: два
    # замечания об одной связи агент чинит дважды.
    _merged, report, errors = parse_and_merge([
        _doc(_БРОКЕР_A, "edges:\n- from: orders\n  to: Kafka\n")
    ])

    assert errors == []
    assert not any("в channel перечень" in w for w in report.warnings)
    assert any("а канал не указан" in w for w in report.warnings)


def test_перечней_в_channel_больше_капа_свёрнуты():
    # Кап свой у каждого класса — как у связей в контейнер и в брокер без канала.
    services = "".join(f"  - name: s{i}\n" for i in range(13))
    edges = "".join(f"- from: s{i}\n  to: Kafka\n  channel: a, b\n" for i in range(13))
    _merged, report, errors = parse_and_merge([
        _doc(
            "- name: Ярмарка\n  children:\n" + services + "  - name: Kafka\n    shape: broker\n",
            "edges:\n" + edges,
        )
    ])

    assert errors == []
    assert len([w for w in report.warnings if "в channel перечень" in w]) == 10
    assert "…ещё 3 таких связей с перечнем в channel" in report.warnings


# ── изолированные группы (Ф8з, полевая валидация Ф8) ──────────────────────────
# Превью говорило про ОДИНОЧЕК, а компонента из двух узлов («актор → его интерфейс»,
# связанные друг с другом и больше ни с чем) проходила молча и всплывала алертом
# «Незавершённость схемы» уже после создания проекта — когда агент ушёл.

_ФРАГМЕНТ = (
    "- name: Ярмарка\n"
    "  children:\n"
    "  - name: vote\n"
    "  - name: redis\n"
    "  - name: worker\n"
    "  - name: Оператор\n"
    "  - name: Admin UI\n"
)
_ФРАГМЕНТ_РЁБРА = (
    "edges:\n"
    "- from: vote\n  to: redis\n"
    "- from: vote\n  to: worker\n"
    "- from: Оператор\n  to: Admin UI\n"
)


def _группы(report) -> list[str]:
    return [w for w in report.warnings if "не связана с остальной схемой" in w]


def test_изолированная_группа_называется_поимённо():
    _merged, report, errors = parse_and_merge([_doc(_ФРАГМЕНТ, _ФРАГМЕНТ_РЁБРА)])

    assert errors == []
    # Ядро (vote/redis/worker) не называем: замечание должно говорить, ЧТО прицепить,
    # а не пересказывать схему.
    assert _группы(report) == [
        "группа из 2 объектов не связана с остальной схемой: «Оператор», «Admin UI» — "
        "дорисуйте связь с ядром или проверьте, не потерялась ли она"
    ]


def test_связная_схема_о_группах_молчит():
    _merged, report, errors = parse_and_merge([
        _doc(_ФРАГМЕНТ, _ФРАГМЕНТ_РЁБРА + "- from: Оператор\n  to: vote\n")
    ])

    assert errors == []
    assert _группы(report) == []


def test_одиночка_группой_не_считается():
    # Об одиночках уже говорит «объектов без единой связи»: два замечания об одном
    # объекте агент чинит дважды, а группой из одного узла он и не является.
    _merged, report, errors = parse_and_merge([
        _doc(
            "- name: Ярмарка\n  children:\n  - name: vote\n  - name: redis\n"
            "  - name: Одинокий\n",
            "edges:\n- from: vote\n  to: redis\n",
        )
    ])

    assert errors == []
    assert _группы(report) == []
    assert any("без единой связи" in w and "Одинокий" in w for w in report.warnings)


def test_кап_имён_в_группе_и_хвост():
    цепочка = lambda имена: "".join(  # noqa: E731 — короткий локальный помощник
        f"- from: {a}\n  to: {b}\n" for a, b in zip(имена, имена[1:], strict=False)
    )
    ядро = [f"я{i}" for i in range(9)]
    группа = [f"г{i}" for i in range(8)]
    узлы = "- name: Ярмарка\n  children:\n" + "".join(
        f"  - name: {n}\n" for n in ядро + группа
    )

    _merged, report, errors = parse_and_merge([
        _doc(узлы, "edges:\n" + цепочка(ядро) + цепочка(группа))
    ])

    assert errors == []
    [w] = _группы(report)
    assert w.startswith("группа из 8 объектов не связана с остальной схемой: «г0», «г1»")
    assert "«г5» и ещё 2 —" in w
    assert "«г6»" not in w


def test_групп_больше_капа_свёрнуты():
    ядро = "- from: я0\n  to: я1\n- from: я1\n  to: я2\n"
    пары = "".join(f"- from: п{i}a\n  to: п{i}b\n" for i in range(12))
    имена = ["я0", "я1", "я2"] + [f"п{i}{s}" for i in range(12) for s in ("a", "b")]
    узлы = "- name: Ярмарка\n  children:\n" + "".join(f"  - name: {n}\n" for n in имена)

    _merged, report, errors = parse_and_merge([_doc(узлы, "edges:\n" + ядро + пары)])

    assert errors == []
    assert len(_группы(report)) == 10
    assert "…ещё 2 таких групп" in report.warnings


def _db_узел(db, name, parent=None):
    n = Node(
        id=uuid.uuid4(),
        name=name,
        project_id=ensure_project(db).id,
        parent_id=parent.id if parent is not None else None,
    )
    db.add(n)
    return n


def _db_связь(db, src, tgt, **kw):
    db.add(
        Edge(
            id=uuid.uuid4(),
            source_id=src.id,
            target_id=tgt.id,
            project_id=ensure_project(db).id,
            **kw,
        )
    )


_КОРОБКА = (
    "- name: Grafana\n"
    "  children:\n"
    "  - name: server\n"
    "  - name: web\n"
    "- name: Плагин\n"
    "  children:\n"
    "  - name: backend\n"
    "  - name: frontend\n"
)
_КОРОБКА_РЁБРА = (
    "edges:\n"
    "- from: server\n  to: web\n"
    "- from: backend\n  to: frontend\n"
    "- from: backend\n  to: Grafana\n"
)


def test_паритет_связь_в_коробку_соединяет_поддерево(db):
    """Связь в контейнер касается всего его поддерева (AL7, исключение 2026-09-06) — и в
    превью, и в алерте одинаково. Полевой случай федерации: плагин ходит в коробку
    «Grafana», внутренности Grafana связаны между собой — схема связна, ложной «группы»
    нет; сама связь в коробку остаётся замечанием своего класса.
    """
    grafana = _db_узел(db, "Grafana")
    server = _db_узел(db, "server", grafana)
    web = _db_узел(db, "web", grafana)
    plugin = _db_узел(db, "Плагин")
    backend = _db_узел(db, "backend", plugin)
    frontend = _db_узел(db, "frontend", plugin)
    _db_связь(db, server, web)
    _db_связь(db, backend, frontend)
    _db_связь(db, backend, grafana)
    db.commit()

    алерт = get_alerts(db=db, project=ensure_project(db))
    _merged, report, errors = parse_and_merge([_doc(_КОРОБКА, _КОРОБКА_РЁБРА)])

    assert errors == []
    assert алерт.isolated_groups == []
    assert _группы(report) == []
    assert len(алерт.intermediate_edges) == 1
    assert any("конец в контейнере «Grafana»" in w for w in report.warnings)


def test_паритет_с_алертом_изолированных_групп(db):
    """Превью и алерт обязаны смотреть на дерево ОДИНАКОВО.

    Для алерта родитель связью НЕ является (иначе через иерархию связано вообще всё,
    и алерт не загорался бы никогда). Разойдись превью с ним — на одной и той же схеме
    превью было бы зелёным, а панель алертов горела бы сразу после импорта: ровно то,
    что и случилось в поле, только наоборот. Зеркало на ОДНОМ дереве: пять узлов под
    общим родителем, рёбра образуют две компоненты.
    """
    ярмарка = _db_узел(db, "Ярмарка")
    узлы = {
        имя: _db_узел(db, имя, ярмарка)
        for имя in ("vote", "redis", "worker", "Оператор", "Admin UI")
    }
    _db_связь(db, узлы["vote"], узлы["redis"])
    _db_связь(db, узлы["vote"], узлы["worker"])
    _db_связь(db, узлы["Оператор"], узлы["Admin UI"])
    db.commit()

    алерт = get_alerts(db=db, project=ensure_project(db))
    _merged, report, errors = parse_and_merge([_doc(_ФРАГМЕНТ, _ФРАГМЕНТ_РЁБРА)])

    assert errors == []
    # Оба видят фрагментацию: алерт — обе группы, превью — все, кроме ядра.
    assert len(алерт.isolated_groups) == 2
    assert {"Оператор", "Admin UI"} in [set(g.node_names) for g in алерт.isolated_groups]
    assert len(_группы(report)) == 1
    assert "«Оператор», «Admin UI»" in _группы(report)[0]

    # И молчат тоже вместе: дорисованная связь схлопывает компоненты в одну.
    _db_связь(db, узлы["Оператор"], узлы["vote"])
    db.commit()
    мост = "- from: Оператор\n  to: vote\n"
    _m2, report2, errors2 = parse_and_merge([_doc(_ФРАГМЕНТ, _ФРАГМЕНТ_РЁБРА + мост)])

    assert errors2 == []
    assert get_alerts(db=db, project=ensure_project(db)).isolated_groups == []
    assert _группы(report2) == []


def test_паритет_с_алертом_связи_в_собственного_потомка(db):
    """Зеркало К4 ↔ AL32 на ОДНОМ дереве: превью импорта и панель проекта обязаны
    классифицировать связь одинаково, иначе пользователь получает противоположные
    советы на одну связь — превью «удалите», проект «уточните конец до компонента»
    (и заодно «допишите канал», раз конец — брокер). Ровно это и происходило до
    добивки К4: класса AL32 не существовало, и связь приезжала в intermediate_edges.
    """
    заказы = _db_узел(db, "Заказы")
    kafka = _db_узел(db, "kafka", заказы)
    kafka.shape = "broker"
    _db_узел(db, "сборщик", заказы)
    _db_связь(db, заказы, kafka)
    db.commit()

    алерт = get_alerts(db=db, project=ensure_project(db))
    узлы = (
        "- name: Заказы\n"
        "  children:\n"
        "  - name: kafka\n"
        "    shape: broker\n"
        "  - name: сборщик\n"
    )
    _merged, report, errors = parse_and_merge([
        _doc(узлы, "edges:\n- from: Заказы\n  to: kafka\n")
    ])

    assert errors == []
    # Обе стороны опознали КЛАСС: связь узла с собственным потомком.
    assert len(алерт.descendant_edges) == 1
    assert (алерт.descendant_edges[0].source_name, алерт.descendant_edges[0].target_name) == (
        "Заказы",
        "kafka",
    )
    assert any("иерархия уже выражает вложенность" in w for w in report.warnings)
    # И обе молчат об остальном: ни «уточните конец», ни «канал».
    assert алерт.intermediate_edges == [] and алерт.broker_edge_channels == []
    assert not any("уточните её до конкретн" in w for w in report.warnings)
    assert not any("а канал не указан" in w for w in report.warnings)


# ── природа замечаний: файловые против схемных (Ф6, docs/plan-skeptic-audit.md) ──
#
# Пакет собирают N агентов, каждый видит ТОЛЬКО свой репозиторий и переписывает
# только свой YAML. Значит, замечание, порождённое содержимым одного файла, надо
# уметь отдать его агенту, а свойство слитой картины (конфликт двух файлов,
# оторванная группа) — оставить человеку: рассудить это может только тот, кто
# видит весь ландшафт. Инвариант суммы держит совместимость с плоскими списками.

# Два «репозитория» одной системы. В первом — актор внутри системы, стрелка в
# брокер без канала и оторванная от ядра группа «Оператор → Админка» (всё лечится в
# файле 1), во втором — перечень каналов в одном поле (лечится в файле 2). Схемное
# одно: расхождение technology у сервиса, который описали оба файла.
_Ф6_ЗАКАЗЫ = """
nodes:
  - name: Ярмарка
    children:
      - name: orders
        technology: Go
      - name: kafka
        shape: broker
      - name: Оператор
        shape: person
      - name: Админка
edges:
  - from: orders
    to: kafka
  - from: Оператор
    to: Админка
"""
_Ф6_ПЛАТЕЖИ = """
nodes:
  - name: Ярмарка
    children:
      - name: payments
      - name: orders
        technology: Rust
edges:
  - from: payments
    to: orders
    channel: "orders.created, orders.paid"
"""


def test_замечания_разложены_по_файлу_виновнику():
    _merged, report, errors = parse_and_merge([_Ф6_ЗАКАЗЫ, _Ф6_ПЛАТЕЖИ])
    файлы, ошибки_схемы, предупреждения_схемы = split_remarks(report)

    assert errors == [] and ошибки_схемы == []
    assert [f.file for f in файлы] == [1, 2]
    # Файловые: каждое ушло к своему агенту и НЕ ушло к чужому.
    assert any("человек" in w and "Оператор" in w for w in файлы[0].warnings)
    assert any("а канал не указан" in w for w in файлы[0].warnings)
    assert any("в channel перечень" in w for w in файлы[1].warnings)
    assert not any("в channel перечень" in w for w in файлы[0].warnings)
    assert not any("человек" in w for w in файлы[1].warnings)
    # Остров целиком из файла 1 — его агенту (Ф7 переписала это утверждение: в Ф6
    # изоляция была схемной ПО КЛАССУ, и тот же файл в одиночку получал замечание
    # себе, а в компании второго — уже нет).
    assert any("не связана с остальной схемой" in w for w in файлы[0].warnings)
    # Схемное: конфликт полей — рассудить его может только видящий оба репозитория.
    assert any("technology: оставлено «Go»" in w for w in предупреждения_схемы)
    assert not any("не связана с остальной схемой" in w for w in предупреждения_схемы)
    assert not any("оставлено «Go»" in w for f in файлы for w in f.warnings)


def test_сумма_корзин_равна_плоским_спискам():
    """Зеркало: каждое замечание ровно в одной корзине, объединение == плоскому
    списку. Плоские warnings/conflicts/errors — исторический контракт превью
    (их читают MCP-тулза и нынешний фронт), и раскладка не имеет права их менять."""
    _merged, report, errors = parse_and_merge([_Ф6_ЗАКАЗЫ, _Ф6_ПЛАТЕЖИ])
    файлы, ошибки_схемы, предупреждения_схемы = split_remarks(report)

    assert errors == []
    assert sorted([w for f in файлы for w in f.warnings] + предупреждения_схемы) == sorted(
        report.conflicts + report.warnings
    )
    assert sorted([e for f in файлы for e in f.errors] + ошибки_схемы) == sorted(report.errors)


def test_замечание_об_объектах_из_разных_файлов_остаётся_пользователю():
    """Одно замечание на объекты ДВУХ файлов виноватого не имеет: адресовать его
    агенту одного из них — значит прислать ему замечание о чужом коде."""
    а = "nodes:\n- name: Ярмарка\n  children:\n  - name: vote\n  - name: Оператор\n    shape: person\n"
    б = "nodes:\n- name: Ярмарка\n  children:\n  - name: vote\n  - name: Админ\n    shape: person\n"
    рёбра = "edges:\n- from: Оператор\n  to: vote\n"
    _merged, report, errors = parse_and_merge(
        [а + рёбра, б + "edges:\n- from: Админ\n  to: vote\n"]
    )
    файлы, _ошибки, предупреждения_схемы = split_remarks(report)

    assert errors == []
    assert any("человек" in w and "Оператор" in w and "Админ" in w for w in предупреждения_схемы)
    assert all(f.warnings == [] for f in файлы)


def test_ошибки_разбора_адресованы_своему_файлу_без_префикса():
    merged, report, errors = parse_and_merge([_Ф6_ЗАКАЗЫ, "nodes:\n  - name: [оборвано"])
    файлы, ошибки_схемы, _предупреждения = split_remarks(report)

    assert merged is None
    # Плоский список — как раньше, с префиксом файла (его показывает шапка превью).
    assert errors and all(e.startswith("файл 2: ") for e in errors)
    assert файлы[0].errors == []
    # В корзине — те же строки без префикса: адресация уже в структуре.
    assert файлы[1].errors == [e.removeprefix("файл 2: ") for e in errors]
    assert ошибки_схемы == []


def test_лимит_слияния_это_замечание_к_слитой_схеме():
    def много(префикс: str) -> str:
        return "nodes:\n" + "\n".join(f"  - name: {префикс}{i}" for i in range(1200)) + "\n"

    _merged, report, errors = parse_and_merge([много("a"), много("b")])
    файлы, ошибки_схемы, _предупреждения = split_remarks(report)

    assert any("слишком много узлов" in e.lower() for e in errors)
    assert any("слишком много узлов" in e.lower() for e in ошибки_схемы)
    assert all(f.errors == [] for f in файлы)


def test_одно_файловый_режим_кладёт_всё_в_единственный_файл():
    """Решение пользователя: в одно-файловом мире агент видит всю систему и чинит
    всё — включая изоляцию, которая при нескольких файлах схемная. Схемные корзины
    пусты, панель импорта работает ровно как до Ф6."""
    _merged, report, errors = parse_and_merge([_doc(_ФРАГМЕНТ, _ФРАГМЕНТ_РЁБРА)])
    файлы, ошибки_схемы, предупреждения_схемы = split_remarks(report)

    assert errors == [] and (ошибки_схемы, предупреждения_схемы) == ([], [])
    assert len(файлы) == 1 and файлы[0].file == 1
    assert файлы[0].warnings == report.conflicts + report.warnings
    assert any("не связана с остальной схемой" in w for w in файлы[0].warnings)


def test_кап_предупреждений_режет_разметку_вместе_со_списком():
    """Свёртка «…и ещё N предупреждений» режет плоский список — разметка природы
    обязана укоротиться строка в строку, иначе корзины разъедутся со списком."""
    файлы_яml = [
        "nodes:\n- name: Система\n  children:\n"
        + "".join(f"  - name: сервис-{i}-{суффикс}\n" for i in range(40))
        for суффикс in ("a", "b")
    ]
    _merged, report, errors = parse_and_merge(файлы_яml)
    файлы, _ошибки, предупреждения_схемы = split_remarks(report)

    assert errors == []
    assert len(report.warnings) == len(report.warning_files)
    assert any("и ещё" in w for w in report.warnings)
    assert sorted([w for f in файлы for w in f.warnings] + предупреждения_схемы) == sorted(
        report.conflicts + report.warnings
    )


# ── адресат по происхождению виновных, а не по классу замечания (Ф7) ───────────
#
# Ф6 адресовала по КЛАССУ: изолированная группа при files>1 всегда схемная. Следствие
# поймал пользователь: один и тот же файл получал РАЗНЫЙ ответ в зависимости от того,
# сколько документов лежит рядом в панели (залил остров один — замечание своему агенту;
# добавил второй, ничего не менявший, файл — то же замечание уехало человеку). Правило
# Ф7 одно на все классы: есть файл, внёсший вклад в КАЖДУЮ виновную сущность, — ему и
# адресуем (при нескольких кандидатах — наименьший номер), нет — схемная корзина.

# Ядро (vote → redis, worker) и остров «Оператор → Admin UI» — всё из одного файла.
# Ядро строго крупнее острова: при равном размере «ядром» становится компонента,
# первая по алфавиту, и замечание указало бы на другую половину.
_Ф7_ОСТРОВ = """
nodes:
  - name: Ярмарка
    children:
      - name: vote
      - name: redis
      - name: worker
      - name: Оператор
      - name: Admin UI
edges:
  - from: vote
    to: redis
  - from: vote
    to: worker
  - from: Оператор
    to: Admin UI
"""
# Валидный сосед: свой сервис, привязанный к ядру, сущностей острова не трогает.
_Ф7_СОСЕД = """
nodes:
  - name: Ярмарка
    children:
      - name: payments
      - name: vote
edges:
  - from: payments
    to: vote
"""
_ОСТРОВ_ТЕКСТ = (
    "группа из 2 объектов не связана с остальной схемой: «Оператор», «Admin UI» — "
    "дорисуйте связь с ядром или проверьте, не потерялась ли она"
)


def _корзины(*файлы_yaml: str):
    _merged, report, errors = parse_and_merge(list(файлы_yaml))
    assert errors == []
    return split_remarks(report)


def test_адресат_замечания_не_зависит_от_состава_панели():
    """Находка пользователя: замечание об острове файла A обязано остаться замечанием
    АГЕНТУ A и после того, как в панель добавили второй файл. Текст и корзина те же."""
    соло, схема_ошибки, схема_пред = _корзины(_Ф7_ОСТРОВ)
    assert соло[0].warnings == [_ОСТРОВ_ТЕКСТ] and (схема_ошибки, схема_пред) == ([], [])

    файлы, _ошибки, схема = _корзины(_Ф7_ОСТРОВ, _Ф7_СОСЕД)
    assert файлы[0].warnings == [_ОСТРОВ_ТЕКСТ]
    assert файлы[1].warnings == [] and схема == []


def test_замечание_следует_за_файлом_при_перестановке():
    """Перестановка меняет НОМЕР файла, но не адресацию: замечание едет за своим
    документом, а не за позицией в панели."""
    файлы, _ошибки, схема = _корзины(_Ф7_СОСЕД, _Ф7_ОСТРОВ)

    assert файлы[1].warnings == [_ОСТРОВ_ТЕКСТ]
    assert файлы[0].warnings == [] and схема == []


# Сосед, ПРИВЯЗАВШИЙ остров к ядру своей связью.
_Ф7_МОСТ = """
nodes:
  - name: Ярмарка
    children:
      - name: vote
      - name: Оператор
edges:
  - from: Оператор
    to: vote
"""


def test_остров_погашенный_слиянием_не_упоминается_нигде():
    """В слитом графе острова нет — значит, нет и замечания: подсистема вправе
    держаться за мир через чужой репозиторий, и предъявлять это её агенту не за что."""
    файлы, _ошибки, схема = _корзины(_Ф7_ОСТРОВ, _Ф7_МОСТ)

    assert схема == []
    assert not any("не связана с остальной схемой" in w for f in файлы for w in f.warnings)


# Остров, собранный ДВУМЯ файлами: «Оператор → Шина» из первого, «Шина → Журнал» из
# второго. Общего файла у тройки нет — свести её с ядром может только человек.
_Ф7_ПОЛОВИНА_А = """
nodes:
  - name: Ярмарка
    children:
      - name: vote
      - name: redis
      - name: worker
      - name: api
      - name: Оператор
      - name: Шина
edges:
  - from: vote
    to: redis
  - from: vote
    to: worker
  - from: vote
    to: api
  - from: Оператор
    to: Шина
"""
_Ф7_ПОЛОВИНА_Б = """
nodes:
  - name: Ярмарка
    children:
      - name: Шина
      - name: Журнал
edges:
  - from: Шина
    to: Журнал
"""


def test_группа_из_узлов_разных_файлов_остаётся_пользователю():
    файлы, _ошибки, схема = _корзины(_Ф7_ПОЛОВИНА_А, _Ф7_ПОЛОВИНА_Б)

    assert [w for w in схема if "не связана с остальной схемой" in w] == [
        "группа из 3 объектов не связана с остальной схемой: «Оператор», «Шина», "
        "«Журнал» — дорисуйте связь с ядром или проверьте, не потерялась ли она"
    ]
    assert not any(
        "не связана с остальной схемой" in w for f in файлы for w in f.warnings
    )


# Связь в атомарный (для своего файла) redis; контейнером его делает ЧУЖОЙ файл.
_Ф7_СВЯЗЬ_В_REDIS = """
nodes:
  - name: Ярмарка
    children:
      - name: vote
      - name: redis
edges:
  - from: vote
    to: redis
"""
_Ф7_КОМПОНЕНТЫ_REDIS = """
nodes:
  - name: Ярмарка
    children:
      - name: redis
        children:
          - name: redis-core
edges: []
"""
_Ф7_СВОЙ_КОНТЕЙНЕР = """
nodes:
  - name: Ярмарка
    children:
      - name: vote
      - name: redis
        children:
          - name: redis-core
edges:
  - from: vote
    to: redis
"""


def test_контейнер_раскрытый_чужим_файлом_адресован_агенту_связи():
    """Ф7-вариант «замечание уходит человеку» ВЫТЕСНЕН П5. Прежде агент файла 1 видел
    на конце атомарный сервис (компоненты пришли только из файла 2) и уточнить его не
    мог физически — строка уезжала в схемную корзину. Теперь недостающее знание
    вложено в текст перечнем, и виновная сущность остаётся ровно одна — сама связь:
    замечание уходит её первоисточнику (правило Ф7 то же, круг виновных сужен)."""
    файлы, _ошибки, схема = _корзины(_Ф7_СВЯЗЬ_В_REDIS, _Ф7_КОМПОНЕНТЫ_REDIS)

    assert файлы[0].file == 1
    assert файлы[0].warnings == [
        "связь «vote → redis»: конец в контейнере «redis», у которого есть компоненты, — "
        "уточните её до конкретного компонента: «redis / redis-core»"
    ]
    assert not any("контейнер" in w for w in схема)


def test_контейнер_с_вкладом_своего_файла_адресован_агенту_связи():
    """Тот же второй файл, но компонент redis есть и в файле связи. Адресат прежний
    (файл связи), а перечень не двоится: redis-core обоих файлов — один узел слитого
    дерева, из него перечень и берётся."""
    файлы, _ошибки, схема = _корзины(_Ф7_СВОЙ_КОНТЕЙНЕР, _Ф7_КОМПОНЕНТЫ_REDIS)

    assert (
        "связь «vote → redis»: конец в контейнере «redis», у которого есть компоненты, — "
        "уточните её до конкретного компонента: «redis / redis-core»"
    ) in файлы[0].warnings
    assert not any("контейнер" in w for w in схема)


_Ф7_АКТОР = """
nodes:
  - name: Ярмарка
    children:
      - name: vote
      - name: Оператор
        shape: person
edges:
  - from: Оператор
    to: vote
"""


def test_объект_обоих_файлов_адресуется_первому():
    """Виновник, внесённый ОБОИМИ файлами, даёт двух кандидатов — берём наименьшего:
    тот же tie-break, что у всего слияния («побеждает первый файл»). В Ф6 такой объект
    адресата не имел вовсе (правило требовало РОВНО одного файла на объект), и
    замечание о нём уходило человеку, хотя чинить его есть кому."""
    файлы, _ошибки, схема = _корзины(_Ф7_АКТОР, _Ф7_АКТОР)

    assert any("человек" in w and "Оператор" in w for w in файлы[0].warnings)
    assert файлы[1].warnings == [] and схема == []


# ── федерация: содержательный вклад против заглушки (П2) и матчер якорей v2 (П3) ─
#
# Полевой мультирепо-QA Zabbix+Grafana (docs/qa-multirepo-federation.md): один продукт
# описан с трёх сторон. Сосед знает Grafana только СНАРУЖИ — имя, сетевое имя,
# угаданная technology, external: true и ни одного компонента. Свой репозиторий
# разобрал её ИЗНУТРИ. Плагин вписал в узел продукта СВОЁ репо: для него Grafana —
# место жительства. До Ф0 спор полей выигрывал первый по порядку файл (в проекте
# настоящая Grafana оказывалась внешней с оскоплённой technology), а плагин не
# склеивался вовсе («различаются источники»), и продукт оставался раздвоенным.

_ЗАГЛУШКА_СОСЕДА = """
nodes:
  - name: Zabbix
    children:
      - name: server
  - name: Grafana
    technology: Go
    external: true
    source: {host: grafana}
edges:
  - from: server
    to: Grafana
    label: datasource
"""
_СВОЙ_РЕПОЗИТОРИЙ = """
nodes:
  - name: Grafana
    technology: Go, TypeScript
    source: {repo: 'https://github.com/grafana/grafana', path: ''}
    children:
      - name: grafana-server
      - name: grafana-frontend
edges:
  - from: grafana-frontend
    to: grafana-server
    label: HTTP API
"""
_ПЛАГИН = """
nodes:
  - name: grafana
    source: {repo: 'https://github.com/alexanderzobnin/grafana-zabbix.git', host: grafana}
    children:
      - name: zabbix-datasource
      - name: zabbix-panel
edges:
  - from: zabbix-datasource
    to: zabbix-panel
    label: рендер
"""


def test_содержательный_вклад_бьёт_заглушку_независимо_от_порядка():
    """П2: содержательность вклада (компоненты ЛИБО source.repo) сильнее порядка
    файлов. Заглушка соседа не красит продукт ни внешностью, ни угаданной технологией
    — ни первой, ни второй в панели."""
    for порядок in ([_ЗАГЛУШКА_СОСЕДА, _СВОЙ_РЕПОЗИТОРИЙ], [_СВОЙ_РЕПОЗИТОРИЙ, _ЗАГЛУШКА_СОСЕДА]):
        merged, report = merge_imports([_parse(t) for t in порядок])
        grafana = _node_by_path(merged, "Grafana")

        assert grafana.is_external is False
        assert grafana.technology == "Go, TypeScript"
        # Заглушка и содержательный склеились в один продукт (компоненты на месте).
        assert "Grafana / grafana-server" in _path_list(merged)
        # Спор не решён молча: строка есть, номера файлов честные (кто дал оставленное
        # значение, а кто отброшенное), а не «первый вкладчик узла».
        свой = порядок.index(_СВОЙ_РЕПОЗИТОРИЙ) + 1
        чужой = порядок.index(_ЗАГЛУШКА_СОСЕДА) + 1
        assert (
            f"Grafana: technology: оставлено «Go, TypeScript» (файл {свой}), "
            f"отброшено «Go» (файл {чужой})"
        ) in report.conflicts
        assert (
            f"Grafana: external: файлы {min(свой, чужой)} и {max(свой, чужой)} расходятся "
            f"— оставлено false"
        ) in report.conflicts


def test_равная_содержательность_решается_первым_файлом():
    """Оба файла видели сервис изнутри (репо + компоненты) — рассудить их
    содержательностью нечем, работает прежний tie-break «побеждает первый»
    (пара «заглушка + заглушка» — в test_field_conflict_first_wins)."""
    a = _parse(
        "nodes:\n  - name: svc\n    technology: Python\n"
        "    source: {repo: github.com/org/svc}\n    children:\n      - name: api\n"
    )
    b = _parse(
        "nodes:\n  - name: svc\n    technology: Go\n"
        "    source: {repo: github.com/org/svc}\n    children:\n      - name: core\n"
    )
    merged, report = merge_imports([a, b])

    assert _node_by_path(merged, "svc").technology == "Python"
    assert (
        "svc: technology: оставлено «Python» (файл 1), отброшено «Go» (файл 2)"
    ) in report.conflicts


# ── К3: слабое совпадение не гасит спор сильных (Р2-Ф0, docs/plan-tuning-round2.md) ─
#
# Матрица федерации (docs/qa-federation-matrix.md, находка 3) поймала цену мягкого
# правила П3: узел плагина {repo плагина, host grafana} слился с ядром продукта
# {repo продукта, host grafana} — общий host погасил спор repo, и плагин выдал себя за
# ядро (6 из 12 схемных строк «имя/родитель/role/technology/description отброшено»).
# К3 сузил правило до иерархии сил identity.KEY_ORDER: слабое совпадение гасит спор
# сильного поля ТОЛЬКО когда у одной из сторон этого поля нет.

_ЯДРО_ПРОДУКТА = """
nodes:
  - name: Grafana
    children:
      - name: grafana-server
        source: {repo: github.com/grafana/grafana, path: pkg/cmd/grafana, host: grafana}
      - name: grafana-frontend
        source: {repo: github.com/grafana/grafana, path: public/app}
edges:
  - from: grafana-frontend
    to: grafana-server
"""
# Полевая форма плагина: своё имя, своё репо — и тот же сетевой хост, потому
# что плагин живёт ВНУТРИ процесса продукта.
_ПЛАГИН_ПОЛЕ = """
nodes:
  - name: grafana-zabbix
    source:
      repo: https://github.com/alexanderzobnin/grafana-zabbix
      host: grafana
    children:
      - name: datasource
      - name: panel-triggers
"""


def _дети(p: ParsedImport, idx: int) -> set[str]:
    return {n.name for n in p.nodes if n.parent_idx == idx}


def _с_ключом(p: ParsedImport, key: str) -> list[int]:
    return [i for i, n in enumerate(p.nodes) if key in n.source_keys]


def test_заглушка_без_репозитория_склеивается_с_продуктом():
    """К3, кейс (а) — главный успех прошлой итерации, регрессия недопустима. У
    заглушки соседа repo НЕТ вовсе: спорить о сильном поле не с чем (общего типа
    ключа у них не находится), и склейку решает имя, как до появления якорей."""
    for порядок in ([_ЗАГЛУШКА_СОСЕДА, _СВОЙ_РЕПОЗИТОРИЙ], [_СВОЙ_РЕПОЗИТОРИЙ, _ЗАГЛУШКА_СОСЕДА]):
        merged, report = merge_imports([_parse(t) for t in порядок])
        пути = _path_list(merged)

        assert [p for p in пути if p.casefold() == "grafana"] == ["Grafana"], порядок
        assert "Grafana / grafana-server" in пути, порядок
        # Заглушка принесла свою грань источника — по ней продукт найдёт третий файл.
        grafana = _node_by_path(merged, "Grafana")
        assert sorted(grafana.source_keys) == ["git:github.com/grafana/grafana", "host:grafana"]
        assert not any("РАЗНЫЕ объекты" in w for w in report.warnings), порядок


def test_заглушка_склеивается_по_общему_хосту_с_узлом_знающим_репо():
    """К3, кейс (а), вторая ветка: общий тип ключа ЕСТЬ, и он слабый (host). Сильное
    поле знает только одна сторона — противоречия нет, слабое совпадение решает, и
    вызывающий склеивается с ядром поверх разных имён (ради этого якорь и заводился:
    «свой репозиторий знает git, вызывающий — только сетевое имя»)."""
    сосед = "nodes:\n  - name: мониторинг\n    source: {host: grafana}\n"
    merged, report = merge_imports([_parse(_ЯДРО_ПРОДУКТА), _parse(сосед)])

    assert _path_list(merged) == ["Grafana", "Grafana / grafana-server", "Grafana / grafana-frontend"]
    assert any("имя" in c and "мониторинг" in c for c in report.conflicts)
    assert not any("РАЗНЫЕ объекты" in w for w in report.warnings)


def test_плагин_со_своим_репо_не_склеивается_с_ядром_продукта():
    """К3, кейс (б) — полевая ложная склейка находки 3. Плагин и ядро знают своё repo,
    и оно разное: общий host их больше не сводит. Раньше плагин затирал ядро именем,
    родителем и полями (и оставался единственным узлом на два репозитория)."""
    for порядок in ([_ЯДРО_ПРОДУКТА, _ПЛАГИН_ПОЛЕ], [_ПЛАГИН_ПОЛЕ, _ЯДРО_ПРОДУКТА]):
        merged, report = merge_imports([_parse(t) for t in порядок])
        пути = _path_list(merged)

        assert "Grafana / grafana-server" in пути, порядок
        assert {"grafana-zabbix / datasource", "grafana-zabbix / panel-triggers"} <= set(пути)
        # Ни один узел не несёт оба репозитория — значит склейки не было.
        assert all(
            len([k for k in n.source_keys if k.startswith("git:")]) <= 1 for n in merged.nodes
        ), порядок
        assert report.conflicts == [], порядок


def test_плагин_тёзка_продукта_остаётся_отдельным_узлом():
    """Та же К3 на форме прошлой итерации: плагин назвал свой узел ИМЕНЕМ ПРОДУКТА и
    вписал в него своё repo. До К3 это давало «один продукт» (мягкое правило гасило
    спор repo общим host); теперь тёзки с разными репозиториями раздельны, и
    расхождение названо вслух — молчаливой склейки нет."""
    merged, report = merge_imports([_parse(t) for t in (_СВОЙ_РЕПОЗИТОРИЙ, _ПЛАГИН)])
    ядро = _с_ключом(merged, "git:github.com/grafana/grafana")
    плагин = _с_ключом(merged, "git:github.com/alexanderzobnin/grafana-zabbix")

    assert len(ядро) == 1 and len(плагин) == 1 and ядро != плагин
    assert _дети(merged, ядро[0]) == {"grafana-server", "grafana-frontend"}
    assert _дети(merged, плагин[0]) == {"zabbix-datasource", "zabbix-panel"}
    assert any("РАЗНЫЕ объекты" in w for w in report.warnings)


def test_склейка_федерации_не_зависит_от_порядка_файлов():
    """Инвариант матчера v3: исход не зависит от порядка панели (тот же инвариант,
    что у П2). Инкрементальный матчер ему не отвечал — узел копит ключи, и кандидат
    сравнивался с накопленным; стабилизация (_regroup) смотрит на ВКЛАДЫ и повторяет
    проход. После К3 состав другой (плагин отделён от продукта, см. тест выше), а
    инвариант тот же: в любом из шести порядков продукт ЕДИН (оба его компонента под
    одним узлом), плагин цел рядом, и репозитории не смешаны.

    Единственное, что порядок всё же решает, — к кому из двух тёзок прилипнет
    заглушка соседа: у неё только host, общий у продукта и живущего в нём плагина, и
    отличить их она не даёт. Спор полей это не задевает: П2 держит продукт от
    покраски заглушкой в любом порядке."""
    for порядок in permutations((_ЗАГЛУШКА_СОСЕДА, _СВОЙ_РЕПОЗИТОРИЙ, _ПЛАГИН)):
        файлы = [_parse(t) for t in порядок]
        merged, report = merge_imports(файлы)
        ядро = _с_ключом(merged, "git:github.com/grafana/grafana")
        плагин = _с_ключом(merged, "git:github.com/alexanderzobnin/grafana-zabbix")

        assert len(merged.nodes) == 8, порядок
        assert len(ядро) == 1 and len(плагин) == 1 and ядро != плагин, порядок
        assert _дети(merged, ядро[0]) == {"grafana-server", "grafana-frontend"}, порядок
        assert _дети(merged, плагин[0]) == {"zabbix-datasource", "zabbix-panel"}, порядок
        # П2 держится в любом порядке — заглушка не красит продукт.
        продукт = merged.nodes[ядро[0]]
        assert (продукт.is_external, продукт.technology) == (False, "Go, TypeScript"), порядок
        assert merged.nodes[плагин[0]].is_external is False, порядок
        assert any("РАЗНЫЕ объекты" in w for w in report.warnings), порядок
        # Ф0 единого импорта: происхождение целое в любом порядке — прогон проходит
        # через стабилизацию, и вклады обязаны пережить её, где бы кто ни лёг.
        _вклады_согласованы(merged, report, файлы)
        # …и указывают на верные узлы входов: якорь merged-узла прослеживается до того
        # самого узла того самого файла, который его принёс.
        for узел, ключ in (
            (ядро[0], "git:github.com/grafana/grafana"),
            (плагин[0], "git:github.com/alexanderzobnin/grafana-zabbix"),
        ):
            вклады = report.node_contribs[узел]
            assert any(ключ in файлы[fi].nodes[ni].source_keys for fi, ni in вклады), порядок


def test_повторный_проход_стабилизации_сохраняет_происхождение_вкладов():
    """Ф0 единого импорта: node_contribs собирает ПОСЛЕДНИЙ проход слияния, поэтому
    происхождение обязано пережить пересборку, которую заказывает стабилизация
    (_regroup): она отдаёт разметку «атом (файл, узел файла) → группа», и merge_imports
    повторяет проход с ней — индексы merged-узлов при этом другие.

    Разметка здесь задаётся руками, а не добывается из _regroup: после К3 предикат
    _bridged на полевых формах молчит (склейку решают сами матчеры, см. тесты выше), и
    повторный проход иначе не достижим. Проверяется именно ПЕРЕНОС происхождения, а не
    решение о склейке — форма взята прежняя, пред-К3: три «графаны» полевой тройки,
    силой сведённые в один узел продукта."""
    файлы = [_parse(t) for t in (_ЗАГЛУШКА_СОСЕДА, _СВОЙ_РЕПОЗИТОРИЙ, _ПЛАГИН)]
    группы = {(0, 2): 42, (1, 0): 42, (2, 0): 42}  # три «графаны» — одна группа
    merged, report = _run_merge(файлы, группы).finish(файлы)

    assert len(merged.nodes) == 7  # продукт един, а не раздвоен
    _вклады_согласованы(merged, report, файлы)
    assert _вклады(merged, report, файлы, "Grafana") == [
        (0, 2, "Grafana"),
        (1, 0, "Grafana"),
        (2, 0, "grafana"),
    ]
    assert _вклады(merged, report, файлы, "Grafana / zabbix-datasource") == [
        (2, 1, "zabbix-datasource"),
    ]


def test_свидетель_не_сводит_тёзок_спорящих_напрямую():
    """Оборотная сторона стабилизации после К3: вклад-свидетель гасит противоречие
    только там, где по К3 его нет. Третий файл знает «api» лишь по имени зависимости
    и не противоречит ни одной команде (общего типа ключа с ними нет) — но связать
    через себя два разных репозитория он не вправе, иначе К3 обходился бы
    транзитивностью union-find (A+свидетель, свидетель+B → A и B в одной группе
    вопреки их прямому спору)."""
    команда_a = (
        "nodes:\n  - name: Система\n    children:\n      - name: api\n"
        "        source: {repo: github.com/team-a/api.git}\n"
    )
    команда_b = (
        "nodes:\n  - name: Система\n    children:\n      - name: api\n"
        "        source: {repo: github.com/team-b/api.git}\n"
    )
    свидетель = (
        "nodes:\n  - name: Система\n    children:\n      - name: api\n"
        "        source: {host: api-net}\n"
    )
    for порядок in permutations((команда_a, команда_b, свидетель)):
        merged, report = merge_imports([_parse(t) for t in порядок])

        assert len([n for n in merged.nodes if n.name == "api"]) == 2, порядок
        assert any("РАЗНЫЕ объекты" in w for w in report.warnings), порядок


def test_тёзки_раздельны_во_всех_порядках_даже_с_безъякорной_заглушкой():
    """Обратная сторона стабилизации: свидетелем работает только вклад С ЯКОРЯМИ.
    Безъякорная тёзка попадает в узел по имени и не должна связывать двух чужих друг
    другу «api» — иначе порядконезависимость купилась бы ценой молчаливой ложной
    склейки, которая хуже дубля (дубль видно, склейка выглядит корректной схемой)."""
    команда_a = (
        "nodes:\n  - name: Система\n    children:\n      - name: api\n"
        "        source: {repo: github.com/team-a/api.git, host: api-a}\n"
    )
    команда_b = (
        "nodes:\n  - name: Система\n    children:\n      - name: api\n"
        "        source: {repo: github.com/team-b/api.git, host: api-b}\n"
    )
    безъякорная = "nodes:\n  - name: Система\n    children:\n      - name: api\n"
    for порядок in permutations((команда_a, команда_b, безъякорная)):
        merged, report = merge_imports([_parse(t) for t in порядок])

        assert len([n for n in merged.nodes if n.name == "api"]) == 2, порядок
        assert any("РАЗНЫЕ объекты" in w for w in report.warnings), порядок


def test_настоящие_тёзки_без_единого_совпадения_остаются_раздельными():
    """Обратная сторона П3: не совпало НИ ОДНО поле якоря (разные repo И разные host)
    — это два сервиса двух команд. Иначе Ф0 обменяла бы видимый дубль на молчаливую
    ложную склейку, которая выглядит как корректная схема."""
    a = _parse("nodes:\n  - name: api\n    source: {repo: github.com/team-a/api.git, host: api-a}\n")
    b = _parse("nodes:\n  - name: api\n    source: {repo: github.com/team-b/api.git, host: api-b}\n")
    merged, report = merge_imports([a, b])

    assert len([n for n in merged.nodes if n.name == "api"]) == 2
    assert any("РАЗНЫЕ объекты" in w for w in report.warnings)


# ── сборные списки сирот — по файлам-владельцам (П4) ──────────────────────────
#
# «Объектов без единой связи: 17» собирало сирот ВСЕЙ слитой схемы одной строкой:
# общего виновника у неё нет, и строка уезжала человеку — хотя каждого сироту чинит
# агент его репозитория.

_П4_ВИТРИНА = """
nodes:
  - name: Ярмарка
    children:
      - name: vote
      - name: redis
      - name: витрина
      - name: справочник
edges:
  - from: vote
    to: redis
"""
_П4_РАССЫЛЬНЫЙ = """
nodes:
  - name: Ярмарка
    children:
      - name: payments
      - name: vote
      - name: рассыльный
      - name: справочник
edges:
  - from: payments
    to: vote
"""


def _сироты(текст: str) -> str:
    return (
        f"объектов без единой связи: 1 («{текст}») — проверьте, не потерялись ли связи; "
        f"такие объекты попадут в «Незавершённость схемы»"
    )


def test_сироты_разложены_по_файлам_владельцам():
    """Строка на владельца: сироты, весь вклад в которых сделал один файл, — его
    агенту; сирота-склейка обоих файлов идёт ОТДЕЛЬНОЙ строкой, адресат которой
    считается общим правилом Ф7 (наименьший общий файл)."""
    файлы, _ошибки, схема = _корзины(_П4_ВИТРИНА, _П4_РАССЫЛЬНЫЙ)

    assert файлы[0].warnings == [_сироты("витрина"), _сироты("справочник")]
    assert файлы[1].warnings == [_сироты("рассыльный")]
    assert схема == []


def test_сироты_без_общего_файла_остаются_пользователю():
    """Разбиение не выдумывает адресата: сирота, собранная файлами 1–2, и сирота,
    собранная файлами 3–4, общего файла не имеют — их строка уезжает человеку."""

    def один(имя: str) -> str:
        return f"nodes:\n  - name: Ярмарка\n    children:\n      - name: {имя}\n"

    ядро = (
        "nodes:\n  - name: Ярмарка\n    children:\n      - name: vote\n"
        "      - name: redis\n      - name: склад\nedges:\n  - from: vote\n    to: redis\n"
    )
    файлы, _ошибки, схема = _корзины(ядро, один("склад"), один("почта"), один("почта"))

    assert схема == [
        "объектов без единой связи: 2 («склад», «почта») — проверьте, не потерялись "
        "ли связи; такие объекты попадут в «Незавершённость схемы»"
    ]
    assert all(f.warnings == [] for f in файлы)


# ── общий repo без path: склейка перестала быть молчаливой ────────────────────
#
# Пункт 12 чек-листа промпта требует свой path у каждого узла, если repo стоит не на
# одном, — машинной проверки требования не было, и промах агента не показывался
# нигде. В ОДНОМ файле узлы остаются раздельными, но якорь у них общий: следующий
# файл пакета (_match_by_source) и будущий синк живой схемы (sync_plan) находят по
# нему только первого. В РАЗНЫХ файлах те же узлы СКЛЕИВАЮТСЯ, и об исчезнувшем
# имени говорила лишь строка конфликта «имя: оставлено …, отброшено …» — она
# читается как расхождение подписи ОДНОГО объекта, а не как пропажа второго вместе
# с его поддеревом.

_МОНОРЕПО_ОБА = (
    "nodes:\n"
    "  - name: Система\n"
    "    children:\n"
    "      - name: frontend\n"
    "        source: {repo: github.com/org/mono}\n"
    "      - name: backend\n"
    "        source: {repo: github.com/org/mono}\n"
    "        children:\n"
    "          - name: api\n"
)
_МОНОРЕПО_ФРОНТ = (
    "nodes:\n"
    "  - name: Система\n"
    "    children:\n"
    "      - name: frontend\n"
    "        source: {repo: github.com/org/mono}\n"
)
_МОНОРЕПО_БЭК = (
    "nodes:\n"
    "  - name: Система\n"
    "    children:\n"
    "      - name: backend\n"
    "        source: {repo: github.com/org/mono}\n"
    "        children:\n"
    "          - name: api\n"
)


def _про_источник(предупреждения: list[str]) -> list[str]:
    """Только строки нового класса — соседние замечания (сироты) здесь не при чём."""
    return [w for w in предупреждения if "источник" in w]


def test_общий_repo_без_path_в_одном_файле_называет_оба_узла():
    """Внутри файла узлы не склеиваются, но якорь у них один на двоих. Замечание
    называет ОБА имени, сам источник и ответ (свой path каждому), а корзина —
    файла-виновника: общий repo повесил его агент, ему и чинить."""
    файлы, _ошибки, схема = _корзины(_МОНОРЕПО_ОБА)

    assert _про_источник(файлы[0].warnings) == [
        "«backend» и «frontend» указывают один источник (git:github.com/org/mono) — "
        "задайте каждому свой source.path, иначе следующий прогон агента свяжется "
        "только с одним из них"
    ]
    assert схема == []


def test_общий_repo_без_path_в_разных_файлах_склеивает_и_говорит_об_этом():
    """Те же два узла врозь СКЛЕИВАЮТСЯ: «frontend» исчезает, «api» переезжает под
    «backend». Поведение слияния прежнее (правка про видимость), но теперь склейка
    названа поимённо. Корзина схемная: рассудить, один это сервис или два, может
    только видящий оба репозитория."""
    merged, report, errors = parse_and_merge([_МОНОРЕПО_БЭК, _МОНОРЕПО_ФРОНТ])
    assert errors == []
    assert _path_list(merged) == ["Система", "Система / backend", "Система / backend / api"]

    файлы, _ошибки_схемы, схема = split_remarks(report)
    assert _про_источник(схема) == [
        "«backend» и «frontend» слиты в ОДИН объект: у них общий источник "
        "(git:github.com/org/mono), а path не задан — задайте каждому свой "
        "source.path и повторите, иначе вместо 2 объектов в схеме останется один, "
        "а их компоненты окажутся внутри него"
    ]
    assert all(_про_источник(f.warnings) == [] for f in файлы)


def test_свой_path_у_каждого_узла_снимает_замечание():
    """Ответ замечания проверяем буквально: с разными path ключи различны, узлы
    раздельны и в одном файле, и врозь — превью молчит в обоих случаях."""
    свой_путь = "        source: {{repo: github.com/org/mono, path: {}}}\n"
    оба = (
        "nodes:\n"
        "  - name: Система\n"
        "    children:\n"
        "      - name: frontend\n" + свой_путь.format("web") +
        "      - name: backend\n" + свой_путь.format("api")
    )
    файлы, _ошибки, схема = _корзины(оба)
    assert _про_источник(файлы[0].warnings) == [] and _про_источник(схема) == []

    врозь_файлы, _ошибки2, врозь_схема = _корзины(
        "nodes:\n  - name: Система\n    children:\n      - name: backend\n"
        + свой_путь.format("api"),
        "nodes:\n  - name: Система\n    children:\n      - name: frontend\n"
        + свой_путь.format("web"),
    )
    assert all(_про_источник(f.warnings) == [] for f in врозь_файлы)
    assert _про_источник(врозь_схема) == []


def test_текст_замечания_о_общем_источнике_не_зависит_от_порядка_файлов():
    """Перестановка панели меняет, какое имя выживет (прежнее поведение слияния, оно
    видно в строке конфликта), но текст замечания обязан остаться тем же: имена в нём
    по алфавиту, а не по порядку файлов."""
    прямой = _про_источник(_корзины(_МОНОРЕПО_БЭК, _МОНОРЕПО_ФРОНТ)[2])
    обратный = _про_источник(_корзины(_МОНОРЕПО_ФРОНТ, _МОНОРЕПО_БЭК)[2])

    assert прямой == обратный != []


def test_кап_имён_в_замечании_об_общем_источнике():
    """Сервисов на одном repo может быть много — перечень режется с честным хвостом
    (кап как у соседних перечней слияния)."""
    дети = "".join(
        f"      - name: сервис{i}\n        source: {{repo: github.com/org/mono}}\n"
        for i in range(9)
    )
    файлы, _ошибки, _схема = _корзины(f"nodes:\n  - name: Система\n    children:\n{дети}")

    assert _про_источник(файлы[0].warnings) == [
        "«сервис0», «сервис1», «сервис2», «сервис3», «сервис4», «сервис5» и ещё 3 "
        "указывают один источник (git:github.com/org/mono) — задайте каждому свой "
        "source.path, иначе следующий прогон агента свяжется только с одним из них"
    ]


# ── эквивалентность одно-файлового прогона (главный риск Ф0) ──────────────────
#
# Ф0 меняет только МНОГОФАЙЛОВЫЙ мир: содержательность вклада (П2) и мягкий матчер
# якорей (П3) живут внутри слияния, которого при одном файле нет вовсе (merge_imports
# — passthrough), а пофайловые списки сирот (П4) при единственном владельце дают ровно
# одну прежнюю строку. Снимок держит это утверждение целиком: дерево, все плоские
# списки, разметка природы и корзины сверяются с эталоном, снятым с кода ДО правки.
# Любой сдвиг текста, порядка или адресации в одно-репо прогоне — красный тест.
#
# Ф1 (П5) — ЕДИНСТВЕННОЕ санкционированное планом изменение эталона: контейнерные
# строки расширены перечнем компонентов («… : «payments / api», …» вместо «(«payments
# / …»)»). Всё прочее в снимках осталось прежним, и это здесь же и проверяется.


def _снимок(*файлы_yaml: str) -> dict[str, object]:
    """Весь результат прогона одним значением: слитое дерево (путь + все поля узла),
    связи, ВСЕ списки отчёта, разметка природы и корзины split_remarks."""
    merged, report, errors = parse_and_merge(list(файлы_yaml))
    assert merged is not None
    файлы, ошибки_схемы, предупреждения_схемы = split_remarks(report)
    пути = _path_list(merged)
    return {
        "errors": errors,
        "nodes": [
            (
                пути[i],
                n.shape,
                n.status,
                n.role,
                n.technology,
                n.is_external,
                n.description,
                n.source_keys,
            )
            for i, n in enumerate(merged.nodes)
        ],
        "edges": [
            (пути[e.source_idx], пути[e.target_idx], e.label, e.technology, e.channel)
            for e in merged.edges
        ],
        "roots": merged.roots,
        "merged_paths": report.merged_paths,
        "dropped_edges": report.dropped_edges,
        "conflicts": report.conflicts,
        "warnings": report.warnings,
        "warning_files": report.warning_files,
        "report_errors": report.errors,
        "error_files": report.error_files,
        "file_remarks": [(f.file, f.errors, f.warnings) for f in файлы],
        "schema": (ошибки_схемы, предупреждения_схемы),
    }


_ГОЛЫЙ = ("service", "existing", None, None, False, None, [])  # узел без единого поля


def test_снимок_одно_файлового_прогона_file_a():
    предупреждения = [
        "объектов без единой связи: 2 («api», «charge-worker») — проверьте, не "
        "потерялись ли связи; такие объекты попадут в «Незавершённость схемы»",
        "связь «payments → payments-db»: конец в контейнере «payments», у которого есть "
        "компоненты, — уточните её до конкретного компонента: «payments / api», "
        "«payments / charge-worker»",
        "связь «payments → Stripe»: конец в контейнере «payments», у которого есть "
        "компоненты, — уточните её до конкретного компонента: «payments / api», "
        "«payments / charge-worker»",
        "связь «orders → payments»: конец в контейнере «payments», у которого есть "
        "компоненты, — уточните её до конкретного компонента: «payments / api», "
        "«payments / charge-worker»",
    ]
    assert _снимок(FILE_A) == {
        "errors": [],
        "nodes": [
            ("Ярмарка", "service", "existing", "система", None, False, None, []),
            (
                "Ярмарка / payments",
                "service",
                "existing",
                None,
                "Python",
                False,
                "Сервис платежей",
                [],
            ),
            ("Ярмарка / payments / api", "service", "existing", "компонент", None, False, None, []),
            (
                "Ярмарка / payments / charge-worker",
                "service",
                "existing",
                "воркер",
                None,
                False,
                None,
                [],
            ),
            ("Ярмарка / payments-db", "database", "existing", None, "PostgreSQL", False, None, []),
            ("Ярмарка / orders", *_ГОЛЫЙ),
            ("Stripe", "service", "existing", None, None, True, None, []),
        ],
        "edges": [
            ("Ярмарка / payments", "Ярмарка / payments-db", "хранит", None, None),
            ("Ярмарка / payments", "Stripe", "charge", None, None),
            ("Ярмарка / orders", "Ярмарка / payments", "REST", None, None),
        ],
        "roots": ["Ярмарка", "Stripe"],
        "merged_paths": [],
        "dropped_edges": 0,
        "conflicts": [],
        "warnings": предупреждения,
        "warning_files": [0, 0, 0, 0],
        "report_errors": [],
        "error_files": [],
        # Корзина единственного файла повторяет плоский список — это и есть Ф7 для
        # одно-репо: виновные сущности все его, схемным быть нечему.
        "file_remarks": [(1, [], предупреждения)],
        "schema": ([], []),
    }


# Один документ со ВСЕМИ классами замечаний разом: актор внутри системы, семь сирот
# (кап имён 6 + хвост), связь в контейнер с компонентами, связь в брокер без канала,
# перечень каналов в channel, оторванная группа — и якорь источника у узла.
_ВСЕ_КЛАССЫ = """
nodes:
  - name: Ярмарка
    children:
      - name: orders
        technology: Go
        source: {repo: github.com/org/orders, host: orders}
        children:
          - name: api
      - name: kafka
        shape: broker
      - name: Оператор
        shape: person
      - name: Админка
      - name: сирота1
      - name: сирота2
      - name: сирота3
      - name: сирота4
      - name: сирота5
      - name: сирота6
      - name: сирота7
edges:
  - from: orders
    to: kafka
  - from: api
    to: kafka
    label: события
    channel: "orders.created, orders.paid"
  - from: Оператор
    to: Админка
"""


def test_снимок_одно_файлового_прогона_со_всеми_классами_замечаний():
    предупреждения = [
        "внутри системы оказались люди («Оператор») — по C4 человек пользуется системой, "
        "а не входит в неё; перенесите их в корень",
        "объектов без единой связи: 7 («сирота1», «сирота2», «сирота3», «сирота4», "
        "«сирота5», «сирота6» и ещё 1) — проверьте, не потерялись ли связи; такие "
        "объекты попадут в «Незавершённость схемы»",
        "связь «orders → kafka»: конец в контейнере «orders», у которого есть "
        "компоненты, — уточните её до конкретного компонента: «orders / api»",
        "связь «orders → kafka»: конец — брокер «kafka», а канал не указан — добавьте "
        "channel: имя топика/очереди",
        "связь «api → kafka»: в channel перечень «orders.created, orders.paid» — "
        "разделите на отдельные связи, по одной на канал",
        "группа из 2 объектов не связана с остальной схемой: «Оператор», «Админка» — "
        "дорисуйте связь с ядром или проверьте, не потерялась ли она",
    ]
    assert _снимок(_ВСЕ_КЛАССЫ) == {
        "errors": [],
        "nodes": [
            ("Ярмарка", *_ГОЛЫЙ),
            (
                "Ярмарка / orders",
                "service",
                "existing",
                None,
                "Go",
                False,
                None,
                ["git:github.com/org/orders", "host:orders"],
            ),
            ("Ярмарка / orders / api", *_ГОЛЫЙ),
            ("Ярмарка / kafka", "broker", "existing", None, None, False, None, []),
            ("Ярмарка / Оператор", "person", "existing", None, None, False, None, []),
            ("Ярмарка / Админка", *_ГОЛЫЙ),
            *[(f"Ярмарка / сирота{i}", *_ГОЛЫЙ) for i in range(1, 8)],
        ],
        "edges": [
            ("Ярмарка / orders", "Ярмарка / kafka", None, None, None),
            (
                "Ярмарка / orders / api",
                "Ярмарка / kafka",
                "события",
                None,
                "orders.created, orders.paid",
            ),
            ("Ярмарка / Оператор", "Ярмарка / Админка", None, None, None),
        ],
        "roots": ["Ярмарка"],
        "merged_paths": [],
        "dropped_edges": 0,
        "conflicts": [],
        "warnings": предупреждения,
        "warning_files": [0] * 6,
        "report_errors": [],
        "error_files": [],
        "file_remarks": [(1, [], предупреждения)],
        "schema": ([], []),
    }


def test_предупреждение_разбора_доезжает_до_отчёта_с_адресом_файла():
    """Замечание РАЗБОРА (снятые виды якоря — образ и объект k8s) видно только
    парсеру одного документа, а показывает замечания отчёт слияния. Проверяем, что
    оно доехало и адресовано ТОМУ файлу, где найдено, — иначе агент второго
    репозитория чинил бы чужой YAML."""
    чистый = "nodes:\n  - name: Система\n    children:\n      - name: a\n"
    со_старым = (
        "nodes:\n  - name: Система\n    children:\n      - name: b\n"
        "        source: {image: reg.io/b, host: b}\n"
    )
    _merged, report, errors = parse_and_merge([чистый, со_старым])

    assert errors == []
    пары = list(zip(report.warnings, report.warning_files, strict=True))
    свои = [(w, f) for w, f in пары if "больше не якорь" in w]
    assert свои == [("nodes[0].children[0].source: образ и деплоймент больше не якорь "
                     "— поле проигнорировано", 1)]


# ── Основание склейки словами (Ф2 docs/plan-anchor-ux.md) ────────────────────
#
# Мердж докладывает, ЧЕМ узлы признаны одним объектом: «code» (совпал ключ git),
# «dependency» (совпал host), «name» (имя внутри одного родителя). Это доклад, а не
# решение: ни один тест склейки выше от появления оснований не изменился.


def _basis(merged: ParsedImport, report: MergeReport, path: str) -> str | None:
    return report.node_basis[_path_list(merged).index(path)]


def test_основание_склейки_по_коду():
    """Один и тот же репозиторий у обоих файлов — сошлись по коду."""
    a = _parse(
        "nodes:\n  - name: Система\n    children:\n      - name: api\n"
        "        source: {repo: github.com/org/api}\n"
    )
    b = _parse(
        "nodes:\n  - name: Система\n    children:\n      - name: api\n        role: сервис\n"
        "        source: {repo: github.com/org/api}\n"
    )
    merged, report = merge_imports([a, b])

    assert _path_list(merged) == ["Система", "Система / api"]
    assert _basis(merged, report, "Система / api") == "code"
    # Корень якоря не имеет — его свело имя.
    assert _basis(merged, report, "Система") == "name"
    assert report.merged_paths == ["Система", "Система / api"]
    assert report.merged_basis == ["name", "code"]


def test_основание_склейки_по_имени_зависимости():
    """Свой репозиторий знает только вызывающий, у заглушки соседа кода нет —
    общей гранью остаётся имя зависимости."""
    свой = _parse(
        "nodes:\n  - name: Система\n    children:\n      - name: app\n"
        "        source: {repo: github.com/org/payments, host: payments}\n"
    )
    сосед = _parse(
        "nodes:\n  - name: Система\n    children:\n      - name: payments\n"
        "        source: {host: payments}\n"
    )
    merged, report = merge_imports([свой, сосед])

    assert _basis(merged, report, "Система / app") == "dependency"


def test_основание_склейки_по_имени_и_узел_из_одного_файла():
    """Якорей нет вовсе — решило имя. Узел, встреченный ровно в одном файле,
    основания не имеет (склейки не было): None, а не «name»."""
    a = _parse("nodes:\n  - name: Система\n    children:\n      - name: api\n")
    b = _parse(
        "nodes:\n  - name: Система\n    children:\n      - name: api\n"
        "      - name: одинокий\n"
    )
    merged, report = merge_imports([a, b])

    assert _basis(merged, report, "Система / api") == "name"
    assert _basis(merged, report, "Система / одинокий") is None
    assert len(report.node_basis) == len(merged.nodes)


def test_основание_склейки_сильнейшее_из_вкладов():
    """Три файла: второй сошёлся с первым по коду, третий — только по имени.
    Показываем СИЛЬНЕЙШЕЕ основание: узел всё-таки опознан по коду."""
    a = _parse(
        "nodes:\n  - name: Система\n    children:\n      - name: api\n"
        "        source: {repo: github.com/org/api}\n"
    )
    b = _parse(
        "nodes:\n  - name: Система\n    children:\n      - name: api\n"
        "        source: {repo: github.com/org/api}\n"
    )
    c = _parse("nodes:\n  - name: Система\n    children:\n      - name: api\n")
    merged, report = merge_imports([a, b, c])

    assert _path_list(merged) == ["Система", "Система / api"]
    assert _basis(merged, report, "Система / api") == "code"


def test_основание_не_влияет_на_склейку_при_любом_порядке_файлов():
    """Сторож порядконезависимости (стабилизация v3): основание — доклад. При любой
    перестановке файлов результат тот же, и основание узла тоже одно и то же."""
    свой = _parse(
        "nodes:\n  - name: Система\n    children:\n      - name: app\n"
        "        source: {repo: github.com/org/payments, host: payments}\n"
    )
    сосед = _parse(
        "nodes:\n  - name: Система\n    children:\n      - name: payments\n"
        "        source: {host: payments}\n"
    )
    третий = _parse("nodes:\n  - name: Система\n    children:\n      - name: web\n")
    исходы = set()
    for перестановка in permutations([свой, сосед, третий]):
        merged, report = merge_imports(list(перестановка))
        assert len(report.node_basis) == len(merged.nodes)
        # Имя склеенного узла берётся у СОЗДАТЕЛЯ и от порядка зависит осознанно
        # («app» либо «payments»), поэтому сверяем набор оснований, а не пути.
        исходы.add(tuple(sorted(report.node_basis, key=str)))
    assert исходы == {(None, "dependency", "name")}


def test_основание_склейки_один_файл_пусто():
    """Passthrough одного документа: склеек нет, оснований тоже — по узлу на None."""
    один = _parse("nodes:\n  - name: Система\n    children:\n      - name: api\n")
    merged, report = merge_imports([один])

    assert report.node_basis == [None, None]
    assert report.merged_basis == []
