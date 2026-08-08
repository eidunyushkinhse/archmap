"""Тесты слияния нескольких импортов (app/import_merge.py).

Матрица: заглушка+богатый (поля доливаются, дети объединяются), конфликты полей
(первое побеждает + строка в отчёт), external → true, не-дефолт бьёт дефолт,
перевес рёбер + дедуп точных дублей, предупреждения (похожие подписи пары из
разных файлов, fuzzy-имена сиблингов, несовпавшие корни), passthrough одного
файла, нечувствительность к порядку файлов, суммарные лимиты, инвариант
«родители раньше детей» (совместимость с seed_import).
"""

from app.import_merge import merge_imports, parse_and_merge
from app.import_yaml import ParsedImport, parse_import


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
