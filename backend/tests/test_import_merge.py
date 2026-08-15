"""Тесты слияния нескольких импортов (app/import_merge.py).

Матрица: заглушка+богатый (поля доливаются, дети объединяются), конфликты полей
(первое побеждает + строка в отчёт), external → true, не-дефолт бьёт дефолт,
перевес рёбер + дедуп точных дублей, предупреждения (похожие подписи пары из
разных файлов, fuzzy-имена сиблингов, несовпавшие корни), проверки содержания
(люди внутри системы, объекты без связей, связи в контейнер с компонентами),
passthrough одного файла, нечувствительность к порядку файлов, суммарные лимиты,
инвариант «родители раньше детей» (совместимость с seed_import).
"""

import uuid

from conftest import ensure_project

from app.import_merge import merge_imports, parse_and_merge, split_remarks
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
    merged, report = merge_imports([_parse(FILE_A), _parse(FILE_B)])
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
    merged, report = merge_imports([own, caller])

    assert _path_list(merged) == ["Система", "Система / app"]
    assert _node_by_path(merged, "Система / app").technology == "Go"
    assert any("имя" in c and "payments" in c for c in report.conflicts)


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
    merged, report = merge_imports([a, b])

    paths = _path_list(merged)
    assert "Система / auth" in paths and "Система / gateway / auth" not in paths
    assert any("родитель" in c for c in report.conflicts)


def test_склеенный_узел_наследует_все_грани_источника():
    """Третий файл должен найти узел по той грани, которой не было в первом:
    A знает git, B — образ, C ходит только по сетевому имени."""
    a = _parse("nodes:\n  - name: svc\n    source: {repo: github.com/org/svc}\n")
    b = _parse("nodes:\n  - name: svc\n    source: {repo: github.com/org/svc, image: reg.io/svc}\n")
    c = _parse("nodes:\n  - name: другое-имя\n    source: {image: reg.io/svc}\n")
    merged, _report = merge_imports([a, b, c])

    assert len(merged.nodes) == 1
    assert merged.nodes[0].source_keys == ["git:github.com/org/svc", "img:reg.io/svc"]


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
        "уточните её до конкретного компонента («vote / …»)"
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
    warn = next(w for w in report.warnings if "оба конца" in w)
    assert "«vote»" in warn and "«worker»" in warn
    assert "«vote / …»" in warn and "«worker / …»" in warn


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


def _db_связь(db, src, tgt):
    db.add(
        Edge(
            id=uuid.uuid4(),
            source_id=src.id,
            target_id=tgt.id,
            project_id=ensure_project(db).id,
        )
    )


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


# ── природа замечаний: файловые против схемных (Ф6, docs/plan-skeptic-audit.md) ──
#
# Пакет собирают N агентов, каждый видит ТОЛЬКО свой репозиторий и переписывает
# только свой YAML. Значит, замечание, порождённое содержимым одного файла, надо
# уметь отдать его агенту, а свойство слитой картины (конфликт двух файлов,
# оторванная группа) — оставить человеку: рассудить это может только тот, кто
# видит весь ландшафт. Инвариант суммы держит совместимость с плоскими списками.

# Два «репозитория» одной системы. В первом — актор внутри системы и стрелка в
# брокер без канала (лечится в файле 1), во втором — перечень каналов в одном поле
# (лечится в файле 2). Плюс два схемных: расхождение technology у общего сервиса и
# группа «Оператор → Админка», оторванная от ядра.
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
    # Схемные: конфликт полей и оторванная группа — только пользователю.
    assert any("technology: оставлено «Go»" in w for w in предупреждения_схемы)
    assert any("не связана с остальной схемой" in w for w in предупреждения_схемы)
    assert not any(
        "не связана с остальной схемой" in w or "оставлено «Go»" in w
        for f in файлы
        for w in f.warnings
    )


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
